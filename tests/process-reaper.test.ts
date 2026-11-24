import { describe, expect, it } from 'vitest'
import { createProcessReaper } from '../src/main/modules/agents/developers/process-reaper'

const SID = '8f328764-5c37-4e2a-a3ac-5d053fe26a93'

function setup(command: string | null, opts: { diesOnTerm?: boolean } = {}) {
  const signals: (NodeJS.Signals | 0)[] = []
  let alive = true
  const reaper = createProcessReaper({
    commandOf: async () => command,
    kill: (_pid, signal) => {
      signals.push(signal)
      if (signal === 0) { if (!alive) throw new Error('ESRCH'); return }
      if (signal === 'SIGKILL' || (signal === 'SIGTERM' && opts.diesOnTerm !== false)) alive = false
    },
    sleep: async () => undefined,
    graceMs: 5
  })
  return { reaper, signals }
}

describe('process reaper (stops agents orphaned by a crash)', () => {
  it('stops a process that is verifiably this agent\'s claude session', async () => {
    const { reaper, signals } = setup(`/Users/u/.local/bin/claude --permission-mode plan --session-id ${SID} --setting-sources user`)
    expect(await reaper.reap(123, SID)).toBe('killed')
    expect(signals).toContain('SIGTERM')
    expect(signals).not.toContain('SIGKILL') // it exited when asked
  })

  it('escalates to SIGKILL only if the process ignores SIGTERM', async () => {
    const { reaper, signals } = setup(`claude --session-id ${SID}`, { diesOnTerm: false })
    expect(await reaper.reap(123, SID)).toBe('killed')
    expect(signals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']))
  })

  it('re-verifies before SIGKILL so a pid reused during the wait is never killed', async () => {
    const signals: (NodeJS.Signals | 0)[] = []
    let calls = 0
    const reaper = createProcessReaper({
      commandOf: async () => (++calls === 1 ? `claude --session-id ${SID}` : '/usr/bin/some-other-program'), // the pid was recycled
      kill: (_pid, s) => { signals.push(s) },
      sleep: async () => undefined,
      graceMs: 5
    })
    expect(await reaper.reap(123, SID)).toBe('killed')
    expect(signals).toContain('SIGTERM')
    expect(signals).not.toContain('SIGKILL')
  })

  it('only the first word of the command line counts as the program', async () => {
    const { reaper, signals } = setup(`/usr/bin/python3 /home/u/bin/claude --session-id ${SID}`)
    expect(await reaper.reap(123, SID)).toBe('mismatch')
    expect(signals).toEqual([])
  })

  it('never signals a process that merely reuses the pid', async () => {
    for (const command of [
      '/usr/bin/vim notes.txt',
      `/usr/bin/python3 server.py --session-id ${SID}`, // right session id, wrong program
      'claude --session-id 00000000-0000-4000-8000-000000000000', // claude, but a different session
      '/Applications/Safari.app/Contents/MacOS/Safari'
    ]) {
      const { reaper, signals } = setup(command)
      expect(await reaper.reap(123, SID), command).toBe('mismatch')
      expect(signals, command).toEqual([])
    }
  })

  it('does nothing when the process is already gone, or the input is not trustworthy', async () => {
    const gone = setup(null)
    expect(await gone.reaper.reap(123, SID)).toBe('not_found')
    expect(gone.signals).toEqual([])
    const bad = setup(`claude --session-id ${SID}`)
    for (const pid of [0, 1, -5, 1.5, Number.NaN]) expect(await bad.reaper.reap(pid, SID)).toBe('invalid')
    expect(await bad.reaper.reap(123, 'not-a-uuid; rm -rf')).toBe('invalid')
    expect(bad.signals).toEqual([])
  })
})
