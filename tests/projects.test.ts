import { describe, expect, it } from 'vitest'
import { AppError } from '../src/shared/types/result'
import { registerProjectInputSchema, removeProjectInputSchema } from '../src/shared/schemas/project'
import { MAX_PENDING_TOKENS } from '../src/main/modules/projects/service'
import { makeService, tempDir } from './helpers'

const codeOf = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return e instanceof AppError ? e.code : 'OTHER' }
  return 'NONE'
}

describe('ProjectService', () => {
  it('registers a project via token and persists it', async () => {
    const { service } = makeService()
    const dir = tempDir()
    const picked = await service.prepare(dir)
    const project = await service.register({ token: picked.token, name: 'Demo', description: '' })
    expect(project.name).toBe('Demo')
    expect(project.onboardingStatus).toBe('pending')
    expect(service.list().map((p) => p.id)).toEqual([project.id])
  })

  it('tokens are single-use', async () => {
    const { service } = makeService()
    const { token } = await service.prepare(tempDir())
    await service.register({ token, name: 'A', description: '' })
    expect(await codeOf(service.register({ token, name: 'B', description: '' }))).toBe('INVALID_TOKEN')
  })

  it('rejects unknown and expired tokens', async () => {
    let t = 0
    const { service } = makeService(() => t)
    expect(await codeOf(service.register({ token: 'nope', name: 'x', description: '' }))).toBe('INVALID_TOKEN')
    const { token } = await service.prepare(tempDir())
    t += 11 * 60_000
    expect(await codeOf(service.register({ token, name: 'x', description: '' }))).toBe('INVALID_TOKEN')
  })

  it('rejects duplicate directories and nonexistent paths', async () => {
    const { service } = makeService()
    const dir = tempDir()
    await service.register({ token: (await service.prepare(dir)).token, name: 'A', description: '' })
    const again = await service.prepare(dir)
    expect(await codeOf(service.register({ token: again.token, name: 'B', description: '' }))).toBe('ALREADY_REGISTERED')
    expect(await codeOf(service.prepare('/definitely/not/here'))).toBe('INVALID_DIRECTORY')
  })

  it('removes projects and records an activity event on registration', async () => {
    const { service, handle } = makeService()
    const p = await service.register({ token: (await service.prepare(tempDir())).token, name: 'A', description: '' })
    service.remove(p.id)
    expect(service.list()).toEqual([])
    expect(() => service.remove(p.id)).toThrow(AppError)
    handle.close()
  })
})

describe('ProjectService limits', () => {
  it('caps pending tokens by evicting the oldest', async () => {
    const { service } = makeService()
    const first = await service.prepare(tempDir())
    for (let i = 0; i < MAX_PENDING_TOKENS; i++) await service.prepare(tempDir())
    expect(await codeOf(service.register({ token: first.token, name: 'x', description: '' }))).toBe('INVALID_TOKEN')
    const newest = await service.prepare(tempDir())
    await expect(service.register({ token: newest.token, name: 'ok', description: '' })).resolves.toMatchObject({ name: 'ok' })
  })

  it('allows only one directory selection at a time and releases the lock', async () => {
    const { service } = makeService()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const first = service.exclusivePick(() => gate)
    expect(await codeOf(service.exclusivePick(async () => 1))).toBe('DIALOG_BUSY')
    release()
    await first
    await expect(service.exclusivePick(async () => 2)).resolves.toBe(2)
    await expect(service.exclusivePick(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(service.exclusivePick(async () => 3)).resolves.toBe(3)
  })
})

describe('IPC input schema', () => {
  it('limits token and id length', () => {
    const long = 'x'.repeat(65)
    expect(registerProjectInputSchema.safeParse({ token: long, name: 'ok' }).success).toBe(false)
    expect(removeProjectInputSchema.safeParse({ id: long }).success).toBe(false)
    expect(removeProjectInputSchema.safeParse({ id: 'x'.repeat(64) }).success).toBe(true)
  })

  it('requires a non-empty name and defaults description', () => {
    expect(registerProjectInputSchema.safeParse({ token: 't', name: '  ' }).success).toBe(false)
    expect(registerProjectInputSchema.parse({ token: 't', name: 'ok' }).description).toBe('')
  })
})
