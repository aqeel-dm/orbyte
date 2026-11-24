import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../../database/client'
import { activityEvents, planApprovals, planReviews, taskPlans } from '../../database/schema'
import type { PlanApproval, PlanReview, SubmittedPlan, TaskPlan } from '@shared/schemas/plan'

const toPlan = (r: typeof taskPlans.$inferSelect): TaskPlan => ({
  id: r.id, projectId: r.projectId, taskId: r.taskId, agentId: r.agentId, version: r.version,
  content: r.content, contentHash: r.contentHash, status: r.status, submittedAt: r.submittedAt
})
const toReview = (r: typeof planReviews.$inferSelect): PlanReview => ({
  id: r.id, projectId: r.projectId, taskId: r.taskId, planId: r.planId, planVersion: r.planVersion, reviewer: r.reviewer,
  recommendation: r.recommendation, summary: r.summary, concerns: r.concerns, createdAt: r.createdAt
})
const toApproval = (r: typeof planApprovals.$inferSelect): PlanApproval => ({
  id: r.id, projectId: r.projectId, taskId: r.taskId, agentId: r.agentId, planId: r.planId, planVersion: r.planVersion,
  planHash: r.planHash, reviewer: r.reviewer, status: r.status, reason: r.reason, decidedAt: r.decidedAt,
  invalidatedAt: r.invalidatedAt, invalidationReason: r.invalidationReason
})

export class PlanRepository {
  constructor(private readonly db: Db) {}

  getPlan(id: string): TaskPlan | undefined {
    const r = this.db.select().from(taskPlans).where(eq(taskPlans.id, id)).get()
    return r && toPlan(r)
  }

  /** Newest version first. */
  listPlans(taskId: string): TaskPlan[] {
    return this.db.select().from(taskPlans).where(eq(taskPlans.taskId, taskId)).orderBy(desc(taskPlans.version)).all().map(toPlan)
  }

  latestPlan(taskId: string): TaskPlan | undefined {
    return this.listPlans(taskId)[0]
  }

  listReviews(taskId: string): PlanReview[] {
    return this.db.select().from(planReviews).where(eq(planReviews.taskId, taskId)).orderBy(desc(planReviews.createdAt), desc(sql`rowid`)).all().map(toReview)
  }

  listApprovals(taskId: string): PlanApproval[] {
    return this.db.select().from(planApprovals).where(eq(planApprovals.taskId, taskId)).orderBy(desc(planApprovals.decidedAt), desc(sql`rowid`)).all().map(toApproval)
  }

  validApproval(taskId: string): PlanApproval | undefined {
    const r = this.db
      .select()
      .from(planApprovals)
      .where(and(eq(planApprovals.taskId, taskId), eq(planApprovals.status, 'approved'), isNull(planApprovals.invalidatedAt)))
      .get()
    return r && toApproval(r)
  }

  /**
   * Stores a new plan version, supersedes the previous one and invalidates any standing approval, all
   * in one transaction: a changed plan can never stay approved.
   */
  createVersion(args: { projectId: string; taskId: string; agentId: string; content: SubmittedPlan; hash: string }): { plan: TaskPlan; invalidatedApproval: boolean } {
    return this.db.transaction((tx) => {
      const max = tx.select({ v: sql<number>`coalesce(max(${taskPlans.version}), 0)` }).from(taskPlans).where(eq(taskPlans.taskId, args.taskId)).get()?.v ?? 0
      const version = max + 1
      tx.update(taskPlans).set({ status: 'superseded' }).where(and(eq(taskPlans.taskId, args.taskId), eq(taskPlans.status, 'current'))).run()
      const invalidated = this.invalidate(args.taskId, `Superseded by plan version ${version}`, tx)
      const row = tx
        .insert(taskPlans)
        .values({ id: randomUUID(), projectId: args.projectId, taskId: args.taskId, agentId: args.agentId, version, content: args.content, contentHash: args.hash })
        .returning()
        .get()
      this.event(tx, args.projectId, 'plan.submitted', { taskId: args.taskId, planId: row.id, version, agentId: args.agentId })
      return { plan: toPlan(row), invalidatedApproval: invalidated > 0 }
    })
  }

  addReview(args: { projectId: string; taskId: string; plan: TaskPlan; recommendation: PlanReview['recommendation']; summary: string; concerns: string[] }): PlanReview {
    return this.db.transaction((tx) => {
      const row = tx
        .insert(planReviews)
        .values({ id: randomUUID(), projectId: args.projectId, taskId: args.taskId, planId: args.plan.id, planVersion: args.plan.version, reviewer: 'team_lead', recommendation: args.recommendation, summary: args.summary, concerns: args.concerns })
        .returning()
        .get()
      this.event(tx, args.projectId, 'plan.reviewed', { taskId: args.taskId, planId: args.plan.id, version: args.plan.version, recommendation: args.recommendation, reviewer: 'team_lead' })
      return toReview(row)
    })
  }

  addApproval(args: { plan: TaskPlan; status: 'approved' | 'rejected'; reason: string }, tx: DbOrTx): PlanApproval {
    const row = tx
      .insert(planApprovals)
      .values({
        id: randomUUID(), projectId: args.plan.projectId, taskId: args.plan.taskId, agentId: args.plan.agentId, planId: args.plan.id,
        planVersion: args.plan.version, planHash: args.plan.contentHash, reviewer: 'user', status: args.status, reason: args.reason
      })
      .returning()
      .get()
    this.event(tx, args.plan.projectId, args.status === 'approved' ? 'plan.approved' : 'plan.rejected', { taskId: args.plan.taskId, planId: args.plan.id, version: args.plan.version, reviewer: 'user' })
    return toApproval(row)
  }

  /** Marks any valid approval for the task invalid. Returns how many were invalidated. */
  invalidate(taskId: string, reason: string, tx: DbOrTx): number {
    const rows = tx
      .update(planApprovals)
      .set({ invalidatedAt: Date.now(), invalidationReason: reason })
      .where(and(eq(planApprovals.taskId, taskId), eq(planApprovals.status, 'approved'), isNull(planApprovals.invalidatedAt)))
      .returning()
      .all()
    for (const r of rows) this.event(tx, r.projectId, 'approval.invalidated', { taskId, planId: r.planId, version: r.planVersion, reason })
    return rows.length
  }

  runInTransaction<T>(fn: (tx: DbOrTx) => T): T {
    return this.db.transaction((tx) => fn(tx))
  }

  private event(tx: DbOrTx, projectId: string, type: string, payload: Record<string, unknown>): void {
    tx.insert(activityEvents).values({ id: randomUUID(), projectId, type, payload }).run()
  }
}
