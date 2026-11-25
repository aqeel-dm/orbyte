import { createHash, randomUUID } from 'node:crypto'
import { chmod, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CleanOrphansResult, MaintenanceScan, OrphanWorktree } from '@shared/schemas/maintenance'
import { AppError } from '@shared/types/result'
import { activityEvents } from '../../database/schema'
import type { Db } from '../../database/client'
import { log } from '../../logging/logger'
import type { AgentInbox } from '../agents/developers/agent-inbox'
import type { AgentRepository } from '../agents/developers/agent-repository'
import { containment, type GitWorktrees } from '../agents/developers/worktrees'
import type { ProjectRepository } from '../projects/repository'

const UUID = /^[0-9a-f-]{36}$/

export interface RecoveryCounts {
  interruptedAgents: number
  interruptedRuns: number
}

/**
 * Housekeeping for what a crash or a manual delete leaves behind. Everything it does is limited to Orbyte's own
 * directories (worktree root and inbox root), never takes a path from the renderer, and never deletes a worktree
 * that has uncommitted changes.
 */
export class MaintenanceService {
  constructor(
    private readonly deps: {
      db: Db
      backupTo: (dest: string) => Promise<void>
      projects: Pick<ProjectRepository, 'get'>
      agents: Pick<AgentRepository, 'listAll'>
      inbox: AgentInbox
      inboxRoot: string
      worktrees: Pick<GitWorktrees, 'hasChanges' | 'hasUnreferencedCommits' | 'remove' | 'prune'>
      worktreeRoot: string
    }
  ) {}

  /** Runs once at startup after the interrupted agents and runs were reconciled. Records one audited summary. */
  async sweepAtStartup(recovered: RecoveryCounts): Promise<{ orphanInboxesRemoved: number; orphanWorktrees: number }> {
    let orphanInboxesRemoved = 0
    let orphanWorktrees = 0
    try {
      orphanInboxesRemoved = await this.removeOrphanInboxes()
      orphanWorktrees = (await this.scan()).orphanWorktrees.length
    } catch (err) {
      log.error('[maintenance] startup sweep failed', err)
    }
    const summary = { ...recovered, orphanInboxesRemoved, orphanWorktrees }
    if (recovered.interruptedAgents + recovered.interruptedRuns + orphanInboxesRemoved + orphanWorktrees > 0) {
      this.deps.db.insert(activityEvents).values({ id: randomUUID(), projectId: null, type: 'recovery.completed', payload: summary }).run()
      log.info('[maintenance] startup recovery', summary)
    }
    return { orphanInboxesRemoved, orphanWorktrees }
  }

  /** Inbox directories whose agent no longer exists hold nothing anyone can use. */
  private async removeOrphanInboxes(): Promise<number> {
    const known = new Set(this.deps.agents.listAll().map((a) => a.id))
    let removed = 0
    for (const name of await this.safeReaddir(this.deps.inboxRoot)) {
      if (!UUID.test(name) || known.has(name)) continue
      await this.deps.inbox.remove(name)
      removed++
    }
    return removed
  }

  /** Worktree directories (`<root>/<projectId>/<agentId>`) that no agent record owns. Read-only. */
  async scan(): Promise<MaintenanceScan> {
    const owned = new Set(this.deps.agents.listAll().filter((a) => !a.worktreeRemoved).map((a) => a.worktreePath))
    const orphans: OrphanWorktree[] = []
    for (const projectId of await this.safeReaddir(this.deps.worktreeRoot)) {
      const projectDir = join(this.deps.worktreeRoot, projectId)
      for (const name of await this.safeReaddir(projectDir)) {
        const path = join(projectDir, name)
        if (owned.has(path)) continue
        orphans.push({ id: this.idFor(path), projectId, projectName: this.deps.projects.get(projectId)?.name ?? null, name })
      }
    }
    return { orphanWorktrees: orphans }
  }

  /** Removes the orphans the user chose. Ids are matched against a fresh scan, so only listed orphans can be touched. */
  async cleanOrphans(ids: string[]): Promise<CleanOrphansResult> {
    const wanted = new Set(ids)
    const result: CleanOrphansResult = { removed: 0, skipped: [] }
    for (const o of (await this.scan()).orphanWorktrees) {
      if (!wanted.has(o.id)) continue
      const path = join(this.deps.worktreeRoot, o.projectId, o.name)
      const skip = (reason: string): void => void result.skipped.push({ id: o.id, reason })
      try {
        if ((await containment(this.deps.worktreeRoot, path)) !== 'inside') { skip('It is not inside Orbyte\'s worktree directory.'); continue }
        const project = this.deps.projects.get(o.projectId)
        if (!project) { skip('Its project no longer exists. Delete the folder yourself if you are sure.'); continue }
        if (await this.deps.worktrees.hasChanges(path).catch(() => true)) { skip('It has uncommitted changes (or could not be checked). It was kept.'); continue }
        if (await this.deps.worktrees.hasUnreferencedCommits(path).catch(() => true)) { skip('It has commits that are on no branch. It was kept.'); continue }
        await this.deps.worktrees.remove(project.repoPath, path, false)
        await rm(path, { recursive: true, force: true })
        result.removed++
      } catch (err) {
        log.error('[maintenance] could not remove an orphan worktree', err)
        skip('It could not be removed. See the application log.')
      }
    }
    return result
  }

  /** Writes a consistent copy of the database to a path chosen in main (never by the renderer). */
  async backup(dest: string): Promise<void> {
    if (!/\.(db|sqlite|sqlite3)$/i.test(dest)) throw new AppError('INVALID_INPUT', 'Choose a .db file name.')
    // Create (or empty) the file privately first so the copy is never readable by others, even briefly.
    await writeFile(dest, '', { mode: 0o600 })
    await chmod(dest, 0o600)
    await this.deps.backupTo(dest)
    log.info('[maintenance] database backup written')
  }

  private idFor(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 32)
  }

  private async safeReaddir(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((n) => !n.startsWith('.'))
    } catch {
      return []
    }
  }
}
