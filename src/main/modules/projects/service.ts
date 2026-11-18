import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { AppError } from '@shared/types/result'
import type { PickDirectoryResult, Project, RegisterProjectInput, RepoInspection } from '@shared/schemas/project'
import type { ProjectRepository } from './repository'

const TOKEN_TTL_MS = 10 * 60_000
export const MAX_PENDING_TOKENS = 20

interface Pending {
  path: string
  inspection: RepoInspection
  expiresAt: number
}

export interface ProjectServiceDeps {
  repo: ProjectRepository
  inspect: (dir: string) => Promise<RepoInspection>
  now?: () => number
}

/**
 * The renderer never supplies a filesystem path. A directory is chosen in the
 * main process, remembered under a single-use token, and registered by token.
 */
export class ProjectService {
  private readonly pending = new Map<string, Pending>()
  private picking = false
  private readonly now: () => number

  constructor(private readonly deps: ProjectServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  list(): Project[] {
    return this.deps.repo.list()
  }

  /** Allows only one directory-selection flow at a time (prevents dialog spam). */
  async exclusivePick<T>(fn: () => Promise<T>): Promise<T> {
    if (this.picking) throw new AppError('DIALOG_BUSY', 'A directory selection is already in progress.')
    this.picking = true
    try {
      return await fn()
    } finally {
      this.picking = false
    }
  }

  /** Validates a user-selected directory and issues a registration token. */
  async prepare(selected: string): Promise<Extract<PickDirectoryResult, { cancelled: false }>> {
    const path = await this.validateDirectory(selected)
    const inspection = await this.deps.inspect(path)
    const token = randomUUID()
    this.sweep()
    // Bound memory: evict the oldest selections (Map keeps insertion order).
    while (this.pending.size >= MAX_PENDING_TOKENS) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    this.pending.set(token, { path, inspection, expiresAt: this.now() + TOKEN_TTL_MS })
    return { cancelled: false, token, path, suggestedName: basename(path), inspection }
  }

  async register(input: RegisterProjectInput & { description: string }): Promise<Project> {
    const entry = this.pending.get(input.token)
    this.pending.delete(input.token) // single use
    if (!entry || entry.expiresAt < this.now()) {
      throw new AppError('INVALID_TOKEN', 'Directory selection expired. Choose the directory again.')
    }
    // Re-validate: the directory may have changed since it was picked.
    const path = await this.validateDirectory(entry.path)
    if (this.deps.repo.findByPath(path)) {
      throw new AppError('ALREADY_REGISTERED', 'This directory is already registered as a project.')
    }
    const inspection = await this.deps.inspect(path)
    return this.deps.repo.create({
      name: input.name,
      description: input.description,
      repoPath: path,
      defaultBranch: inspection.defaultBranch,
      isGitRepo: inspection.isGitRepo
    })
  }

  remove(id: string): void {
    if (!this.deps.repo.remove(id)) throw new AppError('NOT_FOUND', 'Project not found.')
  }

  private async validateDirectory(p: string): Promise<string> {
    let real: string
    try {
      real = await realpath(p)
      if (!(await stat(real)).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new AppError('INVALID_DIRECTORY', 'The selected path does not exist or is not a directory.')
    }
    return real
  }

  private sweep(): void {
    const t = this.now()
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k)
  }
}
