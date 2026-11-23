import { describe, expect, it } from 'vitest'
import { AppError } from '../src/shared/types/result'
import { makeTaskStack } from './helpers'

const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return e instanceof AppError ? e.code : 'OTHER' }
  return 'NONE'
}

describe('TaskService', () => {
  it('creates tasks as the user, with defaults, audit events and a change event', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const task = t.tasks.create({ projectId: p.id, title: 'Do it' })
    expect(task).toMatchObject({ status: 'backlog', priority: 'medium', source: 'user', approvalStatus: 'none', executionStatus: 'idle', dependsOnTaskIds: [] })
    expect(t.eventTypes(p.id)).toContain('task.created')
    expect(t.events).toContainEqual({ type: 'tasks_changed', projectId: p.id })
    expect(t.tasks.list(p.id).map((x) => x.id)).toEqual([task.id])
  })

  it('validates dependencies on create and update (existence, ownership, cycles)', () => {
    const t = makeTaskStack()
    const p = t.addProject(); const q = t.addProject()
    const a = t.tasks.create({ projectId: p.id, title: 'A' })
    const b = t.tasks.create({ projectId: p.id, title: 'B', dependsOnTaskIds: [a.id] })
    const foreign = t.tasks.create({ projectId: q.id, title: 'Q' })
    expect(code(() => t.tasks.create({ projectId: p.id, title: 'X', dependsOnTaskIds: ['nope'] }))).toBe('INVALID_DEPENDENCY')
    expect(code(() => t.tasks.create({ projectId: p.id, title: 'X', dependsOnTaskIds: [foreign.id] }))).toBe('INVALID_DEPENDENCY')
    expect(code(() => t.tasks.update({ projectId: p.id, taskId: a.id, patch: { dependsOnTaskIds: [b.id] } }))).toBe('INVALID_DEPENDENCY') // cycle
    expect(code(() => t.tasks.update({ projectId: p.id, taskId: a.id, patch: { dependsOnTaskIds: [a.id] } }))).toBe('INVALID_DEPENDENCY') // self
    expect(t.tasks.update({ projectId: p.id, taskId: b.id, patch: { dependsOnTaskIds: [] } }).dependsOnTaskIds).toEqual([])
  })

  it('enforces project ownership with the same error as a missing task', () => {
    const t = makeTaskStack()
    const p = t.addProject(); const q = t.addProject()
    const task = t.tasks.create({ projectId: p.id, title: 'A' })
    for (const call of [
      () => t.tasks.update({ projectId: q.id, taskId: task.id, patch: { title: 'hijack' } }),
      () => t.tasks.transition(q.id, task.id, 'ready', 'user'),
      () => t.tasks.update({ projectId: p.id, taskId: 'missing', patch: { title: 'x' } })
    ]) expect(code(call)).toBe('NOT_FOUND')
    expect(t.tasks.list(p.id)[0]?.title).toBe('A')
    expect(code(() => t.tasks.list('missing'))).toBe('NOT_FOUND')
  })

  it('transitions follow the state machine and record who moved what', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const task = t.tasks.create({ projectId: p.id, title: 'A' })
    expect(t.tasks.transition(p.id, task.id, 'ready', 'user').status).toBe('ready')
    expect(code(() => t.tasks.transition(p.id, task.id, 'in_progress', 'user'))).toBe('INVALID_TRANSITION')
    expect(code(() => t.tasks.transition(p.id, task.id, 'planning', 'user'))).toBe('INVALID_TRANSITION') // orchestrator only
    expect(code(() => t.tasks.transition(p.id, task.id, 'completed', 'user'))).toBe('INVALID_TRANSITION')
    expect(t.taskRepo.get(task.id)?.status).toBe('ready')
    expect(t.tasks.transition(p.id, task.id, 'cancelled', 'user').status).toBe('cancelled')
    expect(t.tasks.transition(p.id, task.id, 'backlog', 'user').status).toBe('backlog') // reopen
    const moves = (t.handle.raw.prepare("select payload from activity_events where type = 'task.transitioned' order by rowid").all() as { payload: string }[]).map((r) => JSON.parse(r.payload))
    expect(moves).toEqual([
      { taskId: task.id, from: 'backlog', to: 'ready', actor: 'user' },
      { taskId: task.id, from: 'ready', to: 'cancelled', actor: 'user' },
      { taskId: task.id, from: 'cancelled', to: 'backlog', actor: 'user' }
    ])
  })

  it('nothing can reach in_progress without an approval check, even as the orchestrator', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const task = t.tasks.create({ projectId: p.id, title: 'A' })
    t.tasks.transition(p.id, task.id, 'ready', 'user')
    t.tasks.transition(p.id, task.id, 'planning', 'orchestrator')
    t.tasks.transition(p.id, task.id, 'awaiting_approval', 'orchestrator')
    expect(code(() => t.tasks.transition(p.id, task.id, 'in_progress', 'orchestrator'))).toBe('INVALID_TRANSITION')
    expect(t.taskRepo.get(task.id)?.status).toBe('awaiting_approval')
    expect(t.tasks.transition(p.id, task.id, 'in_progress', 'orchestrator', { approvalVerified: true }).status).toBe('in_progress')
  })

  it('limits editing by status', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const task = t.tasks.create({ projectId: p.id, title: 'A' })
    t.tasks.transition(p.id, task.id, 'ready', 'user')
    t.tasks.transition(p.id, task.id, 'planning', 'orchestrator')
    expect(code(() => t.tasks.update({ projectId: p.id, taskId: task.id, patch: { title: 'B' } }))).toBe('NOT_EDITABLE')
    expect(t.tasks.update({ projectId: p.id, taskId: task.id, patch: { priority: 'urgent' } }).priority).toBe('urgent') // priority stays editable while open
    t.tasks.transition(p.id, task.id, 'cancelled', 'user')
    expect(code(() => t.tasks.update({ projectId: p.id, taskId: task.id, patch: { priority: 'low' } }))).toBe('NOT_EDITABLE')
  })

  it('refuses changes on archived projects and counts open tasks across active projects', () => {
    const t = makeTaskStack()
    const p = t.addProject(); const q = t.addProject()
    const a = t.tasks.create({ projectId: p.id, title: 'A' })
    t.tasks.create({ projectId: p.id, title: 'B' })
    t.tasks.create({ projectId: q.id, title: 'C' })
    t.tasks.transition(p.id, a.id, 'cancelled', 'user')
    expect(t.tasks.summary()).toEqual({ open: 2, byStatus: { backlog: 2, cancelled: 1 } })
    t.projects.setStatus(q.id, 'archived')
    expect(t.tasks.summary().open).toBe(1)
    expect(code(() => t.tasks.create({ projectId: q.id, title: 'D' }))).toBe('PROJECT_ARCHIVED')
  })

  it('digest gives the Team Lead a compact read-only view', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const a = t.tasks.create({ projectId: p.id, title: 'A', priority: 'high' })
    const b = t.tasks.create({ projectId: p.id, title: 'B', dependsOnTaskIds: [a.id] })
    expect(t.tasks.digest(p.id)).toEqual({
      total: 2,
      tasks: [
        { id: b.id, title: 'B', status: 'backlog', priority: 'medium', dependsOn: [a.id] }, // newest first
        { id: a.id, title: 'A', status: 'backlog', priority: 'high', dependsOn: [] }
      ]
    })
  })

  it('digest lists open tasks before closed ones and reports truncation honestly', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const closed = t.tasks.create({ projectId: p.id, title: 'old closed' })
    t.tasks.transition(p.id, closed.id, 'cancelled', 'user')
    for (let i = 0; i < 105; i++) t.tasks.create({ projectId: p.id, title: `open ${i}` })
    const d = t.tasks.digest(p.id)
    expect(d.total).toBe(106)
    expect(d.tasks).toHaveLength(100)
    expect(d.tasks[0]?.title).toBe('open 104') // newest open first
    expect(d.tasks.every((x) => x.status === 'backlog')).toBe(true) // the closed task is the one cut off
  })
})
