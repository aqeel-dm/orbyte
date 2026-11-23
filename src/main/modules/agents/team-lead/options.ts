import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { TEAM_LEAD_PROMPT } from './prompt'

export interface TeamLeadRunRequest {
  prompt: string
  repoPath: string
  resumeSessionId: string | null
  /** Only when the user has trusted this repository are its hooks/settings loaded. */
  trustRepoSettings: boolean
  abortController: AbortController
  maxTurns?: number
}

/**
 * Pure builder for the Team Lead's SDK options. Read-only by construction:
 * - `tools` removes every built-in except Read/Glob/Grep from the model's context
 * - `disallowedTools` removes write/exec built-ins and any MCP tool (belt and braces)
 * - `strictMcpConfig` stops user/project MCP servers from being started at all
 * - `dontAsk` denies anything that would otherwise need approval
 * Verified against the installed SDK: init.tools was exactly [Glob, Grep, Read].
 */
export function buildTeamLeadOptions(req: TeamLeadRunRequest): Options {
  return {
    cwd: req.repoPath,
    tools: ['Read', 'Glob', 'Grep'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'mcp__*'],
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
