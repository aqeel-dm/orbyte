import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { AppError } from '@shared/types/result'
import type { TestRun } from '@shared/schemas/execution'
import type { AppEvent } from '@shared/schemas/team-lead'
import type { Db } from '../../database/client'
import { activityEvents, testRuns } from '../../database/schema'
import type { AgentRepository } from '../agents/developers/agent-repository'
import type { GitWorktrees } from '../agents/developers/worktrees'
import type { ProjectRepository } from '../projects/repository'
import type { TaskRepository } from '../tasks/repository'
import type { ExecutionRepository } from './execution-repository'
import { log } from '../../logging/logger'

export const TEST_TIMEOUT_MS = 5 * 60_000
export const MAX_TEST_OUTPUT = 32 * 1024
const MAX_PACKAGE_JSON = 256 * 1024
/** What `npm init` writes; running it proves nothing. */
const PLACEHOLDER = /no test specified/i

export interface DetectedTestCommand {
  file: string
  args: string[]
  display: string
}

/**
 * The project's own test script, found by Orbyte: `scripts.test` in a regular `package.json` at the worktree
 * root, run with the package manager its lockfile names. Nothing here comes from the renderer.
 */
export async function detectTestCommand(dir: string): Promise<DetectedTestCommand | null> {
  const pkgPath = join(dir, 'package.json')
  try {
    const st = await lstat(pkgPath)
    if (!st.isFile() || st.size > MAX_PACKAGE_JSON) return null
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> }
    const script = pkg.scripts?.test
    if (typeof script !== 'string' || !script.trim() || PLACEHOLDER.test(script)) return null
  } catch {
    return null
  }
  const has = async (f: string) => lstat(join(dir, f)).then((s) => s.isFile(), () => false)
  const pm = (await has('pnpm-lock.yaml')) ? 'pnpm' : (await has('yarn.lock')) ? 'yarn' : 'npm'
  return { file: pm, args: ['run', 'test'], display: `${pm} run test` }
}

export interface CommandOutcome {
  code: number | null
  output: string
  timedOut: boolean
  /** Set when the process could not be started. */
  failed?: string
}

const ENV_ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TMPDIR'])

/** No Claude or cloud credentials: a project's tests do not need them. */
export function testEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { CI: '1' }
  for (const [k, v] of Object.entries(src)) if (v !== undefined && (ENV_ALLOW.has(k) || k.startsWith('LC_'))) out[k] = v
  return out
}

/** Runs one command without a shell, killing its whole process group on timeout. Keeps only the output's tail. */
export function runCommand(file: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; onStart?: (child: ChildProcess) => void }): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let settled = false
    const done = (r: CommandOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    opts.onStart?.(child)
    const killGroup = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    const timer = setTimeout(() => { timedOut = true; killGroup() }, opts.timeoutMs)
    const add = (b: Buffer) => { output = (output + b.toString('utf8')).slice(-MAX_TEST_OUTPUT) }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    child.on('error', (err) => done({ code: null, output, timedOut, failed: (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${file} was not found on PATH.` : 'The test command could not be started.' }))
    child.on('close', (code) => done({ code, output, timedOut }))
  })
}

/**
 * Orbyte-run tests. The user asks for a run of the CURRENT, unchanged result of a task in review; Orbyte finds
 * the command itself, runs it in the agent's worktree and records the outcome bound to the code snapshot it ran
 * against. These are Orbyte-collected facts (the agent's own report stays labeled unverified). They are NOT
 * required for acceptance and nothing here moves a task. Running the tests executes the agent's code as you:
 * that is why it is a button you press, not something Orbyte does on its own.
 */
export class TestRunService {
  private readonly children = new Map<string, ChildProcess>()
  private readonly now: () => number

  constructor(
    private readonly deps: {
      db: Db
      projects: Pick<ProjectRepository, 'get'>
      taskRepo: Pick<TaskRepository, 'get'>
      exec: Pick<ExecutionRepository, 'latestResult'>
      agents: Pick<AgentRepository, 'get'>
      worktrees: Pick<GitWorktrees, 'snapshot'>
      emit: (event: AppEvent) => void
      run?: typeof runCommand
      timeoutMs?: number
      now?: () => number
    }
  ) {
    this.now = deps.now ?? Date.now
  }

  list(projectId: string, taskId: string): TestRun[] {
    this.requireTask(projectId, taskId)
    return this.deps.db.select().from(testRuns).where(and(eq(testRuns.taskId, taskId))).orderBy(desc(testRuns.startedAt), desc(testRuns.id)).limit(20).all()
  }

  async start(projectId: string, taskId: string, resultId: string): Promise<TestRun> {
    const task = this.requireTask(projectId, taskId)
    if (this.deps.projects.get(projectId)?.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    if (task.status !== 'in_review') throw new AppError('NOT_IN_REVIEW', 'Tests can be run while a result is waiting for your decision.')
    const latest = this.deps.exec.latestResult(taskId)
    if (!latest || latest.id !== resultId || latest.projectId !== projectId || latest.status !== 'current') throw new AppError('STALE_RESULT', 'A newer result exists. Run the tests on that one.')
    if (this.running(taskId)) throw new AppError('TESTS_RUNNING', 'Tests are already running for this task.')
    const agent = this.deps.agents.get(latest.agentId)
    if (!agent || agent.worktreeRemoved) throw new AppError('WORKTREE_FAILED', "The agent's worktree is gone, so the tests cannot run.")

    let snap
    try {
      snap = await this.deps.worktrees.snapshot(agent.worktreePath, agent.baseCommit)
    } catch {
      throw new AppError('WORKTREE_FAILED', "The agent's worktree could not be inspected.")
    }
    if (snap.snapshotHash !== latest.evidence.snapshotHash) throw new AppError('CODE_CHANGED', 'The code changed after this result was submitted. Ask for a new result first.')
    const cmd = await detectTestCommand(agent.worktreePath)
    if (!cmd) throw new AppError('NO_TEST_COMMAND', 'No test script was found: Orbyte looks for "scripts.test" in package.json at the worktree root.')
    // Another call may have started while we awaited.
    if (this.running(taskId)) throw new AppError('TESTS_RUNNING', 'Tests are already running for this task.')

    const id = randomUUID()
    const row = this.deps.db.transaction((tx) => {
      const r = tx.insert(testRuns).values({ id, projectId, taskId, resultId, snapshotHash: latest.evidence.snapshotHash, command: cmd.display, status: 'running', startedAt: this.now() }).returning().get()
      tx.insert(activityEvents).values({ id: randomUUID(), projectId, type: 'tests.started', payload: { taskId, resultId, command: cmd.display } }).run()
      return r
    })
    this.changed(projectId, taskId)
    void this.execute(id, projectId, taskId, agent.worktreePath, cmd)
    return row
  }

  /** A run left `running` by a crash cannot be resumed: say so. */
  recoverInterrupted(): number {
    const rows = this.deps.db.update(testRuns).set({ status: 'error', output: 'Orbyte stopped while these tests were running.', endedAt: this.now() }).where(eq(testRuns.status, 'running')).returning().all()
    return rows.length
  }

  /** Stops test processes when Orbyte quits. */
  shutdown(): void {
    for (const child of this.children.values()) {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }

  private running(taskId: string): boolean {
    return !!this.deps.db.select({ id: testRuns.id }).from(testRuns).where(and(eq(testRuns.taskId, taskId), eq(testRuns.status, 'running'))).get()
  }

  private async execute(id: string, projectId: string, taskId: string, cwd: string, cmd: DetectedTestCommand): Promise<void> {
    let status: TestRun['status'] = 'error'
    let exitCode: number | null = null
    let output = ''
    try {
      const outcome = await (this.deps.run ?? runCommand)(cmd.file, cmd.args, {
        cwd, env: testEnv(process.env), timeoutMs: this.deps.timeoutMs ?? TEST_TIMEOUT_MS, onStart: (c) => this.children.set(id, c)
      })
      exitCode = outcome.code
      output = outcome.failed ? outcome.failed : outcome.output
      status = outcome.failed ? 'error' : outcome.timedOut ? 'timed_out' : outcome.code === 0 ? 'passed' : 'failed'
    } catch (err) {
      log.error('[tests] run failed', err)
      output = 'The test run failed to start.'
    } finally {
      this.children.delete(id)
    }
    try {
      this.deps.db.transaction((tx) => {
        tx.update(testRuns).set({ status, exitCode, output, endedAt: this.now() }).where(and(eq(testRuns.id, id), eq(testRuns.status, 'running'))).run()
        tx.insert(activityEvents).values({ id: randomUUID(), projectId, type: 'tests.finished', payload: { taskId, status, exitCode } }).run()
      })
    } catch (err) {
      log.error('[tests] could not record the outcome', err)
    }
    this.changed(projectId, taskId)
  }

  private requireTask(projectId: string, taskId: string) {
    if (!this.deps.projects.get(projectId)) throw new AppError('NOT_FOUND', 'Project not found.')
    const task = this.deps.taskRepo.get(taskId)
    if (!task || task.projectId !== projectId) throw new AppError('NOT_FOUND', 'Task not found.')
    return task
  }

  private changed(projectId: string, taskId: string): void {
    try { this.deps.emit({ type: 'executions_changed', projectId, taskId }) } catch (err) { log.error('[tests] failed to emit event', err) }
  }
}
