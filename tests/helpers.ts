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
  /** Creates a project; trusted by default so Team Lead tests run. Pass trust: 'unset' for the gate. */
  const addProject = (over: Partial<Parameters<ProjectRepository['create']>[0]> = {}, trust: 'unset' | 'trusted' | 'untrusted' = 'trusted'): Project => {
    const p = projects.create({ name: 'P', description: '', repoPath: `/tmp/${Math.random()}`, defaultBranch: 'main', isGitRepo: true, ...over })
    return trust === 'unset' ? p : projects.setRepoSettingsTrust(p.id, trust)!
  }
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

import { ProposalRepository } from '../src/main/modules/orchestration/proposal-repository'
import { ProposalService } from '../src/main/modules/orchestration/proposal-service'
import { TaskRepository } from '../src/main/modules/tasks/repository'
import { TaskService } from '../src/main/modules/tasks/service'
import type { AppEvent } from '../src/shared/schemas/team-lead'

/** Projects + tasks + proposals on one in-memory database, collecting emitted events. */
export function makeTaskStack() {
  const stack = makeStack()
  const events: AppEvent[] = []
  const emit = (e: AppEvent) => events.push(e)
  const taskRepo = new TaskRepository(stack.handle.db)
  const proposalRepo = new ProposalRepository(stack.handle.db)
  const tasks = new TaskService({ projects: stack.projects, tasks: taskRepo, emit })
  const proposals = new ProposalService({ db: stack.handle.db, projects: stack.projects, tasks: taskRepo, proposals: proposalRepo, emit })
  const eventTypes = (projectId: string) =>
    (stack.handle.raw.prepare('select type from activity_events where project_id = ? order by rowid').all(projectId) as { type: string }[]).map((r) => r.type)
  return { ...stack, events, taskRepo, proposalRepo, tasks, proposals, eventTypes }
}

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'

/** A throwaway git repository. With `commit: false` it has no commits (an "unborn" branch). */
export function makeGitRepo(commit = true): string {
  const dir = realpathSync(tempDir('orbyte-repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  if (commit) {
    writeFileSync(join(dir, 'README.md'), '# demo\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
  }
  return dir
}

import { AgentRepository } from '../src/main/modules/agents/developers/agent-repository'
import { AgentService, type PtyFactory, type PtyProcess } from '../src/main/modules/agents/developers/agent-service'
import { TerminalHub } from '../src/main/modules/agents/developers/terminal-hub'
import { GitWorktrees } from '../src/main/modules/agents/developers/worktrees'

export class FakePty implements PtyProcess {
  pid = 4242
  written: string[] = []
  resized: [number, number][] = []
  killed: string[] = []
  private dataCb: (d: string) => void = () => undefined
  private exitCb: (e: { exitCode: number; signal?: number }) => void = () => undefined
  constructor(readonly file: string, readonly args: string[], readonly opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }, private readonly autoExit: boolean) {}
  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb }
  write(d: string): void { this.written.push(d) }
  resize(c: number, r: number): void { this.resized.push([c, r]) }
  kill(signal?: string): void { this.killed.push(signal ?? 'SIGHUP'); if (this.autoExit) setImmediate(() => this.exit(143)) }
  emit(d: string): void { this.dataCb(d) }
  exit(code: number): void { this.exitCb({ exitCode: code }) }
}

export class FakePtyFactory implements PtyFactory {
  procs: FakePty[] = []
  failNext = false
  /** When true, kill() makes the process exit by itself (a well-behaved process). */
  autoExit = false
  spawn(file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }): PtyProcess {
    if (this.failNext) { this.failNext = false; throw new Error('spawn ENOENT /secret/path/claude') }
    const p = new FakePty(file, args, opts, this.autoExit)
    this.procs.push(p)
    return p
  }
}

/** Real DB, real temp git repo and worktrees, fake processes. */
export function makeAgentStack(opts: { commit?: boolean; trust?: 'unset' | 'trusted' | 'untrusted'; git?: boolean; maxActive?: number; claude?: string | null; env?: NodeJS.ProcessEnv; killGraceMs?: number } = {}) {
  const t = makeTaskStack()
  const repoPath = makeGitRepo(opts.commit ?? true)
  const project = t.addProject({ repoPath, defaultBranch: 'main', isGitRepo: opts.git ?? true }, opts.trust ?? 'trusted')
  const pty = new FakePtyFactory()
  const sent: { windowId: number; agentId: string; data: string }[] = []
  const hub = new TerminalHub((windowId, e) => sent.push({ windowId, agentId: e.agentId, data: e.data }))
  const worktreeRoot = tempDir('orbyte-wt-'); const logDir = tempDir('orbyte-logs-')
  const agentRepo = new AgentRepository(t.handle.db)
  let service!: AgentService
  const tasks = new TaskService({ projects: t.projects, tasks: t.taskRepo, emit: (e) => t.events.push(e), onLeaveActive: (id) => service.onTaskLeft(id) })
  const make = (extra: Partial<ConstructorParameters<typeof AgentService>[0]> = {}) => new AgentService({
    projects: t.projects, taskRepo: t.taskRepo, tasks, agents: agentRepo, worktrees: new GitWorktrees(), pty, hub,
    resolveClaude: () => (opts.claude === undefined ? '/fake/bin/claude' : opts.claude),
    env: () => opts.env ?? { PATH: '/usr/bin', HOME: '/home/u' },
    worktreeRoot, logDir, emit: (e) => t.events.push(e), flushMs: 5, killGraceMs: opts.killGraceMs ?? 30,
    ...(opts.maxActive !== undefined ? { maxActive: opts.maxActive } : {}),
    ...extra
  })
  service = make()
  /** A ready task, as if the user had approved it for work. */
  const readyTask = (title = 'Add login', description = 'Details') => {
    const task = tasks.create({ projectId: project.id, title, description })
    return tasks.transition(project.id, task.id, 'ready', 'user')
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  return { ...t, tasks, repoPath, project, pty, sent, hub, worktreeRoot, logDir, agentRepo, get service() { return service }, restart: (extra: Partial<ConstructorParameters<typeof AgentService>[0]> = {}) => (service = make(extra)), readyTask, sleep }
}
