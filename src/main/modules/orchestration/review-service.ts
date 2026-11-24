import { AppError } from '@shared/types/result'
import type { SubmitReviewInput, TaskPlan } from '@shared/schemas/plan'
import type { AppEvent } from '@shared/schemas/team-lead'
import { REVIEW_PROMPT } from '../agents/team-lead/prompt'
import type { TeamLeadService } from '../agents/team-lead/service'
import type { ProjectRepository } from '../projects/repository'
import type { TaskRepository } from '../tasks/repository'
import { renderPlan } from './plan-hash'
import type { PlanRepository } from './plan-repository'

const REVIEW_MAX_TURNS = 12

/**
 * Team Lead review of a submitted plan. It produces ADVICE only: a stored recommendation with reasons.
 * Nothing here creates, changes or satisfies an approval.
 */
export class ReviewService {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly deps: {
      projects: Pick<ProjectRepository, 'get'>
      taskRepo: Pick<TaskRepository, 'get'>
      plans: PlanRepository
      teamLead: Pick<TeamLeadService, 'runTurn' | 'isActive'>
      emit: (event: AppEvent) => void
      /** How long to wait for the Team Lead to be free (it handles one turn per project). */
      retryMs?: number
      maxWaits?: number
    }
  ) {}

  isInProgress(planId: string): boolean {
    return this.inFlight.has(planId)
  }

  /** Called when a plan is stored. A failure here must never affect the plan itself. */
  reviewAutomatically(plan: TaskPlan): void {
    try {
      if (this.deps.plans.listReviews(plan.taskId).some((r) => r.planId === plan.id)) return
      this.request(plan.projectId, plan.taskId, plan.id)
    } catch (err) {
      console.error('[reviews] automatic review not started', err instanceof AppError ? err.message : err)
    }
  }

  /** Starts a review in the background (validated now, run when the Team Lead is free). */
  request(projectId: string, taskId: string, planId: string): void {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new AppError('NOT_FOUND', 'Project not found.')
    if (project.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    if (project.repoSettingsTrust === 'unset') throw new AppError('TRUST_REQUIRED', "Decide whether to use this repository's Claude settings first.")
    const task = this.deps.taskRepo.get(taskId)
    const plan = this.deps.plans.getPlan(planId)
    if (!task || task.projectId !== projectId || !plan || plan.taskId !== taskId || plan.projectId !== projectId) throw new AppError('NOT_FOUND', 'Plan not found.')
    if (plan.status !== 'current') throw new AppError('STALE_PLAN', 'A newer version of this plan exists.')
    if (this.inFlight.has(planId)) throw new AppError('ALREADY_RUNNING', 'This plan is already being reviewed.')
    this.inFlight.add(planId)
    this.notify(projectId, taskId)
    void this.run(plan, task.title, task.description).catch((err) => console.error('[reviews] unexpected failure', err))
  }

  private async run(plan: TaskPlan, title: string, description: string): Promise<void> {
    try {
      // The Team Lead handles one turn at a time per project (a chat turn may be running).
      const wait = this.deps.retryMs ?? 3000
      for (let i = 0; this.deps.teamLead.isActive(plan.projectId); i++) {
        if (i >= (this.deps.maxWaits ?? 40)) {
          console.error('[reviews] the Team Lead stayed busy; review skipped')
          return
        }
        await new Promise((r) => setTimeout(r, wait))
      }
      // Re-check now: the plan may have been replaced while waiting, and a review of it would be wasted.
      if (this.deps.plans.latestPlan(plan.taskId)?.id !== plan.id) return
      const outcome = await this.deps.teamLead.runTurn({
        projectId: plan.projectId,
        prompt: REVIEW_PROMPT({ title, description }, renderPlan(plan.content), plan.version),
        purpose: 'review',
        saveToChat: false,
        maxTurns: REVIEW_MAX_TURNS,
        // The plan this turn may record a review for is fixed here, on the server.
        reviewTools: { submitReview: (input) => this.record(plan, input) }
      })
      if (!outcome.ok) console.error(`[reviews] review of plan ${plan.id} did not complete: ${outcome.code}`)
    } finally {
      this.inFlight.delete(plan.id)
      this.notify(plan.projectId, plan.taskId)
    }
  }

  private record(plan: TaskPlan, input: SubmitReviewInput): void {
    // A review of a plan that has since been replaced is discarded, not attached to the new one.
    if (this.deps.plans.latestPlan(plan.taskId)?.id !== plan.id) throw new AppError('STALE_PLAN', 'This plan has been replaced; your review was discarded.')
    this.deps.plans.addReview({ projectId: plan.projectId, taskId: plan.taskId, plan, recommendation: input.recommendation, summary: input.summary, concerns: input.concerns })
    this.notify(plan.projectId, plan.taskId)
  }

  private notify(projectId: string, taskId: string): void {
    try {
      this.deps.emit({ type: 'plans_changed', projectId, taskId })
    } catch (err) {
      console.error('[reviews] failed to emit event', err)
    }
  }
}
