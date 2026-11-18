import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ZodError, type ZodType } from 'zod'
import { AppError, fail, ok, type Result } from '@shared/types/result'

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
      const input = schema ? schema.parse(raw) : (undefined as I)
      return ok(await fn(input, event))
    } catch (err) {
      if (err instanceof ZodError) return fail('INVALID_INPUT', err.issues.map((i) => i.message).join('; '))
      if (err instanceof AppError) return fail(err.code, err.message)
      console.error(`[ipc] ${channel} failed`, err)
      return fail('INTERNAL', 'Unexpected error. See the application log.')
    }
  })
}
