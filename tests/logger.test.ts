import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileLogger, redact } from '../src/main/logging/logger'
import { tempDir } from './helpers'

describe('redact', () => {
  it('removes API keys, bearer tokens and secret assignments', () => {
    const out = redact('key sk-ant-api03-abcdefghijkl and Authorization: Bearer abcdefghijklmnop1234 and ANTHROPIC_API_KEY=sk-x CLAUDE_CODE_OAUTH_TOKEN="a b" ok', '/nohome')
    expect(out).not.toMatch(/abcdefghijkl|sk-x|a b/)
    expect(out).toContain('sk-ant-[redacted]')
    expect(out).toContain('ANTHROPIC_API_KEY=[redacted]')
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN=[redacted]')
  })
  it('shortens the home directory', () => {
    expect(redact('failed at /Users/me/code/x', '/Users/me')).toBe('failed at ~/code/x')
  })
})

describe('hardening', () => {
  it('redacts other secret shapes', () => {
    const out = redact('api_key=abc123 {"token":"xyz789"} apiKey: \'k9\' Authorization: Basic dXNlcjpwYXNz --api-key hunter2 ghp_abcdefghijklmnopqrstuvwx AKIAABCDEFGHIJKLMNOP', '/nohome')
    expect(out).not.toMatch(/abc123|xyz789|k9|dXNlcjpwYXNz|hunter2|ghp_abc|AKIAABC/)
  })
})

describe('FileLogger', () => {
  it('writes levelled, redacted lines to a private file and honours the minimum level', () => {
    const dir = join(tempDir('orbyte-log-'), 'logs')
    const l = new FileLogger(dir, { mirror: false, level: 'info' })
    l.write('debug', ['hidden'])
    l.write('error', ['boom', new Error('bad ANTHROPIC_API_KEY=secret123')])
    const text = readFileSync(l.path, 'utf8')
    expect(text).not.toContain('hidden')
    expect(text).toMatch(/ERROR boom Error: bad ANTHROPIC_API_KEY=\[redacted\]/)
    expect(text).not.toContain('secret123')
    expect(statSync(l.path).mode & 0o077).toBe(0)
    expect(statSync(dir).mode & 0o077).toBe(0)
  })

  it('rotates by size and keeps a bounded number of files', () => {
    const dir = tempDir('orbyte-log-')
    const l = new FileLogger(dir, { mirror: false, maxBytes: 300, keep: 2 })
    for (let i = 0; i < 40; i++) l.write('info', [`line ${i} ${'x'.repeat(40)}`])
    expect(existsSync(join(dir, 'orbyte.1.log'))).toBe(true)
    expect(existsSync(join(dir, 'orbyte.2.log'))).toBe(true)
    expect(existsSync(join(dir, 'orbyte.3.log'))).toBe(false)
    expect(readFileSync(l.path, 'utf8')).toContain('line 39')
  })

  it('escapes control characters, cannot forge a new entry, and caps one entry', () => {
    const l = new FileLogger(tempDir('orbyte-log-'), { mirror: false })
    l.write('info', ['hello\nFAKE 2026-01-01 INFO forged\x1b[31m red\r'])
    l.write('info', ['y'.repeat(20000)])
    const lines = readFileSync(l.path, 'utf8').split('\n').filter(Boolean)
    expect(lines.filter((x) => /^\d{4}-/.test(x))).toHaveLength(2) // only real entries start a line
    expect(lines.join('\n')).not.toContain('\x1b')
    expect(lines.find((x) => x.includes('truncated'))).toBeTruthy()
  })

  it('does not throw when formatting an argument itself throws', () => {
    const l = new FileLogger(tempDir('orbyte-log-'), { mirror: false })
    const hostile = { get boom(): string { throw new Error('getter') }, [Symbol.for('nodejs.util.inspect.custom')]() { throw new Error('inspect') } }
    expect(() => l.write('error', [hostile])).not.toThrow()
  })

  it('never throws, even when the directory cannot be written', () => {
    const l = new FileLogger('/proc/definitely/not/writable', { mirror: false })
    expect(() => l.write('error', ['still fine'])).not.toThrow()
  })
})
