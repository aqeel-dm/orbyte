export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export const ok = <T>(data: T): Result<T> => ({ ok: true, data })
export const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } })

/** Error with a stable code that is safe to show the user. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}
