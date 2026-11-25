import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../../../database/client'
import { activityEvents, developerAgents } from '../../../database/schema'
import { ACTIVE_AGENT_STATUSES, type AgentStatus, type DeveloperAgent } from '@shared/schemas/agent'

type Row = typeof developerAgents.$inferSelect

export interface NewAgent {
  id: string
  projectId: string
  taskId: string
  name: string
  claudeSessionId: string
  worktreePath: string
  branch: string
  baseBranch: string
  baseCommit: string
  /** Defaults to planning. */
  kind?: 'planning' | 'execution'
}

/** Internal view: includes values the renderer must not see (session id, base commit, pid). */
export interface AgentRecord extends DeveloperAgent {
  claudeSessionId: string
  baseCommit: string
  pid: number | null
}

const toRecord = (r: Row): AgentRecord => ({
  id: r.id,
  projectId: r.projectId,
  taskId: r.taskId,
  name: r.name,
  status: r.status,
  kind: r.kind,
  currentActivity: r.currentActivity,
  worktreePath: r.worktreePath,
  branch: r.branch,
  baseBranch: r.baseBranch,
  worktreeRemoved: r.worktreeRemoved,
  exitCode: r.exitCode,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  claudeSessionId: r.claudeSessionId,
  baseCommit: r.baseCommit,
  pid: r.pid
})

/** What the renderer is allowed to see. */
export const toPublicAgent = (a: AgentRecord): DeveloperAgent => {
  const { claudeSessionId: _s, baseCommit: _b, pid: _p, ...pub } = a
  return pub
}

export class AgentRepository {
  constructor(private readonly db: Db) {}

  create(input: NewAgent): AgentRecord {
    return this.db.transaction((tx) => {
      const row = tx.insert(developerAgents).values({ ...input, status: 'starting' }).returning().get()
      this.event(tx, input.projectId, 'agent.created', { agentId: input.id, taskId: input.taskId, branch: input.branch })
      return toRecord(row)
    })
  }

  get(id: string): AgentRecord | undefined {
    const r = this.db.select().from(developerAgents).where(eq(developerAgents.id, id)).get()
    return r && toRecord(r)
  }

  list(projectId: string): AgentRecord[] {
    return this.db
      .select()
      .from(developerAgents)
      .where(eq(developerAgents.projectId, projectId))
      .orderBy(desc(developerAgents.createdAt), desc(sql`rowid`))
      .all()
      .map(toRecord)
  }

  listAll(): AgentRecord[] {
    return this.db.select().from(developerAgents).all().map(toRecord)
  }

  /** Every agent that works in the same worktree (a planning agent and the execution agent that follows it share one). */
  listByWorktree(worktreePath: string): AgentRecord[] {
    return this.db.select().from(developerAgents).where(eq(developerAgents.worktreePath, worktreePath)).all().map(toRecord)
  }

  /** Marks every agent that shares a worktree as having lost it. */
  markWorktreeRemovedByPath(worktreePath: string): void {
    this.db.update(developerAgents).set({ worktreeRemoved: true, updatedAt: Date.now() }).where(eq(developerAgents.worktreePath, worktreePath)).run()
  }

  activeForTask(taskId: string): AgentRecord | undefined {
    const r = this.db
      .select()
      .from(developerAgents)
      .where(and(eq(developerAgents.taskId, taskId), inArray(developerAgents.status, [...ACTIVE_AGENT_STATUSES])))
      .get()
    return r && toRecord(r)
  }

  /** Agents recorded as alive, with the pid and session id needed to find a process a crash left behind. */
  listActive(): AgentRecord[] {
    return this.db.select().from(developerAgents).where(inArray(developerAgents.status, [...ACTIVE_AGENT_STATUSES])).all().map(toRecord)
  }

  countActive(): number {
    const r = this.db
      .select({ n: sql<number>`count(*)` })
      .from(developerAgents)
      .where(inArray(developerAgents.status, [...ACTIVE_AGENT_STATUSES]))
      .get()
    return r?.n ?? 0
  }

  markRunning(id: string, pid: number): AgentRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx
        .update(developerAgents)
        .set({ status: 'running', pid, startedAt: Date.now(), updatedAt: Date.now() })
        .where(and(eq(developerAgents.id, id), eq(developerAgents.status, 'starting')))
        .returning()
        .get()
      if (!row) return undefined
      this.event(tx, row.projectId, 'agent.started', { agentId: id, pid })
      return toRecord(row)
    })
  }

  /** Records how an agent ended. Only applies to an agent that is still active. */
  finish(id: string, status: Exclude<AgentStatus, 'starting' | 'running'>, exitCode: number | null, activity: string): AgentRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx
        .update(developerAgents)
        .set({ status, exitCode, pid: null, currentActivity: activity, endedAt: Date.now(), updatedAt: Date.now() })
        .where(and(eq(developerAgents.id, id), inArray(developerAgents.status, [...ACTIVE_AGENT_STATUSES])))
        .returning()
        .get()
      if (!row) return undefined
      this.event(tx, row.projectId, `agent.${status}`, { agentId: id, exitCode })
      return toRecord(row)
    })
  }

  setActivity(id: string, activity: string): void {
    this.db.update(developerAgents).set({ currentActivity: activity, updatedAt: Date.now() }).where(eq(developerAgents.id, id)).run()
  }

  markWorktreeRemoved(id: string): AgentRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.update(developerAgents).set({ worktreeRemoved: true, updatedAt: Date.now() }).where(eq(developerAgents.id, id)).returning().get()
      if (!row) return undefined
      this.event(tx, row.projectId, 'agent.worktree_removed', { agentId: id })
      return toRecord(row)
    })
  }

  /** On startup: no process survives an app exit, so anything still "active" was interrupted. */
  markInterruptedAll(): AgentRecord[] {
    return this.db.transaction((tx) => {
      const rows = tx
        .update(developerAgents)
        .set({ status: 'interrupted', pid: null, endedAt: Date.now(), updatedAt: Date.now() })
        .where(inArray(developerAgents.status, [...ACTIVE_AGENT_STATUSES]))
        .returning()
        .all()
      for (const r of rows) this.event(tx, r.projectId, 'agent.interrupted', { agentId: r.id })
      return rows.map(toRecord)
    })
  }

  private event(tx: DbOrTx, projectId: string, type: string, payload: Record<string, unknown>): void {
    tx.insert(activityEvents).values({ id: randomUUID(), projectId, type, payload }).run()
  }

}
