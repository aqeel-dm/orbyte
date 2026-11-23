import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { DiscoveryResult } from '@shared/schemas/onboarding'

const MAX_DEPTH = 3
const MAX_DIRS = 400
const MAX_ENTRIES_PER_DIR = 5000
const MAX_LIST = 100
const WALK_DEADLINE_MS = 5000
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
    claudeDir: { exists: false, rules: [], skills: [], agents: [], settingsFiles: [], hasHooks: false, riskySettingsKeys: [] },
    hasMcpConfig: false,
    docs: [],
    truncated: false
  }

  const prefix = root.endsWith(sep) ? root : root + sep
  const inside = (real: string): boolean => real === root || real.startsWith(prefix)
  const deadline = Date.now() + WALK_DEADLINE_MS

  /** Returns the file size if `path` is a regular file whose real path stays inside the root. */
  async function safeFile(path: string): Promise<{ real: string; size: number } | null> {
    try {
      const real = await realpath(path)
      if (!inside(real)) return null
      const st = await stat(real)
      return st.isFile() ? { real, size: st.size } : null
    } catch {
      return null
    }
  }
  const safeFileSize = async (path: string): Promise<number | null> => (await safeFile(path))?.size ?? null

  async function safeList(dir: string): Promise<string[]> {
    try {
      const real = await realpath(dir)
      if (!inside(real)) return []
      return (await readdir(real)).sort().slice(0, MAX_LIST)
    } catch {
      return []
    }
  }

  // Walk the tree (bounded) for nested CLAUDE.md files and top-level docs.
  let dirsVisited = 0
  async function walk(dir: string, depth: number): Promise<void> {
    if (dirsVisited >= MAX_DIRS || Date.now() > deadline) {
      result.truncated = true
      return
    }
    dirsVisited++
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    if (names.length > MAX_ENTRIES_PER_DIR) {
      result.truncated = true
      names = names.slice(0, MAX_ENTRIES_PER_DIR)
    }
    names.sort()
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
    const risky = await riskyKeys(claudeDir, result.claudeDir.settingsFiles, safeFile)
    result.claudeDir.riskySettingsKeys = risky
    result.claudeDir.hasHooks = risky.includes('hooks')
  }
  if ((await safeFileSize(join(root, '.mcp.json'))) !== null) result.hasMcpConfig = true

  return result
}

/** Settings keys that can run code, redirect traffic or widen permissions. Names only; values are never read out. */
const RISKY_KEYS = ['hooks', 'env', 'apiKeyHelper', 'statusLine', 'enabledPlugins', 'permissions']

async function riskyKeys(
  dir: string,
  files: string[],
  resolveFile: (p: string) => Promise<{ real: string; size: number } | null>
): Promise<string[]> {
  const found = new Set<string>()
  for (const f of files) {
    const file = await resolveFile(join(dir, f))
    if (file === null || file.size > 256 * 1024) continue
    try {
      // Read through the already-resolved, containment-checked path (not the original path).
      const parsed: unknown = JSON.parse(await readFile(file.real, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        for (const key of RISKY_KEYS) if (key in parsed) found.add(key)
      }
    } catch {
      /* unreadable or invalid JSON: treat as no information */
    }
  }
  return RISKY_KEYS.filter((k) => found.has(k))
}
