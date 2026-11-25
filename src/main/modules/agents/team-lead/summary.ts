import type { Project } from '@shared/schemas/project'
import type { TeamLeadSummary } from '@shared/schemas/team-lead'

/** Counts for the dashboard: Team Leads that finished onboarding in active projects, and turns running now. */
export function summarizeTeamLeads(projects: Pick<Project, 'id' | 'status' | 'onboardingStatus'>[], isActive: (projectId: string) => boolean): TeamLeadSummary {
  const active = projects.filter((p) => p.status === 'active')
  return {
    ready: active.filter((p) => p.onboardingStatus === 'ready').length,
    working: active.filter((p) => isActive(p.id)).length
  }
}
