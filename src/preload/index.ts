import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants/ipc'
import { terminalEventSchema } from '../shared/schemas/agent'
import { appEventSchema } from '../shared/schemas/team-lead'
import type { OrbyteApi } from '../shared/types/api'

// Only named, fixed channels are reachable. ipcRenderer itself is never exposed.
const api: OrbyteApi = {
  projects: {
    list: (input) => ipcRenderer.invoke(IPC.projects.list, input),
    get: (id) => ipcRenderer.invoke(IPC.projects.get, { id }),
    pickDirectory: () => ipcRenderer.invoke(IPC.projects.pickDirectory),
    register: (input) => ipcRenderer.invoke(IPC.projects.register, input),
    archive: (id) => ipcRenderer.invoke(IPC.projects.archive, { id }),
    restore: (id) => ipcRenderer.invoke(IPC.projects.restore, { id }),
    setTrust: (id, trust) => ipcRenderer.invoke(IPC.projects.setTrust, { id, trust }),
    discover: (id) => ipcRenderer.invoke(IPC.projects.discover, { id })
  },
  onboarding: {
    start: (projectId) => ipcRenderer.invoke(IPC.onboarding.start, { projectId })
  },
  teamLead: {
    send: (projectId, text) => ipcRenderer.invoke(IPC.teamLead.send, { projectId, text }),
    interrupt: (projectId) => ipcRenderer.invoke(IPC.teamLead.interrupt, { projectId }),
    history: (projectId) => ipcRenderer.invoke(IPC.teamLead.history, { projectId }),
    summary: () => ipcRenderer.invoke(IPC.teamLead.summary)
  },
  tasks: {
    list: (projectId) => ipcRenderer.invoke(IPC.tasks.list, { projectId }),
    create: (input) => ipcRenderer.invoke(IPC.tasks.create, input),
    update: (input) => ipcRenderer.invoke(IPC.tasks.update, input),
    transition: (projectId, taskId, to) => ipcRenderer.invoke(IPC.tasks.transition, { projectId, taskId, to }),
    summary: () => ipcRenderer.invoke(IPC.tasks.summary)
  },
  proposals: {
    list: (projectId) => ipcRenderer.invoke(IPC.proposals.list, { projectId }),
    approve: (projectId, proposalId, items) => ipcRenderer.invoke(IPC.proposals.approve, { projectId, proposalId, items }),
    dismiss: (projectId, proposalId) => ipcRenderer.invoke(IPC.proposals.dismiss, { projectId, proposalId })
  },
  decisions: {
    list: (projectId) => ipcRenderer.invoke(IPC.decisions.list, { projectId })
  },
  activity: {
    list: (projectId, limit) => ipcRenderer.invoke(IPC.activity.list, { projectId, limit }),
    listRecent: (limit) => ipcRenderer.invoke(IPC.activity.listRecent, { limit })
  },
  agents: {
    list: (projectId) => ipcRenderer.invoke(IPC.agents.list, { projectId }),
    start: (projectId, taskId) => ipcRenderer.invoke(IPC.agents.start, { projectId, taskId }),
    stop: (projectId, agentId) => ipcRenderer.invoke(IPC.agents.stop, { projectId, agentId }),
    discard: (projectId, agentId, force) => ipcRenderer.invoke(IPC.agents.discard, { projectId, agentId, force }),
    attach: (projectId, agentId) => ipcRenderer.invoke(IPC.agents.attach, { projectId, agentId }),
    detach: (projectId, agentId) => ipcRenderer.invoke(IPC.agents.detach, { projectId, agentId }),
    write: (projectId, agentId, data) => ipcRenderer.invoke(IPC.agents.write, { projectId, agentId, data }),
    resize: (projectId, agentId, cols, rows) => ipcRenderer.invoke(IPC.agents.resize, { projectId, agentId, cols, rows }),
    summary: () => ipcRenderer.invoke(IPC.agents.summary)
  },
  usage: { get: (projectId) => ipcRenderer.invoke(IPC.usage.get, { projectId }) },
  system: { check: () => ipcRenderer.invoke(IPC.system.check) },
  updates: {
    status: () => ipcRenderer.invoke(IPC.updates.status),
    check: () => ipcRenderer.invoke(IPC.updates.check),
    openDownload: () => ipcRenderer.invoke(IPC.updates.openDownload)
  },
  maintenance: {
    scan: () => ipcRenderer.invoke(IPC.maintenance.scan),
    cleanOrphans: (ids) => ipcRenderer.invoke(IPC.maintenance.cleanOrphans, { ids }),
    backupDatabase: () => ipcRenderer.invoke(IPC.maintenance.backupDatabase)
  },
  executions: {
    start: (projectId, taskId) => ipcRenderer.invoke(IPC.executions.start, { projectId, taskId }),
    get: (projectId, taskId) => ipcRenderer.invoke(IPC.executions.get, { projectId, taskId }),
    accept: (projectId, taskId, resultId) => ipcRenderer.invoke(IPC.executions.accept, { projectId, taskId, resultId }),
    requestChanges: (projectId, taskId, resultId, feedback) => ipcRenderer.invoke(IPC.executions.requestChanges, { projectId, taskId, resultId, feedback }),
    requestReview: (projectId, taskId, resultId) => ipcRenderer.invoke(IPC.executions.requestReview, { projectId, taskId, resultId }),
    changes: (projectId, taskId, resultId) => ipcRenderer.invoke(IPC.executions.changes, { projectId, taskId, resultId }),
    runTests: (projectId, taskId, resultId) => ipcRenderer.invoke(IPC.executions.runTests, { projectId, taskId, resultId }),
    testRuns: (projectId, taskId) => ipcRenderer.invoke(IPC.executions.testRuns, { projectId, taskId })
  },
  plans: {
    get: (projectId, taskId) => ipcRenderer.invoke(IPC.plans.get, { projectId, taskId }),
    approve: (projectId, taskId, planId) => ipcRenderer.invoke(IPC.plans.approve, { projectId, taskId, planId }),
    reject: (projectId, taskId, planId, reason) => ipcRenderer.invoke(IPC.plans.reject, { projectId, taskId, planId, reason }),
    revoke: (projectId, taskId) => ipcRenderer.invoke(IPC.plans.revoke, { projectId, taskId }),
    requestReview: (projectId, taskId, planId) => ipcRenderer.invoke(IPC.plans.requestReview, { projectId, taskId, planId })
  },
  onTerminalData: (listener) => {
    const handler = (_e: unknown, payload: unknown): void => {
      const parsed = terminalEventSchema.safeParse(payload)
      if (parsed.success) listener(parsed.data) // drop anything malformed
    }
    ipcRenderer.on(IPC.events.terminal, handler)
    return () => ipcRenderer.removeListener(IPC.events.terminal, handler)
  },
  onEvent: (listener) => {
    const handler = (_e: unknown, payload: unknown): void => {
      const parsed = appEventSchema.safeParse(payload)
      if (parsed.success) listener(parsed.data) // drop anything malformed
    }
    ipcRenderer.on(IPC.events.app, handler)
    return () => ipcRenderer.removeListener(IPC.events.app, handler)
  }
}

contextBridge.exposeInMainWorld('orbyte', api)
