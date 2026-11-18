import { describe, expect, it } from 'vitest'
import { isAppUrl, isSafeExternalUrl } from '../src/main/app/navigation-policy'

describe('isSafeExternalUrl', () => {
  it('accepts plain https URLs', () => {
    expect(isSafeExternalUrl('https://example.com/path?q=1')).toBe(true)
  })
  it.each([
    'http://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pw@example.com',
    'https://',
    'not a url',
    ''
  ])('rejects %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false)
  })
})

describe('isAppUrl', () => {
  const file = 'file:///Applications/Orbyte/out/renderer/index.html'
  it('matches the built entry regardless of hash or query', () => {
    expect(isAppUrl(file, file)).toBe(true)
    expect(isAppUrl(`${file}#/projects/1`, file)).toBe(true)
  })
  it('rejects other files, other schemes and garbage in file mode', () => {
    expect(isAppUrl('file:///etc/passwd', file)).toBe(false)
    expect(isAppUrl('https://example.com/', file)).toBe(false)
    expect(isAppUrl('nope', file)).toBe(false)
  })
  it('matches the dev server origin only', () => {
    const dev = 'http://localhost:5173/'
    expect(isAppUrl('http://localhost:5173/anything#x', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('http://evil.test:5173/', dev)).toBe(false)
  })
})
