import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDatabase } from '../src/main/database/client'
import { ProjectRepository } from '../src/main/modules/projects/repository'
import { ProjectService } from '../src/main/modules/projects/service'
import { inspectRepository } from '../src/main/modules/git/inspect'

export const tempDir = (prefix = 'orbyte-test-') => mkdtempSync(join(tmpdir(), prefix))

export function makeService(now?: () => number) {
  const handle = openDatabase(':memory:', resolve(__dirname, '../drizzle'))
  const repo = new ProjectRepository(handle.db)
  return { handle, repo, service: new ProjectService({ repo, inspect: inspectRepository, now }) }
}
