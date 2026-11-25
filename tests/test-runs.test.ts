import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitWorktrees } from '../src/main/modules/agents/developers/worktrees'
import { CompletionService } from '../src/main/modules/orchestration/completion-service'
import { ExecutionRepository } from '../src/main/modules/orchestration/execution-repository'
import { ExecutionService } from '../src/main/modules/orchestration/execution-service'
import { TestRunService, detectTestCommand, runCommand, testEnv } from '../src/main/modules/orchestration/test-run-service'
import { AppError } from '../src/shared/types/result'
import { makeAgentStack } from './helpers'

import { tempDir } from './helpers'
const code = async (fn: () => unknown): Promise<string> => {
  try { await fn() } catch (e) { return e instanceof AppError ? e.code : 'OTHER' }
  return 'NONE'
}
const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  if (!cond()) throw new Error('condition not met in time')
}

/** Real DB, real git worktrees, fake processes: a task with an approved plan, ready to execute. */
async function approved() {
  const s = makeAgentStack()
  s.pty.autoExit = true
  const exec = new ExecutionRepository(s.handle.db)
  const worktrees = new GitWorktrees()
  let execution!: ExecutionService
  const reviewed: string[] = []
  s.restart({
    onProgress: (id, m) => execution.onProgress(id, m),
    onResult: (id, r) => execution.onResult(id, r),
    onExecutionAgentEnded: (a, st) => execution.onAgentEnded(a, st)
  })
  execution = new ExecutionService({
    projects: s.projects, taskRepo: s.taskRepo, tasks: s.tasks, agents: s.agentRepo, agentService: s.service, approvals: s.approvals,
    plans: s.planRepo, exec, worktrees, emit: (e) => s.events.push(e), onResultSubmitted: (r) => { reviewed.push(r.id) }
  })
  const completion = new CompletionService({ projects: s.projects, taskRepo: s.taskRepo, tasks: s.tasks, exec, agents: s.agentRepo, worktrees, emit: (e) => s.events.push(e) })

  const task = s.readyTask('Add login', 'Use sessions.')
  const planner = await s.service.start(s.project.id, task.id)
  s.submitPlan(planner.id)
  s.pty.procs[0]!.exit(0)
  await s.sleep(80)
  const plan = s.planRepo.latestPlan(task.id)!
  s.approvals.approve(s.project.id, task.id, plan.id)
  return { s, task, plan, exec, execution, completion, reviewed }
}
type Ctx = Awaited<ReturnType<typeof approved>>

/** What a real execution agent does: edit files in its worktree, then call submit_result. */
async function agentFinishes(c: Ctx, agentId: string, procIndex: number, file = 'login.ts', body = 'export {}\n') {
  const proc = c.s.pty.procs[procIndex]!
  writeFileSync(join(proc.opts.cwd, file), body)
  writeFileSync(join(c.s.inbox.dirFor(agentId), `result-${Date.now()}-a.json`), JSON.stringify({ result: { summary: 'Added login', tests: [{ command: 'pnpm test', passed: true }] } }))
  proc.exit(0)
  await waitFor(() => c.s.taskRepo.get(c.task.id)?.status === 'in_review' || c.s.taskRepo.get(c.task.id)?.status === 'awaiting_approval')
  // The task moves before the exit handler finishes marking the agent stopped: wait for that too, or the next call races it.
  await waitFor(() => !c.s.agentRepo.activeForTask(c.task.id))
}

const pkg = (test: string) => JSON.stringify({ name: 'x', scripts: { test } })
async function inReview(testScript: string) {
  const c = await approved()
  const agent = await c.execution.start(c.s.project.id, c.task.id)
  await agentFinishes(c, agent.id, 1, 'package.json', pkg(testScript))
  const tests = new TestRunService({ db: c.s.handle.db, projects: c.s.projects, taskRepo: c.s.taskRepo, exec: c.exec, agents: c.s.agentRepo, worktrees: new GitWorktrees(), emit: (e) => c.s.events.push(e), timeoutMs: 20_000 })
  return { ...c, tests, agent, result: c.exec.latestResult(c.task.id)!, cwd: c.s.pty.procs[1]!.opts.cwd }
}
const finished = async (t: TestRunService, pid: string, tid: string) => {
  await waitFor(() => t.list(pid, tid).every((r) => r.status !== 'running'), 20_000)
  return t.list(pid, tid)[0]!
}

describe('detectTestCommand', () => {
  it('reads scripts.test and picks the package manager from the lockfile', async () => {
    const dir = tempDir()
    expect(await detectTestCommand(dir)).toBeNull()
    writeFileSync(join(dir, 'package.json'), pkg('vitest run'))
    expect(await detectTestCommand(dir)).toMatchObject({ file: 'npm', args: ['run', 'test'] })
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    expect(await detectTestCommand(dir)).toMatchObject({ file: 'pnpm', display: 'pnpm run test' })
  })
  it('ignores the npm placeholder, a missing script and bad JSON', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), pkg('echo "Error: no test specified" && exit 1'))
    expect(await detectTestCommand(dir)).toBeNull()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }))
    expect(await detectTestCommand(dir)).toBeNull()
    writeFileSync(join(dir, 'package.json'), '{nope')
    expect(await detectTestCommand(dir)).toBeNull()
  })
})

describe('runCommand and testEnv', () => {
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  it('reports exit codes and output for real processes', async () => {
    const ok = await runCommand(process.execPath, ['-e', 'console.log("hi")'], { cwd: tempDir(), env, timeoutMs: 10_000 })
    expect(ok).toMatchObject({ code: 0, timedOut: false })
    expect(ok.output).toContain('hi')
    const bad = await runCommand(process.execPath, ['-e', 'console.error("boom");process.exit(3)'], { cwd: tempDir(), env, timeoutMs: 10_000 })
    expect(bad.code).toBe(3)
    expect(bad.output).toContain('boom')
  })
  it('kills a process that runs too long, and keeps only the output tail', async () => {
    const slow = await runCommand(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: tempDir(), env, timeoutMs: 300 })
    expect(slow.timedOut).toBe(true)
    const big = await runCommand(process.execPath, ['-e', 'process.stdout.write("a".repeat(100000)+"END")'], { cwd: tempDir(), env, timeoutMs: 10_000 })
    expect(big.output.length).toBeLessThanOrEqual(32 * 1024)
    expect(big.output.endsWith('END')).toBe(true)
  })
  it('reports a missing program instead of throwing', async () => {
    expect((await runCommand('orbyte-no-such-program', [], { cwd: tempDir(), env, timeoutMs: 5000 })).failed).toMatch(/not found/)
  })
  it('passes no credentials', () => {
    const e = testEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 't', LC_ALL: 'C' })
    expect(Object.keys(e).sort()).toEqual(['CI', 'HOME', 'LC_ALL', 'PATH'])
  })
})

// These start real npm processes after a real git setup: the default 5 s limit is too tight on a loaded machine.
describe('TestRunService', { timeout: 30_000 }, () => {
  it('runs the project test script for the current result and records a pass', async () => {
    const c = await inReview('node -e "console.log(123)"')
    const { id: pid } = c.s.project
    const row = await c.tests.start(pid, c.task.id, c.result.id)
    expect(row).toMatchObject({ status: 'running', command: 'npm run test', snapshotHash: c.result.evidence.snapshotHash })
    const done = await finished(c.tests, pid, c.task.id)
    expect(done).toMatchObject({ status: 'passed', exitCode: 0 })
    expect(done.output).toContain('123')
    // Orbyte's run changed nothing about the task.
    expect(c.s.taskRepo.get(c.task.id)?.status).toBe('in_review')
    expect(c.s.handle.raw.prepare("select type from activity_events where type like 'tests.%' order by rowid").all()).toEqual([{ type: 'tests.started' }, { type: 'tests.finished' }])
  })

  it('records a failing run honestly', async () => {
    const c = await inReview('node -e "process.exit(2)"')
    await c.tests.start(c.s.project.id, c.task.id, c.result.id)
    expect(await finished(c.tests, c.s.project.id, c.task.id)).toMatchObject({ status: 'failed', exitCode: 2 })
  })

  it('refuses a run when the code changed, the result is not current, the project is wrong, or there is no test script', async () => {
    const c = await inReview('node -e ""')
    const { id: pid } = c.s.project
    expect(await code(() => c.tests.start('nope', c.task.id, c.result.id))).toBe('NOT_FOUND')
    expect(await code(() => c.tests.start(pid, 'nope', c.result.id))).toBe('NOT_FOUND')
    expect(await code(() => c.tests.start(pid, c.task.id, 'old'))).toBe('STALE_RESULT')
    writeFileSync(join(c.cwd, 'extra.ts'), 'x')
    expect(await code(() => c.tests.start(pid, c.task.id, c.result.id))).toBe('CODE_CHANGED')

    const d = await inReview('echo "Error: no test specified" && exit 1')
    expect(await code(() => d.tests.start(d.s.project.id, d.task.id, d.result.id))).toBe('NO_TEST_COMMAND')
  })

  it('allows one run at a time per task, and marks a run left running by a crash as an error', async () => {
    const c = await inReview('node -e "setTimeout(()=>{},800)"')
    const { id: pid } = c.s.project
    await c.tests.start(pid, c.task.id, c.result.id)
    expect(await code(() => c.tests.start(pid, c.task.id, c.result.id))).toBe('TESTS_RUNNING')
    await finished(c.tests, pid, c.task.id)

    c.s.handle.raw.prepare("update test_runs set status = 'running', ended_at = null").run()
    expect(c.tests.recoverInterrupted()).toBe(1)
    expect(c.tests.list(pid, c.task.id)[0]).toMatchObject({ status: 'error' })
  })
})
