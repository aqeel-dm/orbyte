import { describe, expect, it } from 'vitest'
import { isTrustedFrame } from '../src/main/app/navigation-policy'
import { buildTeamLeadOptions } from '../src/main/modules/agents/team-lead/options'
import { classifyError, mapSdkMessage } from '../src/main/modules/agents/team-lead/events'
import { parseOnboardingOutput } from '../src/main/modules/projects/onboarding'
import { sdk } from './helpers'

describe('buildTeamLeadOptions (read-only by construction)', () => {
  const base = { prompt: 'p', repoPath: '/repo', abortController: new AbortController() }
  it('locks tools down and sets cwd/settings', () => {
    const o = buildTeamLeadOptions({ ...base, resumeSessionId: null })
    expect(o.cwd).toBe('/repo')
    expect(o.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'Bash', 'mcp__*']))
    expect(o.strictMcpConfig).toBe(true)
    expect(o.permissionMode).toBe('dontAsk')
    expect(o.settingSources).toEqual(['user', 'project', 'local'])
    expect(o.includePartialMessages).toBe(true)
    expect(o.resume).toBeUndefined()
  })
  it('only sets resume and maxTurns when given, and never grants bypass or extra tools', () => {
    const o = buildTeamLeadOptions({ ...base, resumeSessionId: 'abc', maxTurns: 5 })
    expect(o.resume).toBe('abc')
    expect(o.maxTurns).toBe(5)
    expect(o.allowedTools).toBeUndefined()
    expect(o.permissionMode).not.toBe('bypassPermissions')
  })
})

describe('mapSdkMessage', () => {
  it('maps the messages we use and ignores the rest', () => {
    expect(mapSdkMessage(sdk.init('s1'))).toEqual([{ kind: 'session', sessionId: 's1' }])
    expect(mapSdkMessage(sdk.delta('hi'))).toEqual([{ kind: 'text_delta', text: 'hi' }])
    expect(mapSdkMessage(sdk.blockStart())).toEqual([{ kind: 'text_block_start' }])
    expect(mapSdkMessage(sdk.tool('Read'))).toEqual([{ kind: 'tool', tool: 'Read' }])
    expect(mapSdkMessage(sdk.success('done'))).toEqual([{ kind: 'success', text: 'done' }])
    expect(mapSdkMessage({ type: 'rate_limit_event' })).toEqual([])
    expect(mapSdkMessage(null)).toEqual([])
    expect(mapSdkMessage('nope')).toEqual([])
  })
  it('maps error results with classified codes', () => {
    expect(mapSdkMessage(sdk.error('No conversation found with session ID: x'))[0]).toMatchObject({ kind: 'error', code: 'SESSION_NOT_FOUND' })
    expect(mapSdkMessage(sdk.error('Invalid API key · Please run /login'))[0]).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(mapSdkMessage(sdk.error('boom'))[0]).toMatchObject({ code: 'AGENT_ERROR' })
    expect(classifyError('something else')).toBe('AGENT_ERROR')
  })
})

describe('parseOnboardingOutput', () => {
  it('splits summary and guidance', () => {
    const r = parseOnboardingOutput('## Project summary\nA stack.\n\n## Proposed workflow guidance\nDo X.')
    expect(r).toEqual({ summary: 'A stack.', workflowGuidance: 'Do X.' })
  })
  it('falls back to the whole text when the format is missing', () => {
    expect(parseOnboardingOutput('just text')).toEqual({ summary: 'just text' })
  })
})

describe('isTrustedFrame (IPC sender check)', () => {
  const entry = 'file:///app/out/renderer/index.html'
  it('accepts the app top frame, including hash routes', () => {
    expect(isTrustedFrame({ url: `${entry}#/projects/1`, parent: null }, entry)).toBe(true)
  })
  it('rejects other URLs, child frames, missing frames and an unset entry', () => {
    expect(isTrustedFrame({ url: 'https://evil.test/', parent: null }, entry)).toBe(false)
    expect(isTrustedFrame({ url: entry, parent: {} }, entry)).toBe(false)
    expect(isTrustedFrame(null, entry)).toBe(false)
    expect(isTrustedFrame({ url: entry, parent: null }, null)).toBe(false)
  })
})
