import type { PtyFactory } from './agent-service'

/**
 * Real PTYs through node-pty (a native module rebuilt for Electron by `pnpm rebuild`).
 * It is loaded lazily so tests and code paths that never spawn do not need the binary.
 */
export function createNodePtyFactory(): PtyFactory {
  return {
    spawn(file, args, opts) {
      const nodePty = require('node-pty') as typeof import('node-pty')
      const p = nodePty.spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env })
      return {
        pid: p.pid,
        onData: (cb) => void p.onData(cb),
        onExit: (cb) => void p.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal })),
        write: (d) => p.write(d),
        resize: (c, r) => p.resize(c, r),
        kill: (s) => p.kill(s)
      }
    }
  }
}
