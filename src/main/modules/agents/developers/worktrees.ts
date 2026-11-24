import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readlink, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Evidence } from '@shared/schemas/execution'
import { AppError } from '@shared/types/result'

const run = promisify(execFile)

/** Branch names Orbyte creates: `orbyte/` + lowercase slug. Anything else is refused. */
const BRANCH = /^orbyte\/[a-z0-9][a-z0-9-]{0,80}$/

export type GitRunner = (cwd: string, args: string[], opts?: { maxBuffer?: number; isolated?: boolean }) => Promise<string>

/** Variables that would redirect git to other repositories, indexes or config. Never inherited. */
const GIT_REDIRECT_VARS = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_EXTERNAL_DIFF|GIT_CONFIG.*|GIT_ATTR_.*)$/

/**
 * Repository config and hooks are untrusted: no hooks (a post-checkout hook would run code),
 * no fsmonitor, no prompts, no optional locks. Fixed arguments, no shell, with a timeout.
 */
export const defaultGit: GitRunner = async (cwd, args, opts) => {
  const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    timeout: 60_000,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    windowsHide: true,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_REDIRECT_VARS.test(k))),
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      // Evidence collection reads a directory an agent can write to: use no user or system config either.
      ...(opts?.isolated ? { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } : {})
    }
  })
  return stdout.trim()
}

export const isInside = (root: string, path: string): boolean => {
  const r = resolve(root)
  const p = resolve(path)
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Containment that follows symlinks. A path that no longer exists is reported as `missing` so the
 * caller can clean up a vanished worktree instead of getting stuck on it.
 */
export async function containment(root: string, path: string): Promise<'inside' | 'outside' | 'missing'> {
  if (!isInside(root, path)) return 'outside'
  let realPath: string
  try {
    realPath = await realpath(path)
  } catch {
    return 'missing'
  }
  try {
    return isInside(await realpath(root), realPath) ? 'inside' : 'outside'
  } catch {
    return 'outside'
  }
}

export class GitWorktrees {
  constructor(private readonly git: GitRunner = defaultGit) {}

  /** Resolves a ref (for example the default branch) to a commit id. */
  async resolveBase(repoPath: string, baseRef: string): Promise<string> {
    try {
      return await this.git(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`])
    } catch {
      throw new AppError('NO_BASE_COMMIT', 'The repository has no commit on its default branch to start from.')
    }
  }

  /** Creates a new branch at `baseCommit` checked out in a new worktree directory. Never touches the main working tree. */
  async add(repoPath: string, worktreePath: string, branch: string, baseCommit: string): Promise<void> {
    if (!BRANCH.test(branch)) throw new AppError('WORKTREE_FAILED', 'Invalid branch name.')
    try {
      await this.git(repoPath, ['check-ref-format', '--branch', branch])
      await mkdir(dirname(worktreePath), { recursive: true })
      await this.git(repoPath, ['worktree', 'add', '-b', branch, '--', worktreePath, baseCommit])
    } catch (err) {
      console.error('[worktrees] add failed', err)
      throw new AppError('WORKTREE_FAILED', 'Could not create an isolated worktree for the agent. See the application log.')
    }
  }

  /** True if the worktree has uncommitted or untracked changes. */
  async hasChanges(worktreePath: string): Promise<boolean> {
    return (await this.git(worktreePath, ['status', '--porcelain'])).length > 0
  }

  /**
   * True if HEAD points at a commit that is neither the branch tip nor the base commit, for example
   * after a detached-HEAD commit. Removing the worktree would leave that work only in the reflog.
   */
  async hasStrayCommits(worktreePath: string, branch: string, baseCommit: string): Promise<boolean> {
    const head = await this.git(worktreePath, ['rev-parse', 'HEAD'])
    let tip: string | null = null
    try {
      tip = await this.git(worktreePath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}`])
    } catch {
      tip = null
    }
    return head !== baseCommit && head !== tip
  }

  /**
   * Facts about the work in a worktree, collected by Orbyte from git itself, not from anything an agent
   * says. The snapshot hash covers HEAD, the full diff against the base commit and every untracked file,
   * so acceptance can be tied to exactly this code and notice when it changes. External diff and textconv
   * drivers are disabled because repository config can use them to run programs.
   */
  async snapshot(worktreePath: string, baseCommit: string): Promise<Evidence> {
    // The agent can edit files in its worktree, including the `.git` pointer file. Refuse to run git against
    // a worktree whose pointer no longer leads outside the worktree (it could lead to a fabricated git dir).
    await this.assertGitDirOutside(worktreePath)
    const listing = { maxBuffer: 16 * 1024 * 1024, isolated: true }
    const g = (args: string[], opts: { maxBuffer?: number; isolated?: boolean } = listing): Promise<string> =>
      this.git(worktreePath, ['-c', 'core.attributesFile=/dev/null', ...args], opts)
    const diff = (extra: string[]): Promise<string> =>
      g(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...extra, baseCommit, '--'])
    const headCommit = await g(['rev-parse', 'HEAD'])
    const numstat = await diff(['--numstat'])
    const nameStatus = await diff(['--name-status'])
    const stat = await diff(['--stat'])
    const log = await g(['log', '--format=%H%x09%s', '-n', '50', `${baseCommit}..HEAD`, '--'])
    const porcelain = await g(['status', '--porcelain'])
    const untrackedRaw = await g(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z'])
    // Ignored files are outside the diff, but Claude settings and MCP config can change what an agent may do.
    const ignoredConfig = await g(['-c', 'core.quotePath=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.claude', '.mcp.json'])
    const untracked = [...new Set([...untrackedRaw.split('\0'), ...ignoredConfig.split('\0')].filter(Boolean))].sort()

    let truncated = false
    let diffHash: string
    try {
      // The full diff, hashed. A diff too large to hold falls back to its numstat, and is flagged.
      diffHash = createHash('sha256').update(await g(['diff', '--no-ext-diff', '--no-textconv', '--binary', baseCommit, '--'], { maxBuffer: 32 * 1024 * 1024, isolated: true })).digest('hex')
    } catch {
      truncated = true
      diffHash = createHash('sha256').update(numstat).digest('hex')
    }

    const statusByPath = new Map(nameStatus.split('\n').filter(Boolean).map((l) => [l.split('\t')[1] ?? '', l.split('\t')[0] ?? '?'] as const))
    const files: Evidence['files'] = numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [add, del, ...rest] = line.split('\t')
        const path = rest.join('\t')
        return { path, status: statusByPath.get(path) ?? 'M', additions: add === '-' ? null : Number(add), deletions: del === '-' ? null : Number(del) }
      })

    // Untracked files are not in the diff: include their names and a content hash.
    const untrackedEntries: string[] = []
    for (const rel of untracked.slice(0, 500)) {
      files.push({ path: rel, status: '?', additions: null, deletions: null })
      untrackedEntries.push(`${rel}:${await this.fileDigest(join(worktreePath, rel))}`)
    }
    if (untracked.length > 500) truncated = true
    const cappedFiles = files.length > 300 ? ((truncated = true), files.slice(0, 300)) : files

    const snapshotHash = createHash('sha256').update([headCommit, diffHash, ...untrackedEntries].join('\n')).digest('hex')
    return {
      headCommit,
      snapshotHash,
      files: cappedFiles,
      diffStat: stat.slice(0, 4000),
      commits: log.split('\n').filter(Boolean).map((l) => ({ sha: l.split('\t')[0] ?? '', subject: l.split('\t').slice(1).join('\t') })),
      uncommitted: porcelain.length > 0,
      truncated
    }
  }

  private async assertGitDirOutside(worktreePath: string): Promise<void> {
    const fail = (): never => { throw new AppError('WORKTREE_FAILED', 'The worktree could not be inspected safely.') }
    try {
      const pointer = join(worktreePath, '.git')
      if (!(await lstat(pointer)).isFile()) return fail()
      const m = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(pointer, 'utf8'))
      if (!m?.[1]) return fail()
      const gitDir = await realpath(resolve(worktreePath, m[1]))
      if (isInside(await realpath(worktreePath), gitDir)) return fail()
    } catch (err) {
      if (err instanceof AppError) throw err
      return fail()
    }
  }

  /** The diff against the base commit as text for a reviewer, capped. External diff and textconv are off. */
  async diffText(worktreePath: string, baseCommit: string, maxChars = 60_000): Promise<{ text: string; truncated: boolean }> {
    let out: string
    try {
      await this.assertGitDirOutside(worktreePath)
      out = await this.git(worktreePath, ['-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', baseCommit, '--'], { maxBuffer: 8 * 1024 * 1024, isolated: true })
    } catch {
      return { text: '(the diff is too large to include)', truncated: true }
    }
    return out.length > maxChars ? { text: out.slice(0, maxChars), truncated: true } : { text: out, truncated: false }
  }

  /** Content hash of one untracked file. A symlink hashes its target path (it is never followed). Very large files hash their size. */
  private async fileDigest(path: string): Promise<string> {
    try {
      const st = await lstat(path)
      if (st.isSymbolicLink()) return createHash('sha256').update(`link:${await readlink(path)}`).digest('hex')
      if (!st.isFile()) return 'not-a-file'
      if (st.size > 5 * 1024 * 1024) return `size:${st.size}`
      return createHash('sha256').update(await readFile(path)).digest('hex')
    } catch {
      return 'unreadable'
    }
  }

  /** Forgets worktrees whose directory no longer exists. */
  async prune(repoPath: string): Promise<void> {
    try {
      await this.git(repoPath, ['worktree', 'prune'])
    } catch (err) {
      console.error('[worktrees] prune failed', err)
    }
  }

  async remove(repoPath: string, worktreePath: string, force: boolean): Promise<void> {
    try {
      await this.git(repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', worktreePath])
    } catch (err) {
      console.error('[worktrees] remove failed', err)
      throw new AppError('WORKTREE_FAILED', 'Could not remove the worktree. See the application log.')
    }
  }

  /** Deletes the branch only if it never moved from its base commit, so no agent work is ever lost. */
  async deleteBranchIfUnmoved(repoPath: string, branch: string, baseCommit: string): Promise<boolean> {
    if (!BRANCH.test(branch)) return false
    try {
      // One atomic step: git deletes the branch only if it still points at the base commit.
      await this.git(repoPath, ['update-ref', '-d', `refs/heads/${branch}`, baseCommit])
      return true
    } catch {
      return false
    }
  }
}
