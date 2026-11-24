import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../../database/client'
import { activityEvents, projects, taskDependencies, tasks } from '../../database/schema'
import type { Task, TaskPriority } from '@shared/schemas/task'
import type { TaskStatus, TransitionActor } from '@shared/task-state'
import type { TaskIndexEntry } from './dependencies'

type Row = typeof tasks.$inferSelect

export interface NewTask {
  id?: string
  projectId: string
  title: string
  description: string
  priority: TaskPriority
  source: 'user' | 'team_lead'
  dependsOnTaskIds: string[]
}
export interface TaskPatch {
  title?: string
  description?: string
  priority?: TaskPriority
  dependsOnTaskIds?: string[]
}

const toTask = (r: Row, deps: string[]): Task => ({
  id: r.id,
  projectId: r.projectId,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  dependsOnTaskIds: deps,
  assignedAgentId: r.assignedAgentId,
  implementationPlan: r.implementationPlan,
  approvalStatus: r.approvalStatus,
  executionStatus: r.executionStatus,
  resultSummary: r.resultSummary,
  source: r.source,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
})

export class TaskRepository {
  constructor(private readonly db: Db) {}

  /** Runs `fn` in the caller's transaction, or in a new one. */
  private inTx<T>(tx: DbOrTx | undefined, fn: (t: DbOrTx) => T): T {
    return tx ? fn(tx) : this.db.transaction((t) => fn(t))
  }

  list(projectId: string): Task[] {
    const rows = this.db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(asc(tasks.createdAt), asc(sql`rowid`)).all()
    const deps = this.depsByTask(rows.map((r) => r.id))
    return rows.map((r) => toTask(r, deps.get(r.id) ?? []))
  }

  get(taskId: string): Task | undefined {
    const r = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    return r && toTask(r, this.depsByTask([r.id]).get(r.id) ?? [])
  }

  /** Lookup structures for dependency validation within one project. */
  graph(projectId: string): { index: Map<string, TaskIndexEntry>; edges: Map<string, string[]> } {
    const rows = this.db.select({ id: tasks.id, projectId: tasks.projectId, status: tasks.status }).from(tasks).where(eq(tasks.projectId, projectId)).all()
    const index = new Map(rows.map((r) => [r.id, { projectId: r.projectId, status: r.status }]))
    return { index, edges: this.depsByTask(rows.map((r) => r.id)) }
  }

  create(input: NewTask, tx?: DbOrTx): Task {
    return this.inTx(tx, (t) => {
      const id = input.id ?? randomUUID()
      const row = t
        .insert(tasks)
        .values({ id, projectId: input.projectId, title: input.title, description: input.description, priority: input.priority, source: input.source })
        .returning()
        .get()
      for (const dep of input.dependsOnTaskIds) t.insert(taskDependencies).values({ taskId: id, dependsOnTaskId: dep }).run()
      this.event(t, input.projectId, 'task.created', { taskId: id, title: input.title, source: input.source })
      return toTask(row, input.dependsOnTaskIds)
    })
  }

  update(taskId: string, patch: TaskPatch, tx?: DbOrTx): Task | undefined {
    return this.inTx(tx, (t) => {
      const { dependsOnTaskIds, ...fields } = patch
      const row = t.update(tasks).set({ ...fields, updatedAt: Date.now() }).where(eq(tasks.id, taskId)).returning().get()
      if (!row) return undefined
      if (dependsOnTaskIds) {
        t.delete(taskDependencies).where(eq(taskDependencies.taskId, taskId)).run()
        for (const dep of dependsOnTaskIds) t.insert(taskDependencies).values({ taskId, dependsOnTaskId: dep }).run()
      }
      this.event(t, row.projectId, 'task.updated', { taskId, fields: Object.keys(patch) })
      const deps = t.select({ d: taskDependencies.dependsOnTaskId }).from(taskDependencies).where(eq(taskDependencies.taskId, taskId)).all()
      return toTask(row, deps.map((d) => d.d))
    })
  }

  /** Compare-and-set on the current status, so two racing moves cannot both apply. */
  setStatus(taskId: string, from: TaskStatus, to: TaskStatus, actor: TransitionActor): Task | undefined {
    return this.db.transaction((t) => {
      const row = t.update(tasks).set({ status: to, updatedAt: Date.now() }).where(and(eq(tasks.id, taskId), eq(tasks.status, from))).returning().get()
      if (!row) return undefined
      this.event(t, row.projectId, 'task.transitioned', { taskId, from, to, actor })
      const deps = t.select({ d: taskDependencies.dependsOnTaskId }).from(taskDependencies).where(eq(taskDependencies.taskId, taskId)).all()
      return toTask(row, deps.map((d) => d.d))
    })
  }

  /** Keeps the task's plan text and approval column in step with the plan and approval records. */
  setPlanState(taskId: string, patch: { implementationPlan?: string; approvalStatus?: Task['approvalStatus'] }, tx?: DbOrTx): void {
    this.inTx(tx, (t) => {
      t.update(tasks).set({ ...patch, updatedAt: Date.now() }).where(eq(tasks.id, taskId)).run()
    })
  }

  /** The orchestrator's record of execution, kept in step with the execution records. Never set from an agent's claim. */
  setExecutionState(taskId: string, patch: { executionStatus?: Task['executionStatus']; resultSummary?: string | null }, tx?: DbOrTx): void {
    this.inTx(tx, (t) => {
      t.update(tasks).set({ ...patch, updatedAt: Date.now() }).where(eq(tasks.id, taskId)).run()
    })
  }

  /** Counts by status across projects that are not archived. */
  summary(): { open: number; byStatus: Record<string, number> } {
    const rows = this.db
      .select({ status: tasks.status, n: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(ne(projects.status, 'archived'))
      .groupBy(tasks.status)
      .all()
    const byStatus: Record<string, number> = {}
    let open = 0
    for (const r of rows) {
      byStatus[r.status] = r.n
      if (r.status !== 'completed' && r.status !== 'cancelled') open += r.n
    }
    return { open, byStatus }
  }

  private depsByTask(ids: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>()
    if (ids.length === 0) return map
    for (const r of this.db.select().from(taskDependencies).where(inArray(taskDependencies.taskId, ids)).all()) {
      const list = map.get(r.taskId) ?? []
      list.push(r.dependsOnTaskId)
      map.set(r.taskId, list)
    }
    return map
  }

  private event(tx: DbOrTx, projectId: string, type: string, payload: Record<string, unknown>): void {
    tx.insert(activityEvents).values({ id: randomUUID(), projectId, type, payload }).run()
  }
}
