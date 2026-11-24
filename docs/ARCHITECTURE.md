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
- `modules/tasks/`: `repository.ts`, `service.ts` (the single place task state changes; every call is checked against the project id), `dependencies.ts` (pure dependency and cycle rules). `src/shared/task-state.ts` is the pure state machine shared with the UI.
- `modules/orchestration/`: `proposal-service.ts`/`proposal-repository.ts` (Team Lead task suggestions become tasks only when you approve) and, for plans, `plan-service.ts` (ingest and versioning), `plan-repository.ts`, `plan-hash.ts`, `review-service.ts` (Team Lead advice) and `approval-service.ts` (your decisions and the execution gate). `src/main/agent-mcp/plan-server.ts` is a second build entry: the small MCP server Claude Code starts to give an agent its `submit_plan` tool.
- `modules/agents/developers/`: `agent-service.ts` (start, supervise, stop, discard, attach, recovery), `agent-repository.ts`, `worktrees.ts` (hardened git), `launch.ts` (CLI arguments and env allowlist), `claude-binary.ts`, `pty-node.ts` (the only place node-pty is loaded), `terminal-buffer.ts`, `terminal-hub.ts` (per-window attach), `process-reaper.ts`.
- `modules/agents/team-lead/`: `options.ts` (read-only SDK options builder), `events.ts` (SDK message to internal signals), `runner.ts` (SDK-backed `TeamLeadRunner`, the test seam), `sdk-loader.ts` (dynamic `import()` of the ESM-only SDK), `service.ts` (turns, session persistence, resume fallback, interrupt), `chat-repository.ts`, `prompt.ts`, `tools.ts` (the in-process `orbyte` MCP server: `list_tasks`, `propose_tasks`).
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

## Data flow: task proposals (Implemented)
1. In a **chat** turn (never onboarding) the Team Lead gets two in-process tools, `list_tasks` (read-only) and `propose_tasks`, through an SDK MCP server named `orbyte`. The project id is bound by the server when the tools are built; the tool input has no project field.
2. `propose_tasks` validates its input with Zod (1-20 tasks, length limits, dependency shape), at most 3 calls per turn, then `ProposalService.record` checks dependencies (exist, same project, not cancelled, acyclic) and stores a **pending proposal**, at most 5 pending per project. **No task is created.** A `proposals_changed` event tells the UI.
3. The user reviews the proposal in the Tasks tab, unticks tasks and edits the rest, then approves. `ProposalService.approve` re-validates everything (dependencies may have changed), creates the tasks in dependency order and marks the proposal approved in **one transaction**, so either all chosen tasks exist or none do. A proposal can be decided only once. Created tasks have `source: team_lead` and status `backlog`.
4. Task status changes go through `TaskService.transition` and the state machine. The renderer always acts as `user`, so it can only make moves the table allows for users (for example backlog to ready, cancel, block, reopen). Planning, review and completion belong to the orchestrator actor, and entering `in_progress` additionally requires a verified approval that nothing can supply yet (Phase 5).

## Data flow: developer agent (Implemented)
1. The user marks a task Ready and chooses Start agent. `AgentService.start` checks: project active, repo-settings trust decided, git repo, task Ready and owned by the project, dependencies completed, no live agent for the task, under the agent limit, `claude` found. A task whose start is in flight is reserved so two clicks cannot start two agents.
2. It resolves the default branch to a commit, records the agent (`starting`), creates the worktree and branch, then the **orchestrator** moves the task Ready to planning, then spawns `claude` in a PTY with the planning-stage arguments. A failure at any step rolls back the later steps (task back to Ready, worktree and unmoved branch removed, agent `failed`).
3. PTY output is kept in a bounded buffer, batched (about 16 ms) and published through `TerminalHub` to windows that attached; the program's terminal title becomes the agent's current activity. xterm.js in the renderer writes the history from `attach` and then live output, and sends keystrokes with `agents:write`.
4. On exit the buffer is saved, the agent becomes `exited`, `failed` (non-zero), `stopped` (user or task change) or `interrupted` (app quit), and the task returns to Ready only if it is still in planning.
5. Archiving a project calls `AgentService.stopAllForProject`. On quit the service refuses new starts and waits for in-flight ones. On startup agents still recorded active are interrupted (after stopping any verified leftover process); on quit all agents are stopped before the database closes.

**Decisions:** one agent per task, always in its own worktree; the real CLI in a real PTY (no emulation); the agent is launched for the planning stage only in Phase 4; Orbyte drives the task state, not the agent.

## Data flow: plan, review, approval (Implemented)
1. The planning agent investigates with read-only tools and calls its `submit_plan` tool. The MCP server validates the plan and writes it to the agent's private inbox (`userData/plan-inbox/<agentId>`).
2. `AgentService` polls that inbox every second while the agent runs, and again (waiting for any read in flight) when the agent exits, and hands each plan to `PlanService.ingest`. A valid plan for a task in `planning` becomes the next numbered version (hashed); any earlier version is superseded and any standing approval is invalidated in the same transaction. The task moves to `awaiting_approval`. An identical resubmission while a decision is pending is ignored.
3. `ReviewService` asks the Team Lead to review the plan automatically (one-shot session, review tool only, waits if the Team Lead is busy, skipped if the plan was replaced). The result is stored as advice.
4. You read the plan, the advice and the gate's blockers in the plan dialog and approve or reject the CURRENT version. Approval stores the record (task, agent, version, hash, reviewer `user`, status, time). Rejection returns the task to planning (agent alive) or Ready (no live agent).
5. `ApprovalService.verify` is the gate. `authorizeExecution` (called only by `ExecutionService.start`, itself reached from `executions:start`) re-verifies, spends the approval, and moves the task to `in_progress` with `approvalVerified: true`, the only place that flag is passed.
6. **Execution and review (Phase 6).** `ExecutionService` launches an execution agent (a fresh `claude` in the plan's worktree, `--permission-mode acceptEdits`, tools `Read,Glob,Grep,Edit,Write,Bash`, only Orbyte's MCP server with `report_progress` and `submit_result`). Reports are claims. On `submit_result`, Orbyte collects its own evidence from git (`GitWorktrees.snapshot`: HEAD, diff hash, untracked file digests, files, commits), stores a numbered result, moves the task to `in_review` and stops the agent so the code is frozen. `ResultReviewService` asks the Team Lead (fresh unsaved session, read access to the worktree) for advice. `CompletionService.accept` is the user's decision and the only place that passes `completionVerified: true`: it needs the current result, a Team Lead review of that result, and a fresh snapshot equal to the stored one. "Request changes" records a single-use change request that `authorizeRevision` (in `approval-service.ts`) spends to start a revision run. An execution that ends without a result returns the task to `awaiting_approval` and needs a fresh approval.

**Decisions:** the Team Lead advises and you decide; an approval is tied to one plan version and hash and is one-shot; the gate re-checks stored state each time; task approval columns are a cache for the UI, never used for decisions.

## Data flow: onboarding (Implemented)
`onboarding.start` marks the project `in_progress` (audit event), then in the background: `discoverProject` (read-only), then one bounded Team Lead turn (max 12 turns, not saved to chat) that returns a summary and proposed workflow guidance. Results are stored in `projects.onboarding_data` and status becomes `ready` or `failed`; `project_updated` events refresh the UI. At startup, onboarding left `in_progress` is marked `failed` (`INTERRUPTED`) so it can be retried. Nothing is written to the repository.

## Filesystem and git boundaries
- **Implemented:** filesystem access by Orbyte itself is `realpath`/`stat` on the user-picked directory, bounded read-only discovery inside it, and the SQLite file under `app.getPath('userData')`. The Team Lead's SDK subprocess separately reads files in the project directory through its read-only tools.
- **Implemented:** git is read-only (`rev-parse`, `symbolic-ref`), with a 10-second timeout and no shell. Orbyte never runs `git init` or changes repo config.
- **Limitation:** non-git directories can be registered; worktree isolation will not apply to them.

## Planned, not built
Recovery, logging, and packaging (Phase 7). See `ROADMAP.md`. Integrations (Jira, Linear, GitHub Issues) must sit behind an adapter interface so the task model stays provider-neutral.

## Decisions
- Electron main as backend, typed IPC, no HTTP server.
- SQLite via better-sqlite3 + Drizzle with SQL migrations applied at startup.
- Tests run under Electron's Node ABI (`ELECTRON_RUN_AS_NODE`) so the native module matches the app.
- Main is built as CommonJS (no `"type": "module"` in `package.json`); preload is a single CJS file because it is sandboxed.
- The Agent SDK is ESM-only and main is CommonJS, so it is loaded with a dynamic `import()` and kept external (verified in `out/main/index.js` and by loading it inside Electron).
- Team Leads (Agent SDK sessions) and developer agents (Claude Code CLI in a PTY) are different mechanisms and must not be treated as interchangeable.
