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

## Push events (main to renderer)
One fixed channel, `events:app`. The renderer subscribes with `window.orbyte.onEvent(listener)` (returns an unsubscribe function). The preload validates every payload with `appEventSchema` and drops invalid ones. Every event carries `projectId`; the renderer must filter by it. `archive`, `restore` and `setTrust` also push `project_updated` so every open view refreshes. Types: `turn_started` (purpose `chat|onboarding`), `text_delta`, `tool_activity`, `turn_completed` (`messageId` or null), `turn_error` (`code`, `message`), `project_updated`.

## Error codes in use
Invoke results: `INVALID_INPUT`, `FORBIDDEN` (untrusted sender frame), `INVALID_TOKEN` (unknown, expired, evicted or used), `INVALID_DIRECTORY`, `DIALOG_BUSY`, `ALREADY_REGISTERED`, `NOT_FOUND`, `PROJECT_ARCHIVED`, `TURN_IN_PROGRESS`, `ONBOARDING_IN_PROGRESS` (chat while onboarding runs), `TRUST_REQUIRED` (repo-settings trust is `unset`), `ALREADY_RUNNING` (onboarding), `FORBIDDEN`, `INTERNAL`.
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
