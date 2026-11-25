import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { AppError } from '@shared/types/result'
import { log } from '../logging/logger'

export type SignedField = string | number | null

/**
 * Signs the rows that authorize work (approvals, acceptances, change requests) so that editing the database
 * file is not enough to forge one. HMAC-SHA256 over a canonical encoding of the row's fields, under a key that
 * is kept encrypted by the operating system (Electron safeStorage). Limit: a process that can use the same
 * OS-protected key (or that replays an older signed copy of a row) is not stopped. See docs/SECURITY.md.
 */
export interface RowSigner {
  sign(fields: readonly SignedField[]): string
  verify(fields: readonly SignedField[], signature: string | null): boolean
}

const encode = (fields: readonly SignedField[]) => JSON.stringify(fields)

export class HmacRowSigner implements RowSigner {
  constructor(private readonly key: Buffer) {
    if (key.length < 32) throw new Error('signing key too short')
  }
  sign(fields: readonly SignedField[]): string {
    return createHmac('sha256', this.key).update(encode(fields)).digest('hex')
  }
  verify(fields: readonly SignedField[], signature: string | null): boolean {
    if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false
    return timingSafeEqual(Buffer.from(this.sign(fields), 'hex'), Buffer.from(signature, 'hex'))
  }
}

/** A key that lives only in this process's memory: the default for tests. The app always passes its protected key. */
const processKey = randomBytes(32)
export const processSigner = (): RowSigner => new HmacRowSigner(processKey)

/** Used when no protected key can be had: nothing can be signed, nothing verifies, so nothing is authorized. */
export class UnavailableSigner implements RowSigner {
  sign(): string {
    throw new AppError('SIGNING_UNAVAILABLE', "Orbyte cannot protect approvals on this system (no secure key storage), so it will not record them.")
  }
  verify(): boolean {
    return false
  }
}

export interface SecureStore {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/**
 * Loads the signing key from `file` (encrypted with `store`), creating it on first use. Returns an
 * `UnavailableSigner` instead of falling back to plaintext when the OS cannot protect the key.
 */
export function loadRowSigner(file: string, store: SecureStore): RowSigner {
  try {
    if (!store.isEncryptionAvailable()) {
      log.warn('[signing] secure key storage is unavailable: approvals cannot be recorded')
      return new UnavailableSigner()
    }
    if (existsSync(file)) return new HmacRowSigner(Buffer.from(store.decryptString(readFileSync(file)), 'hex'))
    const key = randomBytes(32)
    writeFileSync(file, store.encryptString(key.toString('hex')), { mode: 0o600 })
    chmodSync(file, 0o600)
    return new HmacRowSigner(key)
  } catch (err) {
    log.error('[signing] could not load the signing key', err)
    return new UnavailableSigner()
  }
}
