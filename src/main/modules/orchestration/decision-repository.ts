import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../../database/client'
import { projects, taskProposals, tasks } from '../../database/schema'
import type { DecisionItem } from '@shared/schemas/task'

const MAX_ITEMS = 200

/**
 * Read-only: what is waiting for the user's decision right now, in active projects. It decides nothing;
 * approving, dismissing and accepting stay in their own services.
 */
export class DecisionRepository {
  constructor(private readonly db: Db) {}

  list(projectId?: string): DecisionItem[] {
    const inProject = (col: typeof tasks.projectId | typeof taskProposals.projectId) => (projectId ? eq(col, projectId) : undefined)

    const proposals = this.db
      .select({ projectId: taskProposals.projectId, projectName: projects.name, summary: taskProposals.summary, items: taskProposals.items, since: taskProposals.createdAt })
      .from(taskProposals)
      .innerJoin(projects, eq(projects.id, taskProposals.projectId))
      .where(and(eq(taskProposals.status, 'pending'), eq(projects.status, 'active'), inProject(taskProposals.projectId)))
      .all()
      .map((r): DecisionItem => ({
        kind: 'proposal',
        projectId: r.projectId,
        projectName: r.projectName,
        taskId: null,
        title: r.summary.trim() || `${r.items.length} proposed task${r.items.length === 1 ? '' : 's'}`,
        since: r.since
      }))

    const waitingTasks = this.db
      .select({ id: tasks.id, projectId: tasks.projectId, projectName: projects.name, title: tasks.title, status: tasks.status, approvalStatus: tasks.approvalStatus, since: tasks.updatedAt })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(projects.status, 'active'), inProject(tasks.projectId)))
      .all()
      .flatMap((r): DecisionItem[] => {
        const kind = r.status === 'awaiting_approval' && r.approvalStatus === 'pending' ? 'plan' : r.status === 'in_review' ? 'result' : null
        return kind ? [{ kind, projectId: r.projectId, projectName: r.projectName, taskId: r.id, title: r.title, since: r.since }] : []
      })

    return [...proposals, ...waitingTasks].sort((a, b) => a.since - b.since).slice(0, MAX_ITEMS)
  }
}
