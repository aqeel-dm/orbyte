/**
 * Task status state machine. Pure and shared so the backend enforces it and the UI
 * only offers moves the backend will accept. Default-deny: anything not listed is refused.
 */
export const TASK_STATUSES = [
  'backlog',
  'ready',
  'planning',
  'awaiting_approval',
  'in_progress',
  'in_review',
  'blocked',
  'completed',
  'cancelled'
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Who is asking for the move. The renderer can only ever act as 'user'. */
export type TransitionActor = 'user' | 'orchestrator'

const U: TransitionActor[] = ['user']
const O: TransitionActor[] = ['orchestrator']
const UO: TransitionActor[] = ['user', 'orchestrator']

const TABLE: Record<TaskStatus, Partial<Record<TaskStatus, TransitionActor[]>>> = {
  backlog: { ready: U, cancelled: U },
  ready: { backlog: U, planning: O, blocked: UO, cancelled: U },
  planning: { awaiting_approval: O, ready: UO, blocked: UO, cancelled: U },
  awaiting_approval: { in_progress: O, planning: O, blocked: UO, cancelled: U },
  in_progress: { in_review: O, ready: O, blocked: UO, cancelled: U },
  in_review: { completed: O, in_progress: O, blocked: UO, cancelled: U },
  blocked: { backlog: U, ready: UO, cancelled: U },
  completed: {},
  cancelled: { backlog: U }
}

export interface TransitionContext {
  /**
   * Must be true to enter in_progress. Phase 5 will set it only after the
   * orchestrator verifies a stored approval record for the current plan version.
   * Until then nothing sets it, so execution cannot start.
   */
  approvalVerified?: boolean
}

export type TransitionCheck = { ok: true } | { ok: false; reason: string }

export function checkTransition(from: TaskStatus, to: TaskStatus, actor: TransitionActor, ctx: TransitionContext = {}): TransitionCheck {
  const actors = TABLE[from][to]
  if (!actors) return { ok: false, reason: `A task cannot move from ${from} to ${to}.` }
  if (!actors.includes(actor)) return { ok: false, reason: `Moving from ${from} to ${to} is not something you can do directly.` }
  if (to === 'in_progress' && ctx.approvalVerified !== true) {
    return { ok: false, reason: 'A task cannot start without a verified approval of its plan.' }
  }
  return { ok: true }
}

/** Moves the user may request from a status (what the UI offers). */
export function userTransitionsFrom(status: TaskStatus): TaskStatus[] {
  return TASK_STATUSES.filter((to) => checkTransition(status, to, 'user').ok)
}

/** Statuses whose title, description and dependencies the user may edit. */
export const CONTENT_EDITABLE: readonly TaskStatus[] = ['backlog', 'ready', 'blocked']
/** Statuses that no longer count as open work. */
export const CLOSED_STATUSES: readonly TaskStatus[] = ['completed', 'cancelled']
export const isOpen = (s: TaskStatus): boolean => !CLOSED_STATUSES.includes(s)
