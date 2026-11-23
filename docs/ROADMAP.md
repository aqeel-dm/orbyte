# Roadmap

Each phase must leave the app runnable. Do not start a phase without explicit authorization.

| # | Phase | Status | Summary |
|---|---|---|---|
| 1 | Foundation | **Complete** (commit `9d62d2e`) | Electron shell, secure preload and typed IPC, SQLite + Drizzle migrations, dashboard, project registration and persistence |
| 2 | Project workspace, onboarding, Team Lead chat | **Implemented on branch `phase-2`** (verification caveats below) | Project page, onboarding lifecycle, discovery of CLAUDE.md and `.claude/`, Team Lead via Claude Agent SDK, session persistence and resume, streaming chat |
| 3 | Tasks and orchestration | Not started | Task model, backlog UI, dependencies, validated state machine, Team Lead task tools, orchestrator, persistent event history |
| 4 | Developer agent runtime | Not started | Claude Code CLI in node-pty, git worktrees, xterm.js terminals, agent persistence |
| 5 | Planning and approval | Not started | Plan capture and versioning, Team Lead review, backend-enforced approval gate |
| 6 | Execution and review | Not started | Approved execution, result and test capture, Team Lead review, completion rules |
| 7 | Reliability and polish | Not started | Crash recovery, process cleanup, logging, tests, packaging |

## Phase 1 acceptance (met, with caveats)
App launches; project registered by token flow and persisted (tested at service/DB level); renderer isolated (verified over DevTools protocol). Caveat: the native folder dialog was not exercised end-to-end.

## Phase 2 acceptance
Verified by running the built app with the real SDK and the user's existing Claude Code login (project row seeded into a throwaway user-data directory, because the native folder dialog cannot be driven over the DevTools protocol): onboarding reached `ready` with discovery, summary and guidance; chat streamed; an edit request was refused and no file was created; after an app restart the session id and history persisted and the follow-up turn resumed the same session; archive/restore and input validation behaved as specified; the renderer stayed isolated. 57 automated tests pass (the real SDK is not used in automated tests).

Not verified: the native folder dialog; visual UI quality (the project route was only checked to render); a not-signed-in run (auth error mapping is heuristic); a packaged build; resuming after the SDK's session file is deleted (covered by a fake-runner test and by observing the SDK's error text for a bogus id).

## Open items for Phase 3 and later
Team Lead task-creation tools (use `createSdkMcpServer`; confirm `strictMcpConfig` still allows SDK-provided servers); `repoPath` re-validation before developer agents; non-git projects must be refused for developer agents (Phase 4); packaging the SDK's native binary (Phase 7).
