import { describe, expect, it } from 'vitest'
import { resolveClaudeBinary } from '../src/main/modules/agents/developers/claude-binary'
import { PLANNING_DENIED_TOOLS, PLANNING_TOOLS, agentEnv, buildAgentLaunch } from '../src/main/modules/agents/developers/launch'
import { TerminalBuffer, lastTerminalTitle } from '../src/main/modules/agents/developers/terminal-buffer'
import { TerminalHub } from '../src/main/modules/agents/developers/terminal-hub'

const input = { taskTitle: 'Add login', taskDescription: 'Use sessions.', branch: 'orbyte/add-login-1234abcd', baseBranch: 'main', sessionId: '11111111-1111-4111-8111-111111111111', repoSettingsTrust: 'trusted' as const }

describe('buildAgentLaunch', () => {
  it('starts in plan mode with a known session id, the write/exec tools denied, and the prompt after --', () => {
    const args = buildAgentLaunch(input)
    expect(args.slice(0, 4)).toEqual(['--permission-mode', 'plan', '--session-id', input.sessionId])
    expect(args).toContain(`--disallowedTools=${PLANNING_DENIED_TOOLS.join(',')}`)
    expect(PLANNING_DENIED_TOOLS).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'mcp__*']))
    const sep = args.indexOf('--')
    expect(sep).toBe(args.length - 2) // exactly one argument (the prompt) follows
    expect(args[sep + 1]).toContain('Add login')
    expect(args[sep + 1]).toContain('Use sessions.')
  })

  it('gives the agent an exact tool allowlist and starts no MCP servers (it had ~55 tools without these)', () => {
    const args = buildAgentLaunch(input)
    expect(PLANNING_TOOLS).toEqual(['Read', 'Glob', 'Grep'])
    expect(args).toContain('--tools=Read,Glob,Grep')
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--mcp-config')
    // the same holds for an untrusted project
    const untrusted = buildAgentLaunch({ ...input, repoSettingsTrust: 'untrusted' })
    expect(untrusted).toContain('--tools=Read,Glob,Grep')
    expect(untrusted).toContain('--strict-mcp-config')
  })

  it('never uses bypass or skip-permission flags, or a permissive mode', () => {
    const joined = buildAgentLaunch(input).join(' ')
    expect(joined).not.toMatch(/dangerously|bypassPermissions|acceptEdits|--allowedTools|dontAsk/)
  })

  it('loads the repo\'s own settings only for a trusted project', () => {
    expect(buildAgentLaunch(input)).not.toContain('--setting-sources')
    const untrusted = buildAgentLaunch({ ...input, repoSettingsTrust: 'untrusted' })
    expect(untrusted.slice(untrusted.indexOf('--setting-sources'), untrusted.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'user'])
  })

  it('strips control characters (a NUL would make the process spawn throw)', () => {
    const args = buildAgentLaunch({ ...input, taskTitle: 'a\u0000b\u0007c', taskDescription: 'x\u001by' })
    expect(args.join('')).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
  })
})

describe('agentEnv (allowlist)', () => {
  it('passes what Claude Code needs and nothing else', () => {
    const env = agentEnv({
      PATH: '/usr/bin', HOME: '/h', USER: 'u', LANG: 'en_US.UTF-8', LC_ALL: 'C', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1',
      GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws_secret', NPM_TOKEN: 'npm', CLAUDECODE: '1', DATABASE_URL: 'postgres://x', TERM: 'dumb',
      CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '123'
    })
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/h', USER: 'u', LANG: 'en_US.UTF-8', LC_ALL: 'C', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/cfg', TERM: 'xterm-256color' })
    // markers of a surrounding Claude Code session would switch off transcript saving
    for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) expect(env).not.toHaveProperty(marker)
    for (const secret of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'DATABASE_URL', 'CLAUDECODE']) expect(env).not.toHaveProperty(secret)
  })
})

describe('resolveClaudeBinary', () => {
  const only = (...paths: string[]) => (p: string) => paths.includes(p)
  it('prefers PATH, then common install locations, and never runs a shell', () => {
    expect(resolveClaudeBinary({ env: { PATH: '/a:/b' }, home: '/h', isExecutable: only('/b/claude', '/h/.local/bin/claude') })).toBe('/b/claude')
    expect(resolveClaudeBinary({ env: { PATH: '/usr/bin:/bin' }, home: '/h', isExecutable: only('/h/.local/bin/claude') })).toBe('/h/.local/bin/claude')
    expect(resolveClaudeBinary({ env: { PATH: '/usr/bin' }, home: '/h', isExecutable: only('/opt/homebrew/bin/claude') })).toBe('/opt/homebrew/bin/claude')
  })
  it('ignores relative PATH entries, which would resolve against whatever directory is current', () => {
    expect(resolveClaudeBinary({ env: { PATH: 'node_modules/.bin:./bin:/usr/bin' }, home: '/h', isExecutable: only('node_modules/.bin/claude', './bin/claude', 'bin/claude') })).toBeNull()
    expect(resolveClaudeBinary({ env: { PATH: 'bin:/usr/bin' }, home: '/h', isExecutable: only('/usr/bin/claude') })).toBe('/usr/bin/claude')
  })
  it('returns null when it is not installed', () => {
    expect(resolveClaudeBinary({ env: {}, home: '/h', isExecutable: () => false })).toBeNull()
  })
})

describe('TerminalBuffer and titles', () => {
  it('does not copy the whole buffer per chunk, and trims a single oversized chunk', () => {
    const b = new TerminalBuffer(1000)
    for (let i = 0; i < 5000; i++) b.append('abcdefghij') // 50,000 chars in 10-char chunks
    expect(b.snapshot().length).toBeLessThanOrEqual(1010)
    expect(b.snapshot().endsWith('abcdefghij')).toBe(true)
    const big = new TerminalBuffer(100)
    big.append('x'.repeat(500))
    expect(big.snapshot()).toBe('x'.repeat(100))
    big.append('')
    expect(big.snapshot()).toBe('x'.repeat(100))
  })
  it('keeps only the most recent output', () => {
    const b = new TerminalBuffer(100)
    b.append('x'.repeat(80)); b.append('\nline2\n'); b.append('y'.repeat(80))
    expect(b.snapshot().length).toBeLessThanOrEqual(100)
    expect(b.snapshot().endsWith('y'.repeat(80))).toBe(true)
    expect(b.tail(5)).toBe('yyyyy')
  })
  it('extracts the last terminal title (BEL or ST terminated), sanitized and capped', () => {
    expect(lastTerminalTitle('hi \x1b]0;First\x07 x \x1b]2;Second\x1b\\ end')).toBe('Second')
    expect(lastTerminalTitle('\x1b]0;a\x01b\x07')).toBe('ab')
    expect(lastTerminalTitle(`\x1b]0;${'z'.repeat(200)}\x07`)).toHaveLength(80)
    expect(lastTerminalTitle('\x1b]0;safe\u202etxt.exe\u200b\x07')).toBe('safetxt.exe') // bidi override and zero-width stripped
    expect(lastTerminalTitle('plain output')).toBeNull()
    expect(lastTerminalTitle('\x1b]0;   \x07')).toBeNull()
  })
})

describe('TerminalHub (per-agent scoping)', () => {
  it('delivers output only to windows attached to that agent', () => {
    const sent: [number, string, string][] = []
    const hub = new TerminalHub((w, e) => sent.push([w, e.agentId, e.data]))
    hub.attach('a1', 1); hub.attach('a1', 2); hub.attach('a2', 2)
    hub.publish('a1', 'hello'); hub.publish('a2', 'other'); hub.publish('a3', 'nobody')
    expect(sent).toEqual([[1, 'a1', 'hello'], [2, 'a1', 'hello'], [2, 'a2', 'other']])
    hub.detach('a1', 2); sent.length = 0
    hub.publish('a1', 'again')
    expect(sent).toEqual([[1, 'a1', 'again']])
    hub.detachAll(1); sent.length = 0
    hub.publish('a1', 'x')
    expect(sent).toEqual([])
  })
  it('does not leak empty subscription sets, and clear() drops an ended agent', () => {
    const hub = new TerminalHub(() => undefined)
    hub.attach('a', 1); hub.detach('a', 1)
    hub.attach('b', 1); hub.attach('b', 2); hub.detachAll(1); hub.detachAll(2)
    hub.attach('c', 3); hub.clear('c')
    expect((hub as unknown as { subs: Map<string, Set<number>> }).subs.size).toBe(0)
    expect(hub.isAttached('c', 3)).toBe(false)
  })
  it('one failing window does not stop delivery to the others', () => {
    const sent: number[] = []
    const hub = new TerminalHub((w) => { if (w === 1) throw new Error('destroyed'); sent.push(w) })
    hub.attach('a', 1); hub.attach('a', 2)
    hub.publish('a', 'x')
    expect(sent).toEqual([2])
  })
})
