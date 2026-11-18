import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../../database/client'
import { activityEvents, projects } from '../../database/schema'
import type { Project } from '@shared/schemas/project'

type Row = typeof projects.$inferSelect
export interface NewProject {
  name: string
  description: string
  repoPath: string
  defaultBranch: string | null
  isGitRepo: boolean
}

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
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
})

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  list(): Project[] {
    return this.db.select().from(projects).orderBy(desc(projects.createdAt)).all().map(toProject)
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
      tx.insert(activityEvents)
        .values({ id: randomUUID(), projectId: id, type: 'project.registered', payload: { repoPath: input.repoPath } })
        .run()
      return toProject(row)
    })
  }

  remove(id: string): boolean {
    return this.db.delete(projects).where(eq(projects.id, id)).run().changes > 0
  }
}
