import type { TaskPriority } from '@shared/schemas/task'
import type { TaskStatus } from '@shared/task-state'

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', planning: 'Planning', awaiting_approval: 'Awaiting approval', in_progress: 'In progress',
  in_review: 'In review', blocked: 'Blocked', completed: 'Completed', cancelled: 'Cancelled'
}
/** Display order: active work first, closed work last. */
export const STATUS_ORDER: TaskStatus[] = ['in_progress', 'in_review', 'awaiting_approval', 'planning', 'ready', 'blocked', 'backlog', 'completed', 'cancelled']
export const PRIORITY_LABEL: Record<TaskPriority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' }

export function moveLabel(from: TaskStatus, to: TaskStatus): string {
  if (from === 'cancelled' && to === 'backlog') return 'Reopen'
  return ({ ready: 'Mark ready', backlog: 'Move to backlog', blocked: 'Mark blocked', cancelled: 'Cancel' } as Partial<Record<TaskStatus, string>>)[to] ?? STATUS_LABEL[to]
}

export function describeEvent(type: string, payload: Record<string, unknown>): string {
  const s = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : '')
  switch (type) {
    case 'project.registered': return 'Project registered'
    case 'project.archived': return 'Project archived'
    case 'project.restored': return 'Project restored'
    case 'project.trust_changed': return `Repository settings ${s('trust') === 'trusted' ? 'trusted' : 'not used'}`
    case 'onboarding.started': return 'Onboarding started'
    case 'onboarding.completed': return 'Onboarding completed'
    case 'onboarding.failed': return 'Onboarding failed'
    case 'onboarding.interrupted': return 'Onboarding interrupted'
    case 'teamlead.session_started': return 'Team Lead session started'
    case 'task.created': return `Task created${s('source') === 'team_lead' ? ' (from Team Lead proposal)' : ''}: ${s('title')}`
    case 'task.updated': return 'Task edited'
    case 'task.transitioned': return `Task moved ${s('from').replace('_', ' ')} → ${s('to').replace('_', ' ')}`
    case 'proposal.recorded': return `Team Lead proposed ${String(payload['count'] ?? '')} task(s)`
    case 'proposal.approved': return 'Task proposal approved'
    case 'proposal.dismissed': return 'Task proposal dismissed'
    case 'plan.submitted': return 'Agent submitted a plan'
    case 'plan.approved': return 'You approved a plan'
    case 'plan.rejected': return 'You rejected a plan'
    case 'execution.authorized': return 'Execution authorized by your approval'
    case 'execution.started': return 'Execution started'
    case 'execution.ended': return 'Execution ended'
    case 'execution.revision_authorized': return 'Revision authorized by your change request'
    case 'result.submitted': return 'Agent submitted a result'
    case 'result.reviewed': return 'Team Lead reviewed the result'
    case 'result.accepted': return 'You accepted the result'
    case 'result.changes_requested': return 'You requested changes'
    case 'acceptance.invalidated': return 'Acceptance no longer valid'
    default: return type
  }
}
