import { z } from 'zod'

const fileInfo = z.object({ path: z.string(), bytes: z.number() })

/** Read-only findings about repo-owned instructions. Paths are relative to the repo root. */
export const discoveryResultSchema = z.object({
  claudeMdFiles: z.array(fileInfo),
  claudeDir: z.object({
    exists: z.boolean(),
    rules: z.array(z.string()),
    skills: z.array(z.string()),
    agents: z.array(z.string()),
    settingsFiles: z.array(z.string()),
    hasHooks: z.boolean()
  }),
  hasMcpConfig: z.boolean(),
  docs: z.array(fileInfo),
  truncated: z.boolean()
})

export const onboardingDataSchema = z.object({
  discovery: discoveryResultSchema.optional(),
  /** Team Lead's understanding of the project (stored in Orbyte's DB only). */
  summary: z.string().optional(),
  /** Proposed workflow guidance. Never written into the repository. */
  workflowGuidance: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional()
})

export type DiscoveryResult = z.infer<typeof discoveryResultSchema>
export type OnboardingData = z.infer<typeof onboardingDataSchema>
