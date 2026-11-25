import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitWorktrees } from '../src/main/modules/agents/developers/worktrees'
import { ExecutionRepository } from '../src/main/modules/orchestration/execution-repository'
import { ExecutionService } from '../src/main/modules/orchestration/execution-service'
import { HmacRowSigner, UnavailableSigner, loadRowSigner, type SecureStore } from '../src/main/security/row-signer'
import { AppError } from '../src/shared/types/result'
import { makeAgentStack, tempDir } from './helpers'

const fakeStore = (available = true): SecureStore => ({
  isEncryptionAvailable: () => available,
  encryptString: (v) => Buffer.from(v, 'utf8').reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString('utf8')
})
const code = async (fn: () => unknown): Promise<string> => {
  try { await fn() } catch (e) { return e instanceof AppError ? e.code : 'OTHER' }
  return 'NONE'
}

describe('row signer', () => {
  const signer = new HmacRowSigner(Buffer.alloc(32, 7))
  it('verifies only the exact fields it signed', () => {
    const fields = ['plan_approval', 'a1', 3, null, 'approved'] as const
    const sig = signer.sign(fields)
    expect(signer.verify(fields, sig)).toBe(true)
    expect(signer.verify(['plan_approval', 'a1', 4, null, 'approved'], sig)).toBe(false)
    expect(signer.verify(['plan_approval', 'a1', 3, '', 'approved'], sig)).toBe(false) // null is not ''
    expect(signer.verify(fields, null)).toBe(false)
    expect(signer.verify(fields, 'zz')).toBe(false)
    expect(new HmacRowSigner(Buffer.alloc(32, 8)).verify(fields, sig)).toBe(false)
    expect(() => new HmacRowSigner(Buffer.alloc(8))).toThrow()
  })

  it('creates a private key file once and reuses it', () => {
    const file = join(tempDir(), 'signing.key')
    const first = loadRowSigner(file, fakeStore())
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const sig = first.sign(['x'])
    expect(loadRowSigner(file, fakeStore()).verify(['x'], sig)).toBe(true)
  })

  it('fails closed when the key cannot be protected or read', () => {
    const none = loadRowSigner(join(tempDir(), 'k'), fakeStore(false))
    expect(none).toBeInstanceOf(UnavailableSigner)
    expect(none.verify(['x'], 'a'.repeat(64))).toBe(false)
    expect(() => none.sign(['x'])).toThrow(/will not record/)
    const file = join(tempDir(), 'k')
    writeFileSync(file, 'not an encrypted key')
    expect(loadRowSigner(file, { ...fakeStore(), decryptString: () => { throw new Error('bad') } })).toBeInstanceOf(UnavailableSigner)
  })
})

describe('signed approvals and decisions', () => {
  async function approved() {
    const s = makeAgentStack(); s.pty.autoExit = true
    const exec = new ExecutionRepository(s.handle.db)
    let execution!: ExecutionService
    s.restart({
      onProgress: (id, m) => execution.onProgress(id, m),
      onResult: (id, r) => execution.onResult(id, r),
      onExecutionAgentEnded: (a, st) => execution.onAgentEnded(a, st)
    })
    execution = new ExecutionService({ projects: s.projects, taskRepo: s.taskRepo, tasks: s.tasks, agents: s.agentRepo, agentService: s.service, approvals: s.approvals, plans: s.planRepo, exec, worktrees: new GitWorktrees(), emit: () => undefined })
    const task = s.readyTask('Add login', 'Use sessions.')
    const planner = await s.service.start(s.project.id, task.id)
    s.submitPlan(planner.id)
    s.pty.procs[0]!.exit(0)
    await s.sleep(80)
    const plan = s.planRepo.latestPlan(task.id)!
    s.approvals.approve(s.project.id, task.id, plan.id)
    return { s, task, plan, exec, execution }
  }

  it('an approval row edited in the database no longer authorizes execution', async () => {
    const c = await approved()
    expect(c.s.planRepo.validApproval(c.task.id)).toBeDefined()
    c.s.handle.raw.prepare("update plan_approvals set reason = 'edited'").run()
    expect(c.s.planRepo.validApproval(c.task.id)).toBeUndefined()
    expect(await code(() => c.execution.start(c.s.project.id, c.task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
    expect(c.s.taskRepo.get(c.task.id)?.status).toBe('awaiting_approval')
  })

  it('an approval row with no signature, such as one inserted or from before signing, authorizes nothing', async () => {
    const c = await approved()
    c.s.handle.raw.prepare('update plan_approvals set signature = null').run()
    expect(await code(() => c.execution.start(c.s.project.id, c.task.id))).toBe('EXECUTION_NOT_AUTHORIZED')
  })

  it('a spent approval cannot be revived by clearing its invalidation', async () => {
    const c = await approved()
    await c.execution.start(c.s.project.id, c.task.id)
    expect(c.s.planRepo.validApproval(c.task.id)).toBeUndefined()
    c.s.handle.raw.prepare('update plan_approvals set invalidated_at = null, invalidation_reason = null').run()
    expect(c.s.planRepo.validApproval(c.task.id)).toBeUndefined()
  })

  it('a decision row that was not signed by Orbyte is not an acceptance or a change request', async () => {
    const c = await approved()
    const agent = await c.execution.start(c.s.project.id, c.task.id)
    writeFileSync(join(c.s.pty.procs[1]!.opts.cwd, 'a.ts'), 'x')
    writeFileSync(join(c.s.inbox.dirFor(agent.id), `result-${Date.now()}-a.json`), JSON.stringify({ result: { summary: 's', tests: [] } }))
    c.s.pty.procs[1]!.exit(0)
    for (let i = 0; i < 100 && c.s.taskRepo.get(c.task.id)?.status !== 'in_review'; i++) await c.s.sleep(25)
    const result = c.exec.latestResult(c.task.id)!
    const insert = c.s.handle.raw.prepare("insert into result_decisions (id, project_id, task_id, result_id, result_version, snapshot_hash, reviewer, decision, feedback) values (?, ?, ?, ?, 1, ?, 'user', ?, '')")
    insert.run('forged-1', c.s.project.id, c.task.id, result.id, result.evidence.snapshotHash, 'accepted')
    expect(c.exec.validAcceptance(c.task.id)).toBeUndefined()
    c.s.handle.raw.prepare("update result_decisions set decision = 'changes_requested' where id = 'forged-1'").run()
    expect(c.exec.validChangeRequest(c.task.id)).toBeUndefined()
    // A real acceptance made through the service is signed and still works.
    const real = c.exec.runInTransaction((tx) => c.exec.addDecision({ result, decision: 'accepted', feedback: '' }, tx))
    expect(c.exec.validAcceptance(c.task.id)?.id).toBe(real.id)
    c.s.handle.raw.prepare("update result_decisions set feedback = 'x' where id = ?").run(real.id)
    expect(c.exec.validAcceptance(c.task.id)).toBeUndefined()
  })
})
