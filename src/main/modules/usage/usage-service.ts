import { and, eq, sql } from 'drizzle-orm'
import { AppError } from '@shared/types/result'
import type { UsageSummary } from '@shared/schemas/usage'
import type { Db } from '../../database/client'
import { teamLeadUsage } from '../../database/schema'
import type { AgentRepository } from '../agents/developers/agent-repository'
import type { ProjectRepository } from '../projects/repository'
import { log } from '../../logging/logger'
import { addTotals, emptyTotals, readTranscriptUsage } from './transcript-usage'

const MAX_AGENTS = 60

export interface SdkUsageReport {
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export class UsageService {
  constructor(
    private readonly deps: {
      db: Db
      projects: Pick<ProjectRepository, 'get'>
      agents: Pick<AgentRepository, 'list'>
      configDir: () => string
    }
  ) {}

  /**
   * Stores the newest cumulative report for a Team Lead session. A report below what is already stored is ignored:
   * the SDK documents that crash and startup-error results may carry zeroed values.
   */
  recordTeamLead(projectId: string, sessionId: string, r: SdkUsageReport): void {
    try {
      const total = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens
      const existing = this.deps.db.select().from(teamLeadUsage).where(and(eq(teamLeadUsage.projectId, projectId), eq(teamLeadUsage.sessionId, sessionId))).get()
      const had = existing ? existing.inputTokens + existing.outputTokens + existing.cacheReadTokens + existing.cacheCreationTokens : 0
      if (existing && (total < had || r.costUsd < existing.costUsd)) return
      this.deps.db
        .insert(teamLeadUsage)
        .values({ projectId, sessionId, ...r, cacheReadTokens: r.cacheReadTokens, cacheCreationTokens: r.cacheCreationTokens })
        .onConflictDoUpdate({
          target: [teamLeadUsage.projectId, teamLeadUsage.sessionId],
          set: { costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheCreationTokens: r.cacheCreationTokens, updatedAt: Date.now() }
        })
        .run()
    } catch (err) {
      log.error('[usage] could not record Team Lead usage', err)
    }
  }

  async summary(projectId: string): Promise<UsageSummary> {
    if (!this.deps.projects.get(projectId)) throw new AppError('NOT_FOUND', 'Project not found.')
    const t = this.deps.db
      .select({
        costUsd: sql<number>`coalesce(sum(${teamLeadUsage.costUsd}), 0)`,
        inputTokens: sql<number>`coalesce(sum(${teamLeadUsage.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${teamLeadUsage.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${teamLeadUsage.cacheReadTokens}), 0)`,
        cacheCreationTokens: sql<number>`coalesce(sum(${teamLeadUsage.cacheCreationTokens}), 0)`,
        sessions: sql<number>`count(*)`
      })
      .from(teamLeadUsage)
      .where(eq(teamLeadUsage.projectId, projectId))
      .get()

    let agents = emptyTotals()
    let read = 0
    let unreadable = 0
    const configDir = this.deps.configDir()
    for (const a of this.deps.agents.list(projectId).slice(0, MAX_AGENTS)) {
      const u = await readTranscriptUsage({ configDir, cwd: a.worktreePath, sessionId: a.claudeSessionId })
      if (u) { agents = addTotals(agents, u); read++ } else unreadable++
    }
    return {
      teamLead: t ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessions: 0 },
      agents: { ...agents, agentsRead: read, agentsUnreadable: unreadable }
    }
  }
}
