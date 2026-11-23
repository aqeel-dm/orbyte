import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { openDatabase, type DbHandle } from './database/client'
import { inspectRepository } from './modules/git/inspect'
import { ChatRepository } from './modules/agents/team-lead/chat-repository'
import { createSdkRunner } from './modules/agents/team-lead/runner'
import { TeamLeadService } from './modules/agents/team-lead/service'
import { discoverProject } from './modules/projects/discovery'
import { OnboardingService } from './modules/projects/onboarding'
import { ProjectRepository } from './modules/projects/repository'
import { ProjectService } from './modules/projects/service'
import { setTrustedAppEntry } from './ipc/handle'
import { registerProjectHandlers } from './ipc/projects'
import { installAppSecurity } from './app/security'
import { createMainWindow, getAppEntryUrl } from './app/window'
import { IPC } from '@shared/constants/ipc'
import type { AppEvent } from '@shared/schemas/team-lead'

let dbHandle: DbHandle | undefined
let teamLeadService: TeamLeadService | undefined
let quitting = false

process.on('unhandledRejection', (reason) => console.error('[main] unhandled rejection', reason))

async function bootstrap(): Promise<void> {
  const migrations = app.isPackaged ? join(process.resourcesPath, 'drizzle') : join(app.getAppPath(), 'drizzle')
  dbHandle = openDatabase(join(app.getPath('userData'), 'orbyte.db'), migrations)

  const appEntryUrl = getAppEntryUrl()
  setTrustedAppEntry(appEntryUrl)

  const projectRepo = new ProjectRepository(dbHandle.db)
  // One fixed push channel to the renderer; payloads are validated again in the preload.
  const emit = (event: AppEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.events.app, event)
  }
  const teamLead = (teamLeadService = new TeamLeadService({ projects: projectRepo, chat: new ChatRepository(dbHandle.db), runner: createSdkRunner(), emit }))
  const onboarding = new OnboardingService({ projects: projectRepo, teamLead, discover: discoverProject, emit })
  onboarding.recoverInterrupted()

  registerProjectHandlers({
    projects: new ProjectService({ repo: projectRepo, inspect: inspectRepository, discover: discoverProject }),
    onboarding,
    teamLead,
    emit
  })
  installAppSecurity(appEntryUrl)
  createMainWindow()
}

// Single instance: one app owns the database and (later) all agent processes.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })
  void app.whenReady().then(bootstrap).catch((err) => {
    console.error('[main] startup failed', err)
    dialog.showErrorBox('Orbyte could not start', 'The database or application failed to initialize. See the application log for details.')
    app.exit(1)
  })
  // Closing the window must not end the app on macOS (agents keep running).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
  // Abort in-flight Team Lead turns (and their subprocesses) before the database closes.
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void (teamLeadService?.shutdown() ?? Promise.resolve())
      .catch((err) => console.error('[main] shutdown failed', err))
      .finally(() => {
        dbHandle?.close()
        app.quit()
      })
  })
}
