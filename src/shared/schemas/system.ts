import { z } from 'zod'

/** One thing Orbyte needs from this computer, with what it found. `detail` is a fixed or version string, never a path. */
export const systemCheckItemSchema = z.object({
  id: z.enum(['git', 'claude', 'secureStorage']),
  ok: z.boolean(),
  detail: z.string(),
  help: z.string().nullable()
})
export const systemCheckSchema = z.object({ items: z.array(systemCheckItemSchema) })

export type SystemCheckItem = z.infer<typeof systemCheckItemSchema>
export type SystemCheck = z.infer<typeof systemCheckSchema>
