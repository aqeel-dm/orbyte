import { z } from 'zod'

const id = z.string().min(1).max(64)

export const AGENT_STATUSES = ['starting', 'running', 'exited', 'failed', 'stopped', 'interrupted'] as const
export const agentStatusSchema = z.enum(AGENT_STATUSES)
/** Statuses where a process is (or is about to be) alive. */
export const ACTIVE_AGENT_STATUSES = ['starting', 'running'] as const

export const MAX_TERMINAL_WRITE_BYTES = 64 * 1024

export const developerAgentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  name: z.string(),
  status: agentStatusSchema,
  /** planning: investigates and submits a plan. execution: implements the approved plan. */
  kind: z.enum(['planning', 'execution']),
  currentActivity: z.string(),
  /** Isolated git worktree this agent works in, and its branch. */
  worktreePath: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  worktreeRemoved: z.boolean(),
  exitCode: z.number().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const startAgentInputSchema = z.object({ projectId: id, taskId: id })
export const agentRefInputSchema = z.object({ projectId: id, agentId: id })
export const discardAgentInputSchema = z.object({ projectId: id, agentId: id, force: z.boolean().optional() })
export const terminalWriteInputSchema = z.object({
  projectId: id,
  agentId: id,
  // Characters, not bytes: a cheap upper bound. The service re-checks the byte length.
  data: z.string().min(1).max(MAX_TERMINAL_WRITE_BYTES)
})
export const terminalResizeInputSchema = z.object({
  projectId: id,
  agentId: id,
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200)
})

/** Pushed on the dedicated terminal channel, only to windows that attached to the agent. */
export const terminalEventSchema = z.object({ agentId: z.string(), data: z.string() })
export const attachResultSchema = z.object({
  /** Recent terminal output (live buffer, or the saved tail for an agent that has ended). */
  history: z.string(),
  live: z.boolean()
})
export const agentSummarySchema = z.object({ running: z.number() })

export type DeveloperAgent = z.infer<typeof developerAgentSchema>
export type AgentStatus = z.infer<typeof agentStatusSchema>
export type TerminalEvent = z.infer<typeof terminalEventSchema>
export type AttachResult = z.infer<typeof attachResultSchema>
export type AgentSummary = z.infer<typeof agentSummarySchema>
