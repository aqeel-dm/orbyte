import { IPC } from '@shared/constants/ipc'
import { approvePlanInputSchema, planTaskInputSchema, rejectPlanInputSchema, requestReviewInputSchema } from '@shared/schemas/plan'
import type { ApprovalService } from '../modules/orchestration/approval-service'
import type { ReviewService } from '../modules/orchestration/review-service'
import { handle } from './handle'

/**
 * What the renderer may do with plans. Approving is a user action and the only way an approval record
 * comes into existence. `authorizeExecution` is deliberately NOT exposed here.
 */
export function registerPlanHandlers(deps: { approvals: ApprovalService; reviews: ReviewService }): void {
  const { approvals, reviews } = deps
  handle(IPC.plans.get, planTaskInputSchema, ({ projectId, taskId }) => approvals.bundle(projectId, taskId))
  handle(IPC.plans.approve, approvePlanInputSchema, ({ projectId, taskId, planId }) => approvals.approve(projectId, taskId, planId))
  handle(IPC.plans.reject, rejectPlanInputSchema, ({ projectId, taskId, planId, reason }) => approvals.reject(projectId, taskId, planId, reason))
  handle(IPC.plans.revoke, planTaskInputSchema, ({ projectId, taskId }) => approvals.revoke(projectId, taskId))
  handle(IPC.plans.requestReview, requestReviewInputSchema, ({ projectId, taskId, planId }) => {
    reviews.request(projectId, taskId, planId)
    return null
  })
}
