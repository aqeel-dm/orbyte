import { z } from 'zod'

const id = z.string().min(1).max(64)

/** What a planning agent submits through its submit_plan tool. Validated again in main. */
export const submittedPlanSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  steps: z.array(z.string().trim().min(1).max(1000)).min(1).max(30),
  files: z.array(z.string().trim().min(1).max(300)).max(60).default([]),
  tests: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  risks: z.array(z.string().trim().min(1).max(500)).max(30).default([])
})

export const taskPlanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  /** 1, 2, 3 ... per task. A changed plan is always a new version. */
  version: z.number(),
  content: submittedPlanSchema,
  contentHash: z.string(),
  status: z.enum(['current', 'superseded']),
  submittedAt: z.number()
})

export const recommendationSchema = z.enum(['approve', 'revise', 'reject'])

/** The Team Lead's advice on a plan. It never authorizes anything by itself. */
export const planReviewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  planId: z.string(),
  planVersion: z.number(),
  reviewer: z.literal('team_lead'),
  recommendation: recommendationSchema,
  summary: z.string(),
  concerns: z.array(z.string()),
  createdAt: z.number()
})

/** Input of the Team Lead's submit_review tool. */
export const submitReviewInputSchema = z.object({
  recommendation: recommendationSchema,
  summary: z.string().trim().min(1).max(2000),
  concerns: z.array(z.string().trim().min(1).max(500)).max(20).default([])
})

/** The record the execution gate checks: who decided what about which plan version, and when. */
export const planApprovalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  planId: z.string(),
  planVersion: z.number(),
  planHash: z.string(),
  reviewer: z.literal('user'),
  status: z.enum(['approved', 'rejected']),
  reason: z.string(),
  decidedAt: z.number(),
  invalidatedAt: z.number().nullable(),
  invalidationReason: z.string().nullable()
})

export const gateStateSchema = z.object({
  state: z.enum(['no_plan', 'awaiting_decision', 'approved', 'rejected']),
  /** True only when a valid approval exists for the current plan version and nothing blocks it. */
  executionAuthorized: z.boolean(),
  /** Plain reasons why approval or execution is currently blocked. */
  blockers: z.array(z.string())
})

export const planBundleSchema = z.object({
  plans: z.array(taskPlanSchema),
  reviews: z.array(planReviewSchema),
  approvals: z.array(planApprovalSchema),
  gate: gateStateSchema,
  /** A Team Lead review of the current plan is running right now. */
  reviewInProgress: z.boolean()
})

export const planTaskInputSchema = z.object({ projectId: id, taskId: id })
export const approvePlanInputSchema = z.object({ projectId: id, taskId: id, planId: id })
export const rejectPlanInputSchema = z.object({ projectId: id, taskId: id, planId: id, reason: z.string().trim().min(1, 'A reason is required').max(1000) })
export const requestReviewInputSchema = z.object({ projectId: id, taskId: id, planId: id })

export type SubmitReviewInput = z.infer<typeof submitReviewInputSchema>
export type SubmittedPlan = z.infer<typeof submittedPlanSchema>
export type TaskPlan = z.infer<typeof taskPlanSchema>
export type PlanReview = z.infer<typeof planReviewSchema>
export type PlanApproval = z.infer<typeof planApprovalSchema>
export type PlanBundle = z.infer<typeof planBundleSchema>
export type GateState = z.infer<typeof gateStateSchema>
export type Recommendation = z.infer<typeof recommendationSchema>
