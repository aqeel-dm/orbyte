# Requirements

What Orbyte is required to do, where each requirement came from, and whether the code meets it today. Written after Phase 7 from the original brief (the "Master Implementation Prompt", section numbers below refer to it) and from the decisions the user made while building. It was not written before the work, so the status column describes what was built and checked, not an agreed acceptance test.

Status values: **Met** (built and covered by tests or a live run), **Met, changed by decision** (built, but differently from the brief because the user chose so, see "Decisions"), **Partial**, **Not met**, **Planned**. Details of what was verified, and how, are in `ROADMAP.md`; security limits are in `SECURITY.md`.

## 1. Purpose and scope (brief section 1)

A local-first, single-user desktop app that coordinates Claude Code developer agents across software projects. The user decides WHAT is built; a per-project Team Lead decides HOW to organize it; developer agents do the work; the app enforces approval and safety boundaries.

| ID | Requirement | Status |
|---|---|---|
| P-1 | Runs locally for one user; no Docker, Redis, Postgres or HTTP backend | Met |
| P-2 | Works directly in existing project directories (no copies) | Met |
| P-3 | Renderer and main talk only over typed Electron IPC | Met |

## 2. Projects (4A, 6)

| ID | Requirement | Status |
|---|---|---|
| PR-1 | Register an existing directory chosen in a native dialog; validate it exists; detect whether it is a git repository | Met (the native dialog itself was never driven in an automated run) |
| PR-2 | Never run `git init` or change repository configuration silently | Met |
| PR-3 | Store id, name, description, path, default branch, config, Team Lead session id, status, timestamps | Met |
| PR-4 | Persist across restarts | Met |
| PR-5 | Onboarding: inspect CLAUDE.md (nested too), `.claude/`, skills, hooks, MCP config and docs, summarize stack, structure, commands and conventions, propose workflow guidance, mark the project ready; bounded and read-only | Met |
| PR-6 | Onboarding state survives a restart (an interrupted run can be retried) | Met |
| PR-7 | Platform configuration is stored in Orbyte's database, never written into the repository; repository instructions stay authoritative | Met |
| PR-8 | Non-git directories are allowed but marked limited; agents refuse them | Met, by decision |
| PR-9 | Removing a project archives it (hidden by default, restorable) | Met, by decision |

## 3. Team Lead (4B)

| ID | Requirement | Status |
|---|---|---|
| TL-1 | One Claude Agent SDK session per project, working directory = the repository, resumed after restart | Met |
| TL-2 | Conversational chat with streaming responses and a "working" indicator, history persisted | Met |
| TL-3 | Never starts work, creates tasks, scans unprompted or assigns agents on its own | Met (read-only tools; it can only propose) |
| TL-4 | Breaks a requirement into tasks with dependencies, priorities and risks | Met, changed by decision: it proposes, the user approves what enters the backlog |
| TL-5 | Reviews developer plans (fit, missed files, tests, complexity, security) and records the review | Met, changed by decision: the review is advice |
| TL-6 | Approves, rejects or requests revisions of plans | Met, changed by decision: only the user approves or rejects; the Team Lead recommends |
| TL-7 | Reviews completed work and can request changes | Met, changed by decision: it reviews as advice; the user accepts or requests changes |
| TL-8 | Assigns developer agents and monitors active development | **Not met, by design**: the user starts agents; the Team Lead does not start, assign or monitor them |
| TL-9 | Reports progress to the user | Partial: through chat and the activity list; no proactive reporting |

## 4. Developer agents and terminals (4C)

| ID | Requirement | Status |
|---|---|---|
| DA-1 | Each agent is a real Claude Code CLI process in a real PTY (node-pty), never simulated | Met |
| DA-2 | Each agent has its own git worktree and branch; no two agents share a working tree | Met |
| DA-3 | Store id, project, task, process info, directory, branch, status, activity, timestamps, terminal history | Met |
| DA-4 | xterm.js view with streaming, resizing, lifecycle handling and typing into the real session; several agents; output delivered only to windows attached to that agent | Met (real keyboard typing in the xterm UI was tested through the IPC write path, not by hand) |
| DA-5 | Closing the window does not stop agents while the app runs | Met on macOS; other platforms quit on last window close and were not tested |
| DA-6 | An interrupted run (crash or quit) is marked interrupted and can be restarted | Met (verified live with `kill -9`) |

## 5. Tasks (4D)

| ID | Requirement | Status |
|---|---|---|
| T-1 | Title, description, project, status, priority, dependencies | Met |
| T-2 | Assigned agent, plan, approval, execution state and result summary | Met, stored in linked records (agents, plans, approvals, executions) not as task columns |
| T-3 | Statuses Backlog, Ready, Planning, Awaiting Approval, In Progress, In Review, Blocked, Completed, Cancelled with explicit validated transitions | Met |
| T-4 | Dependencies validated (no self, cycle, missing or cross-project) | Met |
| T-5 | A task with unfinished dependencies may be planned but not executed | Met, by decision |

## 6. Workflow and the approval gate (5)

| ID | Requirement | Status |
|---|---|---|
| W-1 | Planning stage: the agent investigates and produces a plan, no implementation | Met (planning launch is read-only; `submit_plan` is Orbyte's own tool because the CLI's plan tool carries no plan text) |
| W-2 | Plans are structured, stored and versioned | Met |
| W-3 | Execution is blocked until a stored approval record exists, checked by the backend, not by prompts or permission modes | Met |
| W-4 | An approval is tied to task, agent, plan version, reviewer, status and time | Met (the reviewer is the user) |
| W-5 | A materially changed plan needs a new approval | Met |
| W-6 | Execution: the agent implements, runs tests and reports; its terminal stays available | Met |
| W-7 | The app keeps execution state independently of the agent's claims | Met: the agent's report is shown as an unverified claim; Orbyte collects git evidence itself |
| W-8 | Completion only after review; never because the agent says it succeeded | Met: needs a Team Lead review of the current result, the user's acceptance and an unchanged code snapshot |
| W-9 | Test results are collected | **Partial, by decision**: agent-reported results are labelled unverified; Orbyte does not run tests itself |
| W-10 | State, history and activity are persisted and shown on the dashboard | Met |

## 7. User interface (7)

| ID | Requirement | Status |
|---|---|---|
| UI-1 | Global dashboard: projects, status, agents running, tasks in progress, pending approvals | Met |
| UI-2 | Global dashboard: active Team Leads and recent activity | Met (a Team Leads tile with ready and working counts, and a recent-activity list across active projects; checked in the real UI) |
| UI-3 | Project workspace: overview, Team Lead chat, tasks, agents, terminal, recent activity | Met |
| UI-4 | Project workspace: a pending-approvals view | Met (a "Waiting for you" list of proposals, plans and results on the dashboard and each project's overview, opening the Tasks tab; the dashboard tile uses the same count) |
| UI-5 | Approval interface shows task, plan, agent, Team Lead review and whether execution is blocked or authorized | Met (checked in the real UI) |
| UI-6 | Clear loading, error, empty and disconnected states; dark and light themes | Met for the screens checked; not a formal design review |
| UI-7 | The interface separates ordinary conversation from state-changing actions | Partial: proposals and approvals are separate dialogs; not assessed beyond that |

## 8. Persistence and lifecycle (8)

| ID | Requirement | Status |
|---|---|---|
| L-1 | SQLite with WAL and Drizzle migrations, state kept across restarts | Met |
| L-2 | Do not assume a PTY or SDK process survives; resume the Team Lead through the SDK | Met |
| L-3 | Startup recovery: interrupted runs marked, leftover files and orphan worktrees reported, audited | Met |
| L-4 | Logs are useful and private | Met: redacting file logger, mode 600 |

## 9. Safety (9, mandatory)

| ID | Requirement | Status |
|---|---|---|
| S-1 | Renderer has no Node access (`contextIsolation`, no `nodeIntegration`, `sandbox`) | Met |
| S-2 | All privileged operations go through validated IPC; sender checked; ids and ownership checked per project | Met |
| S-3 | No filesystem path, command or executable from the renderer for privileged actions | Met, with one documented exception: the user typing into an agent's terminal |
| S-4 | Agents use isolated worktrees; one project cannot reach another's resources | Met |
| S-5 | Execution blocked until approval recorded and verified in the backend | Met (see limit below) |
| S-6 | No credentials to the renderer; do not modify repository configuration silently | Met |
| S-7 | Never fake agent, terminal, test or approval results | Met |
| S-8 | Validate AI-generated structured output | Met (Zod) |
| S-9 | Process crashes handled | Met |
| S-10 | The approval gate holds against a process running as the user | **Not met, accepted**: approvals and acceptances are unsigned and Claude Code's `!` shell mode can run commands; documented in `SECURITY.md`, deferred by decision |

## 10. Integrations (10)

| ID | Requirement | Status |
|---|---|---|
| I-1 | The core task model is not tied to a provider | Met |
| I-2 | An adapter interface for Jira, Linear and GitHub Issues | **Planned**: no interface exists; the MVP is internal task management only |

## 11. Engineering standards (12) and delivery (11)

| ID | Requirement | Status |
|---|---|---|
| E-1 | TypeScript strict, Zod at boundaries, thin IPC handlers, repositories behind services, no business logic in components | Met |
| E-2 | Vitest tests for business rules | Met (300 tests at the last run) |
| E-3 | Playwright UI tests | **Not met**: Playwright is not installed; the UI was checked by driving the real app over the DevTools protocol |
| E-4 | Phases 1-7, each leaving the app runnable | Met except packaging |
| E-5 | Packaging for desktop distribution | **Planned**, deferred by decision ("no builds for now"): `asarUnpack`, Fuses, signing |
| E-6 | Project folder layout from the brief | Met in spirit: approvals, terminals and sessions live inside `orchestration/` and `agents/developers/` instead of separate modules; the brief allowed the structure to evolve |

## Decisions that shaped the requirements

Made by the user while building (answers to questions, or direct instructions):

| Decision | Effect |
|---|---|
| Team Lead uses the user's existing Claude Code login | No API-key storage or settings screen; policy caveat in `SECURITY.md` |
| Repository settings (hooks) load only after the user marks a project trusted | The first answer was user + project + local settings; a later security review added the per-project trust gate, which governs project and local settings. User settings always load |
| Archive, not delete, on project removal | PR-9 |
| Non-git projects allowed but limited | PR-8 |
| The Team Lead proposes tasks, you approve | TL-4 |
| You approve plans, the Team Lead advises; it reviews automatically | TL-5, TL-6 |
| A dependent task may be planned early, executed later | T-5 |
| You accept completion, after a Team Lead review exists | TL-7, W-8 |
| Commands that need approval ask in the terminal; Orbyte never answers them | W-6 |
| Test results: agent report labelled unverified plus facts Orbyte collects; no Orbyte-run test command | W-9 |
| Signing of approvals deferred; document the limit | S-10 |
| File logger; startup recovery, orphan cleanup and database backup in scope | L-3, L-4 |
| No builds or packaging for now | E-5 |
| Work directly on `main`; commit and push only when asked | `.claude/rules/git-workflow.md` |

## Open items

Signing approval and acceptance rows; the `!` shell-mode gap; an Orbyte-run test command; re-validating `repoPath` for the Team Lead and later worktree operations; the evidence shows line counts but not the diff text itself; Playwright tests; integration adapters; packaging. Each is also tracked in `ROADMAP.md` or `SECURITY.md`.
