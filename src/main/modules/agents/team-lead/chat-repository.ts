import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../../database/client'
import { chatMessages } from '../../../database/schema'
import type { ChatMessage } from '@shared/schemas/team-lead'

export class ChatRepository {
  constructor(private readonly db: Db) {}

  add(projectId: string, role: ChatMessage['role'], content: string): ChatMessage {
    return this.db.insert(chatMessages).values({ id: randomUUID(), projectId, role, content }).returning().get()
  }

  /** Oldest first, in insertion order (rowid breaks same-millisecond ties; uuids are random). */
  list(projectId: string): ChatMessage[] {
    return this.db.select().from(chatMessages).where(eq(chatMessages.projectId, projectId)).orderBy(asc(chatMessages.createdAt), asc(sql`rowid`)).all()
  }
}
