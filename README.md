# Orbyte

Local-first desktop command center for coordinating Claude Code agents across projects.
Electron + React + TypeScript + SQLite (Drizzle). Full product spec lives in the original brief; this repo is built in phases.

See `CLAUDE.md` and `docs/` for architecture, security, IPC, database and roadmap documentation.

## Develop
```
pnpm install      # also rebuilds better-sqlite3 for Electron (postinstall)
pnpm dev          # run the app
pnpm test         # vitest, run under Electron's Node ABI so native modules match
pnpm typecheck
pnpm build
pnpm db:generate  # after editing src/main/database/schema.ts; commit the generated drizzle/ SQL
```

## Architecture
- `src/main`: privileged backend (DB, git, filesystem, IPC). `modules/*` hold business logic; `ipc/*` handlers stay thin.
- `src/preload`: the only bridge; exposes `window.orbyte` (typed in `src/shared/types/api.ts`). `ipcRenderer` is never exposed.
- `src/renderer`: React UI with no Node access (contextIsolation, sandbox, CSP).
- `src/shared`: Zod schemas, types, and the IPC channel map.
- The renderer never supplies filesystem paths: a directory is picked in the main process and registered via a single-use token.

## Checklist
- [x] Phase 1: secure shell, typed IPC, SQLite+migrations, dashboard, project registration and persistence
- [ ] Phase 2: project workspace, onboarding, Team Lead (Agent SDK) chat
- [ ] Phase 3: tasks and orchestration
- [ ] Phase 4: developer agents (node-pty, worktrees, xterm)
- [ ] Phase 5: planning and approval gate
- [ ] Phase 6: execution and review
- [x] Phase 7: reliability; packaging builds unsigned macOS releases from `main` (signing and Fuses still planned) 
