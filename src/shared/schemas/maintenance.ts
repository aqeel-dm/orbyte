import { z } from 'zod'

const id = z.string().min(1).max(64)

/** A worktree directory in Orbyte's own directory that no agent record owns. The renderer only ever sees an opaque id. */
export const orphanWorktreeSchema = z.object({ id, projectId: z.string(), projectName: z.string().nullable(), name: z.string() })
export const maintenanceScanSchema = z.object({ orphanWorktrees: z.array(orphanWorktreeSchema) })
export const cleanOrphansInputSchema = z.object({ ids: z.array(id).min(1).max(50) })
export const cleanOrphansResultSchema = z.object({ removed: z.number(), skipped: z.array(z.object({ id, reason: z.string() })) })
export const backupResultSchema = z.object({ saved: z.boolean() })

export type OrphanWorktree = z.infer<typeof orphanWorktreeSchema>
export type MaintenanceScan = z.infer<typeof maintenanceScanSchema>
export type CleanOrphansResult = z.infer<typeof cleanOrphansResultSchema>
export type BackupResult = z.infer<typeof backupResultSchema>
