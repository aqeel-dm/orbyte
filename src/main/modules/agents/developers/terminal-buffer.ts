/** Keeps the most recent terminal output so a window can attach later and see context. */
export class TerminalBuffer {
  // A list of chunks, so appending never copies the whole buffer; old chunks are dropped whole.
  private chunks: string[] = []
  private length = 0
  constructor(private readonly maxChars = 2_000_000) {}

  append(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
    this.length += chunk.length
    while (this.length > this.maxChars && this.chunks.length > 1) {
      this.length -= (this.chunks.shift() as string).length
    }
    // A single chunk larger than the limit is trimmed to its end.
    if (this.length > this.maxChars) {
      const only = (this.chunks[0] as string).slice(-this.maxChars)
      this.chunks = [only]
      this.length = only.length
    }
  }

  snapshot(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')]
    return this.chunks[0] ?? ''
  }

  tail(chars: number): string {
    return this.snapshot().slice(-chars)
  }
}

const OSC_TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** The most recent terminal title set by the program (OSC 0/2), sanitized, or null. */
export function lastTerminalTitle(chunk: string): string | null {
  let title: string | null = null
  for (const m of chunk.matchAll(OSC_TITLE)) title = m[1] ?? title
  if (title === null) return null
  // Also strips bidirectional overrides and zero-width characters, which can make text look like something else.
  const cleaned = title.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim().slice(0, 80)
  return cleaned || null
}
