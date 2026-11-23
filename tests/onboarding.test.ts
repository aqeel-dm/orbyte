import { describe, expect, it } from 'vitest'
import type { TeamLeadRunRequest } from '../src/main/modules/agents/team-lead/options'
import { TeamLeadService } from '../src/main/modules/agents/team-lead/service'
import { OnboardingService } from '../src/main/modules/projects/onboarding'
import type { DiscoveryResult } from '../src/shared/schemas/onboarding'
import type { AppEvent } from '../src/shared/schemas/team-lead'
import { AppError } from '../src/shared/types/result'
import { makeStack, sdk } from './helpers'

const discovery: DiscoveryResult = {
  claudeMdFiles: [{ path: 'CLAUDE.md', bytes: 10 }],
  claudeDir: { exists: false, rules: [], skills: [], agents: [], settingsFiles: [], hasHooks: false },
  hasMcpConfig: false, docs: [], truncated: false
}

function setup(messages: (req: TeamLeadRunRequest) => unknown[] | Error, discover = async () => discovery) {
  const stack = makeStack()
  const events: AppEvent[] = []
  const requests: TeamLeadRunRequest[] = []
  const runner = { async *run(req: TeamLeadRunRequest) { requests.push(req); const out = messages(req); if (out instanceof Error) throw out; yield* out } }
  const teamLead = new TeamLeadService({ projects: stack.projects, chat: stack.chat, runner, emit: (e) => events.push(e) })
  const onboarding = new OnboardingService({ projects: stack.projects, teamLead, discover, emit: (e) => events.push(e) })
  const project = stack.addProject()
  const settled = () => new Promise<void>((resolve) => {
    const t = setInterval(() => { const s = stack.projects.get(project.id)?.onboardingStatus; if (s === 'ready' || s === 'failed') { clearInterval(t); resolve() } }, 2)
  })
  const eventTypes = () => stack.handle.raw.prepare('select type from activity_events where project_id = ? order by rowid').all(project.id).map((r) => (r as { type: string }).type)
  return { ...stack, onboarding, events, requests, project, settled, eventTypes }
}

describe('OnboardingService', () => {
  it('runs discovery then a bounded read-only turn and stores the result in the DB only', async () => {
    const t = setup(() => [sdk.init('s1'), sdk.delta('x'), sdk.success('## Project summary\nElectron app.\n\n## Proposed workflow guidance\nBranch per phase.')])
    const started = t.onboarding.start(t.project.id)
    expect(started.onboardingStatus).toBe('in_progress')
    await t.settled()
    const p = t.projects.get(t.project.id)!
    expect(p.onboardingStatus).toBe('ready')
    expect(p.onboardingData).toMatchObject({ discovery, summary: 'x', })
    expect(p.onboardingData?.completedAt).toBeTypeOf('number')
    expect(t.requests[0]?.maxTurns).toBeGreaterThan(0)
    expect(t.requests[0]?.prompt).toContain('CLAUDE.md')
    expect(t.chat.list(t.project.id)).toEqual([]) // onboarding prompts are not chat history
    expect(t.eventTypes()).toEqual(['project.registered', 'onboarding.started', 'onboarding.discovered', 'teamlead.session_started', 'onboarding.completed'])
    expect(t.events.filter((e) => e.type === 'project_updated').length).toBeGreaterThanOrEqual(3)
  })

  it('marks onboarding failed with the Team Lead error and allows retry', async () => {
    let fail = true
    const t = setup(() => (fail ? [sdk.error('Invalid API key · Please run /login')] : [sdk.success('## Project summary\nok')]))
    t.onboarding.start(t.project.id); await t.settled()
    expect(t.projects.get(t.project.id)).toMatchObject({ onboardingStatus: 'failed', onboardingData: { error: { code: 'AUTH_REQUIRED' } } })
    fail = false
    t.onboarding.start(t.project.id); await t.settled()
    expect(t.projects.get(t.project.id)?.onboardingStatus).toBe('ready')
    expect(t.eventTypes()).toContain('onboarding.failed')
  })

  it('marks failed when discovery throws', async () => {
    const t = setup(() => [sdk.success('x')], async () => { throw new Error('disk gone') })
    t.onboarding.start(t.project.id); await t.settled()
    expect(t.projects.get(t.project.id)?.onboardingData?.error).toMatchObject({ code: 'ONBOARDING_ERROR', message: 'disk gone' })
  })

  it('refuses to start twice, for archived projects, and for unknown projects', async () => {
    const t = setup(() => [sdk.success('x')])
    t.onboarding.start(t.project.id)
    expect(() => t.onboarding.start(t.project.id)).toThrow(/already working/i)
    await t.settled()
    t.projects.setStatus(t.project.id, 'archived')
    expect(() => t.onboarding.start(t.project.id)).toThrow(/archived/i)
    expect(() => t.onboarding.start('missing')).toThrow(AppError)
  })

  it('recovers onboarding left in_progress by an exit as failed/interrupted', () => {
    const t = setup(() => [])
    t.projects.setOnboarding(t.project.id, 'in_progress', { startedAt: 1 }, 'onboarding.started')
    expect(t.onboarding.recoverInterrupted()).toEqual([t.project.id])
    const p = t.projects.get(t.project.id)!
    expect(p.onboardingStatus).toBe('failed')
    expect(p.onboardingData?.error?.code).toBe('INTERRUPTED')
    expect(t.eventTypes()).toContain('onboarding.interrupted')
    expect(t.onboarding.recoverInterrupted()).toEqual([])
    expect(() => t.onboarding.start(t.project.id)).not.toThrow()
  })
})
