import { AppError } from '@shared/types/result'
import type { CreateTaskInput, Task, TaskSummary, UpdateTaskInput } from '@shared/schemas/task'
import type { AppEvent } from '@shared/schemas/team-lead'
import { CONTENT_EDITABLE, checkTransition, isOpen, type TaskStatus, type TransitionActor, type TransitionContext } from '@shared/task-state'
import type { ProjectRepository } from '../projects/repository'
import { validateTaskDependencies } from './dependencies'
import type { TaskRepository } from './repository'

export interface TaskDigest {
  id: string
  title: string
  status: TaskStatus
  priority: string
  dependsOn: string[]
}

const DIGEST_LIMIT = 100

/**
 * The single place task state changes. Every method takes the project id and checks that the
 * task belongs to it, so one project can never touch another's tasks.
 */
export class TaskService {
  constructor(
    private readonly deps: {
      projects: Pick<ProjectRepository, 'get'>
      tasks: TaskRepository
      emit: (event: AppEvent) => void
    }
  ) {}

  list(projectId: string): Task[] {
    this.requireProject(projectId)
    return this.deps.tasks.list(projectId)
  }

  /** Compact read-only view for the Team Lead: open tasks first, newest first, capped, with the true total. */
  digest(projectId: string): { tasks: TaskDigest[]; total: number } {
    const all = this.list(projectId)
    const ordered = [...all.filter((t) => isOpen(t.status)).reverse(), ...all.filter((t) => !isOpen(t.status)).reverse()]
    return {
      total: all.length,
      tasks: ordered.slice(0, DIGEST_LIMIT).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dependsOn: t.dependsOnTaskIds }))
    }
  }

  summary(): TaskSummary {
    return this.deps.tasks.summary()
  }

  /** A task created directly by the user. (Team Lead tasks only arrive through an approved proposal.) */
  create(input: CreateTaskInput & { projectId: string }): Task {
    this.requireActiveProject(input.projectId)
    const dependsOn = input.dependsOnTaskIds ?? []
    this.checkDependencies(input.projectId, null, dependsOn)
    const task = this.deps.tasks.create({
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? 'medium',
      source: 'user',
      dependsOnTaskIds: dependsOn
    })
    this.changed(input.projectId)
    return task
  }

  update(input: UpdateTaskInput): Task {
    this.requireActiveProject(input.projectId)
    const task = this.requireTask(input.projectId, input.taskId)
    const { dependsOnTaskIds, priority, ...content } = input.patch
    const touchesContent = Object.keys(content).length > 0 || dependsOnTaskIds !== undefined
    if (touchesContent && !CONTENT_EDITABLE.includes(task.status)) {
      throw new AppError('NOT_EDITABLE', `A task in ${task.status} cannot be edited.`)
    }
    if (priority !== undefined && !isOpen(task.status)) throw new AppError('NOT_EDITABLE', `A ${task.status} task cannot be edited.`)
    if (dependsOnTaskIds) this.checkDependencies(input.projectId, task.id, dependsOnTaskIds)
    const updated = this.deps.tasks.update(task.id, input.patch)
    if (!updated) throw new AppError('NOT_FOUND', 'Task not found.')
    this.changed(input.projectId)
    return updated
  }

  /**
   * Moves a task through the state machine. `actor` is fixed to 'user' at the IPC layer; the
   * orchestrator actor and approval context exist for later phases and are unreachable from the renderer.
   */
  transition(projectId: string, taskId: string, to: TaskStatus, actor: TransitionActor, ctx: TransitionContext = {}): Task {
    this.requireActiveProject(projectId)
    const task = this.requireTask(projectId, taskId)
    const check = checkTransition(task.status, to, actor, ctx)
    if (!check.ok) throw new AppError('INVALID_TRANSITION', check.reason)
    const moved = this.deps.tasks.setStatus(task.id, task.status, to, actor)
    if (!moved) throw new AppError('CONFLICT', 'The task changed while you were moving it. Reload and try again.')
    this.changed(projectId)
    return moved
  }

  private checkDependencies(projectId: string, taskId: string | null, dependsOn: string[]): void {
    const { index, edges } = this.deps.tasks.graph(projectId)
    const error = validateTaskDependencies({ projectId, taskId, dependsOn, index, edges })
    if (error) throw new AppError('INVALID_DEPENDENCY', error)
  }

  private requireTask(projectId: string, taskId: string): Task {
    const task = this.deps.tasks.get(taskId)
    // Same error for "missing" and "belongs to another project".
    if (!task || task.projectId !== projectId) throw new AppError('NOT_FOUND', 'Task not found.')
    return task
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

  private changed(projectId: string): void {
    try {
      this.deps.emit({ type: 'tasks_changed', projectId })
    } catch (err) {
      console.error('[tasks] failed to emit event', err)
    }
  }
}
