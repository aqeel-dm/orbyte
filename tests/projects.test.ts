import { describe, expect, it } from 'vitest'
import { AppError } from '../src/shared/types/result'
import { registerProjectInputSchema } from '../src/shared/schemas/project'
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

describe('IPC input schema', () => {
  it('requires a non-empty name and defaults description', () => {
    expect(registerProjectInputSchema.safeParse({ token: 't', name: '  ' }).success).toBe(false)
    expect(registerProjectInputSchema.parse({ token: 't', name: 'ok' }).description).toBe('')
  })
})
