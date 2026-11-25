import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitWorktrees } from '../src/main/modules/agents/developers/worktrees'
import { CompletionService } from '../src/main/modules/orchestration/completion-service'
import { ExecutionRepository } from '../src/main/modules/orchestration/execution-repository'
import { ExecutionService } from '../src/main/modules/orchestration/execution-service'
import { ResultReviewService } from '../src/main/modules/orchestration/result-review-service'
import { requestChangesInputSchema } from '../src/shared/schemas/execution'
import { AppError } from '../src/shared/types/result'
import { makeAgentStack } from './helpers'

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
const review = (c: Ctx) => {
  const result = c.exec.latestResult(c.task.id)!
  c.exec.addReview({ result, recommendation: 'approve', summary: 'Looks fine', concerns: [] })
  return result
}

// Real git worktrees and processes: the default 5 s limit is too tight when the whole suite runs in parallel.
describe('execution', { timeout: 30_000 }, () => {
  it('start refuses without an approval, and starting spends the approval', async () => {
    const s = makeAgentStack(); s.pty.autoExit = true
    const exec = new ExecutionRepository(s.handle.db)
    const task = s.readyTask()
    const e = new ExecutionService({ projects: s.projects, taskRepo: s.taskRepo, tasks: s.tasks, agents: s.agentRepo, agentService: s.service, approvals: s.approvals, plans: s.planRepo, exec, worktrees: new GitWorktrees(), emit: () => undefined })
    expect(await code(() => e.start(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')

    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    expect(agent).toMatchObject({ kind: 'execution', status: 'running' })
    expect(c.s.taskRepo.get(c.task.id)?.status).toBe('in_progress')
    expect(c.exec.listRuns(c.task.id)[0]).toMatchObject({ status: 'running', planVersion: 1 })
    const args = c.s.pty.procs[1]!.args
    expect(args).toContain('acceptEdits')
    expect(args.join(' ')).not.toMatch(/dangerously|bypass/)
    expect(await code(() => c.execution.start(c.s.project.id, c.task.id))).toBe('EXECUTION_NOT_AUTHORIZED') // the approval is spent
  })

  it('a result moves the task to review with evidence collected from git, and the agent claims stay claims', async () => {
    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    await agentFinishes(c, agent.id, 1)
    expect(c.s.taskRepo.get(c.task.id)?.status).toBe('in_review')
    const result = c.exec.latestResult(c.task.id)!
    expect(result).toMatchObject({ version: 1, status: 'current', summary: 'Added login' })
    expect(result.evidence.files.map((f) => f.path)).toContain('login.ts')
    expect(result.evidence.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
    expect(c.reviewed).toEqual([result.id])
    expect(c.exec.listRuns(c.task.id)[0]?.status).toBe('result_submitted')
  })

  it('shows the changes of a result only for the right project and only while the code matches', async () => {
    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    await agentFinishes(c, agent.id, 1, 'login.ts', 'export const login = 1\n')
    const { id: pid } = c.s.project
    const result = c.exec.latestResult(c.task.id)!
    const shown = await c.completion.changes(pid, c.task.id, result.id)
    expect(shown.text).toContain('+++ b/login.ts')
    expect(shown.text).toContain('+export const login = 1')
    expect(await code(() => c.completion.changes('nope', c.task.id, result.id))).toBe('NOT_FOUND')
    expect(await code(() => c.completion.changes(pid, c.task.id, 'nope'))).toBe('NOT_FOUND')
    writeFileSync(join(c.s.pty.procs[1]!.opts.cwd, 'login.ts'), 'export const login = 2\n')
    expect(await code(() => c.completion.changes(pid, c.task.id, result.id))).toBe('CODE_CHANGED')
  })

  it('completion needs a Team Lead review, the user, and unchanged code', async () => {
    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    await agentFinishes(c, agent.id, 1)
    const { id: pid } = c.s.project
    const result = c.exec.latestResult(c.task.id)!
    expect(await code(() => c.completion.accept(pid, c.task.id, result.id))).toBe('REVIEW_REQUIRED')
    expect(c.s.taskRepo.get(c.task.id)?.status).toBe('in_review')
    review(c)
    // the code changes after review
    writeFileSync(join(c.s.pty.procs[1]!.opts.cwd, 'login.ts'), 'export const x = 1\n')
    expect(await code(() => c.completion.accept(pid, c.task.id, result.id))).toBe('CODE_CHANGED')
    writeFileSync(join(c.s.pty.procs[1]!.opts.cwd, 'login.ts'), 'export {}\n')
    expect((await c.completion.bundle(pid, c.task.id)).gate).toMatchObject({ state: 'awaiting_decision', canAccept: true, codeUnchanged: true })
    expect(await code(() => c.completion.accept('nope', c.task.id, result.id))).toBe('NOT_FOUND')
    await c.completion.accept(pid, c.task.id, result.id)
    expect(c.s.taskRepo.get(c.task.id)?.status).toBe('completed')
    expect(c.exec.listDecisions(c.task.id)[0]).toMatchObject({ decision: 'accepted', reviewer: 'user' })
  })

  it('nothing but the completion gate can complete a task', async () => {
    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    await agentFinishes(c, agent.id, 1)
    for (const actor of ['user', 'orchestrator'] as const) {
      expect(await code(() => c.s.tasks.transition(c.s.project.id, c.task.id, 'completed', actor))).not.toBe('NONE')
    }
    expect(c.s.taskRepo.get(c.task.id)?.status).toBe('in_review')
  })

  it('requesting changes spends a single-use request, runs a revision, and supersedes the first result', async () => {
    const c = await approved()
    const { id: pid } = c.s.project
    const agent = await c.execution.start(pid, c.task.id)
    await agentFinishes(c, agent.id, 1)
    const first = review(c)
    expect(requestChangesInputSchema.safeParse({ projectId: pid, taskId: c.task.id, resultId: first.id, feedback: '  ' }).success).toBe(false)
    const revision = await c.execution.requestChanges(pid, c.task.id, first.id, 'Add a test')
    expect(c.s.taskRepo.get(c.task.id)?.status).toBe('in_progress')
    expect(c.s.pty.procs[2]!.args.join(' ')).toContain('Add a test')
    expect(await code(() => c.execution.requestChanges(pid, c.task.id, first.id, 'Again'))).toBe('NOT_IN_REVIEW')
    await agentFinishes(c, revision.id, 2, 'login.test.ts')
    const second = c.exec.latestResult(c.task.id)!
    expect(second.version).toBe(2)
    expect(c.exec.getResult(first.id)?.status).toBe('superseded')
    expect(await code(() => c.completion.accept(pid, c.task.id, first.id))).toBe('STALE_RESULT')
    expect(await code(() => c.completion.accept(pid, c.task.id, second.id))).toBe('REVIEW_REQUIRED') // the new result needs its own review
  })

  it('an execution that ends without a result returns to the approval gate and needs a fresh approval', async () => {
    const c = await approved()
    await c.execution.start(c.s.project.id, c.task.id)
    c.s.pty.procs[1]!.exit(1)
    await waitFor(() => c.s.taskRepo.get(c.task.id)?.status === 'awaiting_approval')
    expect(c.s.taskRepo.get(c.task.id)?.approvalStatus).toBe('pending')
    expect(c.exec.listRuns(c.task.id)[0]?.status).toMatch(/ended_without_result|failed/)
    expect(await code(() => c.execution.start(c.s.project.id, c.task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
  })

  it('discarding the worktree is refused while the task is being executed', async () => {
    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    expect(await code(() => c.s.service.discard(c.s.project.id, agent.id))).toMatch(/AGENT_RUNNING|TASK_ACTIVE/)
  })
})

describe('review fixes', () => {
  it('the execution launch pre-approves no Bash and denies edits to Claude settings and git files', async () => {
    const c = await approved()
    await c.execution.start(c.s.project.id, c.task.id)
    const args = c.s.pty.procs[1]!.args
    const allowed = args.find((a) => a.startsWith('--allowedTools='))!
    expect(allowed).not.toMatch(/Bash/)
    const denied = args.find((a) => a.startsWith('--disallowedTools='))!
    expect(denied).toContain('Edit(.claude/**)')
    expect(denied).toContain('Write(.git)')
  })

  it('evidence refuses a worktree whose .git pointer was rewritten, and includes ignored Claude settings', async () => {
    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    const cwd = c.s.pty.procs[1]!.opts.cwd
    const w = new GitWorktrees()
    const rec = c.s.agentRepo.get(agent.id)!
    writeFileSync(join(cwd, '.gitignore'), '.claude/settings.local.json\n')
    require('node:fs').mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}')
    const ev = await w.snapshot(cwd, rec.baseCommit)
    expect(ev.files.map((f) => f.path)).toContain('.claude/settings.local.json')
    // the agent repoints .git at a directory inside the worktree
    require('node:fs').mkdirSync(join(cwd, 'fake-git'))
    writeFileSync(join(cwd, '.git'), 'gitdir: ' + join(cwd, 'fake-git') + '\n')
    expect(await code(() => w.snapshot(cwd, rec.baseCommit))).toBe('WORKTREE_FAILED')
  })
})

describe('result review is bound to the submitted code', () => {
  const reviewer = (c: Ctx, calls: unknown[]) => new ResultReviewService({
    projects: c.s.projects, taskRepo: c.s.taskRepo, exec: c.exec, plans: c.s.planRepo, agents: c.s.agentRepo, worktrees: new GitWorktrees(),
    teamLead: { isActive: () => false, runTurn: async (opts: unknown) => { calls.push(opts); return { ok: true } } } as never,
    emit: () => undefined, retryMs: 5
  })
  const settle = async (rr: ResultReviewService, id: string) => { await c0(); while (rr.isInProgress(id)) await new Promise((r) => setTimeout(r, 10)) }
  const c0 = () => new Promise((r) => setTimeout(r, 20))

  it('reviews the code when it matches the result, and skips the review when the worktree has changed', async () => {
    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    await agentFinishes(c, agent.id, 1)
    const result = c.exec.latestResult(c.task.id)!
    const calls: unknown[] = []
    const rr = reviewer(c, calls)
    rr.request(c.s.project.id, c.task.id, result.id)
    await settle(rr, result.id)
    expect(calls).toHaveLength(1)
    writeFileSync(join(c.s.pty.procs[1]!.opts.cwd, 'login.ts'), 'export const changed = true\n')
    rr.request(c.s.project.id, c.task.id, result.id)
    await settle(rr, result.id)
    expect(calls).toHaveLength(1) // not asked again: the code is no longer what was submitted
  })
})

describe('gate invariants (source scan)', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const holders = (needle: RegExp) => walk(join(__dirname, '..', 'src')).filter((f) => needle.test(stripComments(readFileSync(f, 'utf8')))).map((f) => relative(join(__dirname, '..'), f))

  it('only completion-service passes completionVerified: true', () => {
    expect(holders(/completionVerified:\s*true/)).toEqual(['src/main/modules/orchestration/completion-service.ts'])
  })
  it('only approval-service passes approvalVerified: true', () => {
    expect(holders(/approvalVerified:\s*true/)).toEqual(['src/main/modules/orchestration/approval-service.ts'])
  })
})
