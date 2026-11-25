/**
 * Commands a person can run to bring an accepted agent's work into their own branch.
 * Orbyte never runs these: it does not commit or merge in a registered repository.
 * Every value is single-quoted so a path or branch name cannot add shell syntax.
 */
export interface MergeGuidanceInput {
  repoPath: string
  worktreePath: string
  branch: string
  baseBranch: string
}

export interface MergeStep {
  title: string
  command: string
}

/** POSIX single-quote escaping. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildMergeGuidance(input: MergeGuidanceInput): MergeStep[] {
  const wt = shellQuote(input.worktreePath)
  const repo = shellQuote(input.repoPath)
  return [
    { title: 'Look at what changed in the agent\'s worktree', command: `git -C ${wt} status && git -C ${wt} diff HEAD` },
    { title: 'Commit it (the agent does not commit; this opens your editor for the message)', command: `git -C ${wt} add -A && git -C ${wt} commit` },
    { title: `Merge the branch into ${input.baseBranch}`, command: `git -C ${repo} switch ${shellQuote(input.baseBranch)} && git -C ${repo} merge --no-ff ${shellQuote(input.branch)}` }
  ]
}
