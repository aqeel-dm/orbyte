/** Internal signals derived from raw SDK messages. The SDK union is large; we handle only what we need. */
export type TeamLeadSignal =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text_block_start' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool'; tool: string }
  | { kind: 'usage'; sessionId: string | null; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  | { kind: 'success'; text: string }
  | { kind: 'error'; code: string; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Best-effort classification. The SDK does not document error codes, so this matches message text. */
export function classifyError(message: string): string {
  if (/No conversation found with session ID/i.test(message)) return 'SESSION_NOT_FOUND'
  if (/not logged in|please run \/login|invalid api key|authentication|unauthorized|\b401\b|oauth/i.test(message)) return 'AUTH_REQUIRED'
  return 'AGENT_ERROR'
}

export function mapSdkMessage(raw: unknown): TeamLeadSignal[] {
  if (!isObj(raw) || typeof raw['type'] !== 'string') return []
  const type = raw['type']

  if (type === 'system' && raw['subtype'] === 'init' && typeof raw['session_id'] === 'string') {
    return [{ kind: 'session', sessionId: raw['session_id'] }]
  }

  if (type === 'stream_event' && isObj(raw['event'])) {
    const ev = raw['event']
    if (ev['type'] === 'content_block_start' && isObj(ev['content_block']) && ev['content_block']['type'] === 'text') {
      return [{ kind: 'text_block_start' }]
    }
    if (ev['type'] === 'content_block_delta' && isObj(ev['delta']) && ev['delta']['type'] === 'text_delta' && typeof ev['delta']['text'] === 'string') {
      return [{ kind: 'text_delta', text: ev['delta']['text'] }]
    }
    return []
  }

  if (type === 'assistant' && isObj(raw['message']) && Array.isArray(raw['message']['content'])) {
    const out: TeamLeadSignal[] = []
    for (const block of raw['message']['content']) {
      if (!isObj(block)) continue
      if (block['type'] === 'tool_use' && typeof block['name'] === 'string') out.push({ kind: 'tool', tool: block['name'] })
      if (block['type'] === 'text' && typeof block['text'] === 'string') out.push({ kind: 'assistant_text', text: block['text'] })
    }
    return out
  }

  if (type === 'result') {
    const usage = usageSignal(raw)
    const outcome = resultOutcome(raw)
    return usage ? [usage, ...outcome] : outcome
  }

  return []
}

const nn = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** Token and cost totals from a result message: the per-model totals, which include sub-agents and helper calls. */
function usageSignal(raw: Record<string, unknown>): TeamLeadSignal | null {
  const models = raw['modelUsage']
  if (!isObj(models) && typeof raw['total_cost_usd'] !== 'number') return null
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0
  if (isObj(models)) {
    for (const m of Object.values(models)) {
      if (!isObj(m)) continue
      inputTokens += nn(m['inputTokens']); outputTokens += nn(m['outputTokens'])
      cacheReadTokens += nn(m['cacheReadInputTokens']); cacheCreationTokens += nn(m['cacheCreationInputTokens'])
    }
  }
  return { kind: 'usage', sessionId: typeof raw['session_id'] === 'string' ? raw['session_id'] : null, costUsd: nn(raw['total_cost_usd']), inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
}

function resultOutcome(raw: Record<string, unknown>): TeamLeadSignal[] {
  if (raw['subtype'] === 'success' && raw['is_error'] !== true) {
    return [{ kind: 'success', text: typeof raw['result'] === 'string' ? raw['result'] : '' }]
  }
  const text = typeof raw['result'] === 'string' && raw['result'] ? raw['result'] : `Agent stopped: ${String(raw['subtype'] ?? 'error')}`
  return [{ kind: 'error', code: classifyError(text), message: text }]
}
