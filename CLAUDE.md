# Orbyte

Local-first Electron desktop app that will coordinate multiple Claude Code developer agents across software projects. Single user, no remote infrastructure (no Docker, Redis, Postgres or HTTP backend).

Stack: Electron, React 19 + TypeScript (strict) + Vite (electron-vite), Tailwind v4 + shadcn-style components, SQLite (better-sqlite3) + Drizzle, Zod, Vitest. Claude Agent SDK is installed (Team Lead only). node-pty and xterm.js are installed (developer agents). Planned and not installed: Playwright.

## Status

**Phases 1-7 are implemented, except packaging**. Implemented: secure Electron shell, typed IPC with sender check, SQLite + migrations, dashboard, project registration, archive/restore, project page, onboarding (read-only discovery + Team Lead summary), a read-only Team Lead chat on the Claude Agent SDK with streaming, persisted history and session resume, a task backlog with dependencies, a validated state machine and Team Lead task proposals that only the user can approve, developer agents (real `claude` CLI in a PTY, one git worktree per agent, xterm terminal, planning stage only), and plans: agents submit a plan through Orbyte's `submit_plan` tool, the Team Lead reviews it as advice, and only your approval creates the record the execution gate checks.

and execution and review (Phase 6): `executions:start` runs the approval gate, an execution agent implements the approved plan in the same worktree, its report is a claim, Orbyte collects git evidence itself, the Team Lead reviews the result as advice, and only your acceptance of a reviewed, unchanged result completes the task (revisions via single-use change requests). Phase 7 added a redacting file logger (`src/main/logging/logger.ts`, use `log` not `console` in main), a startup recovery sweep, orphan worktree cleanup, database backup (`modules/maintenance/`) and closed two Phase 6 gaps. Not built: packaging (`asarUnpack`, Fuses, signing), deferred by decision: do not describe it as existing. Do not implement future phases, add their dependencies or tables, or describe them as existing. Details: @docs/ROADMAP.md

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

- `src/main/`: backend. `app/` (window), `ipc/` (`handle.ts` wrapper + thin handlers), `modules/projects/` (repository, service, discovery, onboarding), `modules/tasks/` (state, dependencies), `modules/orchestration/` (task proposals; plans, reviews, approvals and the execution gate), `agent-mcp/` (the `submit_plan` server), `modules/agents/team-lead/` (read-only SDK session + task tools), `modules/agents/developers/` (agents, worktrees, PTY), `modules/git/` (read-only inspect), `modules/maintenance/` (startup sweep, orphans, backup), `security/` (row signer), `logging/` (logger), `notifications/` (decision notifier), `database/` (schema, client)
- `src/preload/index.ts`: the only bridge, exposes `window.orbyte`
- `src/renderer/`: React UI (`pages/`, `features/`, `components/ui/`, `hooks/`, `layouts/`, `lib/`)
- `src/shared/`: Zod schemas, types, IPC channel map (the contract; imports nothing from other layers)
- `drizzle/`: generated SQL migrations. `tests/`: Vitest specs. `docs/`: project documentation.

## Principles that must hold

1. **Human authorization.** The user decides WHAT is built; a Team Lead decides HOW. Team Leads must not create unrequested tasks or start work on their own.
2. **Backend-enforced approval.** Developer agents cannot execute without a stored approval record verified by the orchestrator. Prompts and permission modes are not enforcement. (Implemented, Phases 5-6.)
3. **Electron security.** Main owns privileged work. The renderer has no Node access. All IPC is typed and Zod-validated. Secrets never reach the renderer. See @.claude/rules/electron-security.md
4. **Developer isolation.** Each developer agent gets its own git worktree/working directory; project boundaries are checked. (Implemented, Phase 4.)
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
- `docs/REQUIREMENTS.md`: what the app must do (from the original brief and your decisions) and whether each requirement is met
- `docs/ROADMAP.md`: the seven phases and status

## Reviewers

Read-only agents in `.claude/agents/` (Read, Grep, Glob only): `architecture-reviewer`, `code-reviewer`, `security-reviewer`. Skills in `.claude/skills/`: `orbyte-architecture-review`, `orbyte-security-review`, `orbyte-phase-verify`. Reviewers report; they do not fix.

## Gotchas

- better-sqlite3 is built for Electron's ABI. Plain Node cannot load it. Use `pnpm test`.
- TypeScript 7: no `baseUrl`; aliases (`@shared/*`, `@/*`) are relative `paths`, mirrored in the Vite and Vitest configs.
- Main is CommonJS and the sandboxed preload is one CJS file (`out/preload/index.cjs`). Do not add `"type": "module"`.
- The renderer never passes filesystem paths. Directories are picked in main and registered by single-use token.
- The Agent SDK is ESM-only; main is CommonJS, so load it only via `sdk-loader.ts` (dynamic `import()`), kept external.
- Team Lead options (`modules/agents/team-lead/options.ts`) are the read-only enforcement: never add built-in tools, bypass modes, or drop `strictMcpConfig` (your personal MCP tools leak in otherwise). `allowedTools` may contain only Orbyte's own two tools, and only for chat turns. Tests assert this.
- The Team Lead can only PROPOSE tasks (`propose_tasks`); only `ProposalService.approve` (user action) creates them. Never add a path from the Team Lead to `TaskService.create`/`TaskRepository.create`. Task moves go through `src/shared/task-state.ts`; nothing may enter `in_progress` without `approvalVerified`.
- Team Lead auth uses the user's existing Claude Code login (user's choice; see `docs/SECURITY.md` policy caveat). Repo settings (hooks) load only after the user marks the project `trusted` (`repoSettingsTrust`); `unset` blocks the Team Lead in main. It can read `.env` files in the project.
- Developer agents: spawn the real `claude` directly via `launch.ts` (no shell); the planning launch must keep `--tools=Read,Glob,Grep` and `--strict-mcp-config` (without them the agent had ~55 tools); never add bypass/accept-edits flags; keep the env allowlist tight (no `CLAUDE_` prefix); all git for worktrees goes through `GitWorktrees` (hooks off). node-pty is a native module: `pnpm rebuild` after install.
- The execution gate: only `ApprovalService` (`authorizeExecution`, `authorizeRevision`) may pass `approvalVerified: true` and only `CompletionService` may pass `completionVerified: true` (tests scan for both); only the user's `plans:approve` creates an approval and only `executions:accept` an acceptance. Team Lead reviews (plans and results) are advice in fresh unsaved sessions. `executions:start` is renderer-reachable because it runs the gate in main; never expose authorize methods or a way to pass an approval id. Execution launch (`launch.ts`): no pre-approved Bash prefixes (prefix rules do not parse flags), deny edits to `.claude/**`, `.mcp.json`, `.git`; evidence collection (`GitWorktrees.snapshot`) must stay hardened (no inherited `GIT_*`, config off, `.git` pointer checked). The gate is not an OS-level boundary: an agent's `!` shell mode could edit the database (see `docs/SECURITY.md`).
- Terminal input is the user typing into Claude Code, which has a `!` shell mode that works even with `Bash` denied (tested): anything able to call `agents:write` can run shell commands as the user. See `docs/SECURITY.md`; do not claim planning agents are fully write-proof.
- When testing crashes, kill the Electron main process, not the `pnpm`/Node wrapper.
- End-to-end check recipes: `docs/DEVELOPMENT.md`.
- Known gaps (see `docs/SECURITY.md`): `style-src 'unsafe-inline'` in prod CSP, `repoPath` revalidation only at agent start (not for the Team Lead or later worktree operations), heuristic auth-error detection, no packaging config. Never send raw SDK/runtime error text to the renderer (map to fixed messages; log in main).
- CSP is injected at build time from `electron.vite.config.ts` (strict in prod, looser in dev). Navigation/permission guards live in `src/main/app/security.ts`.
