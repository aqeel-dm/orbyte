import { AppError } from '@shared/types/result'
import type { CompletionGate, Evidence, ExecutionBundle, ExecutionResult, ResultChanges, ResultDecision } from '@shared/schemas/execution'
import type { AppEvent } from '@shared/schemas/team-lead'
import type { Task } from '@shared/schemas/task'
import type { AgentRepository } from '../agents/developers/agent-repository'
import type { GitWorktrees } from '../agents/developers/worktrees'
import type { ProjectRepository } from '../projects/repository'
import type { TaskRepository } from '../tasks/repository'
import type { TaskService } from '../tasks/service'
import type { ExecutionRepository } from './execution-repository'
import { log } from '../../logging/logger'

export type CompletionVerdict = { ok: true; decision: ResultDecision; result: ExecutionResult } | { ok: false; blockers: string[] }

/**
 * The completion gate. A task is Completed only when ALL of these hold at the moment of completion, re-read
 * from storage and from git rather than trusted: the task is in review, the result is the latest, the Team
 * Lead has reviewed it (advice), the user has a valid stored acceptance of it, and the code in the worktree
 * is exactly what was submitted and reviewed. This service is the only code that passes
 * `completionVerified: true` to the task state machine.
 */
export class CompletionService {
  constructor(
    private readonly deps: {
      projects: Pick<ProjectRepository, 'get'>
      taskRepo: TaskRepository
      tasks: Pick<TaskService, 'transitionSystem'>
      exec: ExecutionRepository
      agents: Pick<AgentRepository, 'get'>
      worktrees: Pick<GitWorktrees, 'snapshot' | 'changesText'>
      emit: (event: AppEvent) => void
      reviewInProgress?: (resultId: string) => boolean
    }
  ) {}

  private readonly freshCache = new Map<string, { at: number; promise: Promise<Evidence | null> }>()

  /** Everything the UI needs about a task's execution, with the gate's current view (including a fresh look at the code). */
  async bundle(projectId: string, taskId: string): Promise<ExecutionBundle> {
    const task = this.requireTask(projectId, taskId)
    const fresh = task.status === 'in_review' ? await this.cachedEvidence(taskId) : null
    const latest = this.deps.exec.latestResult(taskId)
    return {
      runs: this.deps.exec.listRuns(taskId),
      progress: this.deps.exec.listProgress(taskId),
      results: this.deps.exec.listResults(taskId),
      reviews: this.deps.exec.listReviews(taskId),
      decisions: this.deps.exec.listDecisions(taskId),
      gate: this.gate(task, fresh),
      reviewInProgress: latest ? (this.deps.reviewInProgress?.(latest.id) ?? false) : false
    }
  }

  /** The code changes of a result, for the person deciding. Read-only: shown only while the code is exactly what the result recorded. */
  async changes(projectId: string, taskId: string, resultId: string): Promise<ResultChanges> {
    this.requireTask(projectId, taskId)
    const result = this.deps.exec.getResult(resultId)
    if (!result || result.taskId !== taskId || result.projectId !== projectId) throw new AppError('NOT_FOUND', 'Result not found.')
    const agent = this.deps.agents.get(result.agentId)
    if (!agent || agent.worktreeRemoved) throw new AppError('WORKTREE_FAILED', "The agent's worktree is gone, so the changes can no longer be shown.")
    const fresh = await this.freshEvidence(taskId)
    if (!fresh) throw new AppError('WORKTREE_FAILED', "The agent's worktree could not be inspected.")
    if (fresh.snapshotHash !== result.evidence.snapshotHash) throw new AppError('CODE_CHANGED', 'The code changed after this result was submitted, so it no longer matches what was recorded.')
    const untracked = fresh.files.filter((f) => f.status === '?').map((f) => f.path)
    try {
      return await this.deps.worktrees.changesText(agent.worktreePath, agent.baseCommit, untracked)
    } catch {
      throw new AppError('WORKTREE_FAILED', "The agent's worktree could not be inspected.")
    }
  }

  /** The user accepts the CURRENT result. Completes the task only if the gate verifies everything. */
  async accept(projectId: string, taskId: string, resultId: string): Promise<ResultDecision> {
    this.requireActiveTask(projectId, taskId)
    const asked = this.deps.exec.getResult(resultId)
    if (!asked || asked.taskId !== taskId || asked.projectId !== projectId) throw new AppError('NOT_FOUND', 'Result not found.')
    const fresh = await this.freshEvidence(taskId) // the only await: everything below is synchronous

    const task = this.requireTask(projectId, taskId)
    if (task.status !== 'in_review') throw new AppError('NOT_IN_REVIEW', 'This task is not waiting for a review decision.')
    const latest = this.deps.exec.latestResult(taskId)
    if (!latest || latest.id !== asked.id || latest.status !== 'current') throw new AppError('STALE_RESULT', 'A newer result exists. Review that one instead.')
    if (!this.deps.exec.listReviews(taskId).some((r) => r.resultId === latest.id)) {
      throw new AppError('REVIEW_REQUIRED', 'The Team Lead has not reviewed this result yet. Ask for a review first.')
    }
    if (latest.evidence.truncated) throw new AppError('EVIDENCE_INCOMPLETE', 'The change is too large to verify completely, so it cannot be accepted. Ask for a smaller change.')
    if (!fresh) throw new AppError('WORKTREE_FAILED', "The agent's worktree could not be inspected, so the result cannot be accepted.")
    if (fresh.snapshotHash !== latest.evidence.snapshotHash) throw new AppError('CODE_CHANGED', 'The code changed after this result was submitted. Ask for a new result.')

    const existing = this.deps.exec.validAcceptance(taskId)
    const decision =
      existing && existing.resultId === latest.id
        ? existing
        : this.deps.exec.runInTransaction((tx) => this.deps.exec.addDecision({ result: latest, decision: 'accepted', feedback: '' }, tx))
    this.completeNow(projectId, taskId, fresh)
    return decision
  }

  /** Is this task completable right now? Looks at the code again. */
  async verify(projectId: string, taskId: string): Promise<CompletionVerdict> {
    const fresh = await this.freshEvidence(taskId)
    return this.verifyWith(projectId, taskId, fresh)
  }

  /** The user moved the task out of review (blocked, cancelled, back to Ready): a standing acceptance must not survive. */
  onTaskLeft(taskId: string): void {
    const task = this.deps.taskRepo.get(taskId)
    if (!task) return
    const n = this.deps.exec.runInTransaction((tx) => this.deps.exec.invalidateAcceptance(taskId, 'The task left review', tx))
    if (n > 0) this.changed(task.projectId, taskId)
  }

  // ---------------------------------------------------------------- internals

  /** Re-verifies synchronously against `fresh`, then completes. The ONLY place `completionVerified: true` is passed. */
  private completeNow(projectId: string, taskId: string, fresh: Evidence | null): void {
    const verdict = this.verifyWith(projectId, taskId, fresh)
    if (!verdict.ok) throw new AppError('COMPLETION_NOT_AUTHORIZED', verdict.blockers.join(' '))
    this.deps.tasks.transitionSystem(projectId, taskId, 'completed', { completionVerified: true })
    // The agent's own words, labeled as such, kept on the task for reference.
    this.deps.taskRepo.setExecutionState(taskId, { resultSummary: `Agent-reported: ${verdict.result.summary}` })
    this.changed(projectId, taskId)
  }

  private verifyWith(projectId: string, taskId: string, fresh: Evidence | null): CompletionVerdict {
    const project = this.deps.projects.get(projectId)
    const task = this.deps.taskRepo.get(taskId)
    if (!project || !task || task.projectId !== projectId) return { ok: false, blockers: ['Task not found.'] }
    const blockers: string[] = []
    if (project.status === 'archived') blockers.push('The project is archived.')
    if (task.status !== 'in_review') blockers.push(`The task is not in review (it is ${task.status.replace('_', ' ')}).`)
    const latest = this.deps.exec.latestResult(taskId)
    const acceptance = this.deps.exec.validAcceptance(taskId)
    if (!latest) blockers.push('No result has been submitted.')
    if (!acceptance) blockers.push('There is no valid acceptance from the user.')
    if (latest && acceptance) {
      if (acceptance.reviewer !== 'user' || acceptance.decision !== 'accepted') blockers.push('The acceptance was not made by the user.')
      if (acceptance.resultId !== latest.id) blockers.push(`The acceptance is for result version ${acceptance.resultVersion}, but the current result is version ${latest.version}.`)
      if (latest.status !== 'current') blockers.push('The result has been superseded.')
      if (acceptance.snapshotHash !== latest.evidence.snapshotHash) blockers.push('The accepted code differs from the submitted result.')
    }
    if (latest && !this.deps.exec.listReviews(taskId).some((r) => r.resultId === latest.id)) blockers.push('The Team Lead has not reviewed this result.')
    if (latest?.evidence.truncated) blockers.push('The change is too large to verify completely.')
    if (latest) {
      if (!fresh) blockers.push("The agent's worktree could not be inspected.")
      else if (fresh.snapshotHash !== latest.evidence.snapshotHash) blockers.push('The code changed after the result was submitted.')
    }
    if (blockers.length > 0 || !latest || !acceptance) return { ok: false, blockers }
    return { ok: true, decision: acceptance, result: latest }
  }

  private gate(task: Task, fresh: Evidence | null): CompletionGate {
    const latest = this.deps.exec.latestResult(task.id)
    if (!latest) return { state: 'no_result', canAccept: false, blockers: ['No result has been submitted yet.'], codeUnchanged: null }
    const codeUnchanged = fresh ? fresh.snapshotHash === latest.evidence.snapshotHash : null
    const valid = this.deps.exec.validAcceptance(task.id)
    if (valid && valid.resultId === latest.id) return { state: 'accepted', canAccept: false, blockers: [], codeUnchanged }
    const blockers: string[] = []
    if (task.status !== 'in_review') blockers.push(`The task is ${task.status.replace('_', ' ')}, not in review.`)
    if (!this.deps.exec.listReviews(task.id).some((r) => r.resultId === latest.id)) blockers.push('The Team Lead has not reviewed this result yet.')
    if (latest.evidence.truncated) blockers.push('The change is too large to verify completely.')
    if (task.status === 'in_review') {
      if (!fresh) blockers.push("The agent's worktree could not be inspected.")
      else if (codeUnchanged === false) blockers.push('The code changed after this result was submitted. A new result is needed.')
    }
    const asked = this.deps.exec.listDecisions(task.id).find((d) => d.resultId === latest.id && d.decision === 'changes_requested')
    if (asked && task.status === 'in_progress') return { state: 'changes_requested', canAccept: false, blockers, codeUnchanged }
    return { state: 'awaiting_decision', canAccept: blockers.length === 0, blockers, codeUnchanged }
  }

  /** Polling must not spawn a git run per call: share one result for a few seconds. `accept` never uses this. */
  private cachedEvidence(taskId: string): Promise<Evidence | null> {
    const hit = this.freshCache.get(taskId)
    if (hit && Date.now() - hit.at < 3000) return hit.promise
    const promise = this.freshEvidence(taskId)
    this.freshCache.set(taskId, { at: Date.now(), promise })
    return promise
  }

  private async freshEvidence(taskId: string): Promise<Evidence | null> {
    const latest = this.deps.exec.latestResult(taskId)
    if (!latest) return null
    const agent = this.deps.agents.get(latest.agentId)
    if (!agent || agent.worktreeRemoved) return null
    try {
      return await this.deps.worktrees.snapshot(agent.worktreePath, agent.baseCommit)
    } catch {
      return null
    }
  }

  private requireTask(projectId: string, taskId: string): Task {
    if (!this.deps.projects.get(projectId)) throw new AppError('NOT_FOUND', 'Project not found.')
    const task = this.deps.taskRepo.get(taskId)
    if (!task || task.projectId !== projectId) throw new AppError('NOT_FOUND', 'Task not found.')
    return task
  }

  private requireActiveTask(projectId: string, taskId: string): Task {
    const task = this.requireTask(projectId, taskId)
    if (this.deps.projects.get(projectId)?.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    return task
  }

  private changed(projectId: string, taskId: string): void {
    try {
      this.deps.emit({ type: 'executions_changed', projectId, taskId })
      this.deps.emit({ type: 'tasks_changed', projectId })
    } catch (err) {
      log.error('[completion] failed to emit event', err)
    }
  }
}
