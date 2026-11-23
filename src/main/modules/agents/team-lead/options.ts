import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { TEAM_LEAD_PROMPT } from './prompt'
import { TEAM_LEAD_TOOL_NAMES, type TeamLeadTaskTools } from './tools'

export interface TeamLeadRunRequest {
  prompt: string
  repoPath: string
  resumeSessionId: string | null
  /** Only when the user has trusted this repository are its hooks/settings loaded. */
  trustRepoSettings: boolean
  /** Task tools for chat turns. Null for onboarding and anything else: no task tools, no MCP server. */
  taskTools: TeamLeadTaskTools | null
  abortController: AbortController
  maxTurns?: number
}

/**
 * Pure builder for the Team Lead's SDK options. Read-only by construction:
 * - `tools` removes every built-in except Read/Glob/Grep from the model's context
 * - `disallowedTools` removes write/exec built-ins
 * - `strictMcpConfig` stops user/project MCP servers from being started at all; the only MCP
 *   server is Orbyte's own in-process one, and only for chat turns
 * - without task tools, `mcp__*` is also denied (verified: the wildcard works, and it would also
 *   block our own tools, so it is dropped when they are enabled)
 * - `dontAsk` denies anything that would otherwise need approval
 * Verified against the installed SDK: init.tools was exactly [Glob, Grep, Read].
 */
export function buildTeamLeadOptions(req: TeamLeadRunRequest): Options {
  return {
    cwd: req.repoPath,
    tools: ['Read', 'Glob', 'Grep'],
    disallowedTools: req.taskTools ? ['Edit', 'Write', 'NotebookEdit', 'Bash'] : ['Edit', 'Write', 'NotebookEdit', 'Bash', 'mcp__*'],
    // Exact allowlist of Orbyte's own tools. Under dontAsk a tool that is not allowed here cannot run.
    ...(req.taskTools ? { allowedTools: [...TEAM_LEAD_TOOL_NAMES] } : {}),
    strictMcpConfig: true,
    permissionMode: 'dontAsk',
    // Repo settings (hooks etc.) load only after the user trusted this project; otherwise user settings only.
    settingSources: req.trustRepoSettings ? ['user', 'project', 'local'] : ['user'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: TEAM_LEAD_PROMPT },
    includePartialMessages: true,
    // The SDK replaces the subprocess environment when `env` is given.
    env: { ...process.env },
    abortController: req.abortController,
    ...(req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}),
    ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {})
  }
}
