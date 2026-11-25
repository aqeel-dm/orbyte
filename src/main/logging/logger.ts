import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Secrets must never reach a log file: API keys, bearer tokens and KEY/TOKEN/SECRET assignments. The home directory is shortened. */
const HOME = ((): string => { try { return homedir() } catch { return '' } })()

export function redact(text: string, home: string = HOME): string {
  let out = text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]')
    // common token shapes: GitHub, generic sk-, AWS access key ids, JWTs
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, '[redacted-token]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]')
    // NAME=value, name: value, "name":"value" for secret-looking names, any case
    .replace(/((?:[\w-]*(?:api[_-]?key|token|secret|passw(?:or)?d|authorization|credential)[\w-]*)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-?key|token|secret|password)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
  if (home.length > 1) out = out.split(home).join('~')
  return out
}

const MAX_LINE = 8 * 1024

/** One log entry, safe to append: control characters (ANSI escapes, carriage returns) are escaped, continuation lines are indented so text cannot forge a new entry, and the size is capped. */
function format(args: unknown[]): string {
  const text = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}` : inspect(a, { depth: 4, breakLength: 120 })))
    .join(' ')
  const safe = text
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/\n/g, '\n  ')
  return safe.length > MAX_LINE ? `${safe.slice(0, MAX_LINE)} [truncated ${safe.length - MAX_LINE} characters]` : safe
}

const toConsole = (level: LogLevel, line: string): void => {
  try {
    ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line)
  } catch {
    // a closed stdout (EPIPE) must not turn into another error
  }
}

export interface LoggerOptions {
  /** Rotate when the active file exceeds this many bytes. */
  maxBytes?: number
  /** Rotated files kept besides the active one. */
  keep?: number
  /** Also print to the console (development and tests). */
  mirror?: boolean
  level?: LogLevel
}

/**
 * A small file logger: levels, redaction, size-based rotation. Logs live in main only; nothing is sent to the
 * renderer. It never throws (a broken log must not break the app). Before `initLogging`, messages go to the console.
 */
export class FileLogger {
  private readonly file: string
  private readonly maxBytes: number
  private readonly keep: number
  private readonly mirror: boolean
  private readonly min: number
  private size = 0

  constructor(private readonly dir: string, opts: LoggerOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
    this.keep = opts.keep ?? 3
    this.mirror = opts.mirror ?? true
    this.min = RANK[opts.level ?? 'info']
    this.file = join(dir, 'orbyte.log')
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      this.size = statSync(this.file).size
    } catch {
      this.size = 0
    }
  }

  get path(): string {
    return this.file
  }

  write(level: LogLevel, args: unknown[]): void {
    try {
      if (RANK[level] < this.min) return
      const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(format(args))}\n`
      const bytes = Buffer.byteLength(line)
      try {
        if (this.size + bytes > this.maxBytes) this.rotate()
        appendFileSync(this.file, line, { mode: 0o600 })
        this.size += bytes
      } catch {
        // a broken log file must not break the app
      }
      if (this.mirror) toConsole(level, line.trimEnd())
    } catch {
      // never throw from logging (custom inspect functions and getters can throw too)
    }
  }

  private rotate(): void {
    for (let i = this.keep; i >= 1; i--) {
      const from = i === 1 ? this.file : join(this.dir, `orbyte.${i - 1}.log`)
      const to = join(this.dir, `orbyte.${i}.log`)
      try {
        if (i === this.keep) rmSync(to, { force: true })
        renameSync(from, to)
      } catch {
        // a missing file in the chain is fine
      }
    }
    this.size = 0
  }
}

let active: FileLogger | null = null

export function initLogging(dir: string, opts?: LoggerOptions): FileLogger {
  active = new FileLogger(dir, opts)
  return active
}

const emit = (level: LogLevel, args: unknown[]): void => {
  try {
    if (active) return active.write(level, args)
    toConsole(level, redact(format(args)))
  } catch {
    // never throw from logging
  }
}

/** The application logger. Use instead of `console` in main. */
export const log = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args)
}
