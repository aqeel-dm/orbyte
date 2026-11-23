import { AppError } from '@shared/types/result'
import { proposeTasksInputSchema, type ProposeTasksInput } from '@shared/schemas/task'
import type { TaskDigest } from '../../tasks/service'
import type { ClaudeAgentSdk } from './sdk-loader'

/** In-process tools exposed to the Team Lead (SDK MCP server named "orbyte"). */
export const TEAM_LEAD_TOOL_NAMES = ['mcp__orbyte__list_tasks', 'mcp__orbyte__propose_tasks'] as const

/** What the tools may do. Bound to ONE project by the server; the model never supplies a project id. */
export interface TeamLeadTaskTools {
  listTasks(): { tasks: TaskDigest[]; total: number }
  /** Records a proposal only. It does not create tasks. */
  propose(input: ProposeTasksInput): { proposalId: string; count: number }
}

export const MAX_PROPOSE_CALLS_PER_TURN = 3

interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

/** Pure handlers (no SDK) so they can be tested directly. */
export function makeToolHandlers(tools: TeamLeadTaskTools) {
  let proposeCalls = 0
  return {
    async listTasks(): Promise<ToolResult> {
      try {
        const { tasks, total } = tools.listTasks()
        return text(JSON.stringify({ tasks, total, truncated: total > tasks.length }))
      } catch (err) {
        if (err instanceof AppError) return text(err.message, true)
        console.error('[team-lead] list_tasks failed', err)
        return text('The task list could not be read.', true)
      }
    },
    async proposeTasks(args: unknown): Promise<ToolResult> {
      if (++proposeCalls > MAX_PROPOSE_CALLS_PER_TURN) {
        return text('Too many proposals in one turn. Stop and let the user review what you have already proposed.', true)
      }
      const parsed = proposeTasksInputSchema.safeParse(args)
      if (!parsed.success) return text(`Invalid proposal: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, true)
      try {
        const { count } = tools.propose(parsed.data)
        return text(`Proposal recorded for the user's review (${count} tasks). Nothing has been created: tasks exist only if the user approves. Do not claim they were created.`)
      } catch (err) {
        if (err instanceof AppError) return text(err.message, true)
        console.error('[team-lead] propose_tasks failed', err)
        return text('The proposal could not be recorded.', true)
      }
    }
  }
}

export function createOrbyteServer(sdk: Pick<ClaudeAgentSdk, 'createSdkMcpServer' | 'tool'>, tools: TeamLeadTaskTools) {
  const h = makeToolHandlers(tools)
  return sdk.createSdkMcpServer({
    name: 'orbyte',
    version: '1.0.0',
    tools: [
      sdk.tool('list_tasks', "List this project's tasks (id, title, status, priority, dependencies). Read-only.", {}, () => h.listTasks()),
      sdk.tool(
        'propose_tasks',
        'Put a task breakdown in front of the user for review. This only RECORDS A PROPOSAL; nothing is created unless the user approves it. Use it only when the user has asked you to plan or break down work. Dependencies between proposed tasks use 0-based positions in `tasks` (dependsOnIndexes); dependencies on existing tasks use their ids (dependsOnTaskIds).',
        proposeTasksInputSchema.shape,
        (args) => h.proposeTasks(args)
      )
    ]
  })
}
