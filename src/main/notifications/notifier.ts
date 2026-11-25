import type { DecisionItem } from '@shared/schemas/task'
import type { AppEvent } from '@shared/schemas/team-lead'
import { log } from '../logging/logger'

const WATCHED: ReadonlySet<AppEvent['type']> = new Set(['proposals_changed', 'plans_changed', 'executions_changed', 'tasks_changed'])
const MAX_SHOWN = 3

const WHAT = { proposal: 'proposed tasks to review', plan: 'plan waiting for your approval', result: 'result waiting for your decision' } as const
const key = (d: DecisionItem) => `${d.kind}:${d.taskId ?? d.projectId}:${d.since}`

/**
 * Tells you when something starts waiting for a decision from you (the same list as "Waiting for you"),
 * but only while no Orbyte window is focused. It reads state and shows a message: it never approves,
 * accepts or starts anything, and a notification carries no action other than bringing the window forward.
 */
export class Notifier {
  private known: Set<string>

  constructor(
    private readonly deps: {
      list: () => DecisionItem[]
      isFocused: () => boolean
      show: (title: string, body: string) => void
    }
  ) {
    // What is already waiting at startup is not news.
    this.known = new Set(this.safeList().map(key))
  }

  onEvent(event: AppEvent): void {
    if (WATCHED.has(event.type)) this.check()
  }

  check(): void {
    const items = this.safeList()
    const fresh = items.filter((d) => !this.known.has(key(d)))
    this.known = new Set(items.map(key))
    if (fresh.length === 0 || this.deps.isFocused()) return
    try {
      for (const d of fresh.slice(0, MAX_SHOWN)) this.deps.show(`${d.projectName}: ${WHAT[d.kind]}`, d.title)
      if (fresh.length > MAX_SHOWN) this.deps.show('Orbyte', `${fresh.length - MAX_SHOWN} more waiting for you`)
    } catch (err) {
      log.error('[notify] could not show a notification', err)
    }
  }

  private safeList(): DecisionItem[] {
    try { return this.deps.list() } catch (err) { log.error('[notify] could not read decisions', err); return [] }
  }
}
