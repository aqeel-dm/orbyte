import { describe, expect, it } from 'vitest'
import { MAX_PENDING_PROPOSALS } from '../src/main/modules/orchestration/proposal-service'
import type { ProposeTasksInput } from '../src/shared/schemas/task'
import { AppError } from '../src/shared/types/result'
import { makeTaskStack } from './helpers'

const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return e instanceof AppError ? e.code : 'OTHER' }
  return 'NONE'
}
const input = (tasks: Partial<ProposeTasksInput['tasks'][number]>[]): ProposeTasksInput => ({
  summary: 'plan',
  tasks: tasks.map((t, i) => ({ title: `T${i}`, description: '', priority: 'medium' as const, dependsOnIndexes: [], dependsOnTaskIds: [], ...t }))
})

describe('ProposalService', () => {
  it('recording a proposal creates NO tasks (the Team Lead cannot create tasks)', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const { proposalId, count } = t.proposals.record(p.id, input([{}, { dependsOnIndexes: [0] }]))
    expect(count).toBe(2)
    expect(t.tasks.list(p.id)).toEqual([])
    expect(t.proposals.list(p.id)[0]).toMatchObject({ id: proposalId, status: 'pending', createdTaskIds: [] })
    expect(t.eventTypes(p.id)).toEqual(expect.arrayContaining(['proposal.recorded']))
    expect(t.eventTypes(p.id)).not.toContain('task.created')
    expect(t.events).toContainEqual({ type: 'proposals_changed', projectId: p.id })
  })

  it('approving creates the chosen tasks with provenance, dependencies and one audit trail', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const { proposalId } = t.proposals.record(p.id, input([{ title: 'Schema' }, { title: 'API', dependsOnIndexes: [0] }, { title: 'UI', dependsOnIndexes: [1] }]))
    const items = t.proposals.list(p.id)[0]!.items
    const created = t.proposals.approve(p.id, proposalId, items)
    expect(created.map((c) => c.title).sort()).toEqual(['API', 'Schema', 'UI'])
    const byTitle = Object.fromEntries(created.map((c) => [c.title, c]))
    expect(byTitle['Schema']!.dependsOnTaskIds).toEqual([])
    expect(byTitle['API']!.dependsOnTaskIds).toEqual([byTitle['Schema']!.id])
    expect(byTitle['UI']!.dependsOnTaskIds).toEqual([byTitle['API']!.id])
    expect(created.every((c) => c.source === 'team_lead' && c.status === 'backlog')).toBe(true)
    expect(t.proposals.list(p.id)[0]).toMatchObject({ status: 'approved', createdTaskIds: expect.arrayContaining(created.map((c) => c.id)) })
    expect(t.eventTypes(p.id).filter((e) => e === 'task.created')).toHaveLength(3)
    expect(t.eventTypes(p.id)).toContain('proposal.approved')
  })

  it('the user can untick tasks and edit the rest', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const { proposalId } = t.proposals.record(p.id, input([{ title: 'A' }, { title: 'B' }, { title: 'C' }]))
    const items = t.proposals.list(p.id)[0]!.items
    const created = t.proposals.approve(p.id, proposalId, [{ ...items[0]!, title: 'A (edited)', priority: 'urgent' }, items[2]!])
    expect(created.map((c) => [c.title, c.priority]).sort()).toEqual([['A (edited)', 'urgent'], ['C', 'medium']])
    expect(t.tasks.list(p.id)).toHaveLength(2)
  })

  it('rejects a selection that leaves out a dependency, or includes tasks that are not in the proposal', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const { proposalId } = t.proposals.record(p.id, input([{ title: 'A' }, { title: 'B', dependsOnIndexes: [0] }]))
    const items = t.proposals.list(p.id)[0]!.items
    expect(code(() => t.proposals.approve(p.id, proposalId, [items[1]!]))).toBe('INVALID_DEPENDENCY') // B without A
    expect(code(() => t.proposals.approve(p.id, proposalId, [{ ...items[0]!, key: 7 }]))).toBe('INVALID_PROPOSAL')
    expect(code(() => t.proposals.approve(p.id, proposalId, [items[0]!, items[0]!]))).toBe('INVALID_PROPOSAL')
    expect(t.tasks.list(p.id)).toEqual([])
    expect(t.proposals.list(p.id)[0]?.status).toBe('pending')
  })

  it('a proposal can only be decided once', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const { proposalId } = t.proposals.record(p.id, input([{}]))
    const items = t.proposals.list(p.id)[0]!.items
    t.proposals.approve(p.id, proposalId, items)
    expect(code(() => t.proposals.approve(p.id, proposalId, items))).toBe('ALREADY_DECIDED')
    expect(code(() => t.proposals.dismiss(p.id, proposalId))).toBe('ALREADY_DECIDED')
    expect(t.tasks.list(p.id)).toHaveLength(1)
  })

  it('dismissing creates nothing and is recorded', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const { proposalId } = t.proposals.record(p.id, input([{}]))
    expect(t.proposals.dismiss(p.id, proposalId).status).toBe('dismissed')
    expect(t.tasks.list(p.id)).toEqual([])
    expect(t.eventTypes(p.id)).toContain('proposal.dismissed')
  })

  it('is atomic: if creation fails midway, no task is created and the proposal stays pending', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const existing = t.tasks.create({ projectId: p.id, title: 'Existing' })
    const { proposalId } = t.proposals.record(p.id, input([{ title: 'A' }, { title: 'B', dependsOnIndexes: [0], dependsOnTaskIds: [existing.id] }]))
    const items = t.proposals.list(p.id)[0]!.items
    // Make the second insert fail inside the transaction by removing the dependency target underneath it.
    t.handle.raw.prepare('delete from tasks where id = ?').run(existing.id)
    // validation catches the missing dependency up front...
    expect(code(() => t.proposals.approve(p.id, proposalId, items))).toBe('INVALID_DEPENDENCY')
    // ...and a forced failure during the write also rolls back everything.
    t.taskRepo.create({ projectId: p.id, title: 'seed', description: '', priority: 'low', source: 'user', dependsOnTaskIds: [] })
    const real = t.taskRepo.create.bind(t.taskRepo)
    let calls = 0
    t.taskRepo.create = ((i: Parameters<typeof real>[0], tx?: Parameters<typeof real>[1]) => {
      if (++calls === 2) throw new Error('disk full')
      return real(i, tx)
    }) as typeof t.taskRepo.create
    const clean = items.map((i) => ({ ...i, dependsOnTaskIds: [] }))
    const before = t.tasks.list(p.id).length
    expect(() => t.proposals.approve(p.id, proposalId, clean)).toThrow('disk full')
    expect(t.tasks.list(p.id).length).toBe(before)
    expect(t.proposals.list(p.id)[0]?.status).toBe('pending')
  })

  it('validates dependencies at record time and again at approval time', () => {
    const t = makeTaskStack()
    const p = t.addProject(); const q = t.addProject()
    const foreign = t.tasks.create({ projectId: q.id, title: 'Q' })
    const live = t.tasks.create({ projectId: p.id, title: 'Live' })
    expect(code(() => t.proposals.record(p.id, input([{ dependsOnIndexes: [5] }])))).toBe('INVALID_DEPENDENCY')
    expect(code(() => t.proposals.record(p.id, input([{ dependsOnIndexes: [0] }])))).toBe('INVALID_DEPENDENCY') // itself
    expect(code(() => t.proposals.record(p.id, input([{ dependsOnIndexes: [1] }, { dependsOnIndexes: [0] }])))).toBe('INVALID_DEPENDENCY') // cycle
    expect(code(() => t.proposals.record(p.id, input([{ dependsOnTaskIds: [foreign.id] }])))).toBe('INVALID_DEPENDENCY')
    const { proposalId } = t.proposals.record(p.id, input([{ dependsOnTaskIds: [live.id] }]))
    t.tasks.transition(p.id, live.id, 'cancelled', 'user') // becomes invalid after recording
    expect(code(() => t.proposals.approve(p.id, proposalId, t.proposals.list(p.id)[0]!.items))).toBe('INVALID_DEPENDENCY')
    expect(t.tasks.list(p.id)).toHaveLength(1)
  })

  it('is scoped to the project: another project cannot decide or see a proposal', () => {
    const t = makeTaskStack()
    const p = t.addProject(); const q = t.addProject()
    const { proposalId } = t.proposals.record(p.id, input([{}]))
    const items = t.proposals.list(p.id)[0]!.items
    expect(code(() => t.proposals.approve(q.id, proposalId, items))).toBe('NOT_FOUND')
    expect(code(() => t.proposals.dismiss(q.id, proposalId))).toBe('NOT_FOUND')
    expect(t.proposals.list(q.id)).toEqual([])
    expect(t.tasks.list(q.id)).toEqual([])
  })

  it('caps pending proposals and refuses archived projects', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    for (let i = 0; i < MAX_PENDING_PROPOSALS; i++) t.proposals.record(p.id, input([{}]))
    expect(code(() => t.proposals.record(p.id, input([{}])))).toBe('TOO_MANY_PROPOSALS')
    const q = t.addProject()
    t.projects.setStatus(q.id, 'archived')
    expect(code(() => t.proposals.record(q.id, input([{}])))).toBe('PROJECT_ARCHIVED')
  })
})

describe('duplicate dependencies (review finding M1)', () => {
  it('a proposal with a repeated dependency key is rejected at record time, not at approval', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    expect(code(() => t.proposals.record(p.id, input([{}, { dependsOnIndexes: [0, 0] }])))).toBe('INVALID_DEPENDENCY')
    expect(t.proposals.list(p.id)).toEqual([]) // nothing recorded, so no pending slot is consumed
  })
  it('combined key and task-id dependencies are capped at the per-task limit', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const ids = Array.from({ length: 12 }, (_, i) => t.tasks.create({ projectId: p.id, title: `E${i}` }).id)
    const many = input([...Array.from({ length: 12 }, () => ({})), { dependsOnIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], dependsOnTaskIds: ids }])
    expect(code(() => t.proposals.record(p.id, many))).toBe('INVALID_DEPENDENCY')
  })
  it('approval with a repeated key is rejected up front (never a database error that rolls back)', () => {
    const t = makeTaskStack()
    const p = t.addProject()
    const { proposalId } = t.proposals.record(p.id, input([{ title: 'A' }, { title: 'B', dependsOnIndexes: [0] }]))
    const items = t.proposals.list(p.id)[0]!.items
    const tampered = [items[0]!, { ...items[1]!, dependsOnKeys: [0, 0] }]
    expect(code(() => t.proposals.approve(p.id, proposalId, tampered))).toBe('INVALID_DEPENDENCY')
    expect(t.proposals.list(p.id)[0]?.status).toBe('pending')
  })
})
