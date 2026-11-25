import { describe, expect, it } from 'vitest'
import { buildMergeGuidance, shellQuote } from '@shared/merge-guidance'

describe('merge guidance', () => {
  it('quotes every interpolated value', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
    const steps = buildMergeGuidance({ repoPath: "/r/it's", worktreePath: '/w/x y', branch: 'orbyte/a;rm -rf ~', baseBranch: 'main' })
    expect(steps).toHaveLength(3)
    expect(steps[0]?.command).toContain("'/w/x y'")
    expect(steps[2]?.command).toContain("'orbyte/a;rm -rf ~'")
    expect(steps[2]?.command).toContain(`'/r/it'\\''s'`)
  })
  it('names the base branch in the merge step', () => {
    const steps = buildMergeGuidance({ repoPath: '/r', worktreePath: '/w', branch: 'b', baseBranch: 'develop' })
    expect(steps[2]?.title).toContain('develop')
  })
})
