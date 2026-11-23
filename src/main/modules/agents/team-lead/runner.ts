import { loadAgentSdk, type ClaudeAgentSdk } from './sdk-loader'
import { buildTeamLeadOptions, type TeamLeadRunRequest } from './options'

/** Seam for tests: yields raw SDK messages for one turn. */
export interface TeamLeadRunner {
  run(req: TeamLeadRunRequest): AsyncIterable<unknown>
}

export function createSdkRunner(load: () => Promise<ClaudeAgentSdk> = loadAgentSdk): TeamLeadRunner {
  return {
    async *run(req) {
      const sdk = await load()
      yield* sdk.query({ prompt: req.prompt, options: buildTeamLeadOptions(req) })
    }
  }
}
