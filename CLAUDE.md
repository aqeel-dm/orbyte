# Orbyte

Local-first Electron desktop app that will coordinate multiple Claude Code developer agents across software projects. Single user, no remote infrastructure (no Docker, Redis, Postgres or HTTP backend).

Stack: Electron, React 19 + TypeScript (strict) + Vite (electron-vite), Tailwind v4 + shadcn-style components, SQLite (better-sqlite3) + Drizzle, Zod, Vitest. Planned and not installed: Claude Agent SDK, node-pty, xterm.js, Playwright.

## Status

**Phase 1 is complete.** Implemented: secure Electron shell, typed IPC, SQLite + migrations, dashboard, project registration (pick directory, name it, persist, list, remove).

Everything else (Team Leads, onboarding, tasks, agents, terminals, approvals, orchestration) is **not built**. Phase 2 (project workspace, onboarding, Team Lead chat) is next but **must not start without explicit user authorization**. Do not implement future phases, add their dependencies or tables, or describe them as existing. Details: @docs/ROADMAP.md

## Commands

```
pnpm dev           # run the app
pnpm build         # production build to out/
pnpm typecheck     # tsc, node + web configs
pnpm test          # Vitest under Electron's Node ABI (do NOT run vitest directly)
pnpm db:generate   # create a migration after editing schema.ts
```

There is no linter or formatter. Before saying work is done, run `pnpm typecheck` and `pnpm test` (and `pnpm build` if you touched build config, preload or renderer) and report the actual results. `pnpm install` rebuilds better-sqlite3 for Electron via `postinstall`.

## Layout

- `src/main/`: backend. `app/` (window), `ipc/` (`handle.ts` wrapper + thin handlers), `modules/projects/` (repository + service), `modules/git/` (read-only inspect), `database/` (schema, client)
- `src/preload/index.ts`: the only bridge, exposes `window.orbyte`
- `src/renderer/`: React UI (`pages/`, `features/`, `components/ui/`, `hooks/`, `layouts/`, `lib/`)
- `src/shared/`: Zod schemas, types, IPC channel map (the contract; imports nothing from other layers)
- `drizzle/`: generated SQL migrations. `tests/`: Vitest specs. `docs/`: project documentation.

## Principles that must hold

1. **Human authorization.** The user decides WHAT is built; a Team Lead decides HOW. Team Leads must not create unrequested tasks or start work on their own.
2. **Backend-enforced approval.** Developer agents cannot execute without a stored approval record verified by the orchestrator. Prompts and permission modes are not enforcement. (Planned, Phase 5; nothing enforces it yet.)
3. **Electron security.** Main owns privileged work. The renderer has no Node access. All IPC is typed and Zod-validated. Secrets never reach the renderer. See @.claude/rules/electron-security.md
4. **Developer isolation.** Each developer agent gets its own git worktree/working directory; project boundaries are checked. (Planned, Phase 4.)
5. **Incremental phases.** App stays runnable after every phase; no unnecessary dependencies or abstractions.
6. **Honesty.** Never fake agent, terminal, test or approval results. Mark planned work as Planned.

## Rules and docs

Rules in `.claude/rules/`: `architecture.md`, `electron-security.md` (path-scoped), `typescript.md` (path-scoped), `database.md` (path-scoped), `testing.md` (path-scoped), `git-workflow.md`.

Docs (read the relevant one before changing that area, and update it when behavior changes):
- `docs/ARCHITECTURE.md`: layers, data flow, decisions
- `docs/DATABASE.md`: tables, migrations, limitations
- `docs/IPC-CONTRACTS.md`: channels, schemas, error codes, how to add a channel
- `docs/SECURITY.md`: code-enforced protections vs known gaps
- `docs/DEVELOPMENT.md`: setup, native modules, tests
- `docs/ROADMAP.md`: the seven phases and status

## Reviewers

Read-only agents in `.claude/agents/` (Read, Grep, Glob only): `architecture-reviewer`, `code-reviewer`, `security-reviewer`. Skills in `.claude/skills/`: `orbyte-architecture-review`, `orbyte-security-review`, `orbyte-phase-verify`. Reviewers report; they do not fix.

## Gotchas

- better-sqlite3 is built for Electron's ABI. Plain Node cannot load it. Use `pnpm test`.
- TypeScript 7: no `baseUrl`; aliases (`@shared/*`, `@/*`) are relative `paths`, mirrored in the Vite and Vitest configs.
- Main is CommonJS and the sandboxed preload is one CJS file (`out/preload/index.cjs`). Do not add `"type": "module"`.
- The renderer never passes filesystem paths. Directories are picked in main and registered by single-use token.
- Known unfixed gaps (see `docs/SECURITY.md`): no IPC sender check, loose CSP in prod, project removal cascades the audit trail, `updated_at` not maintained.
