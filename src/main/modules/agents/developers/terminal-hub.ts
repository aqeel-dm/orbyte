import type { TerminalEvent } from '@shared/schemas/agent'

/**
 * Tracks which windows are attached to which agent's terminal. Output is delivered ONLY to
 * attached windows, so a window never receives terminals it did not ask for.
 */
export class TerminalHub {
  private readonly subs = new Map<string, Set<number>>()

  constructor(private readonly send: (windowId: number, event: TerminalEvent) => void) {}

  attach(agentId: string, windowId: number): void {
    const set = this.subs.get(agentId) ?? new Set<number>()
    set.add(windowId)
    this.subs.set(agentId, set)
  }

  detach(agentId: string, windowId: number): void {
    const set = this.subs.get(agentId)
    set?.delete(windowId)
    if (set?.size === 0) this.subs.delete(agentId)
  }

  detachAll(windowId: number): void {
    for (const [agentId, set] of this.subs) {
      set.delete(windowId)
      if (set.size === 0) this.subs.delete(agentId)
    }
  }

  /** Drops every subscription for an agent (when its process has ended). */
  clear(agentId: string): void {
    this.subs.delete(agentId)
  }

  isAttached(agentId: string, windowId: number): boolean {
    return this.subs.get(agentId)?.has(windowId) ?? false
  }

  publish(agentId: string, data: string): void {
    for (const windowId of this.subs.get(agentId) ?? []) {
      try {
        this.send(windowId, { agentId, data })
      } catch (err) {
        console.error('[terminal] failed to deliver output', err)
      }
    }
  }
}
