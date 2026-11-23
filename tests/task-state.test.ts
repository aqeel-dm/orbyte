import { describe, expect, it } from 'vitest'
import { TASK_STATUSES, checkTransition, userTransitionsFrom, type TaskStatus } from '../src/shared/task-state'

describe('task state machine', () => {
  const allowedForUser: [TaskStatus, TaskStatus][] = [
    ['backlog', 'ready'], ['backlog', 'cancelled'], ['ready', 'backlog'], ['ready', 'blocked'], ['ready', 'cancelled'],
    ['planning', 'ready'], ['planning', 'blocked'], ['planning', 'cancelled'], ['awaiting_approval', 'blocked'], ['awaiting_approval', 'cancelled'],
    ['in_progress', 'blocked'], ['in_progress', 'cancelled'], ['in_review', 'blocked'], ['in_review', 'cancelled'],
    ['blocked', 'backlog'], ['blocked', 'ready'], ['blocked', 'cancelled'], ['cancelled', 'backlog']
  ]
  it.each(allowedForUser)('user may move %s -> %s', (from, to) => {
    expect(checkTransition(from, to, 'user')).toEqual({ ok: true })
  })

  it('is exhaustive: the user can make exactly the listed moves and no others', () => {
    const actual: string[] = []
    for (const from of TASK_STATUSES) for (const to of TASK_STATUSES) if (checkTransition(from, to, 'user').ok) actual.push(`${from}>${to}`)
    expect(actual.sort()).toEqual(allowedForUser.map(([f, t]) => `${f}>${t}`).sort())
  })

  it('the user can never start, plan, review or complete work directly', () => {
    for (const to of ['planning', 'awaiting_approval', 'in_progress', 'in_review', 'completed'] as TaskStatus[]) {
      for (const from of TASK_STATUSES) expect(checkTransition(from, to, 'user').ok).toBe(false)
    }
  })

  it('completed is terminal and self-moves are refused', () => {
    for (const to of TASK_STATUSES) {
      expect(checkTransition('completed', to, 'user').ok).toBe(false)
      expect(checkTransition('completed', to, 'orchestrator').ok).toBe(false)
    }
    for (const s of TASK_STATUSES) expect(checkTransition(s, s, 'orchestrator').ok).toBe(false)
  })

  it('entering in_progress needs a verified approval, even for the orchestrator', () => {
    expect(checkTransition('awaiting_approval', 'in_progress', 'orchestrator')).toMatchObject({ ok: false })
    expect(checkTransition('awaiting_approval', 'in_progress', 'orchestrator', { approvalVerified: false })).toMatchObject({ ok: false })
    expect(checkTransition('awaiting_approval', 'in_progress', 'orchestrator', { approvalVerified: true })).toEqual({ ok: true })
    // there is no way into in_progress that skips awaiting_approval
    for (const from of TASK_STATUSES.filter((s) => s !== 'awaiting_approval')) {
      expect(checkTransition(from, 'in_progress', 'orchestrator', { approvalVerified: true }).ok).toBe(from === 'in_review')
    }
  })

  it('the orchestrator drives the execution path', () => {
    expect(checkTransition('ready', 'planning', 'orchestrator').ok).toBe(true)
    expect(checkTransition('planning', 'awaiting_approval', 'orchestrator').ok).toBe(true)
    expect(checkTransition('in_progress', 'in_review', 'orchestrator').ok).toBe(true)
    expect(checkTransition('in_review', 'completed', 'orchestrator').ok).toBe(true)
  })

  it('userTransitionsFrom lists only what the UI may offer', () => {
    expect(userTransitionsFrom('backlog').sort()).toEqual(['cancelled', 'ready'])
    expect(userTransitionsFrom('completed')).toEqual([])
    expect(userTransitionsFrom('in_progress').sort()).toEqual(['blocked', 'cancelled'])
  })
})
