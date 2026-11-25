import { describe, expect, it } from 'vitest'
import { Notifier } from '../src/main/notifications/notifier'
import type { DecisionItem } from '../src/shared/schemas/task'

const item = (over: Partial<DecisionItem> = {}): DecisionItem => ({ kind: 'plan', projectId: 'p', projectName: 'Shop', taskId: 't1', title: 'Add login', since: 1, ...over })

function setup(initial: DecisionItem[], focused = false) {
  const state = { items: initial, focused }
  const shown: [string, string][] = []
  const n = new Notifier({ list: () => state.items, isFocused: () => state.focused, show: (t, b) => void shown.push([t, b]) })
  return { state, shown, n }
}
const ev = { type: 'plans_changed', projectId: 'p', taskId: 't1' } as const

describe('Notifier', () => {
  it('does not announce what was already waiting at startup', () => {
    const { n, shown } = setup([item()])
    n.onEvent(ev)
    expect(shown).toEqual([])
  })

  it('announces a newly waiting decision once, with project and title', () => {
    const { n, shown, state } = setup([])
    state.items = [item()]
    n.onEvent(ev)
    n.onEvent(ev)
    expect(shown).toEqual([['Shop: plan waiting for your approval', 'Add login']])
  })

  it('stays quiet while a window is focused, and does not replay it afterwards', () => {
    const { n, shown, state } = setup([], true)
    state.items = [item()]
    n.onEvent(ev)
    state.focused = false
    n.onEvent(ev)
    expect(shown).toEqual([])
  })

  it('a changed plan version or a new result counts as new', () => {
    const { n, shown, state } = setup([item()])
    state.items = [item({ since: 2 }), item({ kind: 'result', taskId: 't2', title: 'Fix bug' })]
    n.onEvent(ev)
    expect(shown.map((s) => s[0])).toEqual(['Shop: plan waiting for your approval', 'Shop: result waiting for your decision'])
  })

  it('groups a flood and ignores unrelated events', () => {
    const { n, shown, state } = setup([])
    state.items = [1, 2, 3, 4, 5].map((i) => item({ taskId: `t${i}`, title: `T${i}` }))
    n.onEvent({ type: 'agent_changed', projectId: 'p', agentId: 'a' })
    expect(shown).toEqual([])
    n.onEvent(ev)
    expect(shown).toHaveLength(4)
    expect(shown[3]).toEqual(['Orbyte', '2 more waiting for you'])
  })

  it('survives a failing read or display', () => {
    const n = new Notifier({ list: () => { throw new Error('db') }, isFocused: () => false, show: () => { throw new Error('os') } })
    expect(() => n.onEvent(ev)).not.toThrow()
  })
})
