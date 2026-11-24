import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export interface ResolveDeps {
  env: NodeJS.ProcessEnv
  home: string
  /** Injectable for tests. Defaults to "is a regular file the user can execute". */
  isExecutable?: (path: string) => boolean
}

const defaultIsExecutable = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Finds the user's installed `claude` CLI without running a shell. A GUI-launched app gets a
 * minimal PATH (often without ~/.local/bin), so common install locations are searched too.
 */
export function resolveClaudeBinary(deps: ResolveDeps): string | null {
  const isExec = deps.isExecutable ?? defaultIsExecutable
  const dirs = [
    // A relative PATH entry would be resolved against the current directory, so it is ignored.
    ...(deps.env['PATH'] ?? '').split(delimiter).filter((d) => d && isAbsolute(d)),
    join(deps.home, '.local', 'bin'),
    join(deps.home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  for (const dir of dirs) {
    const candidate = join(dir, 'claude')
    if (isExec(candidate)) return candidate
  }
  return null
}
