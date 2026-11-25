import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { TokenTotals } from '@shared/schemas/usage'

const MAX_TRANSCRIPT_BYTES = 100 * 1024 * 1024
const SESSION_ID = /^[0-9a-f-]{36}$/i

export const emptyTotals = (): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
export const addTotals = (a: TokenTotals, b: TokenTotals): TokenTotals => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens
})

/** How Claude Code names a project's transcript folder: every character that is not a letter or digit becomes "-". */
export const transcriptDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/**
 * Token usage of one Claude Code session, read from its transcript. The transcript repeats a message once per
 * content block, so messages are counted once by id (the last record of an id wins). The format is Claude
 * Code's own and not documented as an interface: anything unexpected yields null or zeros, never a guess.
 */
export async function readTranscriptUsage(opts: { configDir: string; cwd: string; sessionId: string }): Promise<TokenTotals | null> {
  if (!SESSION_ID.test(opts.sessionId)) return null
  const file = join(opts.configDir, 'projects', transcriptDirName(opts.cwd), `${opts.sessionId}.jsonl`)
  try {
    const st = await lstat(file)
    if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) return null
  } catch {
    return null
  }
  const byMessage = new Map<string, TokenTotals>()
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue
      let rec: unknown
      try { rec = JSON.parse(line) } catch { continue }
      const m = (rec as { message?: { id?: unknown; usage?: Record<string, unknown> } } | null)?.message
      if (!m || typeof m.id !== 'string' || !m.usage || typeof m.usage !== 'object') continue
      byMessage.set(m.id, {
        inputTokens: num(m.usage['input_tokens']),
        outputTokens: num(m.usage['output_tokens']),
        cacheReadTokens: num(m.usage['cache_read_input_tokens']),
        cacheCreationTokens: num(m.usage['cache_creation_input_tokens'])
      })
    }
  } catch {
    return null
  }
  let total = emptyTotals()
  for (const t of byMessage.values()) total = addTotals(total, t)
  return total
}
