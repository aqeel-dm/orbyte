import { z } from 'zod'

/** What the update check knows. `url` is always a GitHub release page chosen by main, never renderer input. */
export const updateStatusSchema = z.object({
  current: z.string(),
  /** False for a development run: the check is skipped there. */
  packaged: z.boolean(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  checkedAt: z.string().nullable(),
  /** A fixed message, or null. */
  error: z.string().nullable()
})
export type UpdateStatus = z.infer<typeof updateStatusSchema>
