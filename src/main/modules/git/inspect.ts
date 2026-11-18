import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepoInspection } from '@shared/schemas/project'

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 10_000, windowsHide: true })
    return stdout.trim()
  } catch {
    return null
  }
}

/** Read-only repository inspection. Never initialises or modifies a repository. */
export async function inspectRepository(dir: string): Promise<RepoInspection> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') return { isGitRepo: false, repoRoot: null, defaultBranch: null }

  const repoRoot = await git(dir, ['rev-parse', '--show-toplevel'])
  const remoteHead = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const defaultBranch =
    remoteHead?.replace(/^origin\//, '') || (await git(dir, ['symbolic-ref', '--short', 'HEAD'])) || null
  return { isGitRepo: true, repoRoot, defaultBranch }
}
