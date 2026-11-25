import { z } from 'zod'
import type { UpdateStatus } from '@shared/schemas/updates'
import { AppError } from '@shared/types/result'
import { compareVersions, parseVersion } from '@shared/version'

export const RELEASES_API = 'https://api.github.com/repos/aqeel-dm/orbyte/releases?per_page=10'
/** The only pages the download button may open. */
export const RELEASES_URL_PREFIX = 'https://github.com/aqeel-dm/orbyte/releases/'

const releasesSchema = z.array(z.object({ tag_name: z.string(), draft: z.boolean(), html_url: z.string() }))

const NO_NETWORK = 'Could not reach GitHub to look for updates.'
const NOT_AVAILABLE = 'Update information is not available (the releases page is private or missing).'
const RATE_LIMITED = 'GitHub is limiting update checks right now. Try again later.'
const BAD_DATA = 'GitHub returned an unexpected answer.'

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface UpdateServiceDeps {
  currentVersion: string
  packaged: boolean
  fetch: FetchLike
  now?: () => Date
  openExternal: (url: string) => Promise<void> | void
  log?: (message: string, detail?: unknown) => void
  timeoutMs?: number
}

/**
 * Looks for a newer Orbyte release on GitHub (read-only, no account, nothing sent about you) and lets the user open
 * its download page. It never downloads or installs anything: unsigned macOS apps cannot update themselves.
 */
export class UpdateService {
  private url: string | null = null
  private status: UpdateStatus
  private inflight: Promise<UpdateStatus> | null = null

  constructor(private readonly deps: UpdateServiceDeps) {
    this.status = { current: deps.currentVersion, packaged: deps.packaged, latest: null, updateAvailable: false, checkedAt: null, error: null }
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  check(): Promise<UpdateStatus> {
    if (!this.deps.packaged) return Promise.resolve(this.status)
    this.inflight ??= this.run().finally(() => { this.inflight = null })
    return this.inflight
  }

  /** Opens the release page found by the last check. Takes no URL from the caller. */
  async openDownload(): Promise<void> {
    if (!this.status.updateAvailable || !this.url || !this.url.startsWith(RELEASES_URL_PREFIX)) {
      throw new AppError('NO_UPDATE', 'There is no update to download.')
    }
    await this.deps.openExternal(this.url)
  }

  private async run(): Promise<UpdateStatus> {
    const checkedAt = (this.deps.now ?? (() => new Date()))().toISOString()
    const fail = (error: string, detail?: unknown): UpdateStatus => {
      this.deps.log?.(`[updates] check failed: ${error}`, detail)
      return (this.status = { ...this.status, checkedAt, error })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 10_000)
    try {
      let res
      try {
        res = await this.deps.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Orbyte-update-check' }, signal: controller.signal })
      } catch (e) {
        return fail(NO_NETWORK, e)
      }
      if (res.status === 403 || res.status === 429) return fail(RATE_LIMITED)
      if (!res.ok) return fail(res.status === 404 ? NOT_AVAILABLE : NO_NETWORK, res.status)
      const parsed = releasesSchema.safeParse(await res.json().catch(() => null))
      if (!parsed.success) return fail(BAD_DATA, parsed.error.message)
      let best: { version: string; url: string } | null = null
      for (const r of parsed.data) {
        if (r.draft || !parseVersion(r.tag_name) || !r.html_url.startsWith(RELEASES_URL_PREFIX)) continue
        const version = r.tag_name.replace(/^v/, '')
        if (!best || compareVersions(version, best.version) > 0) best = { version, url: r.html_url }
      }
      const available = !!best && !!parseVersion(this.deps.currentVersion) && compareVersions(best.version, this.deps.currentVersion) > 0
      this.url = available ? best!.url : null
      return (this.status = { ...this.status, latest: best?.version ?? null, updateAvailable: available, checkedAt, error: null })
    } finally {
      clearTimeout(timer)
    }
  }
}
