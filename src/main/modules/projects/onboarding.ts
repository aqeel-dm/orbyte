import { AppError } from '@shared/types/result'
import type { DiscoveryResult, OnboardingData } from '@shared/schemas/onboarding'
import type { Project } from '@shared/schemas/project'
import type { AppEvent } from '@shared/schemas/team-lead'
import { ONBOARDING_PROMPT } from '../agents/team-lead/prompt'
import type { TeamLeadService } from '../agents/team-lead/service'
import type { ProjectRepository } from './repository'
import { log } from '../../logging/logger'

const ONBOARDING_MAX_TURNS = 12

export interface OnboardingDeps {
  projects: ProjectRepository
  teamLead: Pick<TeamLeadService, 'runTurn' | 'isActive'>
  discover: (repoPath: string) => Promise<DiscoveryResult>
  emit: (event: AppEvent) => void
}

/** Splits the Team Lead's reply into summary and proposed guidance. Falls back to the whole text as the summary. */
export function parseOnboardingOutput(text: string): { summary: string; workflowGuidance?: string } {
  const m = text.match(/^#{1,3}\s*Proposed workflow guidance\s*$/im)
  if (!m || m.index === undefined) return { summary: text.trim() }
  const summary = text.slice(0, m.index).replace(/^#{1,3}\s*Project summary\s*$/im, '').trim()
  const guidance = text.slice(m.index + m[0].length).trim()
  return { summary: summary || text.trim(), ...(guidance ? { workflowGuidance: guidance } : {}) }
}

/** Names come from the repository and are untrusted: strip anything unusual and bound length and count. */
const clean = (s: string): string => s.replace(/[^\w.\-/@+ ]/g, '?').slice(0, 80)
const list = (items: string[]): string =>
  items.length ? items.slice(0, 25).map(clean).join(', ') + (items.length > 25 ? ', …' : '') : 'none'

export function summarizeDiscovery(d: DiscoveryResult): string {
  const lines: string[] = []
  for (const f of d.claudeMdFiles) lines.push(`- ${clean(f.path)} (CLAUDE.md, ${f.bytes} bytes)`)
  if (d.claudeDir.exists) {
    lines.push(`- .claude/ (rules: ${list(d.claudeDir.rules)}; skills: ${list(d.claudeDir.skills)}; agents: ${list(d.claudeDir.agents)}; settings: ${list(d.claudeDir.settingsFiles)}; hooks configured: ${d.claudeDir.hasHooks})`)
  }
  if (d.hasMcpConfig) lines.push('- .mcp.json (MCP configuration present)')
  for (const f of d.docs) lines.push(`- ${clean(f.path)} (${f.bytes} bytes)`)
  return lines.length ? lines.join('\n') : '- (no CLAUDE.md, .claude/ or documentation files were found)'
}

export class OnboardingService {
  constructor(private readonly deps: OnboardingDeps) {}

  /** Call once at startup: onboarding that was running when the app exited is marked failed/interrupted. */
  recoverInterrupted(): string[] {
    return this.deps.projects.markInterruptedOnboardings()
  }

  /** Marks onboarding in_progress and runs it in the background. Progress is announced with `project_updated`. */
  start(projectId: string): Project {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new AppError('NOT_FOUND', 'Project not found.')
    if (project.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it first.')
    if (project.repoSettingsTrust === 'unset') {
      throw new AppError('TRUST_REQUIRED', "Decide whether to use this repository's Claude settings before onboarding.")
    }
    if (project.onboardingStatus === 'in_progress' || this.deps.teamLead.isActive(projectId)) {
      throw new AppError('ALREADY_RUNNING', 'The Team Lead is already working on this project.')
    }
    const started = this.deps.projects.setOnboarding(projectId, 'in_progress', { startedAt: Date.now() }, 'onboarding.started')
    if (!started) throw new AppError('NOT_FOUND', 'Project not found.')
    this.safeEmit(projectId)
    // run() handles its own failures; the catch is a last-resort guard against an unhandled rejection.
    void this.run(started).catch((err) => log.error('[onboarding] unexpected failure', err))
    return started
  }

  private async run(project: Project): Promise<void> {
    const id = project.id
    const data: OnboardingData = { startedAt: project.onboardingData?.startedAt ?? Date.now() }
    try {
      data.discovery = await this.deps.discover(project.repoPath)
      this.deps.projects.setOnboarding(id, 'in_progress', data, 'onboarding.discovered')
      this.safeEmit(id)

      const outcome = await this.deps.teamLead.runTurn({
        projectId: id,
        prompt: ONBOARDING_PROMPT(summarizeDiscovery(data.discovery)),
        purpose: 'onboarding',
        saveToChat: false,
        maxTurns: ONBOARDING_MAX_TURNS
      })

      if (outcome.ok) {
        const parsed = parseOnboardingOutput(outcome.text)
        this.deps.projects.setOnboarding(id, 'ready', { ...data, ...parsed, completedAt: Date.now() }, 'onboarding.completed')
      } else {
        this.deps.projects.setOnboarding(id, 'failed', { ...data, error: { code: outcome.code, message: outcome.message } }, 'onboarding.failed', { code: outcome.code })
      }
    } catch (err) {
      log.error(`[onboarding] failed for project ${id}`, err)
      try {
        this.deps.projects.setOnboarding(
          id,
          'failed',
          { ...data, error: { code: 'ONBOARDING_ERROR', message: 'Onboarding failed unexpectedly. See the application log.' } },
          'onboarding.failed',
          { code: 'ONBOARDING_ERROR' }
        )
      } catch (inner) {
        log.error(`[onboarding] could not record failure for project ${id}`, inner)
      }
    }
    this.safeEmit(id)
  }

  private safeEmit(projectId: string): void {
    try {
      this.deps.emit({ type: 'project_updated', projectId })
    } catch (err) {
      log.error('[onboarding] failed to emit event', err)
    }
  }
}
