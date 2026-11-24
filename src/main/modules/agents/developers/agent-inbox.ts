import { chmod, lstat, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { progressNoteSchema, submittedResultSchema, type SubmittedResult } from '@shared/schemas/execution'
import { submittedPlanSchema, type SubmittedPlan } from '@shared/schemas/plan'

const MAX_FILE_BYTES = 256 * 1024
const ID = /^[0-9a-f-]{36}$/
/** A flood of submissions in one drain is cut off per kind; the rest are discarded. */
const MAX_FILES_PER_KIND = 10

const FILE_NAME = /^(plan|progress|result)-(\d+)-[\w-]+\.json$/
const schemas = {
  plan: z.object({ plan: submittedPlanSchema }),
  progress: z.object({ progress: progressNoteSchema }),
  result: z.object({ result: submittedResultSchema })
}

export interface Drained {
  plans: SubmittedPlan[]
  progress: string[]
  results: SubmittedResult[]
  rejected: number
}

/**
 * One private directory per agent (mode 700). The agent MCP server drops plan, progress and result
 * files there and Orbyte drains them. Anything that is not a small regular file with valid content is
 * discarded, and symlinks are never followed.
 */
export class AgentInbox {
  constructor(private readonly root: string) {}

  dirFor(agentId: string): string {
    if (!ID.test(agentId)) throw new Error('invalid agent id')
    return join(this.root, agentId)
  }

  async prepare(agentId: string): Promise<string> {
    const dir = this.dirFor(agentId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700) // mkdir's mode is subject to umask and ignored for an existing directory
    return dir
  }

  /** Removes an agent's inbox directory (best effort). */
  async remove(agentId: string): Promise<void> {
    await rm(this.dirFor(agentId), { recursive: true, force: true }).catch(() => undefined)
  }

  /** Reads and removes every submitted file, oldest first within each kind. Invalid files are removed and counted. */
  async drain(agentId: string): Promise<Drained> {
    const dir = this.dirFor(agentId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return { plans: [], progress: [], results: [], rejected: 0 }
    }
    const byKind: Record<'plan' | 'progress' | 'result', { name: string; at: number }[]> = { plan: [], progress: [], result: [] }
    for (const name of names) {
      const m = FILE_NAME.exec(name)
      if (m) byKind[m[1] as 'plan' | 'progress' | 'result'].push({ name, at: Number(m[2]) })
    }
    const out: Drained = { plans: [], progress: [], results: [], rejected: 0 }
    for (const kind of ['plan', 'progress', 'result'] as const) {
      const files = byKind[kind].sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
      for (const extra of files.slice(MAX_FILES_PER_KIND)) {
        out.rejected++
        await unlink(join(dir, extra.name)).catch(() => undefined)
      }
      for (const { name } of files.slice(0, MAX_FILES_PER_KIND)) {
        const path = join(dir, name)
        try {
          const st = await lstat(path) // lstat: a symlink is never followed
          if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('not an acceptable file')
          const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
          const parsed = schemas[kind].safeParse(raw)
          if (!parsed.success) throw new Error('invalid content')
          if (kind === 'plan') out.plans.push((parsed.data as z.infer<typeof schemas.plan>).plan)
          else if (kind === 'progress') out.progress.push((parsed.data as z.infer<typeof schemas.progress>).progress.message)
          else out.results.push((parsed.data as z.infer<typeof schemas.result>).result)
        } catch {
          out.rejected++
        } finally {
          await unlink(path).catch(() => undefined)
        }
      }
    }
    return out
  }
}
