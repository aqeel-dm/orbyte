import type { SubmittedPlan } from './schemas/plan'

/** Plain-text rendering of a plan, used on the task and inside prompts. */
export function renderPlan(c: SubmittedPlan): string {
  const list = (title: string, items: string[]): string => (items.length ? `\n\n${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : '')
  return `Summary: ${c.summary}\n\nSteps:\n${c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${list('Files', c.files)}${list('Tests', c.tests)}${list('Risks', c.risks)}`
}

/** Text from an agent or a person goes inside a prompt fence: angle brackets are replaced so it cannot close the fence. */
export const defang = (s: string): string => s.replace(/</g, '‹').replace(/>/g, '›')
