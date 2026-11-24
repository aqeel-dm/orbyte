import { execFile } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { AppError } from '@shared/types/result'

const run = promisify(execFile)

/** Branch names Orbyte creates: `orbyte/` + lowercase slug. Anything else is refused. */
const BRANCH = /^orbyte\/[a-z0-9][a-z0-9-]{0,80}$/

export type GitRunner = (cwd: string, args: string[]) => Promise<string>

/**
 * Repository config and hooks are untrusted: no hooks (a post-checkout hook would run code),
 * no fsmonitor, no prompts, no optional locks. Fixed arguments, no shell, with a timeout.
 */
export const defaultGit: GitRunner = async (cwd, args) => {
  const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
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
