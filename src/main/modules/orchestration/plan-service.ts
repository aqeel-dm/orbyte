import type { SubmittedPlan, TaskPlan } from '@shared/schemas/plan'
import type { AppEvent } from '@shared/schemas/team-lead'
import type { AgentRepository } from '../agents/developers/agent-repository'
import type { TaskRepository } from '../tasks/repository'
import type { TaskService } from '../tasks/service'
import { planHash, renderPlan } from './plan-hash'
import type { PlanRepository } from './plan-repository'

export type IngestResult =
  | { accepted: true; plan: TaskPlan; invalidatedApproval: boolean }
  | { accepted: false; reason: 'unknown_agent' | 'task_not_planning' | 'duplicate' | 'too_many_versions' }

/** A runaway agent cannot bury the user in versions (each one also invalidates their approval). */
export const MAX_PLAN_VERSIONS = 20

/**
 * Receives plans captured from developer agents. A plan is stored as a numbered, hashed version;
 * a changed plan supersedes the previous one and invalidates any approval of it. Ingesting a plan
 * never approves anything.
 */
export class PlanService {
  constructor(
    private readonly deps: {
      agents: Pick<AgentRepository, 'get'>
      taskRepo: TaskRepository
      tasks: Pick<TaskService, 'transitionSystem'>
      plans: PlanRepository
      emit: (event: AppEvent) => void
      /** Called after a new version is stored (the Team Lead reviews it automatically). */
      onPlanSubmitted?: (plan: TaskPlan) => void
    }
  ) {}

  ingest(agentId: string, content: SubmittedPlan): IngestResult {
    const agent = this.deps.agents.get(agentId)
    if (!agent) return { accepted: false, reason: 'unknown_agent' }
    const task = this.deps.taskRepo.get(agent.taskId)
    if (!task || task.projectId !== agent.projectId) return { accepted: false, reason: 'unknown_agent' }
    // Only a task that is being planned (or already waiting on a plan) can receive one.
    if (task.status !== 'planning' && task.status !== 'awaiting_approval') return { accepted: false, reason: 'task_not_planning' }

    if (this.deps.plans.listPlans(task.id).length >= MAX_PLAN_VERSIONS) {
      console.warn(`[plans] version limit reached for task ${task.id}; plan ignored`)
      return { accepted: false, reason: 'too_many_versions' }
    }
    const hash = planHash(content)
    // The same plan resubmitted while a decision is already pending adds nothing. But a task that is
    // back in planning is waiting for a plan (for example after a rejection), so it must be recorded.
    if (task.status === 'awaiting_approval' && this.deps.plans.latestPlan(task.id)?.contentHash === hash) return { accepted: false, reason: 'duplicate' }

    const { plan, invalidatedApproval } = this.deps.plans.createVersion({ projectId: task.projectId, taskId: task.id, agentId, content, hash })
    // A new version always needs a fresh decision, so the task's approval column goes back to pending.
    this.deps.taskRepo.setPlanState(task.id, { implementationPlan: renderPlan(content), approvalStatus: 'pending' })
    if (task.status === 'planning') {
      try {
        this.deps.tasks.transitionSystem(task.projectId, task.id, 'awaiting_approval')
      } catch (err) {
        console.error('[plans] could not move the task to awaiting approval', err)
      }
    }
    this.safe(() => this.deps.emit({ type: 'plans_changed', projectId: task.projectId, taskId: task.id }))
    this.safe(() => this.deps.onPlanSubmitted?.(plan))
    return { accepted: true, plan, invalidatedApproval }
  }

  private safe(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.error('[plans] callback failed', err)
    }
  }
}
