import { AppError } from '@shared/types/result'
import type { ExecutionResult } from '@shared/schemas/execution'
import type { SubmitReviewInput } from '@shared/schemas/plan'
import type { AppEvent } from '@shared/schemas/team-lead'
import { renderPlan } from '@shared/plan-text'
import { RESULT_REVIEW_PROMPT } from '../agents/team-lead/prompt'
import type { TeamLeadService } from '../agents/team-lead/service'
import type { AgentRepository } from '../agents/developers/agent-repository'
import type { GitWorktrees } from '../agents/developers/worktrees'
import type { ProjectRepository } from '../projects/repository'
import type { TaskRepository } from '../tasks/repository'
import type { ExecutionRepository } from './execution-repository'
import type { PlanRepository } from './plan-repository'
import { log } from '../../logging/logger'

const REVIEW_MAX_TURNS = 12

/**
 * Team Lead review of an implementation result. ADVICE only: a stored recommendation with reasons. It cannot
 * accept, complete or change anything. The reviewer is shown the agent's claims labeled as claims, plus
 * what Orbyte collected itself and the actual diff, and may read the agent's worktree (read-only).
 */
export class ResultReviewService {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly deps: {
      projects: Pick<ProjectRepository, 'get'>
      taskRepo: Pick<TaskRepository, 'get'>
      exec: ExecutionRepository
      plans: Pick<PlanRepository, 'getPlan'>
      agents: Pick<AgentRepository, 'get'>
      worktrees: Pick<GitWorktrees, 'diffText' | 'snapshot'>
      teamLead: Pick<TeamLeadService, 'runTurn' | 'isActive'>
      emit: (event: AppEvent) => void
      retryMs?: number
      maxWaits?: number
    }
  ) {}

  isInProgress(resultId: string): boolean {
    return this.inFlight.has(resultId)
  }

  /** Called when a result is stored. A failure here must never affect the result itself. */
  reviewAutomatically(result: ExecutionResult): void {
    try {
      if (this.deps.exec.listReviews(result.taskId).some((r) => r.resultId === result.id)) return
      this.request(result.projectId, result.taskId, result.id)
    } catch (err) {
      log.error('[result-reviews] automatic review not started', err instanceof AppError ? err.message : err)
    }
  }

  request(projectId: string, taskId: string, resultId: string): void {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new AppError('NOT_FOUND', 'Project not found.')
    if (project.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    if (project.repoSettingsTrust === 'unset') throw new AppError('TRUST_REQUIRED', "Decide whether to use this repository's Claude settings first.")
    const task = this.deps.taskRepo.get(taskId)
    const result = this.deps.exec.getResult(resultId)
    if (!task || task.projectId !== projectId || !result || result.taskId !== taskId || result.projectId !== projectId) throw new AppError('NOT_FOUND', 'Result not found.')
    if (result.status !== 'current') throw new AppError('STALE_RESULT', 'A newer result exists.')
    if (this.inFlight.has(resultId)) throw new AppError('ALREADY_RUNNING', 'This result is already being reviewed.')
    this.inFlight.add(resultId)
    this.notify(projectId, taskId)
    void this.run(result, task.title, task.description).catch((err) => log.error('[result-reviews] unexpected failure', err))
  }

  private async run(result: ExecutionResult, title: string, description: string): Promise<void> {
    try {
      const wait = this.deps.retryMs ?? 3000
      for (let i = 0; this.deps.teamLead.isActive(result.projectId); i++) {
        if (i >= (this.deps.maxWaits ?? 40)) {
          log.error('[result-reviews] the Team Lead stayed busy; review skipped')
          return
        }
        await new Promise((r) => setTimeout(r, wait))
      }
      if (this.deps.exec.latestResult(result.taskId)?.id !== result.id) return // replaced while waiting
      const agent = this.deps.agents.get(result.agentId)
      const run = this.deps.exec.getRun(result.executionId)
      const plan = run && this.deps.plans.getPlan(run.planId)
      if (!agent || agent.worktreeRemoved || !plan) {
        log.error('[result-reviews] the worktree or plan is gone; review skipped')
        return
      }
      // A review is only worth having for the code that was submitted: if the worktree already differs from
      // the stored snapshot, do not review it (the result cannot be accepted in that state anyway).
      const now = await this.deps.worktrees.snapshot(agent.worktreePath, agent.baseCommit).catch(() => null)
      if (!now || now.snapshotHash !== result.evidence.snapshotHash) {
        log.error('[result-reviews] the worktree no longer matches the submitted result; review skipped')
        return
      }
      const diff = await this.deps.worktrees.diffText(agent.worktreePath, agent.baseCommit)
      const tests = result.tests.length ? result.tests.map((t) => `- ${t.command}: ${t.passed ? 'passed' : 'FAILED'}${t.note ? ` (${t.note})` : ''}`).join('\n') : '(none reported)'
      const e = result.evidence
      const evidence = [
        `HEAD ${e.headCommit}${e.uncommitted ? ' (there are uncommitted changes)' : ''}`,
        `Files changed (${e.files.length}${e.truncated ? ', list truncated' : ''}):`,
        ...e.files.map((f) => `- ${f.status} ${f.path}${f.additions === null ? '' : ` (+${f.additions} -${f.deletions})`}`),
        e.commits.length ? `Commits:\n${e.commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.subject}`).join('\n')}` : 'No commits on the branch.'
      ].join('\n')
      const outcome = await this.deps.teamLead.runTurn({
        projectId: result.projectId,
        prompt: RESULT_REVIEW_PROMPT({
          task: { title, description }, planText: renderPlan(plan.content), resultVersion: result.version,
          agentSummary: result.summary, agentTests: tests, evidence, diff: diff.truncated ? `${diff.text}\n[diff truncated]` : diff.text, worktreePath: agent.worktreePath
        }),
        purpose: 'review',
        saveToChat: false,
        maxTurns: REVIEW_MAX_TURNS,
        readDir: agent.worktreePath,
        // The result this turn may record a review for is fixed here, on the server.
        reviewTools: { submitReview: (input) => this.record(result, input) }
      })
      if (!outcome.ok) log.error(`[result-reviews] review of result ${result.id} did not complete: ${outcome.code}`)
    } finally {
      this.inFlight.delete(result.id)
      this.notify(result.projectId, result.taskId)
    }
  }

  private record(result: ExecutionResult, input: SubmitReviewInput): void {
    // A review of a result that has since been replaced is discarded, not attached to the new one.
    if (this.deps.exec.latestResult(result.taskId)?.id !== result.id) throw new AppError('STALE_RESULT', 'This result has been replaced; your review was discarded.')
    this.deps.exec.addReview({ result, recommendation: input.recommendation, summary: input.summary, concerns: input.concerns })
    this.notify(result.projectId, result.taskId)
  }

  private notify(projectId: string, taskId: string): void {
    try {
      this.deps.emit({ type: 'executions_changed', projectId, taskId })
    } catch (err) {
      log.error('[result-reviews] failed to emit event', err)
    }
  }
}
