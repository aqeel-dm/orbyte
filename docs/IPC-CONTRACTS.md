# IPC Contracts

Channels are defined once in `src/shared/constants/ipc.ts`, request/response schemas in `src/shared/schemas/project.ts`, and the renderer-facing type in `src/shared/types/api.ts` (`OrbyteApi`). The preload (`src/preload/index.ts`) maps each method to its channel.

## Envelope (Implemented)
Every handler returns `Result<T>`: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. `handle()` in `src/main/ipc/handle.ts` parses input with Zod and converts failures: `ZodError` to `INVALID_INPUT`, `AppError` to its own code, anything else to `INTERNAL` (logged in main, generic message to the renderer).

## Channels (all Implemented)
Invoke channels (renderer to main), defined in `src/shared/constants/ipc.ts`; the renderer calls them as `window.orbyte.<group>.<method>`.

| Method | Channel | Input | Output |
|---|---|---|---|
| `projects.list(input?)` | `projects:list` | `{includeArchived?}` | `Project[]` (archived hidden by default) |
| `projects.get(id)` | `projects:get` | `{id (<=64)}` | `Project` |
| `projects.pickDirectory()` | `projects:pickDirectory` | none | `{cancelled: true}` or `{cancelled: false, token, path, suggestedName, inspection}` |
| `projects.register(input)` | `projects:register` | `{token (<=64), name (1-100), description (<=1000)}` | `Project` |
| `projects.archive(id)` / `restore(id)` | `projects:archive` / `projects:restore` | `{id}` | `Project` |
| `projects.setTrust(id, trust)` | `projects:setTrust` | `{id, trust: 'trusted' or 'untrusted'}` | `Project` |
| `projects.discover(id)` | `projects:discover` | `{id}` | `DiscoveryResult` (read-only listing of instruction files and risky settings key names) |
| `onboarding.start(projectId)` | `onboarding:start` | `{projectId}` | `Project` (now `in_progress`; the work continues in the background) |
| `teamLead.send(projectId, text)` | `teamLead:send` | `{projectId, text (1-20000, trimmed)}` | `{turnId, userMessage}` (the reply streams as events) |
| `teamLead.interrupt(projectId)` | `teamLead:interrupt` | `{projectId}` | `null` |
| `teamLead.history(projectId)` | `teamLead:history` | `{projectId}` | `ChatMessage[]` oldest first |
| `teamLead.summary()` | `teamLead:summary` | none | `{ready, working}`: active projects whose onboarding finished, and Team Lead turns running now |

| `tasks.list(projectId)` | `tasks:list` | `{projectId}` | `Task[]` |
| `tasks.create(input)` | `tasks:create` | `{projectId, title (1-120), description (<=4000), priority, dependsOnTaskIds (<=20)}` | `Task` (always `source: user`, status `backlog`) |
| `tasks.update(input)` | `tasks:update` | `{projectId, taskId, patch: {title?, description?, priority?, dependsOnTaskIds?}}` | `Task` |
| `tasks.transition(projectId, taskId, to)` | `tasks:transition` | `{projectId, taskId, to}` | `Task`. The handler passes the actor `user`; the orchestrator actor is not reachable from the renderer |
| `tasks.summary()` | `tasks:summary` | none | `{open, byStatus}` across non-archived projects |
| `proposals.list(projectId)` | `proposals:list` | `{projectId}` | `TaskProposal[]` (pending first) |
| `proposals.approve(projectId, proposalId, items)` | `proposals:approve` | `{projectId, proposalId, items: ProposalItem[] (1-20)}` | `Task[]` created. The only way a Team Lead suggestion becomes tasks |
| `proposals.dismiss(projectId, proposalId)` | `proposals:dismiss` | `{projectId, proposalId}` | `TaskProposal` |
| `activity.list(projectId, limit?)` | `activity:list` | `{projectId, limit (1-200)}` | `ActivityEvent[]`, newest first |
| `decisions.list(projectId?)` | `decisions:list` | `{projectId?}` | `DecisionItem[]` (`kind` is `proposal`, `plan` or `result`; project, optional task, title, `since`), longest-waiting first. Read-only: pending task proposals, tasks whose plan awaits your decision, tasks in review; active projects only. Unknown project: `NOT_FOUND` |
| `activity.listRecent(limit?)` | `activity:listRecent` | `{limit (1-100)}` | `RecentActivityEvent[]` (event plus `projectId` and `projectName`), newest first, across active projects; app-wide events (no project, such as `recovery.completed`) have both null; archived projects are left out |

| `agents.list(projectId)` | `agents:list` | `{projectId}` | `DeveloperAgent[]` (no session id, base commit or pid) |
| `agents.start(projectId, taskId)` | `agents:start` | `{projectId, taskId}` | `DeveloperAgent`; creates the worktree, moves the task to planning, starts the process |
| `agents.stop(projectId, agentId)` | `agents:stop` | `{projectId, agentId}` | `DeveloperAgent` (it becomes `stopped` when the process exits) |
| `agents.discard(projectId, agentId, force?)` | `agents:discard` | `{projectId, agentId, force?}` | `DeveloperAgent`; removes the worktree, refuses uncommitted changes unless `force` |
| `agents.attach(projectId, agentId)` / `detach` | `agents:attach` / `agents:detach` | `{projectId, agentId}` | `{history, live}` / `null`. Output is pushed only after attaching |
| `agents.write(projectId, agentId, data)` | `agents:write` | `{projectId, agentId, data (<=64KB)}` | `null`. The user typing into the Claude Code session. Refused with `SHELL_MODE_BLOCKED` in a planning agent when the input would start a line with `!` |
| `agents.resize(projectId, agentId, cols, rows)` | `agents:resize` | `cols 20-500, rows 5-200` | `null` |
| `agents.summary()` | `agents:summary` | none | `{running}` |

| `plans.get(projectId, taskId)` | `plans:get` | `{projectId, taskId}` | `PlanBundle`: plan versions (newest first), Team Lead reviews, approval records, the gate verdict (`state`, `executionAuthorized`, `blockers`) and `reviewInProgress` |
| `plans.approve(projectId, taskId, planId)` | `plans:approve` | ids | `PlanApproval`. Only the CURRENT version can be approved. The only way an approval comes into existence |
| `plans.reject(projectId, taskId, planId, reason)` | `plans:reject` | reason 1-1000 characters | `PlanApproval` (status `rejected`) |
| `plans.revoke(projectId, taskId)` | `plans:revoke` | ids | `PlanBundle`. Only while the task awaits approval |
| `plans.requestReview(projectId, taskId, planId)` | `plans:requestReview` | ids | `null`. Asks the Team Lead for advice on the current plan |

| `executions.start(projectId, taskId)` | `executions:start` | ids | `DeveloperAgent`. Runs the approval gate in main: refused (`EXECUTION_NOT_AUTHORIZED`) without a valid stored approval, which it spends. The renderer supplies no approval id, path or command |
| `executions.get(projectId, taskId)` | `executions:get` | ids | `ExecutionBundle`: runs, progress notes, results (agent claims plus Orbyte-collected evidence), Team Lead reviews, decisions, the completion gate (`canAccept`, `blockers`, `codeUnchanged` from a fresh look at git) and `reviewInProgress` |
| `executions.accept(projectId, taskId, resultId)` | `executions:accept` | ids | `ResultDecision`. The only way a task completes; refused unless the result is current, Team Lead-reviewed and the code unchanged (`REVIEW_REQUIRED`, `STALE_RESULT`, `CODE_CHANGED`, `NOT_IN_REVIEW`) |
| `executions.requestChanges(projectId, taskId, resultId, feedback)` | `executions:requestChanges` | feedback 1-2000 characters | `DeveloperAgent`. Records a single-use change request and starts a revision run |
| `system.check()` | `system:check` | none | `SystemCheck`: whether `git`, the `claude` command and OS secure key storage are available, with version strings (never paths). Read-only; does not check that Claude Code is signed in |
| `executions.changes(projectId, taskId, resultId)` | `executions:changes` | ids | `{text, truncated}`: the tracked diff plus the content of new untracked text files, read fresh from the worktree (60,000 characters at most). Errors: `NOT_FOUND`, `WORKTREE_FAILED`, `CODE_CHANGED` (the code no longer matches the result). The renderer supplies no path |
| `executions.runTests(projectId, taskId, resultId)` | `executions:runTests` | ids | `TestRun` (status `running`; the outcome arrives as an `executions_changed` event). Runs the `test` script Orbyte finds in the worktree's package.json, only for the current, unchanged result of a task in review. Errors: `STALE_RESULT`, `CODE_CHANGED`, `NOT_IN_REVIEW`, `NO_TEST_COMMAND`, `TESTS_RUNNING`, `WORKTREE_FAILED`. The renderer supplies no command |
| `executions.testRuns(projectId, taskId)` | `executions:testRuns` | ids | `TestRun[]`, newest first (max 20) |
| `executions.requestReview(projectId, taskId, resultId)` | `executions:requestReview` | ids | `null`. Asks the Team Lead for advice on the current result |

| `maintenance.scan()` | `maintenance:scan` | none | `{orphanWorktrees: [{id, projectId, projectName, name}]}`: worktree directories in Orbyte's own directory that no agent owns. Opaque ids, no paths. Read-only |
| `maintenance.cleanOrphans(ids)` | `maintenance:cleanOrphans` | 1-50 ids | `{removed, skipped: [{id, reason}]}`. Ids are matched against a fresh scan; a worktree with uncommitted changes, one outside the worktree directory, or one of an unknown project is kept |
| `maintenance.backupDatabase()` | `maintenance:backupDatabase` | none | `{saved}`. A native save dialog is shown by main; the renderer supplies no path |

There is deliberately no channel that passes an approval, authorizes a revision, or marks a task completed: `authorizeExecution` and `authorizeRevision` are internal to main.

## Push events (main to renderer)
One fixed channel, `events:app`. The renderer subscribes with `window.orbyte.onEvent(listener)` (returns an unsubscribe function). The preload validates every payload with `appEventSchema` and drops invalid ones. Every event carries `projectId`; the renderer must filter by it. `archive`, `restore` and `setTrust` also push `project_updated` so every open view refreshes. Also `tasks_changed`, `proposals_changed`, `plans_changed` and `executions_changed` (`projectId`, `taskId`) and `agent_changed` (carry `projectId`; `agent_changed` also `agentId`). Terminal output uses a second fixed channel, `events:terminal` (`{agentId, data}`), validated in the preload and delivered only to windows that attached to that agent. Types: `turn_started` (purpose `chat|onboarding|review`), `text_delta`, `tool_activity`, `turn_completed` (`messageId` or null), `turn_error` (`code`, `message`), `project_updated`.

## Error codes in use
Invoke results: `INVALID_INPUT`, `FORBIDDEN` (untrusted sender frame), `INVALID_TOKEN` (unknown, expired, evicted or used), `INVALID_DIRECTORY`, `DIALOG_BUSY`, `ALREADY_REGISTERED`, `NOT_FOUND`, `PROJECT_ARCHIVED`, `TURN_IN_PROGRESS`, `ONBOARDING_IN_PROGRESS` (chat while onboarding runs), `TRUST_REQUIRED` (repo-settings trust is `unset`), `INVALID_DEPENDENCY`, `INVALID_TRANSITION`, `NOT_EDITABLE`, `CONFLICT` (task changed under a move), `INVALID_PROPOSAL`, `ALREADY_DECIDED`, `TOO_MANY_PROPOSALS`, `NOT_GIT_REPO`, `NO_BASE_COMMIT`, `CLAUDE_NOT_FOUND`, `TASK_NOT_READY`, `DEPENDENCIES_INCOMPLETE`, `AGENT_ALREADY_RUNNING`, `TOO_MANY_AGENTS`, `WORKTREE_FAILED`, `WORKTREE_DIRTY` (uncommitted changes, or commits not on the branch), `SPAWN_FAILED`, `SHUTTING_DOWN`, `AGENT_RUNNING`, `NOT_RUNNING`, `NOT_AWAITING_APPROVAL`, `STALE_PLAN`, `PLAN_TAMPERED`, `ALREADY_APPROVED`, `EXECUTION_NOT_AUTHORIZED`, `NOT_IN_REVIEW`, `STALE_RESULT`, `REVIEW_REQUIRED`, `CODE_CHANGED`, `COMPLETION_NOT_AUTHORIZED`, `TASK_ACTIVE` (discard while a task is executing), `ALREADY_RUNNING` (review), `ALREADY_RUNNING` (onboarding), `FORBIDDEN`, `INTERNAL`.
Turn errors (events and stored onboarding errors): `AUTH_REQUIRED`, `SESSION_NOT_FOUND` (handled internally by retrying fresh; surfaces only if the retry also fails), `INTERRUPTED`, `TIMEOUT`, `NO_RESULT`, `TRUST_REQUIRED`, `AGENT_ERROR`, `ONBOARDING_ERROR`.

## Adding a channel
1. Add the channel name to `IPC` in `shared/constants/ipc.ts`.
2. Add Zod input (and output type) in `shared/schemas/`.
3. Add the method to `OrbyteApi` and to the preload, each as a fixed `invoke` of that channel.
4. Register it in `main/ipc/*` through `handle(channel, schema, fn)`. Keep the handler thin and put logic in a service.
5. Add tests for the validation and failure codes.

## Limitations / Planned
- **Limitation:** an in-progress turn is only visible through live events. If the user leaves the project page mid-turn and returns, the partial streamed text is not replayed; the completed message appears in history when the turn finishes.
- **Planned:** terminal data streaming (Phase 4) will need its own per-agent scoped channel design.
