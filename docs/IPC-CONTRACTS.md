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

| `tasks.list(projectId)` | `tasks:list` | `{projectId}` | `Task[]` |
| `tasks.create(input)` | `tasks:create` | `{projectId, title (1-120), description (<=4000), priority, dependsOnTaskIds (<=20)}` | `Task` (always `source: user`, status `backlog`) |
| `tasks.update(input)` | `tasks:update` | `{projectId, taskId, patch: {title?, description?, priority?, dependsOnTaskIds?}}` | `Task` |
| `tasks.transition(projectId, taskId, to)` | `tasks:transition` | `{projectId, taskId, to}` | `Task`. The handler passes the actor `user`; the orchestrator actor is not reachable from the renderer |
| `tasks.summary()` | `tasks:summary` | none | `{open, byStatus}` across non-archived projects |
| `proposals.list(projectId)` | `proposals:list` | `{projectId}` | `TaskProposal[]` (pending first) |
| `proposals.approve(projectId, proposalId, items)` | `proposals:approve` | `{projectId, proposalId, items: ProposalItem[] (1-20)}` | `Task[]` created. The only way a Team Lead suggestion becomes tasks |
| `proposals.dismiss(projectId, proposalId)` | `proposals:dismiss` | `{projectId, proposalId}` | `TaskProposal` |
| `activity.list(projectId, limit?)` | `activity:list` | `{projectId, limit (1-200)}` | `ActivityEvent[]`, newest first |

| `agents.list(projectId)` | `agents:list` | `{projectId}` | `DeveloperAgent[]` (no session id, base commit or pid) |
| `agents.start(projectId, taskId)` | `agents:start` | `{projectId, taskId}` | `DeveloperAgent`; creates the worktree, moves the task to planning, starts the process |
| `agents.stop(projectId, agentId)` | `agents:stop` | `{projectId, agentId}` | `DeveloperAgent` (it becomes `stopped` when the process exits) |
| `agents.discard(projectId, agentId, force?)` | `agents:discard` | `{projectId, agentId, force?}` | `DeveloperAgent`; removes the worktree, refuses uncommitted changes unless `force` |
| `agents.attach(projectId, agentId)` / `detach` | `agents:attach` / `agents:detach` | `{projectId, agentId}` | `{history, live}` / `null`. Output is pushed only after attaching |
| `agents.write(projectId, agentId, data)` | `agents:write` | `{projectId, agentId, data (<=64KB)}` | `null`. The user typing into the Claude Code session |
| `agents.resize(projectId, agentId, cols, rows)` | `agents:resize` | `cols 20-500, rows 5-200` | `null` |
| `agents.summary()` | `agents:summary` | none | `{running}` |

| `plans.get(projectId, taskId)` | `plans:get` | `{projectId, taskId}` | `PlanBundle`: plan versions (newest first), Team Lead reviews, approval records, the gate verdict (`state`, `executionAuthorized`, `blockers`) and `reviewInProgress` |
| `plans.approve(projectId, taskId, planId)` | `plans:approve` | ids | `PlanApproval`. Only the CURRENT version can be approved. The only way an approval comes into existence |
| `plans.reject(projectId, taskId, planId, reason)` | `plans:reject` | reason 1-1000 characters | `PlanApproval` (status `rejected`) |
| `plans.revoke(projectId, taskId)` | `plans:revoke` | ids | `PlanBundle`. Only while the task awaits approval |
| `plans.requestReview(projectId, taskId, planId)` | `plans:requestReview` | ids | `null`. Asks the Team Lead for advice on the current plan |

There is deliberately no channel to authorize or start execution.

## Push events (main to renderer)
One fixed channel, `events:app`. The renderer subscribes with `window.orbyte.onEvent(listener)` (returns an unsubscribe function). The preload validates every payload with `appEventSchema` and drops invalid ones. Every event carries `projectId`; the renderer must filter by it. `archive`, `restore` and `setTrust` also push `project_updated` so every open view refreshes. Also `tasks_changed`, `proposals_changed`, `plans_changed` (`projectId`, `taskId`) and `agent_changed` (carry `projectId`; `agent_changed` also `agentId`). Terminal output uses a second fixed channel, `events:terminal` (`{agentId, data}`), validated in the preload and delivered only to windows that attached to that agent. Types: `turn_started` (purpose `chat|onboarding|review`), `text_delta`, `tool_activity`, `turn_completed` (`messageId` or null), `turn_error` (`code`, `message`), `project_updated`.

## Error codes in use
Invoke results: `INVALID_INPUT`, `FORBIDDEN` (untrusted sender frame), `INVALID_TOKEN` (unknown, expired, evicted or used), `INVALID_DIRECTORY`, `DIALOG_BUSY`, `ALREADY_REGISTERED`, `NOT_FOUND`, `PROJECT_ARCHIVED`, `TURN_IN_PROGRESS`, `ONBOARDING_IN_PROGRESS` (chat while onboarding runs), `TRUST_REQUIRED` (repo-settings trust is `unset`), `INVALID_DEPENDENCY`, `INVALID_TRANSITION`, `NOT_EDITABLE`, `CONFLICT` (task changed under a move), `INVALID_PROPOSAL`, `ALREADY_DECIDED`, `TOO_MANY_PROPOSALS`, `NOT_GIT_REPO`, `NO_BASE_COMMIT`, `CLAUDE_NOT_FOUND`, `TASK_NOT_READY`, `DEPENDENCIES_INCOMPLETE`, `AGENT_ALREADY_RUNNING`, `TOO_MANY_AGENTS`, `WORKTREE_FAILED`, `WORKTREE_DIRTY` (uncommitted changes, or commits not on the branch), `SPAWN_FAILED`, `SHUTTING_DOWN`, `AGENT_RUNNING`, `NOT_RUNNING`, `NOT_AWAITING_APPROVAL`, `STALE_PLAN`, `PLAN_TAMPERED`, `ALREADY_APPROVED`, `EXECUTION_NOT_AUTHORIZED` (backend only), `ALREADY_RUNNING` (review), `ALREADY_RUNNING` (onboarding), `FORBIDDEN`, `INTERNAL`.
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
