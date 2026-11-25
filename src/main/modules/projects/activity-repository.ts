import { desc, eq, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../database/client'
import { activityEvents, projects } from '../../database/schema'
import type { ActivityEvent, RecentActivityEvent } from '@shared/schemas/task'

/** Read-only view of the persisted audit trail for a project, newest first. */
export class ActivityRepository {
  constructor(private readonly db: Db) {}

  list(projectId: string, limit = 50): ActivityEvent[] {
    return this.db
      .select({ id: activityEvents.id, type: activityEvents.type, payload: activityEvents.payload, createdAt: activityEvents.createdAt })
      .from(activityEvents)
      .where(eq(activityEvents.projectId, projectId))
      .orderBy(desc(activityEvents.createdAt), desc(sql`rowid`))
      .limit(limit)
      .all()
  }

  /** Newest events of active projects plus app-wide events (no project). Archived projects are left out. */
  listRecent(limit = 20): RecentActivityEvent[] {
    return this.db
      .select({
        id: activityEvents.id,
        type: activityEvents.type,
        payload: activityEvents.payload,
        createdAt: activityEvents.createdAt,
        projectId: activityEvents.projectId,
        projectName: projects.name
      })
      .from(activityEvents)
      .leftJoin(projects, eq(activityEvents.projectId, projects.id))
      .where(or(isNull(activityEvents.projectId), eq(projects.status, 'active')))
      .orderBy(desc(activityEvents.createdAt), desc(sql`${activityEvents}.rowid`))
      .limit(limit)
      .all()
  }
}
