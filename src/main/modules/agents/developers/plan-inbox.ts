import { chmod, lstat, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { submittedPlanSchema, type SubmittedPlan } from '@shared/schemas/plan'

const MAX_PLAN_FILE_BYTES = 256 * 1024
/** A flood of submissions in one drain is cut off; the rest are discarded. */
const MAX_FILES_PER_DRAIN = 10
const ID = /^[0-9a-f-]{36}$/
const fileSchema = z.object({ plan: submittedPlanSchema })

/**
 * One private directory per agent (mode 700). The submit_plan MCP server drops plan files there and
 * Orbyte drains them. Anything that is not a small regular file with a valid plan is discarded.
 */
export class PlanInbox {
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

  /** Reads and removes every submitted plan, oldest first. Invalid files are removed and counted. */
  async drain(agentId: string): Promise<{ plans: SubmittedPlan[]; rejected: number }> {
    const dir = this.dirFor(agentId)
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => /^plan-[\w-]+\.json$/.test(n)).sort()
    } catch {
      return { plans: [], rejected: 0 }
    }
    const plans: SubmittedPlan[] = []
    let rejected = 0
    for (const name of names.slice(MAX_FILES_PER_DRAIN)) {
      rejected++
      await unlink(join(dir, name)).catch(() => undefined)
    }
    for (const name of names.slice(0, MAX_FILES_PER_DRAIN)) {
      const path = join(dir, name)
      try {
        const st = await lstat(path) // lstat: a symlink is never followed
        if (!st.isFile() || st.size > MAX_PLAN_FILE_BYTES) throw new Error('not an acceptable plan file')
        const parsed = fileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
        if (!parsed.success) throw new Error('invalid plan')
        plans.push(parsed.data.plan)
      } catch {
        rejected++
      } finally {
        await unlink(path).catch(() => undefined)
      }
    }
    return { plans, rejected }
  }
}
