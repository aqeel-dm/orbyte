import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

// Production CSP is strict. The dev server needs inline scripts (React refresh preamble) and websockets.
const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'"
const csp = {
  name: 'orbyte-csp',
  transformIndexHtml: (html: string, ctx: { server?: unknown }) => html.replace('__CSP__', ctx.server ? CSP_DEV : CSP_PROD)
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    // plan-server is a second entry: Claude Code starts it as a child process (see src/main/agent-mcp).
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), 'plan-server': resolve(__dirname, 'src/main/agent-mcp/plan-server.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preloads must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwind(), csp],
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer'), '@shared': shared } },
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } }
  }
})
