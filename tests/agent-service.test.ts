import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppError } from '../src/shared/types/result'
import { makeAgentStack } from './helpers'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString().trim()
const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try { await (typeof p === 'function' ? p() : p) } catch (e) { return e instanceof AppError ? e.code : 'OTHER' }
  return 'NONE'
}

describe('AgentService.start', () => {
  it('runs a real process in an isolated worktree and moves the task to planning', async () => {
    const s = makeAgentStack({ env: { PATH: '/usr/bin', HOME: '/h', GITHUB_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: 'k' } })
    const task = s.readyTask('Add login')
    const agent = await s.service.start(s.project.id, task.id)

    expect(agent).toMatchObject({ status: 'running', taskId: task.id, baseBranch: 'main', worktreeRemoved: false })
    expect(agent.branch).toMatch(/^orbyte\/add-login-[0-9a-f]{8}$/)
    expect(agent).not.toHaveProperty('claudeSessionId')
    expect(agent).not.toHaveProperty('baseCommit')
    expect(agent).not.toHaveProperty('pid')

    // an isolated worktree on its own branch; the user's own working tree is untouched
    expect(existsSync(join(agent.worktreePath, 'README.md'))).toBe(true)
    expect(agent.worktreePath.startsWith(s.worktreeRoot)).toBe(true)
    expect(git(agent.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(agent.branch)
    expect(git(s.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git(s.repoPath, 'status', '--porcelain')).toBe('')

    // the process: real binary path, args, cwd = worktree, allowlisted env
    const proc = s.pty.procs[0]!
    expect(proc.file).toBe('/fake/bin/claude')
    expect(proc.opts.cwd).toBe(agent.worktreePath)
    expect(proc.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    expect(proc.opts.env).toMatchObject({ ANTHROPIC_API_KEY: 'k' })
    expect(proc.opts.env).not.toHaveProperty('GITHUB_TOKEN')

    expect(s.taskRepo.get(task.id)?.status).toBe('planning')
    expect(s.eventTypes(s.project.id)).toEqual(expect.arrayContaining(['agent.created', 'agent.started', 'task.transitioned']))
    expect(s.events).toContainEqual({ type: 'agent_changed', projectId: s.project.id, agentId: agent.id })
    expect(s.service.list(s.project.id).map((a) => a.id)).toEqual([agent.id])
    expect(s.service.summary()).toEqual({ running: 1 })
  })

  it.each([
    ['trust not decided', { trust: 'unset' as const }, 'TRUST_REQUIRED'],
    ['not a git repository', { git: false }, 'NOT_GIT_REPO'],
    ['claude not installed', { claude: null }, 'CLAUDE_NOT_FOUND']
  ])('is refused when %s, before anything is created', async (_n, opts, expected) => {
    const s = makeAgentStack(opts)
    const task = s.readyTask()
    expect(await code(s.service.start(s.project.id, task.id))).toBe(expected)
    expect(s.pty.procs).toHaveLength(0)
    expect(s.taskRepo.get(task.id)?.status).toBe('ready')
    expect(s.agentRepo.list(s.project.id)).toEqual([])
  })

  it('only starts a Ready task, but a task with unfinished dependencies may be PLANNED (execution needs them done)', async () => {
    const s = makeAgentStack()
    const backlog = s.tasks.create({ projectId: s.project.id, title: 'Not ready' })
    expect(await code(s.service.start(s.project.id, backlog.id))).toBe('TASK_NOT_READY')
    const dep = s.tasks.create({ projectId: s.project.id, title: 'Dep' })
    const child = s.tasks.create({ projectId: s.project.id, title: 'Child', dependsOnTaskIds: [dep.id] })
    s.tasks.transition(s.project.id, child.id, 'ready', 'user')
    expect((await s.service.start(s.project.id, child.id)).status).toBe('running') // planning is read-only
    expect(s.taskRepo.get(child.id)?.status).toBe('planning')
  })

  it('cannot start a task from another project, or in an archived project', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const other = s.addProject()
    expect(await code(s.service.start(other.id, task.id))).toBe('NOT_FOUND')
    expect(await code(s.service.start('missing', task.id))).toBe('NOT_FOUND')
    s.projects.setStatus(s.project.id, 'archived')
    expect(await code(s.service.start(s.project.id, task.id))).toBe('PROJECT_ARCHIVED')
    expect(s.pty.procs).toHaveLength(0)
  })

  it('two simultaneous starts for one task create exactly one agent', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const results = await Promise.allSettled([s.service.start(s.project.id, task.id), s.service.start(s.project.id, task.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(s.pty.procs).toHaveLength(1)
    expect(s.agentRepo.list(s.project.id)).toHaveLength(1)
  })

  it('limits the number of live agents', async () => {
    const s = makeAgentStack({ maxActive: 1 })
    const a = s.readyTask('A'); const b = s.readyTask('B')
    await s.service.start(s.project.id, a.id)
    expect(await code(s.service.start(s.project.id, b.id))).toBe('TOO_MANY_AGENTS')
    expect(s.taskRepo.get(b.id)?.status).toBe('ready')
  })

  it('the database itself allows only one live agent per task', () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const base = { projectId: s.project.id, taskId: task.id, name: 'x', claudeSessionId: 's', worktreePath: '/p', branch: 'orbyte/x', baseBranch: 'main', baseCommit: 'c' }
    s.agentRepo.create({ id: '11111111-1111-4111-8111-111111111111', ...base })
    expect(() => s.agentRepo.create({ id: '22222222-2222-4222-8222-222222222222', ...base })).toThrow()
  })

  it('rolls everything back when the process cannot be spawned (and does not leak internals)', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    s.pty.failNext = true
    let message = ''
    try { await s.service.start(s.project.id, task.id) } catch (e) { message = e instanceof AppError ? `${e.code}: ${e.message}` : 'other' }
    expect(message).toMatch(/^SPAWN_FAILED/)
    expect(message).not.toContain('/secret')
    expect(s.taskRepo.get(task.id)?.status).toBe('ready') // moved back
    const [agent] = s.agentRepo.list(s.project.id)
    expect(agent).toMatchObject({ status: 'failed', worktreeRemoved: true })
    expect(existsSync(agent!.worktreePath)).toBe(false) // worktree removed
    expect(git(s.repoPath, 'branch', '--list', 'orbyte/*')).toBe('') // unmoved branch removed
    // and the user can simply try again
    expect((await s.service.start(s.project.id, task.id)).status).toBe('running')
  })

  it('leaves the task Ready when there is no commit to start from', async () => {
    const s = makeAgentStack({ commit: false })
    const task = s.readyTask()
    expect(await code(s.service.start(s.project.id, task.id))).toBe('NO_BASE_COMMIT')
    expect(s.taskRepo.get(task.id)?.status).toBe('ready')
    expect(s.pty.procs).toHaveLength(0)
  })
})

describe('AgentService lifecycle', () => {
  it('a clean exit marks the agent exited, returns the task to Ready, and keeps the output', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    s.pty.procs[0]!.emit('hello from claude\r\n')
    s.pty.procs[0]!.exit(0)
    await s.sleep(30)
    expect(s.agentRepo.get(agent.id)).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(s.taskRepo.get(task.id)?.status).toBe('ready')
    expect(readFileSync(join(s.logDir, `${agent.id}.log`), 'utf8')).toContain('hello from claude')
    const attached = await s.service.attach(1, s.project.id, agent.id)
    expect(attached).toEqual({ history: expect.stringContaining('hello from claude'), live: false })
    expect(s.eventTypes(s.project.id)).toContain('agent.exited')
  })

  it('a non-zero exit is reported as failed, honestly', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    s.pty.procs[0]!.exit(1)
    await s.sleep(30)
    expect(s.agentRepo.get(agent.id)).toMatchObject({ status: 'failed', exitCode: 1 })
    expect(s.taskRepo.get(task.id)?.status).toBe('ready')
  })

  it('stop asks the process to end, escalates to SIGKILL if it does not, and records "stopped"', async () => {
    const s = makeAgentStack({ killGraceMs: 20 })
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    s.service.stop(s.project.id, agent.id)
    expect(s.pty.procs[0]!.killed).toEqual(['SIGTERM'])
    await s.sleep(60) // the fake ignores SIGTERM
    expect(s.pty.procs[0]!.killed).toEqual(['SIGTERM', 'SIGKILL'])
    s.pty.procs[0]!.exit(137)
    await s.sleep(30)
    expect(s.agentRepo.get(agent.id)?.status).toBe('stopped')
    expect(await code(() => s.service.stop(s.project.id, agent.id))).toBe('NOT_RUNNING')
  })

  it('cancelling the task in the UI stops its agent, and the task stays cancelled', async () => {
    const s = makeAgentStack()
    s.pty.autoExit = true
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    s.tasks.transition(s.project.id, task.id, 'cancelled', 'user')
    await s.sleep(40)
    expect(s.pty.procs[0]!.killed).toContain('SIGTERM')
    expect(s.agentRepo.get(agent.id)?.status).toBe('stopped')
    expect(s.taskRepo.get(task.id)?.status).toBe('cancelled') // not dragged back to ready
  })

  it('blocking the task also stops the agent', async () => {
    const s = makeAgentStack()
    s.pty.autoExit = true
    const task = s.readyTask()
    await s.service.start(s.project.id, task.id)
    s.tasks.transition(s.project.id, task.id, 'blocked', 'user')
    await s.sleep(40)
    expect(s.pty.procs[0]!.killed).toContain('SIGTERM')
    expect(s.taskRepo.get(task.id)?.status).toBe('blocked')
  })

  it('after an app restart, agents that were active are marked interrupted and their tasks are Ready again', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    const fresh = s.restart() // a new process: nothing is alive
    await fresh.recoverInterrupted()
    expect(s.agentRepo.get(agent.id)).toMatchObject({ status: 'interrupted', pid: null })
    expect(s.taskRepo.get(task.id)?.status).toBe('ready')
    expect(await code(() => fresh.write(s.project.id, agent.id, 'x'))).toBe('NOT_RUNNING')
    expect(s.eventTypes(s.project.id)).toContain('agent.interrupted')
    expect((await fresh.start(s.project.id, task.id)).status).toBe('running') // can be restarted
  })

  it('recovery stops processes left by a crash, verified by pid and session id, before marking agents interrupted', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    const sessionId = s.agentRepo.get(agent.id)!.claudeSessionId
    const calls: [number, string][] = []
    const fresh = s.restart({ reaper: { reap: async (pid, sid) => { calls.push([pid, sid]); return 'killed' } } })
    await fresh.recoverInterrupted()
    expect(calls).toEqual([[4242, sessionId]])
    expect(s.agentRepo.get(agent.id)?.status).toBe('interrupted')
    expect(s.taskRepo.get(task.id)?.status).toBe('ready')
  })

  it('a failing orphan check never blocks startup recovery', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    const fresh = s.restart({ reaper: { reap: async () => { throw new Error('ps unavailable') } } })
    await fresh.recoverInterrupted()
    expect(s.agentRepo.get(agent.id)?.status).toBe('interrupted')
  })

  it('shutdown stops every agent and records them as interrupted', async () => {
    const s = makeAgentStack()
    s.pty.autoExit = true
    const a = await s.service.start(s.project.id, s.readyTask('A').id)
    const b = await s.service.start(s.project.id, s.readyTask('B').id)
    await s.service.shutdown(500)
    expect(s.pty.procs.every((p) => p.killed.includes('SIGTERM'))).toBe(true)
    expect(s.agentRepo.get(a.id)?.status).toBe('interrupted')
    expect(s.agentRepo.get(b.id)?.status).toBe('interrupted')
    expect(s.service.summary()).toEqual({ running: 0 })
  })

  it('shows the program\'s own terminal title as the current activity', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    s.events.length = 0
    s.pty.procs[0]!.emit('\x1b]0;✳ Reading the codebase\x07')
    expect(s.agentRepo.get(agent.id)?.currentActivity).toBe('✳ Reading the codebase')
    expect(s.events).toContainEqual({ type: 'agent_changed', projectId: s.project.id, agentId: agent.id })
  })
})

describe('AgentService terminals', () => {
  it('sends output only to attached windows, batches chunks, and replays history on attach', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    s.pty.procs[0]!.emit('early ')
    const a1 = await s.service.attach(1, s.project.id, agent.id)
    expect(a1).toEqual({ history: 'early ', live: true })
    s.pty.procs[0]!.emit('one'); s.pty.procs[0]!.emit(' two'); s.pty.procs[0]!.emit(' three')
    await s.sleep(30)
    expect(s.sent).toEqual([{ windowId: 1, agentId: agent.id, data: 'one two three' }]) // one batched delivery; window 2 never attached
    await s.service.detach(1, s.project.id, agent.id)
    s.pty.procs[0]!.emit('after detach'); await s.sleep(30)
    expect(s.sent).toHaveLength(1)
  })

  it('keystrokes and resizes reach the process, and are limited and validated', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    s.service.write(s.project.id, agent.id, 'hello\r')
    s.service.resize(s.project.id, agent.id, 100, 40)
    expect(s.pty.procs[0]!.written).toEqual(['hello\r'])
    expect(s.pty.procs[0]!.resized).toEqual([[100, 40]])
    expect(await code(() => s.service.write(s.project.id, agent.id, 'x'.repeat(70 * 1024)))).toBe('INVALID_INPUT')
    expect(s.pty.procs[0]!.written).toHaveLength(1)
  })

  it('every terminal operation is scoped to the agent\'s own project', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    const other = s.addProject()
    for (const call of [
      () => s.service.attach(1, other.id, agent.id),
      () => s.service.detach(1, other.id, agent.id),
      () => s.service.write(other.id, agent.id, 'x'),
      () => s.service.resize(other.id, agent.id, 80, 24),
      () => s.service.stop(other.id, agent.id),
      () => s.service.discard(other.id, agent.id),
      () => s.service.list('missing')
    ]) expect(await code(call)).toBe('NOT_FOUND')
    expect(s.pty.procs[0]!.written).toEqual([])
    expect(s.pty.procs[0]!.killed).toEqual([])
    expect(s.hub.isAttached(agent.id, 1)).toBe(false)
  })
})

describe('AgentService.discard', () => {
  async function ended() {
    const s = makeAgentStack()
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    return { s, task, agent }
  }

  it('refuses while the agent is running', async () => {
    const { s, agent } = await ended()
    expect(await code(s.service.discard(s.project.id, agent.id, true))).toBe('AGENT_RUNNING')
    expect(existsSync(agent.worktreePath)).toBe(true)
  })

  it('removes an untouched worktree and its unmoved branch', async () => {
    const { s, agent } = await ended()
    s.pty.procs[0]!.exit(0); await s.sleep(30)
    const out = await s.service.discard(s.project.id, agent.id)
    expect(out.worktreeRemoved).toBe(true)
    expect(existsSync(agent.worktreePath)).toBe(false)
    expect(git(s.repoPath, 'branch', '--list', 'orbyte/*')).toBe('')
    expect(s.eventTypes(s.project.id)).toContain('agent.worktree_removed')
  })

  it('refuses to delete uncommitted work without force, then deletes it when forced', async () => {
    const { s, agent } = await ended()
    s.pty.procs[0]!.exit(0); await s.sleep(30)
    writeFileSync(join(agent.worktreePath, 'wip.txt'), 'unsaved work')
    expect(await code(s.service.discard(s.project.id, agent.id))).toBe('WORKTREE_DIRTY')
    expect(readFileSync(join(agent.worktreePath, 'wip.txt'), 'utf8')).toBe('unsaved work')
    await s.service.discard(s.project.id, agent.id, true)
    expect(existsSync(agent.worktreePath)).toBe(false)
  })

  it('keeps the branch when the agent committed work', async () => {
    const { s, agent } = await ended()
    s.pty.procs[0]!.exit(0); await s.sleep(30)
    writeFileSync(join(agent.worktreePath, 'f.txt'), 'x'); git(agent.worktreePath, 'add', '.'); git(agent.worktreePath, 'commit', '-q', '-m', 'agent work')
    await s.service.discard(s.project.id, agent.id)
    expect(git(s.repoPath, 'branch', '--list', 'orbyte/*')).toContain(agent.branch)
  })

  it('will not touch a path outside Orbyte\'s worktree directory, even if the record were tampered with', async () => {
    const { s, agent } = await ended()
    s.pty.procs[0]!.exit(0); await s.sleep(30)
    s.handle.raw.prepare('update developer_agents set worktree_path = ? where id = ?').run(s.repoPath, agent.id)
    expect(await code(s.service.discard(s.project.id, agent.id, true))).toBe('WORKTREE_FAILED')
    expect(existsSync(join(s.repoPath, 'README.md'))).toBe(true)
  })
})

describe('review fixes', () => {
  it('archiving a project stops its agents, and the task is not stranded in planning', async () => {
    const s = makeAgentStack()
    s.pty.autoExit = true
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    const { ProjectService } = await import('../src/main/modules/projects/service')
    const { ProjectRepository } = await import('../src/main/modules/projects/repository')
    const projects = new ProjectService({ repo: new ProjectRepository(s.handle.db), inspect: async () => ({ isGitRepo: true, repoRoot: null, defaultBranch: 'main' }), onArchive: (id) => s.service.stopAllForProject(id) })
    projects.archive(s.project.id)
    await s.sleep(60)
    expect(s.pty.procs[0]!.killed).toContain('SIGTERM')
    expect(s.agentRepo.get(agent.id)?.status).toBe('stopped')
    expect(s.taskRepo.get(task.id)?.status).toBe('ready') // returned even though the project is archived
    expect(s.projects.get(s.project.id)?.status).toBe('archived')
  })

  it('archive hook failures never stop the archive itself', async () => {
    const s = makeAgentStack()
    const { ProjectService } = await import('../src/main/modules/projects/service')
    const { ProjectRepository } = await import('../src/main/modules/projects/repository')
    const projects = new ProjectService({ repo: new ProjectRepository(s.handle.db), inspect: async () => ({ isGitRepo: true, repoRoot: null, defaultBranch: 'main' }), onArchive: () => { throw new Error('boom') } })
    expect(projects.archive(s.project.id).status).toBe('archived')
  })

  it('a start that is in flight when the app quits aborts before spawning and cleans up', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const starting = s.service.start(s.project.id, task.id).then(() => 'started', (e: unknown) => (e instanceof AppError ? e.code : 'other'))
    await s.service.shutdown(3000) // waits for the in-flight start to finish its git work
    expect(await starting).toBe('SHUTTING_DOWN')
    expect(s.pty.procs).toHaveLength(0) // nothing was spawned into a closing app
    expect(s.taskRepo.get(task.id)?.status).toBe('ready')
    const [agent] = s.agentRepo.list(s.project.id)
    expect(agent).toMatchObject({ status: 'failed', worktreeRemoved: true })
    expect(existsSync(agent!.worktreePath)).toBe(false)
    expect(await code(s.service.start(s.project.id, task.id))).toBe('SHUTTING_DOWN') // and none can start afterwards
  })

  it('discard refuses commits that exist only on a detached HEAD, unless forced', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    s.pty.procs[0]!.exit(0); await s.sleep(30)
    git(agent.worktreePath, 'checkout', '-q', '--detach')
    writeFileSync(join(agent.worktreePath, 'secret-work.txt'), 'hours of work')
    git(agent.worktreePath, 'add', '.'); git(agent.worktreePath, 'commit', '-q', '-m', 'detached work')
    expect(await code(s.service.discard(s.project.id, agent.id))).toBe('WORKTREE_DIRTY') // status is clean, but the commit would be orphaned
    expect(existsSync(join(agent.worktreePath, 'secret-work.txt'))).toBe(true)
    await s.service.discard(s.project.id, agent.id, true)
    expect(existsSync(agent.worktreePath)).toBe(false)
  })

  it('a worktree directory deleted by hand can still be discarded', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    s.pty.procs[0]!.exit(0); await s.sleep(30)
    execFileSync('rm', ['-rf', agent.worktreePath])
    const out = await s.service.discard(s.project.id, agent.id)
    expect(out.worktreeRemoved).toBe(true)
    expect(git(s.repoPath, 'worktree', 'list').split('\n')).toHaveLength(1) // git forgot it
    expect(git(s.repoPath, 'branch', '--list', 'orbyte/*')).toBe('') // and the unmoved branch is gone
  })

  it('a symlink swapped in for the worktree path is not followed', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    s.pty.procs[0]!.exit(0); await s.sleep(30)
    execFileSync('rm', ['-rf', agent.worktreePath])
    symlinkSync(s.repoPath, agent.worktreePath) // looks like it is inside the worktree root, resolves to the user's repository
    expect(await code(s.service.discard(s.project.id, agent.id, true))).toBe('WORKTREE_FAILED')
    expect(existsSync(join(s.repoPath, 'README.md'))).toBe(true)
    expect(git(s.repoPath, 'status', '--porcelain')).toBe('')
  })

  it('a database error while handling output never throws into the PTY callback', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    s.agentRepo.setActivity = () => { throw new Error('database is locked') }
    expect(() => s.pty.procs[0]!.emit('\x1b]0;a brand new title\x07 visible output')).not.toThrow()
    const attached = await s.service.attach(1, s.project.id, agent.id)
    expect(attached.history).toContain('visible output') // output still buffered
  })

  it('a database error while recording an exit cannot strand the rest of the cleanup', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    await s.service.attach(1, s.project.id, agent.id)
    const realFinish = s.agentRepo.finish.bind(s.agentRepo)
    s.agentRepo.finish = () => { throw new Error('database is locked') }
    s.pty.procs[0]!.exit(0)
    await s.sleep(40)
    expect(s.hub.isAttached(agent.id, 1)).toBe(false) // subscriptions dropped
    expect(s.taskRepo.get(task.id)?.status).toBe('ready') // task still returned
    expect(await code(() => s.service.stop(s.project.id, agent.id))).toBe('NOT_RUNNING') // no live handle left
    s.agentRepo.finish = realFinish
  })

  it('in-flight starts are not double counted toward the limit', async () => {
    const s = makeAgentStack({ maxActive: 2 })
    const a = s.readyTask('A'); const b = s.readyTask('B'); const c = s.readyTask('C')
    const results = await Promise.allSettled([s.service.start(s.project.id, a.id), s.service.start(s.project.id, b.id)])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true) // the cap is 2, so both fit
    expect(await code(s.service.start(s.project.id, c.id))).toBe('TOO_MANY_AGENTS')
  })

  it('a failed worktree creation leaves no half-made agent behind', async () => {
    const s = makeAgentStack()
    const task = s.readyTask()
    // Make `git worktree add` fail by pre-creating a non-empty directory where the worktree would go.
    const realAdd = s.service['deps'].worktrees.add.bind(s.service['deps'].worktrees)
    s.service['deps'].worktrees.add = async (repo: string, path: string, branch: string, base: string) => {
      await realAdd(repo, path, branch, base)
      throw new AppError('WORKTREE_FAILED', 'simulated failure after the directory was created')
    }
    expect(await code(s.service.start(s.project.id, task.id))).toBe('WORKTREE_FAILED')
    const [agent] = s.agentRepo.list(s.project.id)
    expect(agent).toMatchObject({ status: 'failed', worktreeRemoved: true })
    expect(existsSync(agent!.worktreePath)).toBe(false) // the partly created worktree was removed
    expect(git(s.repoPath, 'branch', '--list', 'orbyte/*')).toBe('')
    expect(s.taskRepo.get(task.id)?.status).toBe('ready')
  })
})
