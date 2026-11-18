import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { openDatabase } from '../src/main/database/client'
import { ProjectRepository } from '../src/main/modules/projects/repository'
import { tempDir } from './helpers'

it('projects survive closing and reopening the database file (WAL, migrated)', () => {
  const file = join(tempDir(), 'orbyte.db')
  const migrations = resolve(__dirname, '../drizzle')

  const first = openDatabase(file, migrations)
  const created = new ProjectRepository(first.db).create({
    name: 'Persisted', description: '', repoPath: '/tmp/x', defaultBranch: 'main', isGitRepo: true
  })
  first.close()

  const second = openDatabase(file, migrations) // re-running migrations must be a no-op
  expect(new ProjectRepository(second.db).list().map((p) => p.id)).toEqual([created.id])
  second.close()
})
