import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ZodError, type ZodType } from 'zod'
import { AppError, fail, ok, type Result } from '@shared/types/result'
import { isTrustedFrame } from '../app/navigation-policy'
import { log } from '../logging/logger'

let appEntryUrl: string | null = null

/** Must be called before handlers are used. Until then every call is rejected (fail closed). */
export function setTrustedAppEntry(url: string): void {
  appEntryUrl = url
}

export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return isTrustedFrame(event.senderFrame, appEntryUrl)
}

/**
 * Registers a validated, error-safe IPC handler. Input is parsed with Zod and
 * every outcome is returned as a Result; raw exceptions never cross the bridge.
 */
export function handle<I, O>(
  channel: string,
  schema: ZodType<I> | null,
  fn: (input: I, event: IpcMainInvokeEvent) => Promise<O> | O
): void {
  ipcMain.handle(channel, async (event, raw): Promise<Result<O>> => {
    try {
      if (!isTrustedSender(event)) return fail('FORBIDDEN', 'IPC call from an untrusted frame was rejected.')
      const input = schema ? schema.parse(raw) : (undefined as I)
      return ok(await fn(input, event))
    } catch (err) {
      if (err instanceof ZodError) return fail('INVALID_INPUT', err.issues.map((i) => i.message).join('; '))
      if (err instanceof AppError) return fail(err.code, err.message)
      log.error(`[ipc] ${channel} failed`, err)
      return fail('INTERNAL', 'Unexpected error. See the application log.')
    }
  })
}
