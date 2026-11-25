import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentInbox } from '../src/main/modules/agents/developers/agent-inbox'
import { GitWorktrees } from '../src/main/modules/agents/developers/worktrees'
import { MaintenanceService } from '../src/main/modules/maintenance/service'
import { AppError } from '../src/shared/types/result'
import { makeAgentStack, tempDir } from './helpers'

function stack() {
  const inboxRoot = tempDir('orbyte-inboxroot-')
  const s = makeAgentStack({ inbox: new AgentInbox(inboxRoot) })
  const git = new GitWorktrees()
  const dests: string[] = []
  const m = new MaintenanceService({
    db: s.handle.db, projects: s.projects, agents: s.agentRepo, inbox: s.inbox, inboxRoot, worktrees: git, worktreeRoot: s.worktreeRoot,
    backupTo: async (d) => { dests.push(d); await s.handle.raw.backup(d) }
  })
  /** A real registered git worktree that no agent row owns (as left by a crash or a deleted database row). */
  const orphan = async (projectId = s.project.id) => {
    const name = randomUUID()
    const path = join(s.worktreeRoot, projectId, name)
    mkdirSync(join(s.worktreeRoot, projectId), { recursive: true })
    await git.add(s.repoPath, path, `orbyte/orphan-${name.slice(0, 8)}`, await git.resolveBase(s.repoPath, 'main'))
    return { name, path }
  }
  return { s, m, inboxRoot, orphan, dests }
}

describe('startup sweep', () => {
  it('removes inboxes of agents that no longer exist, keeps known ones, and records one audited summary', async () => {
    const { s, m, inboxRoot } = stack()
    const task = s.readyTask()
    s.pty.autoExit = true
    const agent = await s.service.start(s.project.id, task.id)
    const known = s.inbox.dirFor(agent.id)
    // an inbox root of its own, with a stray directory and a non-uuid name that must be left alone
    const stray = randomUUID()
    mkdirSync(join(inboxRoot, stray)); mkdirSync(join(inboxRoot, 'not-an-agent'))
    const res = await m.sweepAtStartup({ interruptedAgents: 1, interruptedRuns: 0 })
    expect(res.orphanInboxesRemoved).toBe(1)
    expect(existsSync(join(inboxRoot, stray))).toBe(false)
    expect(existsSync(join(inboxRoot, 'not-an-agent'))).toBe(true)
    expect(existsSync(known)).toBe(true)
    const row = s.handle.raw.prepare("select payload from activity_events where type = 'recovery.completed'").get() as { payload: string }
    expect(JSON.parse(row.payload)).toMatchObject({ interruptedAgents: 1, orphanInboxesRemoved: 1 })
  })

  it('writes nothing when there is nothing to report', async () => {
    const { s, m } = stack()
    await m.sweepAtStartup({ interruptedAgents: 0, interruptedRuns: 0 })
    expect(s.handle.raw.prepare("select count(*) as n from activity_events where type = 'recovery.completed'").get()).toEqual({ n: 0 })
  })
})

describe('orphan worktrees', () => {
  it('lists only directories no agent owns, and cleans a clean one but keeps one with changes', async () => {
    const { s, m, orphan } = stack()
    s.pty.autoExit = true
    const owned = await s.service.start(s.project.id, s.readyTask().id) // owned: must never be listed
    const clean = await orphan(); const dirty = await orphan()
    writeFileSync(join(dirty.path, 'work.txt'), 'unsaved work')
    const { orphanWorktrees } = await m.scan()
    expect(orphanWorktrees.map((o) => o.name).sort()).toEqual([clean.name, dirty.name].sort())
    expect(orphanWorktrees.some((o) => o.name === owned.worktreePath.split('/').pop())).toBe(false)

    const res = await m.cleanOrphans(orphanWorktrees.map((o) => o.id))
    expect(res.removed).toBe(1)
    expect(res.skipped).toHaveLength(1)
    expect(existsSync(clean.path)).toBe(false)
    expect(existsSync(join(dirty.path, 'work.txt'))).toBe(true) // never deletes uncommitted work
  })

  it('ignores ids that a fresh scan does not list, and refuses an orphan of an unknown project', async () => {
    const { s, m } = stack()
    expect(await m.cleanOrphans(['not-a-real-id'])).toEqual({ removed: 0, skipped: [] })
    const ghost = join(s.worktreeRoot, 'gone-project', randomUUID())
    mkdirSync(ghost, { recursive: true })
    const [o] = (await m.scan()).orphanWorktrees
    expect(o).toMatchObject({ projectId: 'gone-project', projectName: null })
    const res = await m.cleanOrphans([o!.id])
    expect(res.removed).toBe(0)
    expect(res.skipped[0]?.reason).toMatch(/project no longer exists/)
    expect(existsSync(ghost)).toBe(true)
  })
})

describe('orphans with stray commits', () => {
  it('keeps a clean orphan whose HEAD has a commit on no branch', async () => {
    const { m, orphan } = stack()
    const o = await orphan()
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: o.path })
    writeFileSync(join(o.path, 'x.txt'), 'x')
    execFileSync('git', ['add', '-A'], { cwd: o.path })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'stray'], { cwd: o.path })
    const [item] = (await m.scan()).orphanWorktrees
    const res = await m.cleanOrphans([item!.id])
    expect(res.removed).toBe(0)
    expect(res.skipped[0]?.reason).toMatch(/on no branch/)
    expect(existsSync(o.path)).toBe(true)
  })
})

describe('backup', () => {
  it('writes a consistent, readable copy and refuses a name that is not a database file', async () => {
    const { s, m, dests } = stack()
    const dest = join(tempDir('orbyte-bak-'), 'backup.db')
    await m.backup(dest)
    expect(dests).toEqual([dest])
    const copy = new Database(dest, { readonly: true })
    expect(copy.prepare('select count(*) as n from projects').get()).toEqual({ n: 1 })
    expect(s.project.id).toBeTruthy()
    copy.close()
    expect(require('node:fs').statSync(dest).mode & 0o077).toBe(0)
    await expect(m.backup(join(tempDir('orbyte-bak-'), 'backup.txt'))).rejects.toBeInstanceOf(AppError)
  })
})

describe('discard races', () => {
  it('a second discard of the same worktree is refused while the first is running', async () => {
    const s = makeAgentStack(); s.pty.autoExit = true
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    s.pty.procs[0]!.exit(0); await s.sleep(60)
    const results = await Promise.allSettled([s.service.discard(s.project.id, agent.id), s.service.discard(s.project.id, agent.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    expect((rejected?.reason as AppError | undefined)?.code).toBe('AGENT_RUNNING')
  })

  it('does not delete the worktree if the task became active during the git checks', async () => {
    class Racy extends GitWorktrees {
      override async hasChanges(path: string): Promise<boolean> {
        const r = await super.hasChanges(path)
        racy.onCheck()
        return r
      }
    }
    const racy = { onCheck: () => undefined as void }
    const s = makeAgentStack(); s.pty.autoExit = true
    s.restart({ worktrees: new Racy() })
    const task = s.readyTask()
    const agent = await s.service.start(s.project.id, task.id)
    s.pty.procs[0]!.exit(0); await s.sleep(60)
    racy.onCheck = () => { s.handle.raw.prepare("update tasks set status = 'in_progress' where id = ?").run(task.id) }
    await expect(s.service.discard(s.project.id, agent.id)).rejects.toMatchObject({ code: 'TASK_ACTIVE' })
    expect(existsSync(agent.worktreePath)).toBe(true)
  })
})
