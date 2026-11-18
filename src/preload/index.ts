import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants/ipc'
import type { OrbyteApi } from '../shared/types/api'

// Only named, fixed channels are reachable. ipcRenderer itself is never exposed.
const api: OrbyteApi = {
  projects: {
    list: () => ipcRenderer.invoke(IPC.projects.list),
    pickDirectory: () => ipcRenderer.invoke(IPC.projects.pickDirectory),
    register: (input) => ipcRenderer.invoke(IPC.projects.register, input),
    remove: (id) => ipcRenderer.invoke(IPC.projects.remove, { id })
  }
}

contextBridge.exposeInMainWorld('orbyte', api)
