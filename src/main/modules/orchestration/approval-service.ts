import { randomUUID } from 'node:crypto'
import { AppError } from '@shared/types/result'
import type { GateState, PlanApproval, PlanBundle, TaskPlan } from '@shared/schemas/plan'
import type { AppEvent } from '@shared/schemas/team-lead'
import type { Task } from '@shared/schemas/task'
import type { Db } from '../../database/client'
import { activityEvents } from '../../database/schema'
import type { AgentRepository } from '../agents/developers/agent-repository'
import type { ProjectRepository } from '../projects/repository'
import type { TaskRepository } from '../tasks/repository'
import type { TaskService } from '../tasks/service'
import { planHash } from './plan-hash'
import type { PlanRepository } from './plan-repository'

export type Verdict = { ok: true; approval: PlanApproval; plan: TaskPlan } | { ok: false; blockers: string[] }

/**
 * Plan decisions and the execution gate.
 *
 * The user's approval creates a stored record (task, agent, plan version, reviewer, status, time).
 * `verify` checks that record against the current plan and the task's state, and `authorizeExecution`
 * is the ONLY place in the application that passes `approvalVerified: true` to the task state machine.
 * Nothing the Team Lead or an agent says can create or substitute for that record.
 */
export class ApprovalService {
  constructor(
    private readonly deps: {
      db: Db
      projects: Pick<ProjectRepository, 'get'>
      taskRepo: TaskRepository
      tasks: Pick<TaskService, 'transitionSystem'>
      agents: Pick<AgentRepository, 'activeForTask' | 'get'>
      plans: PlanRepository
      emit: (event: AppEvent) => void
      reviewInProgress?: (planId: string) => boolean
    }
  ) {}

  /** Everything the UI needs about a task's plans, with the gate's current verdict. */
  bundle(projectId: string, taskId: string): PlanBundle & { reviewInProgress: boolean } {
    const task = this.requireTask(projectId, taskId)
    const plans = this.deps.plans.listPlans(taskId)
    const approvals = this.deps.plans.listApprovals(taskId)
    const current = plans[0]
    return {
      plans,
      reviews: this.deps.plans.listReviews(taskId),
      approvals,
      gate: this.gateState(task, plans, approvals),
      reviewInProgress: current ? (this.deps.reviewInProgress?.(current.id) ?? false) : false
    }
  }

  /** Records the user's approval of the CURRENT plan version. */
  approve(projectId: string, taskId: string, planId: string): PlanApproval {
    const task = this.requireActiveTask(projectId, taskId)
    const plan = this.requireCurrentPlan(task, planId)
    if (task.status !== 'awaiting_approval') throw new AppError('NOT_AWAITING_APPROVAL', 'This task is not waiting for a plan decision.')
    if (planHash(plan.content) !== plan.contentHash) throw new AppError('PLAN_TAMPERED', 'The stored plan does not match its recorded hash.')
    const blockers = this.incompleteDependencies(task)
    if (blockers.length > 0) throw new AppError('DEPENDENCIES_INCOMPLETE', `Finish these tasks first: ${blockers.join(', ')}.`)
    if (this.deps.plans.validApproval(task.id)) throw new AppError('ALREADY_APPROVED', 'This task already has a valid approval.')

    const approval = this.deps.plans.runInTransaction((tx) => {
      const a = this.deps.plans.addApproval({ plan, status: 'approved', reason: '' }, tx)
      this.deps.taskRepo.setPlanState(task.id, { approvalStatus: 'approved' }, tx)
      return a
    })
    this.changed(projectId, taskId)
    return approval
  }

  /** The user rejects the current plan. The task goes back to planning (or Ready if no agent is alive). */
  reject(projectId: string, taskId: string, planId: string, reason: string): PlanApproval {
    const task = this.requireActiveTask(projectId, taskId)
    const plan = this.requireCurrentPlan(task, planId)
    if (task.status !== 'awaiting_approval') throw new AppError('NOT_AWAITING_APPROVAL', 'This task is not waiting for a plan decision.')
    const approval = this.deps.plans.runInTransaction((tx) => {
      this.deps.plans.invalidate(task.id, 'Rejected by user', tx)
      const a = this.deps.plans.addApproval({ plan, status: 'rejected', reason }, tx)
      this.deps.taskRepo.setPlanState(task.id, { approvalStatus: 'rejected' }, tx)
      return a
    })
    try {
      this.deps.tasks.transitionSystem(projectId, taskId, 'planning')
      // With no live agent to revise the plan, return the task so a new agent can be started.
      if (!this.deps.agents.activeForTask(taskId)) this.deps.tasks.transitionSystem(projectId, taskId, 'ready')
    } catch (err) {
      console.error('[approvals] could not move the task after a rejection', err)
    }
    this.changed(projectId, taskId)
    return approval
  }

  /** Withdraws a standing approval before execution starts. */
  revoke(projectId: string, taskId: string): PlanBundle & { reviewInProgress: boolean } {
    const task = this.requireActiveTask(projectId, taskId)
    // Once execution has begun an approval is spent, not something to withdraw.
    if (task.status !== 'awaiting_approval') throw new AppError('NOT_AWAITING_APPROVAL', 'This task is not waiting for a plan decision.')
    const changed = this.deps.plans.runInTransaction((tx) => {
      const n = this.deps.plans.invalidate(task.id, 'Revoked by user', tx)
      if (n > 0) this.deps.taskRepo.setPlanState(task.id, { approvalStatus: 'pending' }, tx)
      return n
    })
    if (changed === 0) throw new AppError('NOT_FOUND', 'There is no standing approval to revoke.')
    this.changed(projectId, taskId)
    return this.bundle(projectId, taskId)
  }

  /** The gate: is execution of this task authorized right now? Re-checks everything, trusts nothing cached. */
  verify(projectId: string, taskId: string): Verdict {
    const project = this.deps.projects.get(projectId)
    const task = this.deps.taskRepo.get(taskId)
    if (!project || !task || task.projectId !== projectId) return { ok: false, blockers: ['Task not found.'] }
    const blockers: string[] = []
    if (project.status === 'archived') blockers.push('The project is archived.')
    if (task.status !== 'awaiting_approval') blockers.push(`The task is not awaiting approval (it is ${task.status.replace('_', ' ')}).`)

    const current = this.deps.plans.latestPlan(taskId)
    const approval = this.deps.plans.validApproval(taskId)
    if (!current) blockers.push('No plan has been submitted.')
    if (!approval) blockers.push('There is no valid approval for this task.')
    if (current && approval) {
      if (approval.reviewer !== 'user' || approval.status !== 'approved') blockers.push('The approval was not made by the user.')
      if (approval.planId !== current.id) blockers.push(`The approval is for plan version ${approval.planVersion}, but the current plan is version ${current.version}.`)
      if (current.status !== 'current') blockers.push('The plan has been superseded.')
      if (planHash(current.content) !== current.contentHash || approval.planHash !== current.contentHash) blockers.push('The plan changed after it was approved.')
    }
    // The plan must still belong to an agent of this task whose worktree is intact: that is where it would run.
    if (current) {
      const agent = this.deps.agents.get(current.agentId)
      if (!agent || agent.projectId !== projectId || agent.taskId !== taskId) blockers.push('The agent that produced this plan no longer exists.')
      else if (agent.worktreeRemoved) blockers.push("The agent's worktree has been removed.")
    }
    const missing = this.incompleteDependencies(task)
    if (missing.length > 0) blockers.push(`Dependencies are not completed: ${missing.join(', ')}.`)

    if (blockers.length > 0 || !current || !approval) return { ok: false, blockers }
    return { ok: true, approval, plan: current }
  }

  /**
   * Moves the task into execution, but only on a valid verdict. This is the only code that passes
   * `approvalVerified: true`. Phase 6 will call it and then launch the execution; it is not exposed
   * to the renderer, and today nothing launches an execution.
   */
  authorizeExecution(projectId: string, taskId: string): PlanApproval {
    const verdict = this.verify(projectId, taskId)
    if (!verdict.ok) throw new AppError('EXECUTION_NOT_AUTHORIZED', verdict.blockers.join(' '))
    // An approval authorizes ONE start. It is spent first, so a failure after this point fails closed
    // (the user must approve again) and a later return to Ready cannot reuse it.
    this.deps.plans.runInTransaction((tx) => this.deps.plans.invalidate(taskId, 'Consumed: execution was authorized', tx))
    this.deps.tasks.transitionSystem(projectId, taskId, 'in_progress', { approvalVerified: true })
    this.deps.db.insert(activityEvents).values({
      id: randomUUID(), projectId, type: 'execution.authorized',
      payload: { taskId, approvalId: verdict.approval.id, planVersion: verdict.plan.version, planHash: verdict.plan.contentHash }
    }).run()
    this.changed(projectId, taskId)
    return verdict.approval
  }

  /**
   * The user moved the task out of active work (blocked, cancelled, back to Ready). A standing approval
   * must not survive that: a task that returns later needs a fresh decision.
   */
  onTaskLeft(taskId: string): void {
    const task = this.deps.taskRepo.get(taskId)
    if (!task) return
    const n = this.deps.plans.runInTransaction((tx) => {
      const count = this.deps.plans.invalidate(taskId, 'The task left awaiting approval', tx)
      if (count > 0) this.deps.taskRepo.setPlanState(taskId, { approvalStatus: 'none' }, tx)
      return count
    })
    if (n > 0) this.changed(task.projectId, taskId)
  }

  // ---------------------------------------------------------------- internals

  private gateState(task: Task, plans: TaskPlan[], approvals: PlanApproval[]): GateState {
    const current = plans[0]
    if (!current) return { state: 'no_plan', executionAuthorized: false, blockers: ['No plan has been submitted yet.'] }
    const valid = approvals.find((a) => a.status === 'approved' && a.invalidatedAt === null)
    if (valid) {
      const v = this.verify(task.projectId, task.id)
      return { state: 'approved', executionAuthorized: v.ok, blockers: v.ok ? [] : v.blockers }
    }
    const rejected = approvals.find((a) => a.status === 'rejected' && a.planId === current.id)
    if (rejected) return { state: 'rejected', executionAuthorized: false, blockers: [`Rejected: ${rejected.reason}`] }
    const blockers: string[] = []
    if (task.status !== 'awaiting_approval') blockers.push(`The task is ${task.status.replace('_', ' ')}, not awaiting approval.`)
    const missing = this.incompleteDependencies(task)
    if (missing.length > 0) blockers.push(`Dependencies are not completed: ${missing.join(', ')}.`)
    return { state: 'awaiting_decision', executionAuthorized: false, blockers }
  }

  private incompleteDependencies(task: Task): string[] {
    return task.dependsOnTaskIds.flatMap((id) => {
      const dep = this.deps.taskRepo.get(id)
      return dep && dep.status === 'completed' ? [] : [dep?.title ?? 'a missing task']
    })
  }

  private requireTask(projectId: string, taskId: string): Task {
    if (!this.deps.projects.get(projectId)) throw new AppError('NOT_FOUND', 'Project not found.')
    const task = this.deps.taskRepo.get(taskId)
    // Same error for "missing" and "belongs to another project".
    if (!task || task.projectId !== projectId) throw new AppError('NOT_FOUND', 'Task not found.')
    return task
  }

  private requireActiveTask(projectId: string, taskId: string): Task {
    const task = this.requireTask(projectId, taskId)
    if (this.deps.projects.get(projectId)?.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    return task
  }

  /** The plan must belong to the task AND be its current version: an older plan can never be decided. */
  private requireCurrentPlan(task: Task, planId: string): TaskPlan {
    const plan = this.deps.plans.getPlan(planId)
    if (!plan || plan.taskId !== task.id || plan.projectId !== task.projectId) throw new AppError('NOT_FOUND', 'Plan not found.')
    if (plan.status !== 'current' || this.deps.plans.latestPlan(task.id)?.id !== plan.id) {
      throw new AppError('STALE_PLAN', 'A newer version of this plan exists. Review that one instead.')
    }
    return plan
  }

  private changed(projectId: string, taskId: string): void {
    try {
      this.deps.emit({ type: 'plans_changed', projectId, taskId })
      this.deps.emit({ type: 'tasks_changed', projectId })
    } catch (err) {
      console.error('[approvals] failed to emit event', err)
    }
  }
}
