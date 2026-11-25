import { describe, expect, it } from 'vitest'
import { checkSystem } from '../src/main/modules/maintenance/system-check'

const ok = { gitVersion: async () => 'git version 2.45.0', resolveClaude: () => '/x/claude', claudeVersion: async () => '2.1.0 (Claude Code)', secureStorageAvailable: () => true }

describe('checkSystem', () => {
  it('reports everything present, with versions and no paths', async () => {
    const c = await checkSystem(ok)
    expect(c.items.map((i) => [i.id, i.ok])).toEqual([['git', true], ['claude', true], ['secureStorage', true]])
    expect(JSON.stringify(c)).not.toContain('/x/claude')
  })
  it('explains what is missing', async () => {
    const c = await checkSystem({ gitVersion: async () => null, resolveClaude: () => null, claudeVersion: async () => null, secureStorageAvailable: () => false })
    expect(c.items.every((i) => !i.ok && i.help)).toBe(true)
    expect(c.items.find((i) => i.id === 'claude')?.help).toMatch(/sign in/)
    expect(c.items.find((i) => i.id === 'secureStorage')?.help).toMatch(/approvals cannot be recorded/)
  })
  it('survives a probe that throws', async () => {
    const c = await checkSystem({ ...ok, gitVersion: async () => { throw new Error('boom') }, claudeVersion: async () => { throw new Error('boom') } })
    expect(c.items.find((i) => i.id === 'git')?.ok).toBe(false)
    expect(c.items.find((i) => i.id === 'claude')).toMatchObject({ ok: true, detail: 'Found' })
  })
})
