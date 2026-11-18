# Roadmap

Each phase must leave the app runnable. Do not start a phase without explicit authorization.

| # | Phase | Status | Summary |
|---|---|---|---|
| 1 | Foundation | **Complete** (commit `9d62d2e`) | Electron shell, secure preload and typed IPC, SQLite + Drizzle migrations, dashboard, project registration and persistence |
| 2 | Project workspace, onboarding, Team Lead chat | Not started (next) | Project page, onboarding lifecycle, discovery of CLAUDE.md and `.claude/`, Team Lead via Claude Agent SDK, session persistence and resume, streaming chat |
| 3 | Tasks and orchestration | Not started | Task model, backlog UI, dependencies, validated state machine, Team Lead task tools, orchestrator, persistent event history |
| 4 | Developer agent runtime | Not started | Claude Code CLI in node-pty, git worktrees, xterm.js terminals, agent persistence |
| 5 | Planning and approval | Not started | Plan capture and versioning, Team Lead review, backend-enforced approval gate |
| 6 | Execution and review | Not started | Approved execution, result and test capture, Team Lead review, completion rules |
| 7 | Reliability and polish | Not started | Crash recovery, process cleanup, logging, tests, packaging |

## Phase 1 acceptance (met, with caveats)
App launches; project registered by token flow and persisted (tested at service/DB level); renderer isolated (verified over DevTools protocol). Caveat: the native folder dialog was not exercised end-to-end.

## Before or during Phase 2 (open items)
Open questions from `SECURITY.md` and `DATABASE.md`: IPC sender validation, project removal vs audit trail, `updated_at` maintenance, behavior for non-git projects. Verify the Agent SDK API and CLI flags in official docs before using them; do not invent them.
