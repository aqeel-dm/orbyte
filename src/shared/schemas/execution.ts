import { z } from 'zod'

const id = z.string().min(1).max(64)

/** A test the agent says it ran. This is the agent's CLAIM; Orbyte does not verify it. */
export const reportedTestSchema = z.object({
  command: z.string().trim().min(1).max(300),
  passed: z.boolean(),
  note: z.string().trim().max(500).optional()
})

/** What an execution agent submits through its submit_result tool. Everything here is self-reported. */
export const submittedResultSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  tests: z.array(reportedTestSchema).max(30).default([])
})
export const progressNoteSchema = z.object({ message: z.string().trim().min(1).max(500) })

/** Facts Orbyte collects itself from git in the agent's worktree, independent of anything the agent says. */
export const evidenceSchema = z.object({
  headCommit: z.string(),
  /** Hash over HEAD, the full diff against the base commit and the untracked files. Acceptance is tied to it. */
  snapshotHash: z.string(),
  files: z.array(z.object({ path: z.string(), status: z.string(), additions: z.number().nullable(), deletions: z.number().nullable() })),
  diffStat: z.string(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
  uncommitted: z.boolean(),
  /** The diff or file list was too large to hash or list in full. */
  truncated: z.boolean()
})

export const executionRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  planId: z.string(),
  planVersion: z.number(),
  planHash: z.string(),
  /** The approval that authorized this run, or null for a revision run authorized by a recorded change request. */
  approvalId: z.string().nullable(),
  status: z.enum(['running', 'result_submitted', 'ended_without_result', 'stopped', 'failed']),
  feedback: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable()
})

export const executionProgressSchema = z.object({ id: z.string(), executionId: z.string(), message: z.string(), createdAt: z.number() })

export const executionResultSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  executionId: z.string(),
  agentId: z.string(),
  version: z.number(),
  summary: z.string(),
  tests: z.array(reportedTestSchema),
  evidence: evidenceSchema,
  status: z.enum(['current', 'superseded']),
  submittedAt: z.number()
})

/** The Team Lead's advice on a result. `approve` here means "accept". It never completes anything. */
export const resultReviewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  resultId: z.string(),
  resultVersion: z.number(),
  reviewer: z.literal('team_lead'),
  recommendation: z.enum(['approve', 'revise', 'reject']),
  summary: z.string(),
  concerns: z.array(z.string()),
  createdAt: z.number()
})

/** The user's decision about a result. Only an `accepted` record (for the unchanged code) can complete a task. */
export const resultDecisionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  resultId: z.string(),
  resultVersion: z.number(),
  snapshotHash: z.string(),
  reviewer: z.literal('user'),
  decision: z.enum(['accepted', 'changes_requested']),
  feedback: z.string(),
  decidedAt: z.number(),
  invalidatedAt: z.number().nullable(),
  invalidationReason: z.string().nullable()
})

export const completionGateSchema = z.object({
  state: z.enum(['no_result', 'awaiting_decision', 'accepted', 'changes_requested']),
  /** True when accepting would be allowed right now. */
  canAccept: z.boolean(),
  blockers: z.array(z.string()),
  /** Does the code in the worktree still match what was reviewed? Null when it could not be checked. */
  codeUnchanged: z.boolean().nullable()
})

export const executionBundleSchema = z.object({
  runs: z.array(executionRunSchema),
  progress: z.array(executionProgressSchema),
  results: z.array(executionResultSchema),
  reviews: z.array(resultReviewSchema),
  decisions: z.array(resultDecisionSchema),
  gate: completionGateSchema,
  reviewInProgress: z.boolean()
})

export const startExecutionInputSchema = z.object({ projectId: id, taskId: id })
export const acceptResultInputSchema = z.object({ projectId: id, taskId: id, resultId: id })
export const requestResultReviewInputSchema = z.object({ projectId: id, taskId: id, resultId: id })
export const requestChangesInputSchema = z.object({ projectId: id, taskId: id, resultId: id, feedback: z.string().trim().min(1, 'Feedback is required').max(2000) })

export type ReportedTest = z.infer<typeof reportedTestSchema>
export type SubmittedResult = z.infer<typeof submittedResultSchema>
export type Evidence = z.infer<typeof evidenceSchema>
export type ExecutionRun = z.infer<typeof executionRunSchema>
export type ExecutionProgress = z.infer<typeof executionProgressSchema>
export type ExecutionResult = z.infer<typeof executionResultSchema>
export type ResultReview = z.infer<typeof resultReviewSchema>
export type ResultDecision = z.infer<typeof resultDecisionSchema>
export type CompletionGate = z.infer<typeof completionGateSchema>
export type ExecutionBundle = z.infer<typeof executionBundleSchema>
