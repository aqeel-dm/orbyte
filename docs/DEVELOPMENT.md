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
better-sqlite3 is compiled for Electron's ABI. Plain Node (`vitest` directly) would fail to load it, so tests use `pnpm test`. pnpm blocks install scripts by default; `pnpm-workspace.yaml` allows better-sqlite3, electron and esbuild. If the Electron binary is missing after install, run `pnpm rebuild electron`. `node-pty` is rebuilt for Electron by the same `postinstall`/`pnpm rebuild` (`electron-rebuild -w better-sqlite3,node-pty`) and is allowed in `pnpm-workspace.yaml`; packaging will need `asarUnpack` for it and for the Agent SDK's native binary (Phase 7). The `claude` CLI is found on PATH or in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`.

## Tests
Specs are in `tests/` (projects, git-inspect, persistence, repository, discovery, navigation-policy, team-lead-core, team-lead-service, onboarding). The Team Lead service and onboarding tests use a fake `TeamLeadRunner` with SDK-shaped messages (`sdk.*` helpers in `tests/helpers.ts`); the real SDK is never called from automated tests. They use real migrations on in-memory or temp-file SQLite and real temp directories. No UI or Electron-window tests exist yet (Playwright is not installed).

## Config notes
- TypeScript 7: `baseUrl` is removed; aliases use relative `paths` (`@shared/*`, `@/*` for renderer).
- Aliases are mirrored in `electron.vite.config.ts` and `vitest.config.ts`.
- Renderer entry is `src/renderer/index.html`; theme tokens are in `src/renderer/styles.css`.
- shadcn components are hand-written in `src/renderer/components/ui/` (`components.json` is present for the CLI).

## End-to-end check with the real SDK
Needs a working Claude Code login (uses your subscription tokens). The native folder dialog cannot be driven over the DevTools protocol, so seed a project row instead:
1. `pnpm build`, then launch once with a throwaway directory so migrations run: `electron . --user-data-dir=/tmp/orbyte-e2e` (then quit).
2. Insert a project row with `ELECTRON_RUN_AS_NODE=1 electron seed.cjs` (better-sqlite3 must load under Electron's ABI): `insert into projects (id,name,repo_path,is_git_repo) values (...)` using a repo path you trust.
3. Relaunch with `--remote-debugging-port=9333` and drive `window.orbyte.*` over the DevTools protocol: `onboarding.start`, `teamLead.send`, `onEvent`.
Check that an edit request is refused and `git status` of the repo stays clean.

## The submit_plan server
Claude Code starts `out/main/plan-server.js` (a second electron-vite entry) as an MCP server for each planning agent, using the Electron binary with `ELECTRON_RUN_AS_NODE=1`. `pnpm build` produces it, and it resolves `@modelcontextprotocol/sdk` and its shared chunk from `out/main` and `node_modules`. You can smoke-test it by speaking MCP over stdio: `ELECTRON_RUN_AS_NODE=1 ORBYTE_PLAN_INBOX=/tmp/inbox electron out/main/plan-server.js`, then `initialize`, `tools/list` and a `tools/call` of `submit_plan`; a validated plan file appears in the inbox.

## End-to-end check of developer agents
Uses the real `claude` CLI (and your usage). Use a **scratch git repository with one commit**, not a real project: agents add branches and worktrees to the repository they work on.
1. Build, launch once with `--user-data-dir=<tmp>` so migrations run, then insert a project row for the scratch repo (`repo_settings_trust` = `untrusted` or `trusted`) with `ELECTRON_RUN_AS_NODE=1 electron seed.cjs`.
2. Relaunch with `--remote-debugging-port=9333`; drive `window.orbyte.tasks` and `window.orbyte.agents` over the DevTools protocol; answer Claude's folder-trust prompt, if shown, with `agents.write` (arrow down, then Enter; the default is "No, exit").
3. To test a crash, `kill -9` the **Electron main process**, not the `pnpm`/Node wrapper above it (`ps -axo pid,ppid,command` shows the chain), then relaunch on the same directory.

## Running the app headlessly for checks
`electron . --remote-debugging-port=9333` after `pnpm build`, then inspect over the DevTools protocol (this was how the renderer isolation was verified).
