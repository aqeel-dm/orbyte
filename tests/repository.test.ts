import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/database/client'
import { ProjectRepository } from '../src/main/modules/projects/repository'
import { makeStack, tempDir } from './helpers'

describe('ProjectRepository', () => {
  it('maintains updated_at and records audit events on status and onboarding changes', async () => {
    const { projects, addProject, handle } = makeStack()
    const p = addProject()
    await new Promise((r) => setTimeout(r, 5))
    const archived = projects.setStatus(p.id, 'archived')!
    expect(archived.updatedAt).toBeGreaterThan(p.updatedAt)
    const onboarded = projects.setOnboarding(p.id, 'ready', { summary: 's' }, 'onboarding.completed')!
    expect(onboarded.updatedAt).toBeGreaterThanOrEqual(archived.updatedAt)
    expect(projects.setStatus('missing', 'active')).toBeUndefined()
    const types = handle.raw.prepare('select type from activity_events order by rowid').all().map((r) => (r as { type: string }).type)
    expect(types).toEqual(['project.registered', 'project.archived', 'onboarding.completed'])
  })

  it('stores chat messages per project in order and cascades on hard delete of a project row', () => {
    const { chat, addProject, handle } = makeStack()
    const a = addProject(); const b = addProject()
    chat.add(a.id, 'user', 'one'); chat.add(a.id, 'assistant', 'two'); chat.add(b.id, 'user', 'other')
    expect(chat.list(a.id).map((m) => m.content)).toEqual(['one', 'two'])
    handle.raw.prepare('delete from projects where id = ?').run(a.id)
    expect(chat.list(a.id)).toEqual([])
    expect(chat.list(b.id)).toHaveLength(1)
  })

  it('migration 0001 upgrades an existing Phase 1 database without losing data', () => {
    const file = join(tempDir(), 'old.db')
    // Build a database at migration 0000 only, with a row, then open it with all migrations.
    const raw = new Database(file)
    const fs = require('node:fs') as typeof import('node:fs')
    const sql0 = fs.readFileSync(resolve(__dirname, '../drizzle/0000_marvelous_nehzno.sql'), 'utf8').split('--> statement-breakpoint')
    for (const stmt of sql0) raw.exec(stmt)
    raw.exec(`create table __drizzle_migrations (id integer primary key autoincrement, hash text not null, created_at numeric)`)
    raw.prepare("insert into projects (id,name,repo_path,is_git_repo) values ('p1','Old','/old',1)").run()
    const journal = JSON.parse(fs.readFileSync(resolve(__dirname, '../drizzle/meta/_journal.json'), 'utf8')) as { entries: { when: number; tag: string }[] }
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const first = journal.entries[0]!
    const hash = crypto.createHash('sha256').update(fs.readFileSync(resolve(__dirname, `../drizzle/${first.tag}.sql`), 'utf8')).digest('hex')
    raw.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)').run(hash, first.when)
    raw.close()

    const upgraded = openDatabase(file, resolve(__dirname, '../drizzle'))
    const repo = new ProjectRepository(upgraded.db)
    expect(repo.list().map((p) => [p.id, p.onboardingData])).toEqual([['p1', null]])
    expect(upgraded.raw.prepare("select name from sqlite_master where name='chat_messages'").get()).toBeTruthy()
    upgraded.close()
  })
})
