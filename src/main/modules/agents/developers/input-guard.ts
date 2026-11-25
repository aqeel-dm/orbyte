/**
 * Best-effort guard for Claude Code's `!` shell mode in a PLANNING agent's terminal.
 *
 * Claude Code switches its prompt into a shell when `!` is the first character of an empty input, and that
 * shell is not covered by the tool deny rules (tested), so a keystroke could run a command as you in a
 * session that is meant to be read-only. This guard tracks how much text is on the prompt line from the
 * keystrokes it has passed on, and refuses input that would put `!` at the start of it.
 *
 * It is NOT a security boundary: it only sees what comes through `agents:write`, the line state is inferred
 * (it cannot see what Claude Code's prompt really holds), and a person can still approve a Bash request the
 * model makes. It stops the accidental case and the cheap abuse of the write channel. See docs/SECURITY.md.
 */
export const SHELL_MODE_BLOCKED = 'Shell mode (starting a line with "!") is turned off in planning agents, which are meant to be read-only. Use the execution stage for commands.'

export class InputGuard {
  private chars = 0

  /** Returns false (and changes nothing) if `data` would put `!` at the start of an empty prompt line. */
  allow(data: string): boolean {
    let chars = this.chars
    let i = 0
    while (i < data.length) {
      const ch = data[i] as string
      if (ch === '\x1b') {
        // Escape sequences (arrow keys, bracketed-paste markers) do not add text. Skip a CSI sequence whole.
        if (data[i + 1] === '[') {
          let j = i + 2
          while (j < data.length && !/[\x40-\x7e]/.test(data[j] as string)) j++
          i = j + 1
        } else i += 2
        continue
      }
      if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') chars = 0
      else if (ch === '\x7f' || ch === '\b') chars = Math.max(0, chars - 1)
      else if (ch >= ' ') {
        if (ch === '!' && chars === 0) return false
        chars++
      }
      i++
    }
    this.chars = chars
    return true
  }
}
