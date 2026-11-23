import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
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
  const teamLead = new TeamLeadService({ projects: projectRepo, chat: new ChatRepository(dbHandle.db), runner: createSdkRunner(), emit })
  const onboarding = new OnboardingService({ projects: projectRepo, teamLead, discover: discoverProject, emit })
  onboarding.recoverInterrupted()

  registerProjectHandlers({
    projects: new ProjectService({ repo: projectRepo, inspect: inspectRepository }),
    onboarding,
    teamLead
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
