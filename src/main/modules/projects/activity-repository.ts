import { desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../database/client'
import { activityEvents } from '../../database/schema'
import type { ActivityEvent } from '@shared/schemas/task'

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
}
