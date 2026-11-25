import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitWorktrees, containment, isInside } from '../src/main/modules/agents/developers/worktrees'
import { AppError } from '../src/shared/types/result'
import { makeGitRepo, tempDir } from './helpers'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString().trim()
const codeOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e instanceof AppError ? e.code : 'OTHER' } return 'NONE' }

describe('GitWorktrees', () => {
  it('creates a branch and an isolated worktree without touching the main working tree', async () => {
    const repo = makeGitRepo(); const wt = join(tempDir(), 'wt'); const w = new GitWorktrees()
    const base = await w.resolveBase(repo, 'main')
    await w.add(repo, wt, 'orbyte/task-1234abcd', base)
    expect(existsSync(join(wt, 'README.md'))).toBe(true)
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('orbyte/task-1234abcd')
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('does not run repository hooks while creating a worktree (hooks are untrusted code)', async () => {
    const repo = makeGitRepo(); const marker = join(tempDir(), 'hook-ran')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    const hook = join(repo, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 })
    // Sanity check that the hook is real: plain git runs it on `worktree add`.
    git(repo, 'worktree', 'add', '-b', 'plain', join(tempDir(), 'plain'), 'main')
    expect(existsSync(marker)).toBe(true)
    execFileSync('rm', [marker])
    const w = new GitWorktrees()
    await w.add(repo, join(tempDir(), 'safe'), 'orbyte/safe-1234abcd', await w.resolveBase(repo, 'main'))
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses branch names that are not orbyte/<slug>', async () => {
    const repo = makeGitRepo(); const w = new GitWorktrees(); const base = await w.resolveBase(repo, 'main')
    for (const bad of ['main', 'orbyte/', 'orbyte/UPPER', 'orbyte/a b', '../x', 'orbyte/a..b', '-D', 'orbyte/x;rm']) {
      expect(await codeOf(w.add(repo, join(tempDir(), 'x'), bad, base)), bad).toBe('WORKTREE_FAILED')
    }
    expect(git(repo, 'branch', '--list')).not.toMatch(/UPPER|a b/)
  })

  it('reports a repository with no commits, and cannot be tricked by an option-like ref', async () => {
    const empty = makeGitRepo(false); const w = new GitWorktrees()
    expect(await codeOf(w.resolveBase(empty, 'main'))).toBe('NO_BASE_COMMIT')
    expect(await codeOf(w.resolveBase(makeGitRepo(), '--upload-pack=touch /tmp/pwned'))).toBe('NO_BASE_COMMIT')
  })

  it('refuses to remove a worktree with changes unless forced, and detects changes', async () => {
    const repo = makeGitRepo(); const wt = join(tempDir(), 'wt'); const w = new GitWorktrees()
    await w.add(repo, wt, 'orbyte/dirty-1234abcd', await w.resolveBase(repo, 'main'))
    expect(await w.hasChanges(wt)).toBe(false)
    writeFileSync(join(wt, 'new.txt'), 'work in progress')
    expect(await w.hasChanges(wt)).toBe(true)
    expect(await codeOf(w.remove(repo, wt, false))).toBe('WORKTREE_FAILED')
    expect(existsSync(join(wt, 'new.txt'))).toBe(true) // nothing was lost
    await w.remove(repo, wt, true)
    expect(existsSync(wt)).toBe(false)
  })

  it('deletes a branch only when it never moved, so agent commits are never lost', async () => {
    const repo = makeGitRepo(); const w = new GitWorktrees(); const base = await w.resolveBase(repo, 'main')
    const a = join(tempDir(), 'a'); const b = join(tempDir(), 'b')
    await w.add(repo, a, 'orbyte/unmoved-1234abcd', base); await w.add(repo, b, 'orbyte/moved-1234abcd', base)
    writeFileSync(join(b, 'f.txt'), 'x'); git(b, 'add', '.'); git(b, 'commit', '-q', '-m', 'work')
    await w.remove(repo, a, true); await w.remove(repo, b, true)
    expect(await w.deleteBranchIfUnmoved(repo, 'orbyte/unmoved-1234abcd', base)).toBe(true)
    expect(await w.deleteBranchIfUnmoved(repo, 'orbyte/moved-1234abcd', base)).toBe(false)
    expect(git(repo, 'branch', '--list', 'orbyte/*')).toContain('orbyte/moved-1234abcd')
    expect(await w.deleteBranchIfUnmoved(repo, 'main', base)).toBe(false) // only orbyte/* branches are ever deleted
  })

  it('detects commits made on a detached HEAD, which removing the worktree would orphan', async () => {
    const repo = makeGitRepo(); const wt = join(tempDir(), 'wt'); const w = new GitWorktrees()
    const base = await w.resolveBase(repo, 'main')
    await w.add(repo, wt, 'orbyte/stray-1234abcd', base)
    expect(await w.hasStrayCommits(wt, 'orbyte/stray-1234abcd', base)).toBe(false) // fresh
    writeFileSync(join(wt, 'a.txt'), '1'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'on the branch')
    expect(await w.hasStrayCommits(wt, 'orbyte/stray-1234abcd', base)).toBe(false) // HEAD is the branch tip
    git(wt, 'checkout', '-q', '--detach')
    writeFileSync(join(wt, 'b.txt'), '2'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'detached work')
    expect(await w.hasStrayCommits(wt, 'orbyte/stray-1234abcd', base)).toBe(true)
  })

  it('deletes the branch atomically and only while it still points at the base commit', async () => {
    const repo = makeGitRepo(); const w = new GitWorktrees(); const base = await w.resolveBase(repo, 'main')
    git(repo, 'branch', 'orbyte/atomic-1234abcd', base)
    expect(await w.deleteBranchIfUnmoved(repo, 'orbyte/atomic-1234abcd', base)).toBe(true)
    expect(git(repo, 'branch', '--list', 'orbyte/*')).toBe('')
    expect(await w.deleteBranchIfUnmoved(repo, 'orbyte/atomic-1234abcd', base)).toBe(false) // already gone
    git(repo, 'branch', 'orbyte/other-1234abcd', base)
    expect(await w.deleteBranchIfUnmoved(repo, 'orbyte/other-1234abcd', 'f'.repeat(40))).toBe(false) // wrong expected commit: refused
    expect(git(repo, 'branch', '--list', 'orbyte/*')).toContain('orbyte/other-1234abcd')
  })

  it('containment follows symlinks and reports vanished directories', async () => {
    const root = tempDir('orbyte-root-'); const outside = tempDir('orbyte-outside-')
    mkdirSync(join(root, 'p', 'a'), { recursive: true })
    expect(await containment(root, join(root, 'p', 'a'))).toBe('inside')
    expect(await containment(root, join(root, 'p', 'gone'))).toBe('missing')
    expect(await containment(root, join(root, '..', 'elsewhere'))).toBe('outside') // lexically outside
    symlinkSync(outside, join(root, 'p', 'link'))
    expect(await containment(root, join(root, 'p', 'link'))).toBe('outside') // looks inside, resolves outside
    rmSync(join(root, 'p', 'a'), { recursive: true })
    expect(await containment(root, join(root, 'p', 'a'))).toBe('missing')
  })

  it('isInside guards path containment', () => {
    expect(isInside('/root/wt', '/root/wt/p/a')).toBe(true)
    expect(isInside('/root/wt', '/root/wt')).toBe(true)
    expect(isInside('/root/wt', '/root/wt-evil/a')).toBe(false)
    expect(isInside('/root/wt', '/root/wt/../other')).toBe(false)
    expect(isInside('/root/wt', '/etc')).toBe(false)
  })
})

describe('verifyRepo', () => {
  it('accepts a real repository path', async () => {
    const repo = realpathSync(makeGitRepo())
    await expect(new GitWorktrees().verifyRepo(repo)).resolves.toBeUndefined()
  })
  it('refuses a path that became a symlink, a missing path and a non-repository', async () => {
    const w = new GitWorktrees()
    const repo = realpathSync(makeGitRepo())
    const link = join(realpathSync(tempDir()), 'link')
    symlinkSync(repo, link)
    expect(await codeOf(w.verifyRepo(link))).toBe('INVALID_DIRECTORY')
    expect(await codeOf(w.verifyRepo(join(repo, 'gone')))).toBe('INVALID_DIRECTORY')
    expect(await codeOf(w.verifyRepo(realpathSync(tempDir())))).toBe('INVALID_DIRECTORY')
  })
})

describe('snapshot of untracked files', () => {
  it('counts the lines of new text files and leaves binaries, links and oversized files uncounted', async () => {
    const repo = makeGitRepo(); const w = new GitWorktrees(); const base = await w.resolveBase(repo, 'main')
    const wt = join(tempDir(), 'wt')
    await w.add(repo, wt, 'orbyte/count-1234abcd', base)
    writeFileSync(join(wt, 'three.txt'), 'a\nb\nc\n')
    writeFileSync(join(wt, 'no-newline.txt'), 'a\nb')
    writeFileSync(join(wt, 'empty.txt'), '')
    writeFileSync(join(wt, 'binary.bin'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(wt, 'big.txt'), 'x\n'.repeat(600_000))
    symlinkSync('three.txt', join(wt, 'link.txt'))
    const before = await w.snapshot(wt, base)
    const by = Object.fromEntries(before.files.map((f) => [f.path, f]))
    expect(by['three.txt']).toMatchObject({ status: '?', additions: 3, deletions: 0 })
    expect(by['no-newline.txt']).toMatchObject({ additions: 2, deletions: 0 })
    expect(by['empty.txt']).toMatchObject({ additions: 0, deletions: 0 })
    expect(by['binary.bin']).toMatchObject({ additions: null, deletions: null })
    expect(by['big.txt']).toMatchObject({ additions: null, deletions: null })
    expect(by['link.txt']).toMatchObject({ additions: null, deletions: null })
    // The hash still covers the contents: editing a counted file changes it.
    writeFileSync(join(wt, 'three.txt'), 'a\nb\nc\nd\n')
    const after = await w.snapshot(wt, base)
    expect(after.snapshotHash).not.toBe(before.snapshotHash)
    expect(after.files.find((f) => f.path === 'three.txt')?.additions).toBe(4)
  })
})

describe('changesText', () => {
  it('shows tracked edits and new files, and only names binaries, big files, links and bad paths', async () => {
    const repo = makeGitRepo(); const w = new GitWorktrees(); const base = await w.resolveBase(repo, 'main')
    const wt = join(tempDir(), 'wt')
    await w.add(repo, wt, 'orbyte/changes-1234abcd', base)
    const tracked = execFileSync('git', ['-C', wt, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)[0]!
    writeFileSync(join(wt, tracked), 'edited line\n')
    writeFileSync(join(wt, 'new.ts'), 'export const a = 1\nexport const b = 2\n')
    writeFileSync(join(wt, 'bin.dat'), Buffer.from([1, 0, 2]))
    writeFileSync(join(wt, 'big.txt'), 'x'.repeat(300 * 1024))
    const outside = join(tempDir(), 'secret.txt'); writeFileSync(outside, 'TOPSECRET')
    symlinkSync(outside, join(wt, 'link.txt'))
    const out = await w.changesText(wt, base, ['new.ts', 'bin.dat', 'big.txt', 'link.txt', '../escape', '/etc/passwd', 'missing.ts'])
    expect(out.text).toContain('+edited line')
    expect(out.text).toContain('+++ b/new.ts')
    expect(out.text).toContain('+export const b = 2')
    expect(out.text).toContain('(new binary file)')
    expect(out.text).toContain('too large to show')
    expect(out.text).not.toContain('TOPSECRET')
    expect((out.text.match(/not shown: not a plain file/g) ?? []).length).toBe(4) // link, ../escape, /etc/passwd, missing
    expect(out.truncated).toBe(false)
  })

  it('caps its output', async () => {
    const repo = makeGitRepo(); const w = new GitWorktrees(); const base = await w.resolveBase(repo, 'main')
    const wt = join(tempDir(), 'wt')
    await w.add(repo, wt, 'orbyte/cap-1234abcd', base)
    writeFileSync(join(wt, 'a.txt'), 'line\n'.repeat(5000))
    const out = await w.changesText(wt, base, ['a.txt'], 2000)
    expect(out.text.length).toBeLessThanOrEqual(2000)
    expect(out.truncated).toBe(true)
  })
})
