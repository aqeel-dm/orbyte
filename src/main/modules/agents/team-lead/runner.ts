import { loadAgentSdk, type ClaudeAgentSdk } from './sdk-loader'
import { buildTeamLeadOptions, type TeamLeadRunRequest } from './options'
import { createOrbyteServer } from './tools'

/** Seam for tests: yields raw SDK messages for one turn. */
export interface TeamLeadRunner {
  run(req: TeamLeadRunRequest): AsyncIterable<unknown>
}

export function createSdkRunner(load: () => Promise<ClaudeAgentSdk> = loadAgentSdk): TeamLeadRunner {
  return {
    async *run(req) {
      const sdk = await load()
      const options = buildTeamLeadOptions(req)
      if (req.taskTools || req.reviewTools) options.mcpServers = { orbyte: createOrbyteServer(sdk, { taskTools: req.taskTools, reviewTools: req.reviewTools ?? null }) }
      yield* sdk.query({ prompt: req.prompt, options })
    }
  }
}
