import { randomUUID } from 'node:crypto'
import { desc, eq, ne } from 'drizzle-orm'
import type { Db } from '../../database/client'
import { activityEvents, projects } from '../../database/schema'
import type { OnboardingData } from '@shared/schemas/onboarding'
import type { Project } from '@shared/schemas/project'

type Row = typeof projects.$inferSelect
export interface NewProject {
  name: string
  description: string
  repoPath: string
  defaultBranch: string | null
  isGitRepo: boolean
}
export type OnboardingStatus = Project['onboardingStatus']

const toProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  repoPath: r.repoPath,
  defaultBranch: r.defaultBranch,
  isGitRepo: r.isGitRepo,
  status: r.status,
  onboardingStatus: r.onboardingStatus,
  teamLeadSessionId: r.teamLeadSessionId,
  onboardingData: r.onboardingData ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
})

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): Project[] {
    const q = this.db.select().from(projects)
    const rows = (includeArchived ? q : q.where(ne(projects.status, 'archived'))).orderBy(desc(projects.createdAt)).all()
    return rows.map(toProject)
  }

  get(id: string): Project | undefined {
    const r = this.db.select().from(projects).where(eq(projects.id, id)).get()
    return r && toProject(r)
  }

  findByPath(repoPath: string): Project | undefined {
    const r = this.db.select().from(projects).where(eq(projects.repoPath, repoPath)).get()
    return r && toProject(r)
  }

  /** Inserts the project and its audit event atomically. */
  create(input: NewProject): Project {
    const id = randomUUID()
    return this.db.transaction((tx) => {
      const row = tx.insert(projects).values({ id, ...input }).returning().get()
      this.event(tx, id, 'project.registered', { repoPath: input.repoPath })
      return toProject(row)
    })
  }

  /** Archive/restore. Returns undefined if the project does not exist. */
  setStatus(id: string, status: 'active' | 'archived'): Project | undefined {
    return this.db.transaction((tx) => {
      const row = tx.update(projects).set({ status, updatedAt: Date.now() }).where(eq(projects.id, id)).returning().get()
      if (!row) return undefined
      this.event(tx, id, status === 'archived' ? 'project.archived' : 'project.restored', {})
      return toProject(row)
    })
  }

  /** Records an onboarding transition and its audit event atomically. */
  setOnboarding(
    id: string,
    status: OnboardingStatus,
    data: OnboardingData | null,
    eventType: string,
    payload: Record<string, unknown> = {}
  ): Project | undefined {
    return this.db.transaction((tx) => {
      const row = tx
        .update(projects)
        .set({ onboardingStatus: status, onboardingData: data, updatedAt: Date.now() })
        .where(eq(projects.id, id))
        .returning()
        .get()
      if (!row) return undefined
      this.event(tx, id, eventType, { status, ...payload })
      return toProject(row)
    })
  }

  setTeamLeadSession(id: string, sessionId: string | null): void {
    this.db.transaction((tx) => {
      tx.update(projects).set({ teamLeadSessionId: sessionId, updatedAt: Date.now() }).where(eq(projects.id, id)).run()
      this.event(tx, id, sessionId ? 'teamlead.session_started' : 'teamlead.session_cleared', {})
    })
  }

  /** On startup: any onboarding left in_progress was interrupted by an exit. */
  markInterruptedOnboardings(): string[] {
    return this.db.transaction((tx) => {
      const stuck = tx.select().from(projects).where(eq(projects.onboardingStatus, 'in_progress')).all()
      for (const p of stuck) {
        const data: OnboardingData = { ...(p.onboardingData ?? {}), error: { code: 'INTERRUPTED', message: 'Onboarding was interrupted when the app closed. Retry to continue.' } }
        tx.update(projects).set({ onboardingStatus: 'failed', onboardingData: data, updatedAt: Date.now() }).where(eq(projects.id, p.id)).run()
        this.event(tx, p.id, 'onboarding.interrupted', {})
      }
      return stuck.map((p) => p.id)
    })
  }

  private event(tx: Pick<Db, 'insert'>, projectId: string, type: string, payload: Record<string, unknown>): void {
    tx.insert(activityEvents).values({ id: randomUUID(), projectId, type, payload }).run()
  }
}
