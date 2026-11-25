import { IPC } from '@shared/constants/ipc'
import {
  activityListInputSchema,
  recentActivityInputSchema,
  approveProposalInputSchema,
  createTaskInputSchema,
  dismissProposalInputSchema,
  projectScopedInputSchema,
  transitionTaskInputSchema,
  updateTaskInputSchema
} from '@shared/schemas/task'
import type { ProposalService } from '../modules/orchestration/proposal-service'
import type { ActivityRepository } from '../modules/projects/activity-repository'
import type { ProjectService } from '../modules/projects/service'
import type { TaskService } from '../modules/tasks/service'
import { handle } from './handle'

export function registerTaskHandlers(deps: {
  tasks: TaskService
  proposals: ProposalService
  activity: ActivityRepository
  projects: Pick<ProjectService, 'get'>
}): void {
  const { tasks, proposals, activity, projects } = deps

  handle(IPC.tasks.list, projectScopedInputSchema, ({ projectId }) => tasks.list(projectId))
  handle(IPC.tasks.create, createTaskInputSchema, (input) => tasks.create(input))
  handle(IPC.tasks.update, updateTaskInputSchema, (input) => tasks.update(input))
  // The renderer can only ever act as the user. The orchestrator actor is not reachable from here.
  handle(IPC.tasks.transition, transitionTaskInputSchema, ({ projectId, taskId, to }) => tasks.transition(projectId, taskId, to, 'user'))
  handle(IPC.tasks.summary, null, () => tasks.summary())

  handle(IPC.proposals.list, projectScopedInputSchema, ({ projectId }) => proposals.list(projectId))
  handle(IPC.proposals.approve, approveProposalInputSchema, ({ projectId, proposalId, items }) => proposals.approve(projectId, proposalId, items))
  handle(IPC.proposals.dismiss, dismissProposalInputSchema, ({ projectId, proposalId }) => proposals.dismiss(projectId, proposalId))

  handle(IPC.activity.list, activityListInputSchema, ({ projectId, limit }) => {
    projects.get(projectId) // throws NOT_FOUND for an unknown project
    return activity.list(projectId, limit)
  })
  handle(IPC.activity.listRecent, recentActivityInputSchema, ({ limit }) => activity.listRecent(limit))
}
