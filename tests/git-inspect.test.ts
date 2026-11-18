import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { inspectRepository } from '../src/main/modules/git/inspect'
import { tempDir } from './helpers'

describe('inspectRepository', () => {
  it('detects a git repo and its branch without modifying it', async () => {
    const dir = tempDir()
    execFileSync('git', ['init', '-b', 'trunk', dir])
    const res = await inspectRepository(dir)
    expect(res.isGitRepo).toBe(true)
    expect(res.defaultBranch).toBe('trunk')
  })

  it('reports a plain directory as not a repo and does not run git init', async () => {
    const dir = tempDir()
    expect(await inspectRepository(dir)).toEqual({ isGitRepo: false, repoRoot: null, defaultBranch: null })
    expect(() => execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'pipe' })).toThrow()
  })
})
