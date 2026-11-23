# Roadmap

Each phase must leave the app runnable. Do not start a phase without explicit authorization.

| # | Phase | Status | Summary |
|---|---|---|---|
| 1 | Foundation | **Complete** (commit `9d62d2e`) | Electron shell, secure preload and typed IPC, SQLite + Drizzle migrations, dashboard, project registration and persistence |
| 2 | Project workspace, onboarding, Team Lead chat | **Complete** (merged into `main`) (verification caveats below) | Project page, onboarding lifecycle, discovery of CLAUDE.md and `.claude/`, Team Lead via Claude Agent SDK, session persistence and resume, streaming chat |
| 3 | Tasks and orchestration | **Implemented** (uncommitted; caveats below) | Task model, backlog UI, dependencies, validated state machine, Team Lead task tools (propose, user approves), persistent event history |
| 4 | Developer agent runtime | Not started | Claude Code CLI in node-pty, git worktrees, xterm.js terminals, agent persistence |
| 5 | Planning and approval | Not started | Plan capture and versioning, Team Lead review, backend-enforced approval gate |
| 6 | Execution and review | Not started | Approved execution, result and test capture, Team Lead review, completion rules |
| 7 | Reliability and polish | Not started | Crash recovery, process cleanup, logging, tests, packaging |

## Phase 1 acceptance (met, with caveats)
App launches; project registered by token flow and persisted (tested at service/DB level); renderer isolated (verified over DevTools protocol). Caveat: the native folder dialog was not exercised end-to-end.

## Phase 2 acceptance
Verified by running the built app with the real SDK and the user's existing Claude Code login (project row seeded into a throwaway user-data directory, because the native folder dialog cannot be driven over the DevTools protocol): onboarding reached `ready` with discovery, summary and guidance; chat streamed; an edit request was refused and no file was created; after an app restart the session id and history persisted and the follow-up turn resumed the same session; archive/restore and input validation behaved as specified; the renderer stayed isolated. 71 automated tests pass (the real SDK is not used in automated tests). A follow-up security review's findings were fixed or documented (see `SECURITY.md`); the trust gate was verified with real UI clicks and real SDK turns in both trust modes.

Not verified: the native folder dialog; the quit path in a running app; visual UI quality (the project route was only checked to render); a not-signed-in run (auth error mapping is heuristic); a packaged build; resuming after the SDK's session file is deleted (covered by a fake-runner test and by observing the SDK's error text for a bogus id).

## Phase 3 acceptance
Verified with 140 automated tests, a read-only security review (findings fixed or recorded in `SECURITY.md`), and a real run (built app, real SDK): tasks persist; dependencies are validated (self, cycle, missing, other project); every illegal user transition is refused and the allowed set is exhaustively tested; the Team Lead's propose tool recorded a proposal and created no task; approving a subset with an edited title created exactly those tasks with provenance and dependencies; approving twice or from another project was refused; a plain question produced no proposal; activity history, the dashboard "Open tasks" count and the Tasks tab (including proposal review) work.

Not verified: the visual quality of the Tasks UI (checked that it renders the expected text, not how it looks); behavior with large backlogs (the Team Lead digest is capped at 100 tasks); the "orchestrator" actor paths beyond unit tests (no caller exists until Phase 4). Phase 3 has no separate orchestrator process: `TaskService` plus the state machine is the orchestrator for task state, and the execution workflow arrives in Phases 4-6.

## Open items for Phase 4 and later
Enforce dependency completion when starting an agent; make cancel stop a running agent; `repoPath` re-validation before developer agents; non-git projects must be refused for developer agents (Phase 4); packaging the SDK's native binary (Phase 7).
