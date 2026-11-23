/** Internal signals derived from raw SDK messages. The SDK union is large; we handle only what we need. */
export type TeamLeadSignal =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text_block_start' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool'; tool: string }
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
    if (raw['subtype'] === 'success' && raw['is_error'] !== true) {
      return [{ kind: 'success', text: typeof raw['result'] === 'string' ? raw['result'] : '' }]
    }
    const text = typeof raw['result'] === 'string' && raw['result'] ? raw['result'] : `Agent stopped: ${String(raw['subtype'] ?? 'error')}`
    return [{ kind: 'error', code: classifyError(text), message: text }]
  }

  return []
}
