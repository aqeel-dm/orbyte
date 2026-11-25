import { z } from 'zod'
import { TASK_STATUSES } from '../task-state'

const id = z.string().min(1).max(64)

export const taskStatusSchema = z.enum(TASK_STATUSES)
export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 } as const

export const MAX_DEPENDENCIES = 20
export const MAX_PROPOSAL_ITEMS = 20

const title = z.string().trim().min(1, 'Title is required').max(120)
const unique = (a: unknown[]): boolean => new Set(a).size === a.length
const description = z.string().trim().max(4000)

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  dependsOnTaskIds: z.array(z.string()),
  /** Stored for Phase 4+; nothing assigns agents yet. */
  assignedAgentId: z.string().nullable(),
  implementationPlan: z.string().nullable(),
  approvalStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  executionStatus: z.enum(['idle', 'running', 'succeeded', 'failed', 'interrupted']),
  resultSummary: z.string().nullable(),
  source: z.enum(['user', 'team_lead']),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const createTaskInputSchema = z.object({
  projectId: id,
  title,
  description: description.default(''),
  priority: taskPrioritySchema.default('medium'),
  dependsOnTaskIds: z.array(id).max(MAX_DEPENDENCIES).default([])
})

export const updateTaskInputSchema = z.object({
  projectId: id,
  taskId: id,
  patch: z
    .object({
      title: title.optional(),
      description: description.optional(),
      priority: taskPrioritySchema.optional(),
      dependsOnTaskIds: z.array(id).max(MAX_DEPENDENCIES).optional()
    })
    .refine((p) => Object.keys(p).length > 0, 'Nothing to update')
})

export const transitionTaskInputSchema = z.object({ projectId: id, taskId: id, to: taskStatusSchema })
export const projectScopedInputSchema = z.object({ projectId: id })

/** One task inside a proposal. `key` identifies it within the proposal so dependencies can reference siblings. */
export const proposalItemSchema = z.object({
  key: z.number().int().min(0).max(MAX_PROPOSAL_ITEMS - 1),
  title,
  description: description.default(''),
  priority: taskPrioritySchema.default('medium'),
  dependsOnKeys: z.array(z.number().int().min(0).max(MAX_PROPOSAL_ITEMS - 1)).max(MAX_DEPENDENCIES).refine(unique, 'Dependencies must not repeat').default([]),
  dependsOnTaskIds: z.array(id).max(MAX_DEPENDENCIES).refine(unique, 'Dependencies must not repeat').default([])
}).refine((i) => i.dependsOnKeys.length + i.dependsOnTaskIds.length <= MAX_DEPENDENCIES, `A task can have at most ${MAX_DEPENDENCIES} dependencies.`)

/** Input of the Team Lead's propose_tasks tool. Dependencies on siblings use 0-based positions in `tasks`. */
export const proposeTasksInputSchema = z.object({
  summary: z.string().trim().max(500).optional(),
  tasks: z
    .array(
      z.object({
        title,
        description: description.default(''),
        priority: taskPrioritySchema.default('medium'),
        dependsOnIndexes: z.array(z.number().int().min(0).max(MAX_PROPOSAL_ITEMS - 1)).max(MAX_DEPENDENCIES).refine(unique, 'Dependencies must not repeat').default([]),
        dependsOnTaskIds: z.array(id).max(MAX_DEPENDENCIES).refine(unique, 'Dependencies must not repeat').default([])
      }).refine((t) => t.dependsOnIndexes.length + t.dependsOnTaskIds.length <= MAX_DEPENDENCIES, `A task can have at most ${MAX_DEPENDENCIES} dependencies.`)
    )
    .min(1)
    .max(MAX_PROPOSAL_ITEMS)
})

export const proposalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  summary: z.string(),
  items: z.array(proposalItemSchema),
  status: z.enum(['pending', 'approved', 'dismissed']),
  createdTaskIds: z.array(z.string()),
  createdAt: z.number(),
  decidedAt: z.number().nullable()
})

export const approveProposalInputSchema = z.object({
  projectId: id,
  proposalId: id,
  /** The tasks to create, possibly edited and possibly a subset of the proposal. */
  items: z.array(proposalItemSchema).min(1).max(MAX_PROPOSAL_ITEMS)
})
export const dismissProposalInputSchema = z.object({ projectId: id, proposalId: id })

export const activityListInputSchema = z.object({ projectId: id, limit: z.number().int().min(1).max(200).optional() })
export const activityEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number()
})

export const recentActivityInputSchema = z.object({ limit: z.number().int().min(1).max(100).optional() })
/** An event from any active project; `projectName` is null for app-wide events such as startup recovery. */
export const recentActivityEventSchema = activityEventSchema.extend({
  projectId: z.string().nullable(),
  projectName: z.string().nullable()
})

export const taskSummarySchema = z.object({ open: z.number(), byStatus: z.record(z.string(), z.number()) })

export type Task = z.infer<typeof taskSchema>
export type TaskPriority = z.infer<typeof taskPrioritySchema>
export type ProposalItem = z.infer<typeof proposalItemSchema>
export type TaskProposal = z.infer<typeof proposalSchema>
export type ProposeTasksInput = z.infer<typeof proposeTasksInputSchema>
export type CreateTaskInput = z.input<typeof createTaskInputSchema>
export type UpdateTaskInput = z.input<typeof updateTaskInputSchema>
export type ActivityEvent = z.infer<typeof activityEventSchema>
export type RecentActivityEvent = z.infer<typeof recentActivityEventSchema>
export type TaskSummary = z.infer<typeof taskSummarySchema>
