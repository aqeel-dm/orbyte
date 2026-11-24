/**
 * A tiny stdio MCP server that Claude Code starts for each developer agent (via --mcp-config).
 * A planning agent gets ONE tool, submit_plan. An execution agent gets report_progress and
 * submit_result. Each validates its input and writes it to the agent's private inbox directory for
 * Orbyte to pick up. It has no other capability and never touches the repository.
 * Run as: ELECTRON_RUN_AS_NODE=1 <electron> agent-server.js
 */
import { randomBytes } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { progressNoteSchema, submittedResultSchema } from '@shared/schemas/execution'
import { submittedPlanSchema } from '@shared/schemas/plan'

const inbox = process.env['ORBYTE_AGENT_INBOX']
const kind = process.env['ORBYTE_AGENT_KIND']
if (!inbox || (kind !== 'planning' && kind !== 'execution')) {
  console.error('ORBYTE_AGENT_INBOX and ORBYTE_AGENT_KIND (planning or execution) must be set')
  process.exit(1)
}

/** Write then rename, so the reader never sees a half-written file. */
function drop(prefix: 'plan' | 'progress' | 'result', body: unknown): void {
  const name = `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.json`
  const tmp = join(inbox as string, `.${name}.tmp`)
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
  renameSync(tmp, join(inbox as string, name))
}
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] })

const server = new McpServer({ name: 'orbyte', version: '1.0.0' })

// These tools are declared read-only so the CLI does not stop at a permission prompt: they write only
// to Orbyte's private inbox and never touch the repository. The hint is a claim the CLI trusts.
if (kind === 'planning') {
  server.registerTool(
    'submit_plan',
    {
      description:
        "Submit your finished implementation plan for review. Call it once when you have investigated enough. It only RECORDS the plan; nothing is executed and you cannot start implementing. After it succeeds, stop and wait for the review and the user's decision. If you are later asked to revise, call it again with the complete revised plan.",
      annotations: { readOnlyHint: true },
      inputSchema: submittedPlanSchema.shape
    },
    async (args) => {
      drop('plan', { plan: submittedPlanSchema.parse(args) })
      return reply("Plan recorded for review. Stop now and wait for the review and the user's decision. Do not implement anything.")
    }
  )
} else {
  server.registerTool(
    'report_progress',
    {
      description: 'Report briefly what you are doing now. It only records a note for the user; call it at meaningful steps, not constantly.',
      annotations: { readOnlyHint: true },
      inputSchema: progressNoteSchema.shape
    },
    async (args) => {
      drop('progress', { progress: progressNoteSchema.parse(args) })
      return reply('Progress recorded.')
    }
  )
  server.registerTool(
    'submit_result',
    {
      description:
        'Report that you have finished implementing the approved plan. Call it ONCE with an honest summary and the tests you actually ran (command and whether it passed). Your report is checked independently, so claim only what you did. After it succeeds, stop.',
      annotations: { readOnlyHint: true },
      inputSchema: submittedResultSchema.shape
    },
    async (args) => {
      drop('result', { result: submittedResultSchema.parse(args) })
      return reply('Result recorded for review. Stop now. Do not make further changes.')
    }
  )
}

void server.connect(new StdioServerTransport())
