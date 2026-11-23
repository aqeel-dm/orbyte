import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverProject } from '../src/main/modules/projects/discovery'
import { tempDir } from './helpers'

const write = (root: string, rel: string, body = 'x') => {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

describe('discoverProject', () => {
  it('finds root and nested CLAUDE.md, .claude contents, docs and .mcp.json', async () => {
    const root = tempDir()
    write(root, 'CLAUDE.md', '# hi')
    write(root, 'packages/app/CLAUDE.md')
    write(root, 'README.md')
    write(root, 'docs/ARCHITECTURE.md')
    write(root, '.claude/rules/a.md')
    write(root, '.claude/skills/s1/SKILL.md')
    write(root, '.claude/agents/ag.md')
    write(root, '.claude/settings.json', JSON.stringify({ hooks: {} }))
    write(root, '.mcp.json', '{}')
    const d = await discoverProject(root)
    expect(d.claudeMdFiles.map((f) => f.path).sort()).toEqual(['CLAUDE.md', 'packages/app/CLAUDE.md'])
    expect(d.claudeDir).toMatchObject({ exists: true, rules: ['a.md'], skills: ['s1'], agents: ['ag.md'], hasHooks: true })
    expect(d.hasMcpConfig).toBe(true)
    expect(d.docs.map((f) => f.path).sort()).toEqual(['README.md', 'docs/ARCHITECTURE.md'])
  })

  it('reports hooks only when a settings file has a hooks key, and handles invalid JSON', async () => {
    const root = tempDir()
    write(root, '.claude/settings.json', '{ not json')
    expect((await discoverProject(root)).claudeDir.hasHooks).toBe(false)
    write(root, '.claude/settings.local.json', JSON.stringify({ permissions: {} }))
    expect((await discoverProject(root)).claudeDir.hasHooks).toBe(false)
  })

  it('skips node_modules/.git, respects depth, and never follows symlinks out of the repo', async () => {
    const outside = tempDir('orbyte-outside-')
    write(outside, 'CLAUDE.md', 'secret')
    write(outside, 'docs/SECRET.md')
    const root = tempDir()
    write(root, 'node_modules/pkg/CLAUDE.md')
    write(root, 'a/b/c/d/e/CLAUDE.md') // deeper than MAX_DEPTH
    symlinkSync(outside, join(root, 'linkdir'))
    symlinkSync(join(outside, 'CLAUDE.md'), join(root, 'CLAUDE.md'))
    symlinkSync(join(outside, 'docs'), join(root, 'docs'))
    symlinkSync(outside, join(root, '.claude'))
    const d = await discoverProject(root)
    expect(d.claudeMdFiles).toEqual([])
    expect(d.docs).toEqual([])
    expect(d.claudeDir.exists).toBe(false)
  })

  it('is bounded and flags truncation', async () => {
    const root = tempDir()
    for (let i = 0; i < 30; i++) write(root, `m${i}/CLAUDE.md`)
    const d = await discoverProject(root)
    expect(d.claudeMdFiles.length).toBe(25)
    expect(d.truncated).toBe(true)
  })

  it('does not modify the repository', async () => {
    const root = tempDir()
    write(root, 'CLAUDE.md')
    const { readdirSync } = await import('node:fs')
    const before = readdirSync(root).join()
    await discoverProject(root)
    expect(readdirSync(root).join()).toBe(before)
  })
})
