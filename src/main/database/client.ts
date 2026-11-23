import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>
/** A database or an open transaction: lets repository methods join a caller's transaction. */
export type DbOrTx = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>
export interface DbHandle {
  db: Db
  /** Raw better-sqlite3 handle (tests and diagnostics only). */
  raw: Database.Database
  close(): void
}

/** Opens (and migrates) a SQLite database. Pass ':memory:' or a file path. */
export function openDatabase(file: string, migrationsFolder: string): DbHandle {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder })
  return { db, raw: sqlite, close: () => sqlite.close() }
}
