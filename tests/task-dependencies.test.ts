import { describe, expect, it } from 'vitest'
import { topologicalOrder, validateTaskDependencies, wouldCreateCycle } from '../src/main/modules/tasks/dependencies'

const idx = (entries: Record<string, { p?: string; s?: 'backlog' | 'cancelled' }>) =>
  new Map(Object.entries(entries).map(([id, e]) => [id, { projectId: e.p ?? 'P', status: e.s ?? ('backlog' as const) }]))

describe('validateTaskDependencies', () => {
  const index = idx({ a: {}, b: {}, c: {}, x: { p: 'OTHER' }, dead: { s: 'cancelled' } })
  const edges = new Map([['b', ['a']], ['c', ['b']]])
  const check = (taskId: string | null, dependsOn: string[]) => validateTaskDependencies({ projectId: 'P', taskId, dependsOn, index, edges })

  it('accepts valid dependencies', () => {
    expect(check(null, ['a', 'b'])).toBeNull()
    expect(check('c', ['a'])).toBeNull()
  })
  it('rejects self, duplicates, unknown, other-project (same message), and cancelled dependencies', () => {
    expect(check('a', ['a'])).toMatch(/itself/)
    expect(check(null, ['a', 'a'])).toMatch(/repeat/)
    const missing = check(null, ['nope'])
    const foreign = check(null, ['x'])
    expect(missing).toMatch(/not found/)
    expect(foreign).toBe(missing) // does not reveal that the id exists elsewhere
    expect(check(null, ['dead'])).toMatch(/cancelled/)
  })
  it('rejects cycles, including indirect ones', () => {
    expect(check('a', ['c'])).toMatch(/cycle/) // a -> c -> b -> a
    expect(check('a', ['b'])).toMatch(/cycle/)
    expect(check('b', ['c'])).toMatch(/cycle/)
  })
  it('limits the number of dependencies', () => {
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`)
    expect(check(null, many)).toMatch(/at most/)
  })
})

describe('graph helpers', () => {
  it('wouldCreateCycle handles diamonds without false positives', () => {
    const edges = new Map([['d', ['b', 'c']], ['b', ['a']], ['c', ['a']]])
    expect(wouldCreateCycle('e', ['d'], edges)).toBe(false)
    expect(wouldCreateCycle('a', ['d'], edges)).toBe(true)
  })
  it('topologicalOrder puts dependencies first and detects cycles', () => {
    expect(topologicalOrder([0, 1, 2], new Map([[0, [1]], [1, [2]]]))).toEqual([2, 1, 0])
    expect(topologicalOrder([0, 1], new Map([[0, [1]], [1, [0]]]))).toBeNull()
    expect(topologicalOrder([0], new Map([[0, [0]]]))).toBeNull()
  })
})
