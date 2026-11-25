import { describe, expect, it } from 'vitest'
import { InputGuard } from '../src/main/modules/agents/developers/input-guard'
import { AppError } from '../src/shared/types/result'
import { makeAgentStack } from './helpers'

describe('InputGuard', () => {
  it('refuses "!" at the start of an empty line, however it arrives', () => {
    expect(new InputGuard().allow('!')).toBe(false)
    expect(new InputGuard().allow('!ls\r')).toBe(false)
    expect(new InputGuard().allow('\x1b[200~!ls\x1b[201~')).toBe(false) // pasted
    const g = new InputGuard()
    expect(g.allow('abc\r')).toBe(true)
    expect(g.allow('!')).toBe(false) // a new line
    expect(new InputGuard().allow('\x1b[A!')).toBe(false) // arrow key does not add text
  })

  it('allows "!" inside text and ordinary typing', () => {
    const g = new InputGuard()
    expect(g.allow('hello')).toBe(true)
    expect(g.allow('!')).toBe(true)
    expect(g.allow('\x1b[D\x1b[C')).toBe(true)
    expect(g.allow('wow!!\r')).toBe(true)
    expect(g.allow('why? ')).toBe(true)
  })

  it('tracks clearing the line', () => {
    const g = new InputGuard()
    g.allow('abc')
    expect(g.allow('\x15!')).toBe(false) // Ctrl-U cleared it
    const h = new InputGuard()
    h.allow('ab')
    h.allow('\x7f\x7f')
    expect(h.allow('!')).toBe(false) // backspaced to empty
    const i = new InputGuard()
    i.allow('ab\x03')
    expect(i.allow('!')).toBe(false) // Ctrl-C
  })

  it('a refused chunk changes nothing, so the rest of the line is not mis-tracked', () => {
    const g = new InputGuard()
    expect(g.allow('!x')).toBe(false)
    expect(g.allow('x')).toBe(true)
    expect(g.allow('!')).toBe(true)
  })
})

describe('terminal write guard in the service', () => {
  const code = async (fn: () => unknown) => { try { await fn() } catch (e) { return e instanceof AppError ? e.code : 'OTHER' } return 'NONE' }

  it('a planning agent never receives shell-mode input, but other keystrokes pass', async () => {
    const s = makeAgentStack()
    const agent = await s.service.start(s.project.id, s.readyTask().id)
    expect(agent.kind).toBe('planning')
    expect(await code(() => s.service.write(s.project.id, agent.id, '!touch pwned\r'))).toBe('SHELL_MODE_BLOCKED')
    s.service.write(s.project.id, agent.id, 'investigate the auth code!\r')
    expect(s.pty.procs[0]!.written).toEqual(['investigate the auth code!\r'])
  })
})
