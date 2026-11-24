import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentInbox } from '../src/main/modules/agents/developers/agent-inbox'
import { tempDir } from './helpers'

const AGENT = '11111111-1111-4111-8111-111111111111'
const plan = (over = {}) => ({ plan: { summary: 'S', steps: ['one'], files: [], tests: [], risks: [], ...over } })

describe('AgentInbox', () => {
  async function setup() {
    const inbox = new AgentInbox(tempDir('orbyte-inbox-'))
    const dir = await inbox.prepare(AGENT)
    return { inbox, dir }
  }

  it('drains valid plans oldest first and removes the files', async () => {
    const { inbox, dir } = await setup()
    writeFileSync(join(dir, 'plan-2-b.json'), JSON.stringify(plan({ summary: 'second' })))
    writeFileSync(join(dir, 'plan-1-a.json'), JSON.stringify(plan({ summary: 'first' })))
    const { plans, rejected } = await inbox.drain(AGENT)
    expect(plans.map((p) => p.summary)).toEqual(['first', 'second'])
    expect(rejected).toBe(0)
    expect((await inbox.drain(AGENT)).plans).toEqual([])
  })

  it('applies defaults for optional lists and rejects invalid or oversized plans', async () => {
    const { inbox, dir } = await setup()
    writeFileSync(join(dir, 'plan-1-ok.json'), JSON.stringify({ plan: { summary: 'S', steps: ['x'] } }))
    writeFileSync(join(dir, 'plan-2-bad.json'), '{ not json')
    writeFileSync(join(dir, 'plan-3-empty-steps.json'), JSON.stringify(plan({ steps: [] })))
    writeFileSync(join(dir, 'plan-4-wrong-shape.json'), JSON.stringify({ steps: ['x'] }))
    writeFileSync(join(dir, 'plan-5-huge.json'), JSON.stringify(plan({ summary: 'x'.repeat(300 * 1024) })))
    const { plans, rejected } = await inbox.drain(AGENT)
    expect(plans).toEqual([{ summary: 'S', steps: ['x'], files: [], tests: [], risks: [] }])
    expect(rejected).toBe(4)
    expect(existsSync(join(dir, 'plan-2-bad.json'))).toBe(false) // invalid files are removed, not retried forever
  })

  it('never follows a symlink, and removes only the link', async () => {
    const { inbox, dir } = await setup()
    const secret = join(tempDir('orbyte-secret-'), 'secret.json')
    writeFileSync(secret, JSON.stringify(plan({ summary: 'from outside' })))
    symlinkSync(secret, join(dir, 'plan-1-link.json'))
    mkdirSync(join(dir, 'plan-2-dir.json'))
    const { plans, rejected } = await inbox.drain(AGENT)
    expect(plans).toEqual([]) // content read through a link is never accepted
    expect(rejected).toBe(2)
    expect(existsSync(secret)).toBe(true) // the target is untouched
  })

  it('ignores half-written temp files and unrelated names', async () => {
    const { inbox, dir } = await setup()
    writeFileSync(join(dir, '.plan-1.json.tmp'), JSON.stringify(plan()))
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    expect(await inbox.drain(AGENT)).toEqual({ plans: [], progress: [], results: [], rejected: 0 })
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })

  it('refuses ids that could escape the inbox root', () => {
    const inbox = new AgentInbox('/root')
    for (const bad of ['../x', '..', 'a/b', '', '11111111-1111-4111-8111-11111111111g/..']) expect(() => inbox.dirFor(bad), bad).toThrow()
  })

  it('an empty or missing inbox is not an error', async () => {
    const inbox = new AgentInbox(tempDir('orbyte-inbox-'))
    expect(await inbox.drain(AGENT)).toEqual({ plans: [], progress: [], results: [], rejected: 0 })
  })
})

describe('AgentInbox cleanup', () => {
  it('removes an agent\'s directory and its contents, and tolerates one that is already gone', async () => {
    const inbox = new AgentInbox(tempDir('orbyte-inbox-'))
    const dir = await inbox.prepare(AGENT)
    writeFileSync(join(dir, 'plan-1-a.json'), '{}')
    await inbox.remove(AGENT)
    expect(existsSync(dir)).toBe(false)
    await expect(inbox.remove(AGENT)).resolves.toBeUndefined()
  })
})


describe('AgentInbox limits and permissions', () => {
  it('processes at most 10 files per drain and discards the rest', async () => {
    const inbox = new AgentInbox(tempDir('orbyte-inbox-'))
    const dir = await inbox.prepare(AGENT)
    for (let i = 0; i < 15; i++) writeFileSync(join(dir, `plan-${String(i).padStart(3, '0')}-a.json`), JSON.stringify(plan({ summary: `p${i}` })))
    const { plans, rejected } = await inbox.drain(AGENT)
    expect(plans).toHaveLength(10)
    expect(plans[0]?.summary).toBe('p0')
    expect(rejected).toBe(5)
    expect((await inbox.drain(AGENT)).plans).toEqual([]) // nothing is left to be replayed later
  })

  it('makes the directory private even if it already existed with looser permissions', async () => {
    const root = tempDir('orbyte-inbox-')
    mkdirSync(join(root, AGENT), { mode: 0o755 })
    chmodSync(join(root, AGENT), 0o755)
    const inbox = new AgentInbox(root)
    await inbox.prepare(AGENT)
    expect(statSync(join(root, AGENT)).mode & 0o777).toBe(0o700)
  })
})
