import { createHash } from 'node:crypto'
import type { SubmittedPlan } from '@shared/schemas/plan'

/** The exact content an approval covers, in a fixed key order so the same plan always hashes the same. */
export function canonicalPlan(c: SubmittedPlan): string {
  return JSON.stringify({ summary: c.summary, steps: c.steps, files: c.files, tests: c.tests, risks: c.risks })
}

export const planHash = (c: SubmittedPlan): string => createHash('sha256').update(canonicalPlan(c)).digest('hex')

/** Plain-text rendering, kept on the task for quick reference. */
export function renderPlan(c: SubmittedPlan): string {
  const list = (title: string, items: string[]): string => (items.length ? `\n\n${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : '')
  return `Summary: ${c.summary}\n\nSteps:\n${c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${list('Files', c.files)}${list('Tests', c.tests)}${list('Risks', c.risks)}`
}
