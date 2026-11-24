/**
 * A tiny stdio MCP server that Claude Code starts for each developer agent (via --mcp-config).
 * It exposes ONE tool, submit_plan, which validates the plan and writes it to the agent's private
 * inbox directory for Orbyte to pick up. It has no other capability and never touches the repository.
 * Run as: ELECTRON_RUN_AS_NODE=1 <electron> plan-server.js
 */
import { randomBytes } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { submittedPlanSchema } from '@shared/schemas/plan'

const inbox = process.env['ORBYTE_PLAN_INBOX']
if (!inbox) {
  console.error('ORBYTE_PLAN_INBOX is not set')
  process.exit(1)
}

const server = new McpServer({ name: 'orbyte', version: '1.0.0' })

server.registerTool(
  'submit_plan',
  {
    description:
      'Submit your finished implementation plan for review. Call it once when you have investigated enough. It only RECORDS the plan; nothing is executed and you cannot start implementing. After it succeeds, stop and wait for the review and the user\'s decision. If you are later asked to revise, call it again with the complete revised plan.',
    // Declared read-only so plan mode does not stop at a permission prompt: it writes only to Orbyte's private inbox, never to the repository.
    annotations: { readOnlyHint: true },
    inputSchema: submittedPlanSchema.shape
  },
  async (args) => {
    const plan = submittedPlanSchema.parse(args)
    const name = `plan-${Date.now()}-${randomBytes(4).toString('hex')}.json`
    // Write then rename, so the reader never sees a half-written file.
    const tmp = join(inbox, `.${name}.tmp`)
    writeFileSync(tmp, JSON.stringify({ plan }), { mode: 0o600 })
    renameSync(tmp, join(inbox, name))
    return { content: [{ type: 'text' as const, text: 'Plan recorded for review. Stop now and wait for the review and the user\'s decision. Do not implement anything.' }] }
  }
)

void server.connect(new StdioServerTransport())
