import { AppError } from '@shared/types/result'
import type { DeveloperAgent } from '@shared/schemas/agent'
import type { ExecutionResult, ExecutionRun, SubmittedResult } from '@shared/schemas/execution'
import type { AppEvent } from '@shared/schemas/team-lead'
import { renderPlan } from '@shared/plan-text'
import { toPublicAgent, type AgentRecord, type AgentRepository } from '../agents/developers/agent-repository'
import type { AgentService } from '../agents/developers/agent-service'
import type { GitWorktrees } from '../agents/developers/worktrees'
import type { ProjectRepository } from '../projects/repository'
import type { TaskRepository } from '../tasks/repository'
import type { TaskService } from '../tasks/service'
import type { ApprovalService } from './approval-service'
import type { ExecutionRepository } from './execution-repository'
import type { PlanRepository } from './plan-repository'

/**
 * Runs approved plans. Starting goes through the gate (`ApprovalService.authorizeExecution`), which
 * re-verifies the stored approval and spends it. The agent's own reports (progress, result) are recorded
 * as claims; what Orbyte trusts is what it collects itself: the run lifecycle and the git evidence.
 */
export class ExecutionService {
  private readonly starting = new Set<string>()

  constructor(
    private readonly deps: {
      projects: Pick<ProjectRepository, 'get'>
      taskRepo: TaskRepository
      tasks: Pick<TaskService, 'transitionSystem'>
      agents: Pick<AgentRepository, 'get' | 'activeForTask'>
      agentService: Pick<AgentService, 'stopAndWait' | 'startExecution' | 'stopAgentById'>
      approvals: Pick<ApprovalService, 'verify' | 'authorizeExecution' | 'authorizeRevision'>
      plans: Pick<PlanRepository, 'getPlan'>
      exec: ExecutionRepository
      worktrees: Pick<GitWorktrees, 'snapshot'>
      emit: (event: AppEvent) => void
      /** Called after a result is stored (the Team Lead reviews it automatically). */
      onResultSubmitted?: (result: ExecutionResult) => void
    }
  ) {}

  /** Starts execution of the task's approved plan. Refused unless the gate verifies a valid approval. */
  async start(projectId: string, taskId: string): Promise<DeveloperAgent> {
    if (this.starting.has(taskId)) throw new AppError('AGENT_ALREADY_RUNNING', 'Execution is already starting for this task.')
    this.starting.add(taskId)
    try {
      const verdict = this.deps.approvals.verify(projectId, taskId)
      if (!verdict.ok) throw new AppError('EXECUTION_NOT_AUTHORIZED', verdict.blockers.join(' '))
      const planner = this.deps.agents.get(verdict.plan.agentId)
      if (!planner) throw new AppError('NOT_FOUND', 'The planning agent no longer exists.')

      // Two agents must never work in one worktree at once: the planning agent (it waits after submitting) stops first.
      const live = this.deps.agents.activeForTask(taskId)
      if (live && !(await this.deps.agentService.stopAndWait(live.id))) {
        throw new AppError('AGENT_RUNNING', 'The planning agent did not stop. Stop it and try again.')
      }

      // The gate: re-verifies everything, spends the approval, and moves the task into execution.
      const approval = this.deps.approvals.authorizeExecution(projectId, taskId)
      // Launch exactly the plan the spent approval was for, not the one read before waiting for the planner to stop.
      const approved = this.deps.plans.getPlan(approval.planId)
      if (!approved || approved.id !== verdict.plan.id || approved.contentHash !== approval.planHash) {
        this.backToGate(projectId, taskId, 'failed')
        throw new AppError('EXECUTION_NOT_AUTHORIZED', 'The plan changed while execution was starting. Review and approve it again.')
      }
      this.deps.taskRepo.setExecutionState(taskId, { executionStatus: 'running' })
      let run: ExecutionRun | undefined
      try {
        const record = await this.deps.agentService.startExecution({
          basedOn: planner,
          planText: renderPlan(verdict.plan.content),
          planVersion: verdict.plan.version,
          feedback: null,
          beforeSpawn: (agent) => {
            run = this.deps.exec.createRun({ projectId, taskId, agentId: agent.id, planId: verdict.plan.id, planVersion: verdict.plan.version, planHash: verdict.plan.contentHash, approvalId: approval.id, feedback: null })
          }
        })
        this.changed(projectId, taskId)
        return toPublicAgent(record)
      } catch (err) {
        // The approval is already spent, so a failed launch fails closed: back to the gate for a fresh decision.
        if (run) this.deps.exec.finishRun(run.id, 'failed')
        this.backToGate(projectId, taskId, 'failed')
        throw err
      }
    } finally {
      this.starting.delete(taskId)
    }
  }

  /**
   * Sends the task back to an execution agent with the user's feedback. The user's recorded request is the
   * authorization (`authorizeRevision` spends it); a request authorizes exactly one revision run.
   */
  async requestChanges(projectId: string, taskId: string, resultId: string, feedback: string): Promise<DeveloperAgent> {
    const task = this.requireTask(projectId, taskId)
    if (this.deps.projects.get(projectId)?.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    if (task.status !== 'in_review') throw new AppError('NOT_IN_REVIEW', 'This task is not waiting for a review decision.')
    const result = this.deps.exec.getResult(resultId)
    if (!result || result.taskId !== taskId || result.projectId !== projectId) throw new AppError('NOT_FOUND', 'Result not found.')
    if (result.status !== 'current' || this.deps.exec.latestResult(taskId)?.id !== result.id) throw new AppError('STALE_RESULT', 'A newer result exists. Review that one instead.')
    if (this.starting.has(taskId)) throw new AppError('AGENT_ALREADY_RUNNING', 'Execution is already starting for this task.')
    const lastRun = this.deps.exec.listRuns(taskId)[0]
    const previous = lastRun && this.deps.agents.get(lastRun.agentId)
    const plan = lastRun && this.deps.plans.getPlan(lastRun.planId)
    if (!lastRun || !previous || !plan) throw new AppError('NOT_FOUND', 'The earlier run could not be found.')

    this.starting.add(taskId)
    try {
      // Record the user's request, then spend it to move the task back into execution.
      this.deps.exec.runInTransaction((tx) => this.deps.exec.addDecision({ result, decision: 'changes_requested', feedback }, tx))
      this.deps.approvals.authorizeRevision(projectId, taskId)
      this.deps.taskRepo.setExecutionState(taskId, { executionStatus: 'running' })
      let run: ExecutionRun | undefined
      try {
        const record = await this.deps.agentService.startExecution({
          basedOn: previous,
          planText: renderPlan(plan.content),
          planVersion: plan.version,
          feedback,
          beforeSpawn: (agent) => {
            run = this.deps.exec.createRun({ projectId, taskId, agentId: agent.id, planId: plan.id, planVersion: plan.version, planHash: plan.contentHash, approvalId: null, feedback })
          }
        })
        this.changed(projectId, taskId)
        return toPublicAgent(record)
      } catch (err) {
        if (run) this.deps.exec.finishRun(run.id, 'failed')
        // The result is still there: the task returns to review so the user can try again.
        try {
          this.deps.tasks.transitionSystem(projectId, taskId, 'in_review')
        } catch (inner) {
          console.error('[execution] could not return the task to review', inner)
        }
        this.deps.taskRepo.setExecutionState(taskId, { executionStatus: 'succeeded' })
        this.changed(projectId, taskId)
        throw err
      }
    } finally {
      this.starting.delete(taskId)
    }
  }

  /** Progress notes from the agent. Recorded as the agent's own words, capped per run. */
  onProgress(agentId: string, messages: string[]): void {
    const run = this.deps.exec.runForAgent(agentId)
    if (!run || run.status !== 'running') return
    for (const message of messages) if (!this.deps.exec.addProgress(run.id, message)) break
    this.changed(run.projectId, run.taskId)
  }

  /**
   * The agent says it is finished. Orbyte records the claim, collects its own evidence from git, moves the
   * task to review and freezes the work by stopping the agent. A result is never taken as proof of success.
   */
  async onResult(agentId: string, submitted: SubmittedResult): Promise<void> {
    const run = this.deps.exec.runForAgent(agentId)
    const agent = this.deps.agents.get(agentId)
    if (!run || run.status !== 'running' || !agent || agent.kind !== 'execution') return
    if (this.deps.taskRepo.get(run.taskId)?.status !== 'in_progress') return

    let evidence
    try {
      evidence = await this.deps.worktrees.snapshot(agent.worktreePath, agent.baseCommit)
    } catch (err) {
      // Fail closed and visibly: no result was recorded, so the run fails and the task returns to the approval gate.
      console.error('[execution] could not collect evidence for a result; the run failed', err)
      if (this.deps.exec.getRun(run.id)?.status === 'running') {
        this.deps.exec.finishRun(run.id, 'failed')
        this.deps.agentService.stopAgentById(agentId)
        this.backToGate(run.projectId, run.taskId, 'failed')
      }
      return
    }
    // The world may have moved while git was working: re-check before writing.
    const current = this.deps.exec.getRun(run.id)
    if (!current || current.status !== 'running' || this.deps.taskRepo.get(run.taskId)?.status !== 'in_progress') return

    const { result } = this.deps.exec.createResult({ run, summary: submitted.summary, tests: submitted.tests, evidence })
    this.deps.exec.finishRun(run.id, 'result_submitted')
    this.deps.taskRepo.setExecutionState(run.taskId, { executionStatus: 'succeeded' })
    try {
      this.deps.tasks.transitionSystem(run.projectId, run.taskId, 'in_review')
    } catch (err) {
      console.error('[execution] could not move the task to review', err)
      this.backToGate(run.projectId, run.taskId, 'failed')
    }
    this.deps.agentService.stopAgentById(agentId) // freeze the work so what is reviewed is what stays
    this.changed(run.projectId, run.taskId)
    try {
      this.deps.onResultSubmitted?.(result)
    } catch (err) {
      console.error('[execution] result callback failed', err)
    }
  }

  /** An execution agent's process ended (its inbox was already drained, so any result is recorded). */
  onAgentEnded(agent: AgentRecord, status: AgentRecord['status']): void {
    const run = this.deps.exec.runForAgent(agent.id)
    if (!run || run.status !== 'running') return // a result was captured: the task is in review
    const ended = status === 'failed' ? 'failed' : status === 'exited' ? 'ended_without_result' : 'stopped'
    this.deps.exec.finishRun(run.id, ended)
    this.backToGate(run.projectId, run.taskId, ended === 'failed' ? 'failed' : 'interrupted')
  }

  /** After a restart no process survived: any run still marked running ended without a result. */
  recoverInterrupted(): void {
    for (const run of this.deps.exec.listRunning()) {
      this.deps.exec.finishRun(run.id, 'stopped')
      this.backToGate(run.projectId, run.taskId, 'interrupted')
    }
  }

  /**
   * The execution ended without a result: the task returns to the approval gate for the same plan (a new
   * approval is needed), unless the user already moved it elsewhere (cancelled, blocked).
   */
  private backToGate(projectId: string, taskId: string, executionStatus: 'failed' | 'interrupted'): void {
    const task = this.deps.taskRepo.get(taskId)
    if (task?.status === 'in_progress') {
      try {
        this.deps.tasks.transitionSystem(projectId, taskId, 'awaiting_approval')
        this.deps.taskRepo.setPlanState(taskId, { approvalStatus: 'pending' })
      } catch (err) {
        console.error('[execution] could not return the task to the approval gate', err)
      }
    }
    if (task) this.deps.taskRepo.setExecutionState(taskId, { executionStatus })
    this.changed(projectId, taskId)
  }

  private requireTask(projectId: string, taskId: string) {
    if (!this.deps.projects.get(projectId)) throw new AppError('NOT_FOUND', 'Project not found.')
    const task = this.deps.taskRepo.get(taskId)
    if (!task || task.projectId !== projectId) throw new AppError('NOT_FOUND', 'Task not found.')
    return task
  }

  private changed(projectId: string, taskId: string): void {
    try {
      this.deps.emit({ type: 'executions_changed', projectId, taskId })
      this.deps.emit({ type: 'tasks_changed', projectId })
    } catch (err) {
      console.error('[execution] failed to emit event', err)
    }
  }
}
