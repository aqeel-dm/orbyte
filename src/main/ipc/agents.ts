import { IPC } from '@shared/constants/ipc'
import { agentRefInputSchema, discardAgentInputSchema, startAgentInputSchema, terminalResizeInputSchema, terminalWriteInputSchema } from '@shared/schemas/agent'
import type { AgentService } from '../modules/agents/developers/agent-service'
import { handle } from './handle'

export function registerAgentHandlers(deps: { agents: AgentService }): void {
  const { agents } = deps

  handle(IPC.agents.list, agentRefInputSchema.pick({ projectId: true }), ({ projectId }) => agents.list(projectId))
  handle(IPC.agents.summary, null, () => agents.summary())
  handle(IPC.agents.start, startAgentInputSchema, ({ projectId, taskId }) => agents.start(projectId, taskId))
  handle(IPC.agents.stop, agentRefInputSchema, ({ projectId, agentId }) => agents.stop(projectId, agentId))
  handle(IPC.agents.discard, discardAgentInputSchema, ({ projectId, agentId, force }) => agents.discard(projectId, agentId, force ?? false))

  // The window id is taken from the IPC event in main, never from the renderer.
  handle(IPC.agents.attach, agentRefInputSchema, ({ projectId, agentId }, event) => agents.attach(event.sender.id, projectId, agentId))
  handle(IPC.agents.detach, agentRefInputSchema, ({ projectId, agentId }, event) => {
    agents.detach(event.sender.id, projectId, agentId)
    return null
  })
  handle(IPC.agents.write, terminalWriteInputSchema, ({ projectId, agentId, data }) => {
    agents.write(projectId, agentId, data)
    return null
  })
  handle(IPC.agents.resize, terminalResizeInputSchema, ({ projectId, agentId, cols, rows }) => {
    agents.resize(projectId, agentId, cols, rows)
    return null
  })
}
