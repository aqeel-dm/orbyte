import { createHash } from 'node:crypto'
import type { SubmittedPlan } from '@shared/schemas/plan'

/** The exact content an approval covers, in a fixed key order so the same plan always hashes the same. */
export function canonicalPlan(c: SubmittedPlan): string {
  return JSON.stringify({ summary: c.summary, steps: c.steps, files: c.files, tests: c.tests, risks: c.risks })
}

export const planHash = (c: SubmittedPlan): string => createHash('sha256').update(canonicalPlan(c)).digest('hex')

export { renderPlan } from '@shared/plan-text'
