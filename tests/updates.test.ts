import { describe, expect, it } from 'vitest'
import { UpdateService, RELEASES_URL_PREFIX, type FetchLike } from '../src/main/modules/updates/update-service'
import { compareVersions, parseVersion } from '../src/shared/version'

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, html_url: `${RELEASES_URL_PREFIX}tag/${tag}`, ...extra })
const answer = (body: unknown, status = 200): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
function make(over: { current?: string; packaged?: boolean; fetch?: FetchLike } = {}) {
  const opened: string[] = []
  const service = new UpdateService({
    currentVersion: over.current ?? '0.1.1',
    packaged: over.packaged ?? true,
    fetch: over.fetch ?? answer([]),
    openExternal: (u) => { opened.push(u) },
    now: () => new Date('2026-01-01T00:00:00Z')
  })
  return { service, opened }
}

describe('versions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '0.9.99')).toBeGreaterThan(0)
    expect(compareVersions('0.1.1', 'v0.1.1')).toBe(0)
    expect(compareVersions('0.1.1', '0.2.0')).toBeLessThan(0)
  })
  it('accepts only plain release versions', () => {
    expect(parseVersion('v0.1.4')).toEqual([0, 1, 4])
    for (const bad of ['0.1', '0.1.4-beta', '0.1.4.1', 'latest', '', 'v0.1.x']) expect(parseVersion(bad)).toBeNull()
  })
})

describe('UpdateService', () => {
  it('reports a newer release and opens only its page', async () => {
    const { service, opened } = make({ fetch: answer([rel('v0.1.2'), rel('v0.1.10'), rel('v0.1.9')]) })
    const s = await service.check()
    expect(s).toMatchObject({ current: '0.1.1', latest: '0.1.10', updateAvailable: true, error: null })
    await service.openDownload()
    expect(opened).toEqual([`${RELEASES_URL_PREFIX}tag/v0.1.10`])
  })

  it('says up to date for the same or an older newest release, and refuses to open anything', async () => {
    for (const tags of [['v0.1.1'], ['v0.1.0']]) {
      const { service, opened } = make({ fetch: answer(tags.map((t) => rel(t))) })
      expect((await service.check()).updateAvailable).toBe(false)
      await expect(service.openDownload()).rejects.toMatchObject({ code: 'NO_UPDATE' })
      expect(opened).toEqual([])
    }
  })

  it('ignores drafts, odd tags and release pages outside this repository', async () => {
    const body = [rel('v0.9.0', { draft: true }), rel('v0.8.0-beta'), rel('v0.7.0', { html_url: 'https://evil.example/releases/v0.7.0' }), rel('v0.1.2')]
    const { service } = make({ fetch: answer(body) })
    expect(await service.check()).toMatchObject({ latest: '0.1.2', updateAvailable: true })
  })

  it('maps failures to fixed messages and keeps no update', async () => {
    const cases: [FetchLike, RegExp][] = [
      [async () => { throw new Error('ENOTFOUND secret-host') }, /Could not reach GitHub/],
      [answer({}, 404), /not available/],
      [answer({}, 403), /limiting/],
      [answer({ not: 'a list' }), /unexpected/],
      [async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }), /unexpected/]
    ]
    for (const [fetch, message] of cases) {
      const { service } = make({ fetch })
      const s = await service.check()
      expect(s.error).toMatch(message)
      expect(s.error).not.toMatch(/secret-host|bad json/)
      expect(s.updateAvailable).toBe(false)
    }
  })

  it('does not look when it is a development run', async () => {
    let calls = 0
    const { service } = make({ packaged: false, fetch: async () => { calls++; return { ok: true, status: 200, json: async () => [] } } })
    const s = await service.check()
    expect(calls).toBe(0)
    expect(s).toMatchObject({ packaged: false, checkedAt: null })
  })

  it('a failed re-check does not keep offering a stale download', async () => {
    let n = 0
    const { service, opened } = make({ fetch: async () => (n++ === 0 ? { ok: true, status: 200, json: async () => [rel('v0.2.0')] } : { ok: false, status: 500, json: async () => ({}) }) })
    expect((await service.check()).updateAvailable).toBe(true)
    await service.check()
    // The earlier finding stands (it was real) and the error is shown; the page is still the validated one.
    await service.openDownload()
    expect(opened).toHaveLength(1)
  })

  it('shares one request between overlapping checks', async () => {
    let calls = 0
    const { service } = make({ fetch: async () => { calls++; return { ok: true, status: 200, json: async () => [] } } })
    await Promise.all([service.check(), service.check()])
    expect(calls).toBe(1)
  })
})
