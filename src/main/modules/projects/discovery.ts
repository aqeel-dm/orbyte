import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { DiscoveryResult } from '@shared/schemas/onboarding'

const MAX_DEPTH = 3
const MAX_DIRS = 400
const MAX_CLAUDE_MD = 25
const MAX_DOCS = 25
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', 'vendor', '.venv', '__pycache__'])
const DOC_NAMES = /^(readme|architecture|contributing|development|design)[^/]*\.(md|mdx|txt)$/i

const posix = (p: string): string => p.split(sep).join('/')

/**
 * Read-only, bounded discovery of repo-owned instructions. Never writes, and
 * never follows a symlink outside the repository root.
 */
export async function discoverProject(repoPath: string): Promise<DiscoveryResult> {
  const root = await realpath(repoPath)
  const result: DiscoveryResult = {
    claudeMdFiles: [],
    claudeDir: { exists: false, rules: [], skills: [], agents: [], settingsFiles: [], hasHooks: false },
    hasMcpConfig: false,
    docs: [],
    truncated: false
  }

  const inside = (real: string): boolean => real === root || real.startsWith(root + sep)

  /** Returns the file size if `path` is a regular file whose real path stays inside the root. */
  async function safeFileSize(path: string): Promise<number | null> {
    try {
      const real = await realpath(path)
      if (!inside(real)) return null
      const st = await stat(real)
      return st.isFile() ? st.size : null
    } catch {
      return null
    }
  }

  async function safeList(dir: string): Promise<string[]> {
    try {
      const real = await realpath(dir)
      if (!inside(real)) return []
      return (await readdir(real)).sort()
    } catch {
      return []
    }
  }

  // Walk the tree (bounded) for nested CLAUDE.md files and top-level docs.
  let dirsVisited = 0
  async function walk(dir: string, depth: number): Promise<void> {
    if (dirsVisited >= MAX_DIRS) {
      result.truncated = true
      return
    }
    dirsVisited++
    let names: string[]
    try {
      names = (await readdir(dir)).sort()
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let st
      try {
        st = await lstat(full) // lstat: symlinks are not followed during the walk
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(name)) await walk(full, depth + 1)
      } else if (st.isFile()) {
        const rel = posix(relative(root, full))
        if (name === 'CLAUDE.md') {
          if (result.claudeMdFiles.length < MAX_CLAUDE_MD) result.claudeMdFiles.push({ path: rel, bytes: st.size })
          else result.truncated = true
        } else if (depth === 0 && DOC_NAMES.test(name)) {
          if (result.docs.length < MAX_DOCS) result.docs.push({ path: rel, bytes: st.size })
        }
      }
    }
  }
  await walk(root, 0)

  // docs/ directory (one level)
  for (const name of await safeList(join(root, 'docs'))) {
    if (result.docs.length >= MAX_DOCS) {
      result.truncated = true
      break
    }
    if (!/\.(md|mdx)$/i.test(name)) continue
    const size = await safeFileSize(join(root, 'docs', name))
    if (size !== null) result.docs.push({ path: `docs/${name}`, bytes: size })
  }

  // .claude directory
  const claudeDir = join(root, '.claude')
  const claudeEntries = await safeList(claudeDir)
  if (claudeEntries.length > 0) {
    result.claudeDir.exists = true
    result.claudeDir.rules = (await safeList(join(claudeDir, 'rules'))).filter((n) => n.endsWith('.md'))
    result.claudeDir.skills = await safeList(join(claudeDir, 'skills'))
    result.claudeDir.agents = (await safeList(join(claudeDir, 'agents'))).filter((n) => n.endsWith('.md'))
    result.claudeDir.settingsFiles = claudeEntries.filter((n) => /^settings(\.local)?\.json$/.test(n))
    // Presence only: settings are repo-owned and are not parsed or copied.
    result.claudeDir.hasHooks = result.claudeDir.settingsFiles.length > 0 && (await hasHooksKey(claudeDir, result.claudeDir.settingsFiles, safeFileSize))
  }
  if ((await safeFileSize(join(root, '.mcp.json'))) !== null) result.hasMcpConfig = true

  return result
}

async function hasHooksKey(
  dir: string,
  files: string[],
  size: (p: string) => Promise<number | null>
): Promise<boolean> {
  const { readFile } = await import('node:fs/promises')
  for (const f of files) {
    const s = await size(join(dir, f))
    if (s === null || s > 256 * 1024) continue
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, f), 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && 'hooks' in parsed) return true
    } catch {
      /* unreadable or invalid JSON: treat as no hooks info */
    }
  }
  return false
}
