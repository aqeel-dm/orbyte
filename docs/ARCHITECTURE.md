# Architecture

Status tags: **Implemented** (exists in code), **Planned** (not built), **Limitation**, **Decision**.
Source is the reference; if this document disagrees with the code, fix the document.

## Process responsibilities

| Layer | Path | Owns | Must not |
|---|---|---|---|
| Main process | `src/main` | Database, git, filesystem, IPC handlers, app lifecycle (**Implemented**) | Contain UI concerns |
| Preload | `src/preload/index.ts` | The `window.orbyte` bridge: fixed methods that call fixed channels (**Implemented**) | Expose `ipcRenderer`, accept arbitrary channel names |
| Renderer | `src/renderer` | React UI (dashboard, register dialog) (**Implemented**) | Access Node, the filesystem, or spawn processes |
| Shared | `src/shared` | Zod schemas, types, IPC channel map, `Result`/`AppError` (**Implemented**) | Import from main or renderer |

**Decision:** the main process is the only backend. There is no HTTP server; renderer and main talk over Electron IPC only.

## Main process layout (Implemented)
- `index.ts`: bootstrap. Single-instance lock, opens DB, builds services, registers handlers, installs app security, creates the window. Closes the DB on `before-quit`. On macOS, closing the window does not quit the app.
- `app/window.ts`: BrowserWindow and its security options; `getAppEntryUrl()`.
- `app/security.ts`: app-wide navigation, window-open and permission guards on every web contents; `app/navigation-policy.ts` holds the pure URL rules (see `SECURITY.md`).
- `ipc/handle.ts`: the one wrapper for every handler: Zod parse, call, return `Result`.
- `ipc/projects.ts`: thin handlers for projects, onboarding and Team Lead. The native folder dialog lives here. `ipc/handle.ts` also holds the sender check.
- `modules/projects/{repository,service}.ts`: data access and business rules (register, archive/restore, status). `discovery.ts`: read-only repo-instruction discovery. `onboarding.ts`: onboarding state machine.
- `modules/agents/team-lead/`: `options.ts` (read-only SDK options builder), `events.ts` (SDK message to internal signals), `runner.ts` (SDK-backed `TeamLeadRunner`, the test seam), `sdk-loader.ts` (dynamic `import()` of the ESM-only SDK), `service.ts` (turns, session persistence, resume fallback, interrupt), `chat-repository.ts`, `prompt.ts`.
- `modules/git/inspect.ts`: read-only repo inspection through `execFile('git', ...)`.
- `database/{schema,client}.ts`: Drizzle schema; opens SQLite and runs migrations.

## Data flow: registering a project (Implemented)
1. Renderer calls `window.orbyte.projects.pickDirectory()`.
2. Preload `ipcRenderer.invoke('projects:pickDirectory')`.
3. `handle()` runs; the handler opens a native dialog in main. The user picks a path.
4. `ProjectService.prepare(path)` resolves the real path, checks it is a directory, runs `inspectRepository`, stores `{path, inspection}` under a random token (in memory, 10-minute TTL) and returns `{token, path, suggestedName, inspection}`.
5. Renderer shows the result and the user enters a name. It calls `register({token, name, description})`.
6. `handle()` validates against `registerProjectInputSchema`. `ProjectService.register` consumes the token (single use), re-validates the directory, rejects duplicates, and `ProjectRepository.create` inserts the project and a `project.registered` activity event in one transaction.
7. The `Result<Project>` returns to the renderer, which refreshes the list.

**Decision:** the renderer never supplies a filesystem path to a privileged call; it only holds an opaque token.

## Data flow: Team Lead chat turn (Implemented)
1. Renderer `teamLead.send(projectId, text)`; `handle()` checks the sender and validates input.
2. `TeamLeadService.send` rejects unknown or archived projects, projects whose repo-settings trust is `unset`, chat during onboarding, and a second concurrent turn for the same project, stores the user message, and starts the turn in the background; the call returns `{turnId, userMessage}` immediately.
3. `runTurn` makes one SDK `query()` through `TeamLeadRunner` with `resume: <stored session id>` and the read-only options (`settingSources` is `['user','project','local']` only when the project is trusted, else `['user']`). It never rejects, aborts after 15 minutes, and `shutdown()` aborts active turns on quit. **Decision:** one query per turn (not a long-lived process), so restart-resume and normal turns are the same code path and nothing assumes a process survived.
4. Raw SDK messages are mapped to signals; text deltas and tool names are emitted as `events:app` pushes (`turn_started`, `text_delta`, `tool_activity`). The session id from the init message is saved on the project.
5. On success the assistant text is stored and `turn_completed` is emitted. On failure `turn_error` is emitted with a code. An unknown session id clears the stored id and retries once without `resume`. An interrupt aborts the query via `AbortController` and keeps real partial output.

## Data flow: onboarding (Implemented)
`onboarding.start` marks the project `in_progress` (audit event), then in the background: `discoverProject` (read-only), then one bounded Team Lead turn (max 12 turns, not saved to chat) that returns a summary and proposed workflow guidance. Results are stored in `projects.onboarding_data` and status becomes `ready` or `failed`; `project_updated` events refresh the UI. At startup, onboarding left `in_progress` is marked `failed` (`INTERRUPTED`) so it can be retried. Nothing is written to the repository.

## Filesystem and git boundaries
- **Implemented:** filesystem access by Orbyte itself is `realpath`/`stat` on the user-picked directory, bounded read-only discovery inside it, and the SQLite file under `app.getPath('userData')`. The Team Lead's SDK subprocess separately reads files in the project directory through its read-only tools.
- **Implemented:** git is read-only (`rev-parse`, `symbolic-ref`), with a 10-second timeout and no shell. Orbyte never runs `git init` or changes repo config.
- **Planned (Phase 4):** git branches and worktrees for developer isolation. Nothing creates a worktree today.
- **Limitation:** non-git directories can be registered; worktree isolation will not apply to them.

## Planned, not built
Team Lead task-creation tools and tasks/orchestrator (Phase 3), developer agents with node-pty and xterm (Phase 4), plan and approval gate (Phase 5), execution and review (Phase 6), recovery and packaging (Phase 7). See `ROADMAP.md`. Integrations (Jira, Linear, GitHub Issues) must sit behind an adapter interface so the task model stays provider-neutral.

## Decisions
- Electron main as backend, typed IPC, no HTTP server.
- SQLite via better-sqlite3 + Drizzle with SQL migrations applied at startup.
- Tests run under Electron's Node ABI (`ELECTRON_RUN_AS_NODE`) so the native module matches the app.
- Main is built as CommonJS (no `"type": "module"` in `package.json`); preload is a single CJS file because it is sandboxed.
- The Agent SDK is ESM-only and main is CommonJS, so it is loaded with a dynamic `import()` and kept external (verified in `out/main/index.js` and by loading it inside Electron).
- Team Leads (Agent SDK sessions) and developer agents (Claude Code CLI in a PTY) are different mechanisms and must not be treated as interchangeable.
