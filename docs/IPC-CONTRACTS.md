# IPC Contracts

Channels are defined once in `src/shared/constants/ipc.ts`, request/response schemas in `src/shared/schemas/project.ts`, and the renderer-facing type in `src/shared/types/api.ts` (`OrbyteApi`). The preload (`src/preload/index.ts`) maps each method to its channel.

## Envelope (Implemented)
Every handler returns `Result<T>`: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. `handle()` in `src/main/ipc/handle.ts` parses input with Zod and converts failures: `ZodError` to `INVALID_INPUT`, `AppError` to its own code, anything else to `INTERNAL` (logged in main, generic message to the renderer).

## Channels (all Implemented)
| Method on `window.orbyte.projects` | Channel | Input | Output |
|---|---|---|---|
| `list()` | `projects:list` | none | `Project[]` |
| `pickDirectory()` | `projects:pickDirectory` | none | `{cancelled: true}` or `{cancelled: false, token, path, suggestedName, inspection}` |
| `register(input)` | `projects:register` | `{token, name (1-100), description (<=1000, default '')}` | `Project` |
| `remove(id)` | `projects:remove` | `{id}` | `null` |

## Error codes in use
`INVALID_INPUT`, `INVALID_TOKEN` (unknown, expired or already used), `INVALID_DIRECTORY`, `ALREADY_REGISTERED`, `NOT_FOUND`, `INTERNAL`.

## Adding a channel
1. Add the channel name to `IPC` in `shared/constants/ipc.ts`.
2. Add Zod input (and output type) in `shared/schemas/`.
3. Add the method to `OrbyteApi` and to the preload, each as a fixed `invoke` of that channel.
4. Register it in `main/ipc/*` through `handle(channel, schema, fn)`. Keep the handler thin and put logic in a service.
5. Add tests for the validation and failure codes.

## Limitations / Planned
- **Limitation:** handlers do not check the sender frame or origin. Safe only while the app loads nothing but its own bundle in one window.
- **Planned:** event streaming (agent output, terminal data, chat tokens) will need a separate main-to-renderer channel design with per-agent/project scoping. None exists yet.
