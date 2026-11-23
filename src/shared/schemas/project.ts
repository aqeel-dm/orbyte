import { z } from 'zod'
import { onboardingDataSchema } from './onboarding'

export const projectStatusSchema = z.enum(['active', 'archived'])
export const repoSettingsTrustSchema = z.enum(['unset', 'trusted', 'untrusted'])
export const onboardingStatusSchema = z.enum(['pending', 'in_progress', 'ready', 'failed'])

export const repoInspectionSchema = z.object({
  isGitRepo: z.boolean(),
  repoRoot: z.string().nullable(),
  defaultBranch: z.string().nullable()
})

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  repoPath: z.string(),
  defaultBranch: z.string().nullable(),
  isGitRepo: z.boolean(),
  status: projectStatusSchema,
  onboardingStatus: onboardingStatusSchema,
  /** Whether the repo's own Claude settings (hooks etc.) may be loaded for the Team Lead. */
  repoSettingsTrust: repoSettingsTrustSchema,
  teamLeadSessionId: z.string().nullable(),
  onboardingData: onboardingDataSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const pickDirectoryResultSchema = z.union([
  z.object({ cancelled: z.literal(true) }),
  z.object({
    cancelled: z.literal(false),
    token: z.string(),
    path: z.string(),
    suggestedName: z.string(),
    inspection: repoInspectionSchema
  })
])

export const registerProjectInputSchema = z.object({
  token: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'Name is required').max(100),
  description: z.string().trim().max(1000).default('')
})

export const setTrustInputSchema = z.object({ id: z.string().min(1).max(64), trust: z.enum(['trusted', 'untrusted']) })
export const projectIdSchema = z.object({ id: z.string().min(1).max(64) })
export const listProjectsInputSchema = z.object({ includeArchived: z.boolean().optional() }).optional()

export type ListProjectsInput = z.infer<typeof listProjectsInputSchema>
export type Project = z.infer<typeof projectSchema>
export type RepoInspection = z.infer<typeof repoInspectionSchema>
export type PickDirectoryResult = z.infer<typeof pickDirectoryResultSchema>
export type RegisterProjectInput = z.input<typeof registerProjectInputSchema>
