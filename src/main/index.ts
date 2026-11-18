import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { openDatabase, type DbHandle } from './database/client'
import { inspectRepository } from './modules/git/inspect'
import { ProjectRepository } from './modules/projects/repository'
import { ProjectService } from './modules/projects/service'
import { registerProjectHandlers } from './ipc/projects'
import { createMainWindow } from './app/window'

let dbHandle: DbHandle | undefined

async function bootstrap(): Promise<void> {
  const migrations = app.isPackaged ? join(process.resourcesPath, 'drizzle') : join(app.getAppPath(), 'drizzle')
  dbHandle = openDatabase(join(app.getPath('userData'), 'orbyte.db'), migrations)

  const projects = new ProjectService({ repo: new ProjectRepository(dbHandle.db), inspect: inspectRepository })
  registerProjectHandlers(projects)
  createMainWindow()
}

// Single instance: one app owns the database and (later) all agent processes.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.focus())
  void app.whenReady().then(bootstrap)
  // Closing the window must not end the app on macOS (agents keep running).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
  app.on('before-quit', () => dbHandle?.close())
}
