import { z } from 'zod'

const id = z.string().min(1).max(64)

export const tokenTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number()
})

/**
 * Usage for one project, from two sources that differ in how reliable they are:
 * - teamLead: totals the Agent SDK reports per session, with its own cost estimate.
 * - agents: tokens read from Claude Code's own session transcripts (an undocumented file format). No cost is
 *   shown for agents, because Orbyte has no price table to turn tokens into money.
 */
export const usageSummarySchema = z.object({
  teamLead: tokenTotalsSchema.extend({ costUsd: z.number(), sessions: z.number() }),
  agents: tokenTotalsSchema.extend({ agentsRead: z.number(), agentsUnreadable: z.number() })
})
export const usageInputSchema = z.object({ projectId: id })

export type TokenTotals = z.infer<typeof tokenTotalsSchema>
export type UsageSummary = z.infer<typeof usageSummarySchema>
