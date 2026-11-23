import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../../database/client'
import { activityEvents, taskProposals } from '../../database/schema'
import type { ProposalItem, TaskProposal } from '@shared/schemas/task'

type Row = typeof taskProposals.$inferSelect

const toProposal = (r: Row): TaskProposal => ({
  id: r.id,
  projectId: r.projectId,
  summary: r.summary,
  items: r.items,
  status: r.status,
  createdTaskIds: r.createdTaskIds,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt
})

export class ProposalRepository {
  constructor(private readonly db: Db) {}

  create(projectId: string, summary: string, items: ProposalItem[]): TaskProposal {
    return this.db.transaction((tx) => {
      const row = tx.insert(taskProposals).values({ id: randomUUID(), projectId, summary, items }).returning().get()
      this.event(tx, projectId, 'proposal.recorded', { proposalId: row.id, count: items.length })
      return toProposal(row)
    })
  }

  get(id: string): TaskProposal | undefined {
    const r = this.db.select().from(taskProposals).where(eq(taskProposals.id, id)).get()
    return r && toProposal(r)
  }

  /** Pending first, then newest. */
  list(projectId: string): TaskProposal[] {
    return this.db
      .select()
      .from(taskProposals)
      .where(eq(taskProposals.projectId, projectId))
      .orderBy(asc(sql`case ${taskProposals.status} when 'pending' then 0 else 1 end`), desc(taskProposals.createdAt), desc(sql`rowid`))
      .all()
      .map(toProposal)
  }

  countPending(projectId: string): number {
    const r = this.db
      .select({ n: sql<number>`count(*)` })
      .from(taskProposals)
      .where(and(eq(taskProposals.projectId, projectId), eq(taskProposals.status, 'pending')))
      .get()
    return r?.n ?? 0
  }

  /** Compare-and-set from pending, so a proposal can be decided only once. Joins the caller's transaction. */
  decide(id: string, status: 'approved' | 'dismissed', createdTaskIds: string[], tx: DbOrTx): TaskProposal | undefined {
    const row = tx
      .update(taskProposals)
      .set({ status, createdTaskIds, decidedAt: Date.now() })
      .where(and(eq(taskProposals.id, id), eq(taskProposals.status, 'pending')))
      .returning()
      .get()
    if (!row) return undefined
    this.event(tx, row.projectId, status === 'approved' ? 'proposal.approved' : 'proposal.dismissed', { proposalId: id, taskIds: createdTaskIds })
    return toProposal(row)
  }

  private event(tx: DbOrTx, projectId: string, type: string, payload: Record<string, unknown>): void {
    tx.insert(activityEvents).values({ id: randomUUID(), projectId, type, payload }).run()
  }
}
