import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PlanInbox } from '../src/main/modules/agents/developers/plan-inbox'
import { MAX_PLAN_VERSIONS } from '../src/main/modules/orchestration/plan-service'
import { AppError } from '../src/shared/types/result'
import { approvePlanInputSchema, rejectPlanInputSchema } from '../src/shared/schemas/plan'
import { makeAgentStack } from './helpers'

const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return e instanceof AppError ? e.code : 'OTHER' }
  return 'NONE'
}

/** A running agent for a Ready task, so the task is in planning. */
async function planning(over: Parameters<typeof makeAgentStack>[0] = {}) {
  const s = makeAgentStack(over)
  s.pty.autoExit = true
  const task = s.readyTask('Add login', 'Use sessions.')
  const agent = await s.service.start(s.project.id, task.id)
  return { s, task, agent }
}
/** The agent submits a plan and its process ends (the exit drains the inbox). */
async function submitAndExit(s: Awaited<ReturnType<typeof planning>>['s'], agentId: string, plan: Parameters<typeof s.submitPlan>[1] = {}, procIndex = 0) {
  s.submitPlan(agentId, plan)
  s.pty.procs[procIndex]!.exit(0)
  await s.sleep(60)
}

describe('plan capture', () => {
  it('stores a plan version, moves the task to awaiting approval, and does NOT approve anything', async () => {
    const { s, task, agent } = await planning()
    await submitAndExit(s, agent.id, { summary: 'Use sessions', steps: ['Add table', 'Add routes'], files: ['src/auth.ts'], tests: ['auth.test.ts'], risks: ['migration'] })
    const [plan] = s.planRepo.listPlans(task.id)
    expect(plan).toMatchObject({ version: 1, agentId: agent.id, status: 'current', content: { summary: 'Use sessions' } })
    expect(plan!.contentHash).toMatch(/^[0-9a-f]{64}$/)
    const t = s.taskRepo.get(task.id)!
    expect(t.status).toBe('awaiting_approval') // and the agent ending did not drag it back to Ready
    expect(t.approvalStatus).toBe('pending')
    expect(t.implementationPlan).toContain('Use sessions')
    expect(s.planRepo.validApproval(task.id)).toBeUndefined()
    expect(s.approvals.verify(s.project.id, task.id)).toMatchObject({ ok: false })
    expect(s.events).toContainEqual({ type: 'plans_changed', projectId: s.project.id, taskId: task.id })
    expect(s.submitted.map((p) => p.id)).toEqual([plan!.id])
    expect(s.eventTypes(s.project.id)).toContain('plan.submitted')
  })

  it('is also picked up while the agent is still running (polling)', async () => {
    const { s, task, agent } = await planning()
    s.submitPlan(agent.id)
    await s.sleep(1300)
    expect(s.taskRepo.get(task.id)?.status).toBe('awaiting_approval')
    expect(s.service.summary()).toEqual({ running: 1 }) // the agent keeps waiting, alive
  })

  it('an identical resubmission is ignored; a changed plan is a new version that supersedes the old', async () => {
    const { s, task, agent } = await planning()
    s.submitPlan(agent.id, { summary: 'v1' }); s.submitPlan(agent.id, { summary: 'v1' })
    s.pty.procs[0]!.exit(0); await s.sleep(60)
    expect(s.planRepo.listPlans(task.id)).toHaveLength(1)
    // a later agent run submits something different
    s.taskRepo.setStatus(task.id, 'awaiting_approval', 'planning', 'orchestrator')
    s.tasks.transitionSystem(s.project.id, task.id, 'ready')
    const second = await s.service.start(s.project.id, task.id)
    s.submitPlan(second.id, { summary: 'v2' })
    s.pty.procs[1]!.exit(0); await s.sleep(60)
    const plans = s.planRepo.listPlans(task.id)
    expect(plans.map((p) => [p.version, p.status])).toEqual([[2, 'current'], [1, 'superseded']])
  })

  it('an identical plan is recorded again when the task is waiting for one (after a rejection), not silently dropped', async () => {
    const { s, task, agent } = await planning()
    await submitAndExit(s, agent.id, { summary: 'Same plan' })
    const v1 = s.planRepo.latestPlan(task.id)!
    s.approvals.reject(s.project.id, task.id, v1.id, 'Try again') // task goes back to Ready (no live agent)
    const second = await s.service.start(s.project.id, task.id)
    s.submitPlan(second.id, { summary: 'Same plan' }) // the new run reaches the same plan
    s.pty.procs[1]!.exit(0); await s.sleep(60)
    expect(s.taskRepo.get(task.id)?.status).toBe('awaiting_approval') // not stuck in planning
    expect(s.planRepo.listPlans(task.id).map((p) => p.version)).toEqual([2, 1])
    expect(s.approvals.bundle(s.project.id, task.id).gate.state).toBe('awaiting_decision') // a fresh decision is needed
  })

  it('ignores invalid plans, unknown agents, and plans for a task that is no longer being planned', async () => {
    const { s, task, agent } = await planning()
    expect(s.planService.ingest('99999999-9999-4999-8999-999999999999', { summary: 'x', steps: ['y'], files: [], tests: [], risks: [] })).toMatchObject({ accepted: false, reason: 'unknown_agent' })
    s.tasks.transition(s.project.id, task.id, 'cancelled', 'user') // user cancels while the agent is alive
    s.submitPlan(agent.id)
    await s.sleep(100)
    s.pty.procs[0]!.exit(0); await s.sleep(60)
    expect(s.planRepo.listPlans(task.id)).toEqual([])
    expect(s.taskRepo.get(task.id)?.status).toBe('cancelled')
    require('node:fs').writeFileSync(join(s.inbox.dirFor(agent.id), 'plan-1-bad.json'), '{ nope')
    expect((await s.inbox.drain(agent.id)).rejected).toBe(1)
  })
})

describe('approval records and the execution gate', () => {
  async function awaiting(over: Parameters<typeof makeAgentStack>[0] = {}) {
    const ctx = await planning(over)
    await submitAndExit(ctx.s, ctx.agent.id, { summary: 'Plan v1' })
    const plan = ctx.s.planRepo.latestPlan(ctx.task.id)!
    return { ...ctx, plan }
  }

  it('approving the current plan stores who/what/when and authorizes execution', async () => {
    const { s, task, agent, plan } = await awaiting()
    const approval = s.approvals.approve(s.project.id, task.id, plan.id)
    expect(approval).toMatchObject({ taskId: task.id, agentId: agent.id, planId: plan.id, planVersion: 1, planHash: plan.contentHash, reviewer: 'user', status: 'approved', invalidatedAt: null })
    expect(approval.decidedAt).toBeTypeOf('number')
    expect(s.taskRepo.get(task.id)?.approvalStatus).toBe('approved')
    expect(s.eventTypes(s.project.id)).toContain('plan.approved')
    const bundle = s.approvals.bundle(s.project.id, task.id)
    expect(bundle.gate).toEqual({ state: 'approved', executionAuthorized: true, blockers: [] })
    expect(s.approvals.verify(s.project.id, task.id)).toMatchObject({ ok: true })
  })

  it('execution is blocked without an approval, however the task got here', async () => {
    const { s, task } = await awaiting()
    const verdict = s.approvals.verify(s.project.id, task.id)
    expect(verdict).toMatchObject({ ok: false })
    expect(code(() => s.approvals.authorizeExecution(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
    expect(s.taskRepo.get(task.id)?.status).toBe('awaiting_approval') // nothing moved
    expect(s.approvals.bundle(s.project.id, task.id).gate).toMatchObject({ state: 'awaiting_decision', executionAuthorized: false })
  })

  it('authorizeExecution moves the task to in_progress only on a valid approval, and records it', async () => {
    const { s, task, plan } = await awaiting()
    const approval = s.approvals.approve(s.project.id, task.id, plan.id)
    expect(s.approvals.authorizeExecution(s.project.id, task.id).id).toBe(approval.id)
    expect(s.taskRepo.get(task.id)?.status).toBe('in_progress')
    const payload = JSON.parse((s.handle.raw.prepare("select payload from activity_events where type = 'execution.authorized'").get() as { payload: string }).payload)
    expect(payload).toMatchObject({ taskId: task.id, approvalId: approval.id, planVersion: 1, planHash: plan.contentHash })
    expect(code(() => s.approvals.authorizeExecution(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED') // cannot authorize twice
  })

  it('a changed plan invalidates the old approval, and only the new version can be approved', async () => {
    const { s, task, plan } = await awaiting()
    s.approvals.approve(s.project.id, task.id, plan.id)
    // the agent revises: a different plan arrives while the task is still awaiting approval
    const second = s.planService.ingest(plan.agentId, { summary: 'Plan v2', steps: ['Different'], files: [], tests: [], risks: [] })
    expect(second).toMatchObject({ accepted: true, invalidatedApproval: true })
    expect(s.planRepo.validApproval(task.id)).toBeUndefined()
    expect(s.taskRepo.get(task.id)?.approvalStatus).toBe('pending')
    const verdict = s.approvals.verify(s.project.id, task.id)
    expect(verdict).toMatchObject({ ok: false })
    expect(code(() => s.approvals.authorizeExecution(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
    expect(code(() => s.approvals.approve(s.project.id, task.id, plan.id))).toBe('STALE_PLAN') // v1 can never be approved again
    const v2 = s.planRepo.latestPlan(task.id)!
    expect(v2.version).toBe(2)
    expect(s.approvals.approve(s.project.id, task.id, v2.id)).toMatchObject({ planVersion: 2 })
    const approvals = s.planRepo.listApprovals(task.id)
    expect(approvals.map((a) => [a.planVersion, a.invalidatedAt !== null])).toEqual([[2, false], [1, true]])
    expect(approvals.find((a) => a.planVersion === 1)?.invalidationReason).toMatch(/Superseded by plan version 2/)
    expect(s.eventTypes(s.project.id)).toContain('approval.invalidated')
  })

  it('detects a plan whose stored content no longer matches the approved hash', async () => {
    const { s, task, plan } = await awaiting()
    s.approvals.approve(s.project.id, task.id, plan.id)
    s.handle.raw.prepare('update task_plans set content = ? where id = ?').run(JSON.stringify({ summary: 'Sneaky edit', steps: ['rm -rf'], files: [], tests: [], risks: [] }), plan.id)
    const v = s.approvals.verify(s.project.id, task.id)
    expect(v).toMatchObject({ ok: false })
    expect((v as { blockers: string[] }).blockers.join(' ')).toMatch(/changed after it was approved/)
    expect(code(() => s.approvals.authorizeExecution(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
    expect(s.approvals.bundle(s.project.id, task.id).gate.executionAuthorized).toBe(false)
  })

  it('a rejected plan never authorizes execution, and the task goes back for a new plan', async () => {
    const { s, task, plan } = await awaiting()
    const rejection = s.approvals.reject(s.project.id, task.id, plan.id, 'Misses the migration')
    expect(rejection).toMatchObject({ status: 'rejected', reason: 'Misses the migration', reviewer: 'user' })
    expect(s.taskRepo.get(task.id)).toMatchObject({ approvalStatus: 'rejected', status: 'ready' }) // no live agent, so a new one can start
    expect(s.approvals.verify(s.project.id, task.id)).toMatchObject({ ok: false })
    expect(s.eventTypes(s.project.id)).toContain('plan.rejected')
    expect((await s.service.start(s.project.id, task.id)).status).toBe('running') // a fresh planning run
  })

  it('rejecting while the planning agent is alive returns the task to planning so it can revise', async () => {
    const { s, task, agent } = await planning()
    s.submitPlan(agent.id, { summary: 'v1' })
    await s.sleep(1300) // picked up by polling; the agent keeps running
    const plan = s.planRepo.latestPlan(task.id)!
    s.approvals.reject(s.project.id, task.id, plan.id, 'Needs tests')
    expect(s.taskRepo.get(task.id)?.status).toBe('planning')
    s.submitPlan(agent.id, { summary: 'v2 with tests', tests: ['t'] })
    await s.sleep(1300)
    expect(s.taskRepo.get(task.id)?.status).toBe('awaiting_approval')
    expect(s.planRepo.latestPlan(task.id)?.version).toBe(2)
  })

  it('a standing approval can be revoked before execution', async () => {
    const { s, task, plan } = await awaiting()
    expect(code(() => s.approvals.revoke(s.project.id, task.id))).toBe('NOT_FOUND') // nothing to revoke yet
    s.approvals.approve(s.project.id, task.id, plan.id)
    const bundle = s.approvals.revoke(s.project.id, task.id)
    expect(bundle.gate).toMatchObject({ state: 'awaiting_decision', executionAuthorized: false })
    expect(s.taskRepo.get(task.id)?.approvalStatus).toBe('pending')
    expect(s.planRepo.listApprovals(task.id)[0]?.invalidationReason).toBe('Revoked by user')
    expect(code(() => s.approvals.authorizeExecution(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
  })

  it('refuses decisions in the wrong state', async () => {
    const { s, task, plan } = await awaiting()
    expect(code(() => s.approvals.approve(s.project.id, task.id, 'nope'))).toBe('NOT_FOUND')
    s.approvals.approve(s.project.id, task.id, plan.id)
    expect(code(() => s.approvals.approve(s.project.id, task.id, plan.id))).toBe('ALREADY_APPROVED')
    s.approvals.authorizeExecution(s.project.id, task.id) // now in_progress
    expect(code(() => s.approvals.approve(s.project.id, task.id, plan.id))).toBe('NOT_AWAITING_APPROVAL')
    expect(code(() => s.approvals.reject(s.project.id, task.id, plan.id, 'late'))).toBe('NOT_AWAITING_APPROVAL')
  })

  it('approval requires completed dependencies, but planning did not', async () => {
    const s = makeAgentStack()
    s.pty.autoExit = true
    const dep = s.tasks.create({ projectId: s.project.id, title: 'Dependency' })
    const child = s.tasks.create({ projectId: s.project.id, title: 'Child', dependsOnTaskIds: [dep.id] })
    s.tasks.transition(s.project.id, child.id, 'ready', 'user')
    const agent = await s.service.start(s.project.id, child.id) // planning is allowed
    await submitAndExit(s, agent.id)
    const plan = s.planRepo.latestPlan(child.id)!
    expect(code(() => s.approvals.approve(s.project.id, child.id, plan.id))).toBe('DEPENDENCIES_INCOMPLETE')
    expect(s.approvals.bundle(s.project.id, child.id).gate.blockers.join(' ')).toMatch(/Dependency/)
    s.handle.raw.prepare("update tasks set status = 'completed' where id = ?").run(dep.id)
    expect(s.approvals.approve(s.project.id, child.id, plan.id)).toMatchObject({ status: 'approved' })
    // and the gate re-checks dependencies at execution time
    s.handle.raw.prepare("update tasks set status = 'in_progress' where id = ?").run(dep.id)
    expect(s.approvals.verify(s.project.id, child.id)).toMatchObject({ ok: false })
  })

  it('is scoped to the project: another project cannot read or decide', async () => {
    const { s, task, plan } = await awaiting()
    const other = s.addProject()
    for (const call of [
      () => s.approvals.bundle(other.id, task.id),
      () => s.approvals.approve(other.id, task.id, plan.id),
      () => s.approvals.reject(other.id, task.id, plan.id, 'x'),
      () => s.approvals.revoke(other.id, task.id)
    ]) expect(code(call)).toBe('NOT_FOUND')
    expect(s.approvals.verify(other.id, task.id)).toMatchObject({ ok: false })
    expect(code(() => s.approvals.authorizeExecution(other.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
    expect(s.planRepo.validApproval(task.id)).toBeUndefined()
  })

  it('an archived project cannot decide, and its gate is closed', async () => {
    const { s, task, plan } = await awaiting()
    s.approvals.approve(s.project.id, task.id, plan.id)
    s.projects.setStatus(s.project.id, 'archived')
    expect(code(() => s.approvals.approve(s.project.id, task.id, plan.id))).toBe('PROJECT_ARCHIVED')
    expect(s.approvals.verify(s.project.id, task.id)).toMatchObject({ ok: false })
    expect(code(() => s.approvals.authorizeExecution(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
  })

  it('the database allows only one valid approval per task', async () => {
    const { s, task, plan } = await awaiting()
    s.approvals.approve(s.project.id, task.id, plan.id)
    expect(() => s.planRepo.runInTransaction((tx) => s.planRepo.addApproval({ plan, status: 'approved', reason: '' }, tx))).toThrow()
    // a rejection record is not a valid approval, so it is allowed
    expect(() => s.planRepo.runInTransaction((tx) => s.planRepo.addApproval({ plan, status: 'rejected', reason: 'x' }, tx))).not.toThrow()
  })
})

describe('the gate is the only way past the approval check', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
    })
  }
  it('only the approval service ever passes approvalVerified: true', () => {
    const root = join(__dirname, '..', 'src')
    const offenders = sourceFiles(root).filter((f) => /approvalVerified\s*:\s*true/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
    expect(offenders).toEqual(['main/modules/orchestration/approval-service.ts'])
  })
  it('the renderer-facing IPC surface has no way to authorize execution or create an approval except the user actions', () => {
    // Comments are stripped: the file explains what it does NOT expose.
    const ipc = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'plans.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(ipc).not.toMatch(/authorizeExecution|transitionSystem|addApproval/)
    const types = readFileSync(join(__dirname, '..', 'src', 'shared', 'types', 'api.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(types).not.toMatch(/authorize/i)
  })
  it('plan decision inputs are validated', () => {
    expect(rejectPlanInputSchema.safeParse({ projectId: 'p', taskId: 't', planId: 'x', reason: '  ' }).success).toBe(false)
    expect(rejectPlanInputSchema.safeParse({ projectId: 'p', taskId: 't', planId: 'x', reason: 'y'.repeat(1001) }).success).toBe(false)
    expect(approvePlanInputSchema.safeParse({ projectId: 'p', taskId: 't', planId: 'x'.repeat(65) }).success).toBe(false)
  })
})


describe('review findings: capture, caps and one-shot approvals', () => {
  async function awaiting() {
    const ctx = await planning()
    await submitAndExit(ctx.s, ctx.agent.id, { summary: 'Plan v1' })
    return { ...ctx, plan: ctx.s.planRepo.latestPlan(ctx.task.id)! }
  }

  it('a plan submitted while a poll is mid-read is still captured when the agent exits', async () => {
    // The first drain lists the (empty) directory, then stalls: the plan lands and the agent exits meanwhile.
    class SlowInbox extends PlanInbox {
      first = true
      async drain(agentId: string) {
        if (this.first) { this.first = false; const r = await super.drain(agentId); await new Promise((res) => setTimeout(res, 300)); return r }
        return super.drain(agentId)
      }
    }
    const s = makeAgentStack({ inbox: new SlowInbox(require('node:os').tmpdir() + '/orbyte-slow-' + Math.random().toString(16).slice(2)) })
    s.pty.autoExit = true
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    await s.sleep(1150) // the 1s poll has started its (slow) drain and seen nothing
    s.submitPlan(agent.id, { summary: 'Submitted just before exit' })
    s.pty.procs[0]!.exit(0)
    await s.sleep(700)
    expect(s.planRepo.latestPlan(task.id)?.content.summary).toBe('Submitted just before exit') // not lost
    expect(s.taskRepo.get(task.id)?.status).toBe('awaiting_approval') // and the task was not sent back to Ready
  })

  it('caps the number of plan versions per task', async () => {
    const { s, task, agent } = await awaiting()
    for (let i = 2; i <= MAX_PLAN_VERSIONS; i++) {
      expect(s.planService.ingest(agent.id, { summary: `v${i}`, steps: [`s${i}`], files: [], tests: [], risks: [] })).toMatchObject({ accepted: true })
    }
    expect(s.planRepo.listPlans(task.id)).toHaveLength(MAX_PLAN_VERSIONS)
    expect(s.planService.ingest(agent.id, { summary: 'one too many', steps: ['x'], files: [], tests: [], risks: [] })).toMatchObject({ accepted: false, reason: 'too_many_versions' })
    expect(s.planRepo.listPlans(task.id)).toHaveLength(MAX_PLAN_VERSIONS)
  })

  it('an approval authorizes exactly one start: it is spent, and a later return to Ready cannot reuse it', async () => {
    const { s, task, plan } = await awaiting()
    const approval = s.approvals.approve(s.project.id, task.id, plan.id)
    s.approvals.authorizeExecution(s.project.id, task.id)
    expect(s.planRepo.validApproval(task.id)).toBeUndefined()
    const spent = s.planRepo.listApprovals(task.id).find((a) => a.id === approval.id)
    expect(spent?.invalidationReason).toBe('Consumed: execution was authorized')
    // execution stops and the task goes back around: the old approval does not come back
    s.tasks.transitionSystem(s.project.id, task.id, 'ready')
    s.tasks.transitionSystem(s.project.id, task.id, 'planning')
    s.tasks.transitionSystem(s.project.id, task.id, 'awaiting_approval')
    expect(s.approvals.verify(s.project.id, task.id)).toMatchObject({ ok: false })
    expect(code(() => s.approvals.authorizeExecution(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
  })

  it('an approval cannot be revoked once execution has begun', async () => {
    const { s, task, plan } = await awaiting()
    s.approvals.approve(s.project.id, task.id, plan.id)
    s.approvals.authorizeExecution(s.project.id, task.id)
    expect(code(() => s.approvals.revoke(s.project.id, task.id))).toBe('NOT_AWAITING_APPROVAL')
  })

  it('the gate is closed when the agent behind the plan is gone or its worktree was removed', async () => {
    const { s, task, agent, plan } = await awaiting()
    s.approvals.approve(s.project.id, task.id, plan.id)
    s.agentRepo.markWorktreeRemoved(agent.id)
    const v = s.approvals.verify(s.project.id, task.id)
    expect(v).toMatchObject({ ok: false })
    expect((v as { blockers: string[] }).blockers.join(' ')).toMatch(/worktree has been removed/)
    expect(code(() => s.approvals.authorizeExecution(s.project.id, task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
    s.handle.raw.pragma('foreign_keys = OFF')
    s.handle.raw.prepare('delete from developer_agents where id = ?').run(agent.id)
    expect((s.approvals.verify(s.project.id, task.id) as { blockers: string[] }).blockers.join(' ')).toMatch(/no longer exists/)
  })

  it('moving the task out of awaiting approval drops the approval, and the badge and gate agree', async () => {
    const { s, task, plan } = await awaiting()
    s.approvals.approve(s.project.id, task.id, plan.id)
    expect(s.taskRepo.get(task.id)?.approvalStatus).toBe('approved')
    s.tasks.transition(s.project.id, task.id, 'blocked', 'user') // the user blocks it
    expect(s.planRepo.validApproval(task.id)).toBeUndefined()
    expect(s.taskRepo.get(task.id)?.approvalStatus).toBe('none') // no stale "Plan approved"
    expect(s.planRepo.listApprovals(task.id)[0]?.invalidationReason).toBe('The task left awaiting approval')
    expect(s.approvals.bundle(s.project.id, task.id).gate.executionAuthorized).toBe(false)
  })
})
