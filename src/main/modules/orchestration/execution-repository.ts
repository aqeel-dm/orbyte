import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../../database/client'
import { activityEvents, executionProgress, executionResults, executions, resultDecisions, resultReviews } from '../../database/schema'
import type { Evidence, ExecutionProgress, ExecutionResult, ExecutionRun, ReportedTest, ResultDecision, ResultReview } from '@shared/schemas/execution'

/** A run cannot flood its own record with notes. */
export const MAX_PROGRESS_PER_RUN = 200

const toRun = (r: typeof executions.$inferSelect): ExecutionRun => ({
  id: r.id, projectId: r.projectId, taskId: r.taskId, agentId: r.agentId, planId: r.planId, planVersion: r.planVersion, planHash: r.planHash,
  approvalId: r.approvalId, status: r.status, feedback: r.feedback, startedAt: r.startedAt, endedAt: r.endedAt
})
const toResult = (r: typeof executionResults.$inferSelect): ExecutionResult => ({
  id: r.id, projectId: r.projectId, taskId: r.taskId, executionId: r.executionId, agentId: r.agentId, version: r.version,
  summary: r.summary, tests: r.tests, evidence: r.evidence, status: r.status, submittedAt: r.submittedAt
})
const toReview = (r: typeof resultReviews.$inferSelect): ResultReview => ({
  id: r.id, projectId: r.projectId, taskId: r.taskId, resultId: r.resultId, resultVersion: r.resultVersion, reviewer: r.reviewer,
  recommendation: r.recommendation, summary: r.summary, concerns: r.concerns, createdAt: r.createdAt
})
const toDecision = (r: typeof resultDecisions.$inferSelect): ResultDecision => ({
  id: r.id, projectId: r.projectId, taskId: r.taskId, resultId: r.resultId, resultVersion: r.resultVersion, snapshotHash: r.snapshotHash,
  reviewer: r.reviewer, decision: r.decision, feedback: r.feedback, decidedAt: r.decidedAt, invalidatedAt: r.invalidatedAt, invalidationReason: r.invalidationReason
})

export class ExecutionRepository {
  constructor(private readonly db: Db) {}

  // ---- runs
  createRun(a: { projectId: string; taskId: string; agentId: string; planId: string; planVersion: number; planHash: string; approvalId: string | null; feedback: string | null }): ExecutionRun {
    return this.db.transaction((tx) => {
      const row = tx.insert(executions).values({ id: randomUUID(), ...a }).returning().get()
      this.event(tx, a.projectId, 'execution.started', { taskId: a.taskId, executionId: row.id, agentId: a.agentId, planVersion: a.planVersion, approvalId: a.approvalId, revision: a.feedback !== null })
      return toRun(row)
    })
  }
  getRun(id: string): ExecutionRun | undefined {
    const r = this.db.select().from(executions).where(eq(executions.id, id)).get()
    return r && toRun(r)
  }
  runForAgent(agentId: string): ExecutionRun | undefined {
    const r = this.db.select().from(executions).where(eq(executions.agentId, agentId)).get()
    return r && toRun(r)
  }
  /** Runs still marked running (after a restart none of them has a live process). */
  listRunning(): ExecutionRun[] {
    return this.db.select().from(executions).where(eq(executions.status, 'running')).all().map(toRun)
  }
  listRuns(taskId: string): ExecutionRun[] {
    return this.db.select().from(executions).where(eq(executions.taskId, taskId)).orderBy(desc(executions.startedAt), desc(sql`rowid`)).all().map(toRun)
  }
  /** Ends a run that is still running. A run that already ended is left alone. */
  finishRun(id: string, status: Exclude<ExecutionRun['status'], 'running'>): ExecutionRun | undefined {
    return this.db.transaction((tx) => {
      const row = tx.update(executions).set({ status, endedAt: Date.now() }).where(and(eq(executions.id, id), eq(executions.status, 'running'))).returning().get()
      if (!row) return undefined
      this.event(tx, row.projectId, 'execution.ended', { taskId: row.taskId, executionId: id, status })
      return toRun(row)
    })
  }

  // ---- progress (agent-reported, unverified)
  addProgress(executionId: string, message: string): boolean {
    const n = this.db.select({ n: sql<number>`count(*)` }).from(executionProgress).where(eq(executionProgress.executionId, executionId)).get()?.n ?? 0
    if (n >= MAX_PROGRESS_PER_RUN) return false
    this.db.insert(executionProgress).values({ id: randomUUID(), executionId, message }).run()
    return true
  }
  /** Newest last, across the task's runs. */
  listProgress(taskId: string, limit = 100): ExecutionProgress[] {
    return this.db
      .select({ id: executionProgress.id, executionId: executionProgress.executionId, message: executionProgress.message, createdAt: executionProgress.createdAt })
      .from(executionProgress)
      .innerJoin(executions, eq(executions.id, executionProgress.executionId))
      .where(eq(executions.taskId, taskId))
      .orderBy(desc(executionProgress.createdAt), desc(sql`${executionProgress}.rowid`))
      .limit(limit)
      .all()
      .reverse()
  }

  // ---- results
  getResult(id: string): ExecutionResult | undefined {
    const r = this.db.select().from(executionResults).where(eq(executionResults.id, id)).get()
    return r && toResult(r)
  }
  /** Newest version first. */
  listResults(taskId: string): ExecutionResult[] {
    return this.db.select().from(executionResults).where(eq(executionResults.taskId, taskId)).orderBy(desc(executionResults.version)).all().map(toResult)
  }
  latestResult(taskId: string): ExecutionResult | undefined {
    return this.listResults(taskId)[0]
  }

  /**
   * Stores the next result version, supersedes the previous one and invalidates any standing acceptance in
   * one transaction: a changed result can never stay accepted.
   */
  createResult(a: { run: ExecutionRun; summary: string; tests: ReportedTest[]; evidence: Evidence }): { result: ExecutionResult; invalidatedAcceptance: boolean } {
    return this.db.transaction((tx) => {
      const max = tx.select({ v: sql<number>`coalesce(max(${executionResults.version}), 0)` }).from(executionResults).where(eq(executionResults.taskId, a.run.taskId)).get()?.v ?? 0
      const version = max + 1
      tx.update(executionResults).set({ status: 'superseded' }).where(and(eq(executionResults.taskId, a.run.taskId), eq(executionResults.status, 'current'))).run()
      const invalidated = this.invalidateAcceptance(a.run.taskId, `Superseded by result version ${version}`, tx)
      const row = tx
        .insert(executionResults)
        .values({ id: randomUUID(), projectId: a.run.projectId, taskId: a.run.taskId, executionId: a.run.id, agentId: a.run.agentId, version, summary: a.summary, tests: a.tests, evidence: a.evidence, snapshotHash: a.evidence.snapshotHash })
        .returning()
        .get()
      this.event(tx, a.run.projectId, 'result.submitted', { taskId: a.run.taskId, resultId: row.id, version, executionId: a.run.id })
      return { result: toResult(row), invalidatedAcceptance: invalidated > 0 }
    })
  }

  // ---- Team Lead reviews of results (advice)
  addReview(a: { result: ExecutionResult; recommendation: ResultReview['recommendation']; summary: string; concerns: string[] }): ResultReview {
    return this.db.transaction((tx) => {
      const row = tx
        .insert(resultReviews)
        .values({ id: randomUUID(), projectId: a.result.projectId, taskId: a.result.taskId, resultId: a.result.id, resultVersion: a.result.version, reviewer: 'team_lead', recommendation: a.recommendation, summary: a.summary, concerns: a.concerns })
        .returning()
        .get()
      this.event(tx, a.result.projectId, 'result.reviewed', { taskId: a.result.taskId, resultId: a.result.id, version: a.result.version, recommendation: a.recommendation, reviewer: 'team_lead' })
      return toReview(row)
    })
  }
  listReviews(taskId: string): ResultReview[] {
    return this.db.select().from(resultReviews).where(eq(resultReviews.taskId, taskId)).orderBy(desc(resultReviews.createdAt), desc(sql`rowid`)).all().map(toReview)
  }

  // ---- the user's decisions
  addDecision(a: { result: ExecutionResult; decision: ResultDecision['decision']; feedback: string }, tx: DbOrTx): ResultDecision {
    const row = tx
      .insert(resultDecisions)
      .values({ id: randomUUID(), projectId: a.result.projectId, taskId: a.result.taskId, resultId: a.result.id, resultVersion: a.result.version, snapshotHash: a.result.evidence.snapshotHash, reviewer: 'user', decision: a.decision, feedback: a.feedback })
      .returning()
      .get()
    this.event(tx, a.result.projectId, a.decision === 'accepted' ? 'result.accepted' : 'result.changes_requested', { taskId: a.result.taskId, resultId: a.result.id, version: a.result.version, reviewer: 'user' })
    return toDecision(row)
  }
  listDecisions(taskId: string): ResultDecision[] {
    return this.db.select().from(resultDecisions).where(eq(resultDecisions.taskId, taskId)).orderBy(desc(resultDecisions.decidedAt), desc(sql`rowid`)).all().map(toDecision)
  }
  validAcceptance(taskId: string): ResultDecision | undefined {
    const r = this.db
      .select()
      .from(resultDecisions)
      .where(and(eq(resultDecisions.taskId, taskId), eq(resultDecisions.decision, 'accepted'), isNull(resultDecisions.invalidatedAt)))
      .get()
    return r && toDecision(r)
  }
  /** The user's standing, unused request for changes (it authorizes exactly one revision run). */
  validChangeRequest(taskId: string): ResultDecision | undefined {
    const r = this.db
      .select()
      .from(resultDecisions)
      .where(and(eq(resultDecisions.taskId, taskId), eq(resultDecisions.decision, 'changes_requested'), isNull(resultDecisions.invalidatedAt)))
      .orderBy(desc(resultDecisions.decidedAt), desc(sql`rowid`))
      .get()
    return r && toDecision(r)
  }
  /** Spends a change request. Returns false if it was already spent. */
  consumeChangeRequest(id: string, reason: string, tx: DbOrTx): boolean {
    const rows = tx
      .update(resultDecisions)
      .set({ invalidatedAt: Date.now(), invalidationReason: reason })
      .where(and(eq(resultDecisions.id, id), eq(resultDecisions.decision, 'changes_requested'), isNull(resultDecisions.invalidatedAt)))
      .returning()
      .all()
    return rows.length > 0
  }

  invalidateAcceptance(taskId: string, reason: string, tx: DbOrTx): number {
    const rows = tx
      .update(resultDecisions)
      .set({ invalidatedAt: Date.now(), invalidationReason: reason })
      .where(and(eq(resultDecisions.taskId, taskId), eq(resultDecisions.decision, 'accepted'), isNull(resultDecisions.invalidatedAt)))
      .returning()
      .all()
    for (const r of rows) this.event(tx, r.projectId, 'acceptance.invalidated', { taskId, resultId: r.resultId, version: r.resultVersion, reason })
    return rows.length
  }

  runInTransaction<T>(fn: (tx: DbOrTx) => T): T {
    return this.db.transaction((tx) => fn(tx))
  }

  private event(tx: DbOrTx, projectId: string, type: string, payload: Record<string, unknown>): void {
    tx.insert(activityEvents).values({ id: randomUUID(), projectId, type, payload }).run()
  }

}
