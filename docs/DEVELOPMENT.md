# Development

Requires Node (developed on 24), pnpm, git. macOS is the tested platform.

## Commands
| Command | Does |
|---|---|
| `pnpm install` | Installs and, via `postinstall`, rebuilds better-sqlite3 for Electron |
| `pnpm dev` | electron-vite dev server and app |
| `pnpm build` | Production build to `out/` |
| `pnpm typecheck` | `tsc` for node (`tsconfig.node.json`) and web (`tsconfig.web.json`) |
| `pnpm test` | Vitest under `ELECTRON_RUN_AS_NODE=1 electron` |
| `pnpm db:generate` | Generate a migration from `schema.ts` |
| `pnpm rebuild` | Re-run electron-rebuild for better-sqlite3 |

There is no lint or format script.

## Native modules
better-sqlite3 is compiled for Electron's ABI. Plain Node (`vitest` directly) would fail to load it, so tests use `pnpm test`. pnpm blocks install scripts by default; `pnpm-workspace.yaml` allows better-sqlite3, electron and esbuild. If the Electron binary is missing after install, run `pnpm rebuild electron`. `node-pty` (Phase 4) will need the same rebuild plus `asarUnpack` when packaging.

## Tests
Specs are in `tests/` (`projects`, `git-inspect`, `persistence`). They use real migrations on in-memory or temp-file SQLite and real temp directories. No UI or Electron-window tests exist yet (Playwright is not installed).

## Config notes
- TypeScript 7: `baseUrl` is removed; aliases use relative `paths` (`@shared/*`, `@/*` for renderer).
- Aliases are mirrored in `electron.vite.config.ts` and `vitest.config.ts`.
- Renderer entry is `src/renderer/index.html`; theme tokens are in `src/renderer/styles.css`.
- shadcn components are hand-written in `src/renderer/components/ui/` (`components.json` is present for the CLI).

## Running the app headlessly for checks
`electron . --remote-debugging-port=9333` after `pnpm build`, then inspect over the DevTools protocol (this was how the renderer isolation was verified).
