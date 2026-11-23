import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants/ipc'
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
    history: (projectId) => ipcRenderer.invoke(IPC.teamLead.history, { projectId })
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
