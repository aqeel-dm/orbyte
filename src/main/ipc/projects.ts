import { BrowserWindow, dialog } from 'electron'
import { IPC } from '@shared/constants/ipc'
import { listProjectsInputSchema, projectIdSchema, registerProjectInputSchema } from '@shared/schemas/project'
import { projectIdInputSchema, sendMessageInputSchema } from '@shared/schemas/team-lead'
import type { OnboardingService } from '../modules/projects/onboarding'
import type { ProjectService } from '../modules/projects/service'
import type { TeamLeadService } from '../modules/agents/team-lead/service'
import { handle } from './handle'

export function registerProjectHandlers(deps: {
  projects: ProjectService
  onboarding: OnboardingService
  teamLead: TeamLeadService
}): void {
  const { projects, onboarding, teamLead } = deps

  handle(IPC.projects.list, listProjectsInputSchema, (input) => projects.list(input?.includeArchived ?? false))
  handle(IPC.projects.get, projectIdSchema, ({ id }) => projects.get(id))

  handle(IPC.projects.pickDirectory, null, (_i, event) =>
    projects.exclusivePick(async () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = { title: 'Select project directory', properties: ['openDirectory' as const] }
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      const picked = res.filePaths[0]
      if (res.canceled || !picked) return { cancelled: true as const }
      return projects.prepare(picked)
    })
  )

  handle(IPC.projects.register, registerProjectInputSchema, (input) => projects.register(input))
  handle(IPC.projects.archive, projectIdSchema, ({ id }) => projects.archive(id))
  handle(IPC.projects.restore, projectIdSchema, ({ id }) => projects.restore(id))

  handle(IPC.onboarding.start, projectIdInputSchema, ({ projectId }) => onboarding.start(projectId))

  handle(IPC.teamLead.send, sendMessageInputSchema, ({ projectId, text }) => teamLead.send(projectId, text))
  handle(IPC.teamLead.interrupt, projectIdInputSchema, ({ projectId }) => {
    teamLead.interrupt(projectId)
    return null
  })
  handle(IPC.teamLead.history, projectIdInputSchema, ({ projectId }) => teamLead.history(projectId))
}
