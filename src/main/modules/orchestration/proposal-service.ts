import { AppError } from '@shared/types/result'
import { MAX_DEPENDENCIES, type ProposalItem, type ProposeTasksInput, type Task, type TaskProposal } from '@shared/schemas/task'
import type { AppEvent } from '@shared/schemas/team-lead'
import type { Db } from '../../database/client'
import type { ProjectRepository } from '../projects/repository'
import { topologicalOrder, validateTaskDependencies } from '../tasks/dependencies'
import type { TaskRepository } from '../tasks/repository'
import type { ProposalRepository } from './proposal-repository'
import { log } from '../../logging/logger'

export const MAX_PENDING_PROPOSALS = 5

/**
 * The authorization boundary for Team Lead task suggestions. The Team Lead can only RECORD a
 * proposal here. Tasks come into existence solely through approve(), which the renderer calls
 * on the user's behalf. There is no code path from the Team Lead to a created task.
 */
export class ProposalService {
  constructor(
    private readonly deps: {
      db: Db
      projects: Pick<ProjectRepository, 'get'>
      tasks: TaskRepository
      proposals: ProposalRepository
      emit: (event: AppEvent) => void
    }
  ) {}

  list(projectId: string): TaskProposal[] {
    this.requireProject(projectId)
    return this.deps.proposals.list(projectId)
  }

  /** Called from the Team Lead's tool. `projectId` comes from the server, never from the model. */
  record(projectId: string, input: ProposeTasksInput): { proposalId: string; count: number } {
    this.requireActiveProject(projectId)
    if (this.deps.proposals.countPending(projectId) >= MAX_PENDING_PROPOSALS) {
      throw new AppError('TOO_MANY_PROPOSALS', `There are already ${MAX_PENDING_PROPOSALS} proposals waiting for the user. Ask them to review those first.`)
    }
    const items: ProposalItem[] = input.tasks.map((t, key) => ({
      key,
      title: t.title,
      description: t.description,
      priority: t.priority,
      dependsOnKeys: t.dependsOnIndexes,
      dependsOnTaskIds: t.dependsOnTaskIds
    }))
    this.validateItems(projectId, items, items.map((i) => i.key))
    const proposal = this.deps.proposals.create(projectId, input.summary ?? '', items)
    this.safeEmit({ type: 'proposals_changed', projectId })
    return { proposalId: proposal.id, count: items.length }
  }

  /** The user's decision: create the given (possibly edited, possibly partial) tasks, atomically. */
  approve(projectId: string, proposalId: string, selected: ProposalItem[]): Task[] {
    this.requireActiveProject(projectId)
    const proposal = this.requireProposal(projectId, proposalId)
    if (proposal.status !== 'pending') throw new AppError('ALREADY_DECIDED', 'This proposal has already been decided.')

    const known = new Set(proposal.items.map((i) => i.key))
    const keys = selected.map((i) => i.key)
    if (new Set(keys).size !== keys.length) throw new AppError('INVALID_PROPOSAL', 'A task appears twice in the selection.')
    if (keys.some((k) => !known.has(k))) throw new AppError('INVALID_PROPOSAL', 'The selection contains a task that is not part of this proposal.')
    this.validateItems(projectId, selected, keys)

    const order = topologicalOrder(keys, new Map(selected.map((i) => [i.key, i.dependsOnKeys])))
    if (!order) throw new AppError('INVALID_DEPENDENCY', 'These dependencies would create a cycle.')
    const byKey = new Map(selected.map((i) => [i.key, i]))

    // All tasks and the decision are written in one transaction: either everything is created or nothing is.
    const created = this.deps.db.transaction((tx) => {
      const idByKey = new Map<number, string>()
      const tasks: Task[] = []
      for (const key of order) {
        const item = byKey.get(key)!
        const dependsOn = [...item.dependsOnKeys.map((k) => idByKey.get(k)!), ...item.dependsOnTaskIds]
        const task = this.deps.tasks.create(
          { projectId, title: item.title, description: item.description, priority: item.priority, source: 'team_lead', dependsOnTaskIds: dependsOn },
          tx
        )
        idByKey.set(key, task.id)
        tasks.push(task)
      }
      const decided = this.deps.proposals.decide(proposalId, 'approved', tasks.map((t) => t.id), tx)
      if (!decided) throw new AppError('ALREADY_DECIDED', 'This proposal has already been decided.')
      return tasks
    })
    this.safeEmit({ type: 'tasks_changed', projectId })
    this.safeEmit({ type: 'proposals_changed', projectId })
    return created
  }

  dismiss(projectId: string, proposalId: string): TaskProposal {
    this.requireActiveProject(projectId)
    const proposal = this.requireProposal(projectId, proposalId)
    if (proposal.status !== 'pending') throw new AppError('ALREADY_DECIDED', 'This proposal has already been decided.')
    const decided = this.deps.db.transaction((tx) => this.deps.proposals.decide(proposalId, 'dismissed', [], tx))
    if (!decided) throw new AppError('ALREADY_DECIDED', 'This proposal has already been decided.')
    this.safeEmit({ type: 'proposals_changed', projectId })
    return decided
  }

  /** Item-level rules shared by recording and approval. `keys` are the items that will exist together. */
  private validateItems(projectId: string, items: ProposalItem[], keys: number[]): void {
    const keySet = new Set(keys)
    const { index, edges } = this.deps.tasks.graph(projectId)
    for (const item of items) {
      if (new Set(item.dependsOnKeys).size !== item.dependsOnKeys.length) throw new AppError('INVALID_DEPENDENCY', `"${item.title}": dependencies must not repeat.`)
      if (item.dependsOnKeys.length + item.dependsOnTaskIds.length > MAX_DEPENDENCIES) throw new AppError('INVALID_DEPENDENCY', `"${item.title}": a task can have at most ${MAX_DEPENDENCIES} dependencies.`)
      for (const k of item.dependsOnKeys) {
        if (k === item.key) throw new AppError('INVALID_DEPENDENCY', `"${item.title}" cannot depend on itself.`)
        if (!keySet.has(k)) throw new AppError('INVALID_DEPENDENCY', `"${item.title}" depends on a task that is not included.`)
      }
      const error = validateTaskDependencies({ projectId, taskId: null, dependsOn: item.dependsOnTaskIds, index, edges })
      if (error) throw new AppError('INVALID_DEPENDENCY', `"${item.title}": ${error}`)
    }
    if (!topologicalOrder(keys, new Map(items.map((i) => [i.key, i.dependsOnKeys])))) {
      throw new AppError('INVALID_DEPENDENCY', 'These dependencies would create a cycle.')
    }
  }

  private requireProposal(projectId: string, proposalId: string): TaskProposal {
    const proposal = this.deps.proposals.get(proposalId)
    // Same error for "missing" and "belongs to another project".
    if (!proposal || proposal.projectId !== projectId) throw new AppError('NOT_FOUND', 'Proposal not found.')
    return proposal
  }

  private requireProject(projectId: string) {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new AppError('NOT_FOUND', 'Project not found.')
    return project
  }

  private requireActiveProject(projectId: string): void {
    if (this.requireProject(projectId).status === 'archived') {
      throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    }
  }

  private safeEmit(event: AppEvent): void {
    try {
      this.deps.emit(event)
    } catch (err) {
      log.error('[proposals] failed to emit event', err)
    }
  }
}
