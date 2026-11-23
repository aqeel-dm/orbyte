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

import { ChatRepository } from '../src/main/modules/agents/team-lead/chat-repository'
import type { Project } from '../src/shared/schemas/project'

export function makeStack() {
  const handle = openDatabase(':memory:', resolve(__dirname, '../drizzle'))
  const projects = new ProjectRepository(handle.db)
  const chat = new ChatRepository(handle.db)
  const addProject = (over: Partial<Parameters<ProjectRepository['create']>[0]> = {}): Project =>
    projects.create({ name: 'P', description: '', repoPath: `/tmp/${Math.random()}`, defaultBranch: 'main', isGitRepo: true, ...over })
  return { handle, projects, chat, addProject }
}

/** Raw SDK-shaped messages for fakes. */
export const sdk = {
  init: (session_id: string) => ({ type: 'system', subtype: 'init', session_id }),
  blockStart: () => ({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }),
  delta: (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }),
  tool: (name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name }] } }),
  text: (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  success: (result = '') => ({ type: 'result', subtype: 'success', is_error: false, result }),
  error: (result: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result })
}
