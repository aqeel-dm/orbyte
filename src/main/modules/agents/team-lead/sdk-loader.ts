import type * as Sdk from '@anthropic-ai/claude-agent-sdk'

export type ClaudeAgentSdk = typeof Sdk

/**
 * The Agent SDK is ESM-only and the main process is CommonJS, so it must be
 * loaded with a dynamic import() and kept external to the bundle.
 */
export const loadAgentSdk = (): Promise<ClaudeAgentSdk> => import('@anthropic-ai/claude-agent-sdk')
