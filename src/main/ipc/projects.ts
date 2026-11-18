import { BrowserWindow, dialog } from 'electron'
import { IPC } from '@shared/constants/ipc'
import { registerProjectInputSchema, removeProjectInputSchema } from '@shared/schemas/project'
import type { ProjectService } from '../modules/projects/service'
import { handle } from './handle'

export function registerProjectHandlers(service: ProjectService): void {
  handle(IPC.projects.list, null, () => service.list())

  handle(IPC.projects.pickDirectory, null, async (_i, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: 'Select project directory', properties: ['openDirectory' as const] }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const picked = res.filePaths[0]
    if (res.canceled || !picked) return { cancelled: true as const }
    return service.prepare(picked)
  })

  handle(IPC.projects.register, registerProjectInputSchema, (input) => service.register(input))

  handle(IPC.projects.remove, removeProjectInputSchema, ({ id }) => {
    service.remove(id)
    return null
  })
}
