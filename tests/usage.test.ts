import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapSdkMessage } from '../src/main/modules/agents/team-lead/events'
import { TeamLeadService } from '../src/main/modules/agents/team-lead/service'
import type { TeamLeadRunner } from '../src/main/modules/agents/team-lead/runner'
import { readTranscriptUsage, transcriptDirName } from '../src/main/modules/usage/transcript-usage'
import { UsageService } from '../src/main/modules/usage/usage-service'
import { AgentRepository } from '../src/main/modules/agents/developers/agent-repository'
import { AppError } from '../src/shared/types/result'
import { makeStack, sdk, tempDir } from './helpers'

const SESSION = '11111111-2222-3333-4444-555555555555'
const result = (cost: number, models: Record<string, Record<string, number>>, extra: Record<string, unknown> = {}) =>
  ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION, total_cost_usd: cost, modelUsage: models, ...extra })
const model = (i: number, o: number, cr: number, cc: number) => ({ inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cc, costUSD: 0 })

describe('Team Lead usage signal', () => {
  it('sums the per-model totals and keeps the outcome signal', () => {
    const sigs = mapSdkMessage(result(0.5, { a: model(10, 20, 30, 40), b: model(1, 2, 3, 4) }))
    expect(sigs[0]).toEqual({ kind: 'usage', sessionId: SESSION, costUsd: 0.5, inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 })
    expect(sigs[1]).toMatchObject({ kind: 'success' })
  })
  it('reports usage on an error result too, and ignores junk numbers', () => {
    const sigs = mapSdkMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', total_cost_usd: -3, modelUsage: { a: { inputTokens: 'x', outputTokens: NaN } } })
    expect(sigs.map((s) => s.kind)).toEqual(['usage', 'error'])
    expect(sigs[0]).toMatchObject({ costUsd: 0, inputTokens: 0, outputTokens: 0 })
  })
  it('emits no usage signal when the result has no usage fields', () => {
    expect(mapSdkMessage(sdk.success('hi')).map((s) => s.kind)).toEqual(['success'])
  })
})

describe('recording Team Lead usage', () => {
  function setup() {
    const stack = makeStack()
    const agents = new AgentRepository(stack.handle.db)
    const usage = new UsageService({ db: stack.handle.db, projects: stack.projects, agents, configDir: () => tempDir() })
    return { ...stack, usage }
  }
  const rep = (cost: number, n: number) => ({ costUsd: cost, inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheCreationTokens: n })

  it('keeps the latest cumulative report per session and sums sessions, never summing reports of one session', async () => {
    const t = setup(); const p = t.addProject()
    t.usage.recordTeamLead(p.id, 's1', rep(1, 100))
    t.usage.recordTeamLead(p.id, 's1', rep(1.5, 150)) // later cumulative report replaces the first
    t.usage.recordTeamLead(p.id, 's2', rep(0.25, 10))
    const s = await t.usage.summary(p.id)
    expect(s.teamLead).toMatchObject({ sessions: 2, costUsd: 1.75, inputTokens: 160 })
  })
  it('ignores a report below what is stored (zeroed crash results) and is scoped to its project', async () => {
    const t = setup(); const p = t.addProject(); const q = t.addProject({ repoPath: '/tmp/other' })
    t.usage.recordTeamLead(p.id, 's1', rep(2, 100))
    t.usage.recordTeamLead(p.id, 's1', rep(0, 0))
    t.usage.recordTeamLead(q.id, 's1', rep(9, 900))
    expect((await t.usage.summary(p.id)).teamLead).toMatchObject({ costUsd: 2, inputTokens: 100, sessions: 1 })
    expect((await t.usage.summary(q.id)).teamLead).toMatchObject({ costUsd: 9, sessions: 1 })
    await expect(t.usage.summary('nope')).rejects.toBeInstanceOf(AppError)
  })
  it('the Team Lead service records the SDK report for its session', async () => {
    const stack = makeStack(); const p = stack.addProject()
    const got: unknown[] = []
    const runner: TeamLeadRunner = { async *run() { yield sdk.init(SESSION); yield result(0.1, { m: model(5, 6, 7, 8) }) } }
    const events: string[] = []
    const svc = new TeamLeadService({ projects: stack.projects, chat: stack.chat, runner, emit: (e) => events.push(e.type), recordUsage: (...a) => void got.push(a) })
    svc.send(p.id, 'hi')
    for (let i = 0; i < 200 && !events.includes('turn_completed'); i++) await new Promise((r) => setTimeout(r, 5))
    expect(got).toEqual([[p.id, SESSION, { costUsd: 0.1, inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheCreationTokens: 8 }]])
  })
})

describe('readTranscriptUsage', () => {
  const line = (id: string, u: Record<string, number>) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: u } })
  function transcript(cwd: string, lines: string[]) {
    const configDir = tempDir()
    const dir = join(configDir, 'projects', transcriptDirName(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${SESSION}.jsonl`), lines.join('\n') + '\n')
    return configDir
  }
  it('names the folder the way Claude Code does', () => {
    expect(transcriptDirName('/private/tmp/a-b/c.d')).toBe('-private-tmp-a-b-c-d')
  })
  it('counts each message once even though it is repeated per content block', async () => {
    const u = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 })
    const cwd = '/work/tree'
    const configDir = transcript(cwd, [line('m1', u(2, 100)), line('m1', u(2, 100)), line('m1', u(2, 100)), line('m2', u(3, 50)), 'not json', JSON.stringify({ type: 'user', message: { content: 'hi' } }), '{"usage": 1}'])
    expect(await readTranscriptUsage({ configDir, cwd, sessionId: SESSION })).toEqual({ inputTokens: 5, outputTokens: 150, cacheReadTokens: 10, cacheCreationTokens: 14 })
  })
  it('returns null for a missing file, a bad session id, or a link, and ignores negative or odd numbers', async () => {
    const cwd = '/work/tree'
    expect(await readTranscriptUsage({ configDir: tempDir(), cwd, sessionId: SESSION })).toBeNull()
    const configDir = transcript(cwd, [line('m1', { input_tokens: -5, output_tokens: 3 })])
    expect(await readTranscriptUsage({ configDir, cwd, sessionId: '../../etc/passwd' })).toBeNull()
    expect(await readTranscriptUsage({ configDir, cwd, sessionId: SESSION })).toMatchObject({ inputTokens: 0, outputTokens: 3 })
    const linked = tempDir(); const dir = join(linked, 'projects', transcriptDirName(cwd)); mkdirSync(dir, { recursive: true })
    const real = join(tempDir(), 'x.jsonl'); writeFileSync(real, line('m1', { output_tokens: 99 }) + '\n')
    symlinkSync(real, join(dir, `${SESSION}.jsonl`))
    expect(await readTranscriptUsage({ configDir: linked, cwd, sessionId: SESSION })).toBeNull()
  })
})
