import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from '../../../logging/logger'

const run = promisify(execFile)
const UUID = /^[0-9a-f-]{36}$/

export type ReapResult = 'killed' | 'not_found' | 'mismatch' | 'invalid'

/** Ends an agent process left behind by a crash of the previous Orbyte run. */
export interface AgentProcessReaper {
  reap(pid: number, sessionId: string): Promise<ReapResult>
}

export interface ReaperDeps {
  /** The command line of a pid, or null if there is no such process. */
  commandOf?: (pid: number) => Promise<string | null>
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  sleep?: (ms: number) => Promise<void>
  graceMs?: number
}

const defaultCommandOf = async (pid: number): Promise<string | null> => {
  try {
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * After a crash a pid number may belong to an unrelated process by now, so a process is only
 * signalled if its command line still carries this agent's exact `--session-id`. Fixed
 * arguments, no shell.
 */
export function createProcessReaper(deps: ReaperDeps = {}): AgentProcessReaper {
  const commandOf = deps.commandOf ?? defaultCommandOf
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const graceMs = deps.graceMs ?? 3000
  const alive = (pid: number): boolean => {
    try {
      kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  return {
    async reap(pid, sessionId) {
      if (!Number.isInteger(pid) || pid <= 1 || !UUID.test(sessionId)) return 'invalid'
      const command = await commandOf(pid)
      if (command === null) return 'not_found'
      const isOurs = (c: string): boolean => /^(?:\S*\/)?claude(?:\s|$)/.test(c) && c.includes(`--session-id ${sessionId}`)
      if (!isOurs(command)) return 'mismatch'
      try {
        kill(pid, 'SIGTERM')
        const deadline = Date.now() + graceMs
        while (alive(pid) && Date.now() < deadline) await sleep(100)
        // The pid could have died and been reused during the wait: verify again before the hard kill.
        if (alive(pid)) {
          const again = await commandOf(pid)
          if (again !== null && isOurs(again)) kill(pid, 'SIGKILL')
        }
      } catch (err) {
        log.error('[agents] could not stop an orphaned agent process', err)
      }
      return 'killed'
    }
  }
}
