import { describe, expect, it } from 'vitest'
import type { TeamLeadRunRequest } from '../src/main/modules/agents/team-lead/options'
import type { TeamLeadRunner } from '../src/main/modules/agents/team-lead/runner'
import { TeamLeadService } from '../src/main/modules/agents/team-lead/service'
import type { AppEvent } from '../src/shared/schemas/team-lead'
import { AppError } from '../src/shared/types/result'
import { makeStack, sdk } from './helpers'

type Script = (req: TeamLeadRunRequest, call: number) => unknown[] | Error | Promise<unknown[] | Error>

function setup(script: Script) {
  const stack = makeStack()
  const events: AppEvent[] = []
  const requests: TeamLeadRunRequest[] = []
  const runner: TeamLeadRunner = {
    async *run(req) {
      requests.push(req)
      const out = await script(req, requests.length)
      for (const m of Array.isArray(out) ? out : []) yield m
      if (out instanceof Error) throw out
    }
  }
  const service = new TeamLeadService({ projects: stack.projects, chat: stack.chat, runner, emit: (e) => events.push(e) })
  const project = stack.addProject()
  const done = () => new Promise<void>((resolve) => {
    const t = setInterval(() => { if (events.some((e) => e.type === 'turn_completed' || e.type === 'turn_error')) { clearInterval(t); resolve() } }, 2)
  })
  return { ...stack, service, events, requests, project, done }
}
const kinds = (events: AppEvent[]) => events.map((e) => e.type)

describe('TeamLeadService', () => {
  it('streams a turn, persists both messages and the session id', async () => {
    const t = setup(() => [sdk.init('sess-1'), sdk.blockStart(), sdk.delta('Hel'), sdk.delta('lo'), sdk.tool('Read'), sdk.success('Hello')])
    const res = t.service.send(t.project.id, 'hi')
    await t.done()
    expect(res.userMessage.content).toBe('hi')
    expect(kinds(t.events)).toEqual(['turn_started', 'text_delta', 'text_delta', 'tool_activity', 'turn_completed'])
    expect(t.chat.list(t.project.id).map((m) => [m.role, m.content])).toEqual([['user', 'hi'], ['assistant', 'Hello']])
    expect(t.projects.get(t.project.id)?.teamLeadSessionId).toBe('sess-1')
    expect(t.requests[0]).toMatchObject({ repoPath: t.project.repoPath, resumeSessionId: null })
  })

  it('resumes the stored session on the next turn', async () => {
    const t = setup(() => [sdk.init('sess-1'), sdk.delta('ok'), sdk.success()])
    t.service.send(t.project.id, 'one'); await t.done(); t.events.length = 0
    t.service.send(t.project.id, 'two'); await t.done()
    expect(t.requests[1]?.resumeSessionId).toBe('sess-1')
  })

  it('separates text blocks that are split by tool calls', async () => {
    const t = setup(() => [sdk.blockStart(), sdk.delta('Checking.'), sdk.tool('Read'), sdk.blockStart(), sdk.delta('Done.'), sdk.success()])
    t.service.send(t.project.id, 'go'); await t.done()
    expect(t.chat.list(t.project.id)[1]?.content).toBe('Checking.\n\nDone.')
  })

  it('falls back to a fresh session once when the stored session is missing', async () => {
    const t = setup((_req, call) => (call === 1 ? [sdk.error('No conversation found with session ID: gone')] : [sdk.init('new-1'), sdk.delta('fresh'), sdk.success()]))
    t.projects.setTeamLeadSession(t.project.id, 'gone')
    t.service.send(t.project.id, 'hello'); await t.done()
    expect(t.requests.map((r) => r.resumeSessionId)).toEqual(['gone', null])
    expect(t.projects.get(t.project.id)?.teamLeadSessionId).toBe('new-1')
    expect(kinds(t.events)).toContain('turn_completed')
    expect(kinds(t.events)).not.toContain('turn_error')
  })

  it('also recovers when the SDK throws instead of returning an error result', async () => {
    const t = setup((_req, call) => (call === 1 ? new Error('Claude Code returned an error result: No conversation found with session ID: gone') : [sdk.init('n'), sdk.success('x')]))
    t.projects.setTeamLeadSession(t.project.id, 'gone')
    t.service.send(t.project.id, 'hello'); await t.done()
    expect(t.requests.length).toBe(2)
  })

  it('maps auth failures to AUTH_REQUIRED and does not save an assistant message', async () => {
    const t = setup(() => [sdk.error('Invalid API key · Please run /login')])
    t.service.send(t.project.id, 'hi'); await t.done()
    expect(t.events.find((e) => e.type === 'turn_error')).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(t.chat.list(t.project.id).map((m) => m.role)).toEqual(['user'])
  })

  it('reports a thrown SDK error once, with a classified code', async () => {
    const t = setup(() => new Error('spawn failed'))
    t.service.send(t.project.id, 'hi'); await t.done()
    expect(t.events.filter((e) => e.type === 'turn_error')).toHaveLength(1)
    expect(t.events.find((e) => e.type === 'turn_error')).toMatchObject({ code: 'AGENT_ERROR', message: 'spawn failed' })
  })

  it('reports NO_RESULT when the stream ends without a result', async () => {
    const t = setup(() => [sdk.init('s')])
    t.service.send(t.project.id, 'hi'); await t.done()
    expect(t.events.find((e) => e.type === 'turn_error')).toMatchObject({ code: 'NO_RESULT' })
  })

  it('allows one turn at a time per project', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const t = setup(async () => { await gate; return [sdk.success('x')] })
    t.service.send(t.project.id, 'one')
    expect(t.service.isActive(t.project.id)).toBe(true)
    expect(() => t.service.send(t.project.id, 'two')).toThrow(AppError)
    release(); await t.done()
    expect(t.service.isActive(t.project.id)).toBe(false)
  })

  it('interrupt aborts the turn, reports INTERRUPTED, and keeps real partial output', async () => {
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    const t = setup(() => [])
    const runner: TeamLeadRunner = {
      async *run(req) {
        yield sdk.delta('partial text')
        started()
        await new Promise<void>((_r, reject) => req.abortController.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      }
    }
    const svc = new TeamLeadService({ projects: t.projects, chat: t.chat, runner, emit: (e) => t.events.push(e) })
    svc.send(t.project.id, 'go'); await running
    svc.interrupt(t.project.id); await t.done()
    expect(t.events.find((e) => e.type === 'turn_error')).toMatchObject({ code: 'INTERRUPTED' })
    expect(t.chat.list(t.project.id).map((m) => m.content)).toEqual(['go', 'partial text'])
    expect(svc.isActive(t.project.id)).toBe(false)
  })

  it('rejects unknown and archived projects without calling the runner', () => {
    const t = setup(() => [sdk.success('x')])
    expect(() => t.service.send('missing', 'hi')).toThrow(/not found/i)
    t.projects.setStatus(t.project.id, 'archived')
    expect(() => t.service.send(t.project.id, 'hi')).toThrow(/archived/i)
    expect(t.requests).toHaveLength(0)
    expect(() => t.service.history('missing')).toThrow(AppError)
  })

  it('keeps chat history per project', async () => {
    const t = setup(() => [sdk.delta('a'), sdk.success()])
    const other = t.addProject()
    t.service.send(t.project.id, 'mine'); await t.done()
    expect(t.service.history(other.id)).toEqual([])
    expect(t.service.history(t.project.id).length).toBe(2)
  })
})
