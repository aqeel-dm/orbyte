import { BrowserWindow, dialog } from 'electron'
import { IPC } from '@shared/constants/ipc'
import { cleanOrphansInputSchema } from '@shared/schemas/maintenance'
import type { SystemCheck } from '@shared/schemas/system'
import { usageInputSchema } from '@shared/schemas/usage'
import type { UsageService } from '../modules/usage/usage-service'
import type { MaintenanceService } from '../modules/maintenance/service'
import { AppError } from '@shared/types/result'
import { handle } from './handle'

/** Maintenance actions. No path crosses the bridge: the save location is chosen in a native dialog in main. */
export function registerMaintenanceHandlers(deps: { maintenance: MaintenanceService; systemCheck: () => Promise<SystemCheck>; usage: UsageService }): void {
  const { maintenance, systemCheck, usage } = deps
  handle(IPC.usage.get, usageInputSchema, ({ projectId }) => usage.summary(projectId))
  handle(IPC.system.check, null, () => systemCheck())
  handle(IPC.maintenance.scan, null, () => maintenance.scan())
  handle(IPC.maintenance.cleanOrphans, cleanOrphansInputSchema, ({ ids }) => maintenance.cleanOrphans(ids))
  let backingUp = false
  handle(IPC.maintenance.backupDatabase, null, async (_input, event) => {
    if (backingUp) throw new AppError('ALREADY_RUNNING', 'A backup is already in progress.')
    backingUp = true
    try {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { title: 'Back up the Orbyte database', defaultPath: `orbyte-backup-${new Date().toISOString().slice(0, 10)}.db`, filters: [{ name: 'Database', extensions: ['db'] }] }
    const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (picked.canceled || !picked.filePath) return { saved: false }
    await maintenance.backup(picked.filePath)
    return { saved: true }
    } finally {
      backingUp = false
    }
  })
}
