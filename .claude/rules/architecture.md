# Architecture rules

- Main process (`src/main`) owns every privileged operation: database, git, filesystem, processes, credentials. The renderer owns UI only.
- No HTTP/backend server. Renderer and main communicate only over typed Electron IPC.
- Keep `src/main/index.ts` thin (bootstrap only). Put logic in `modules/<name>/` as a `repository` (queries) plus a `service` (rules). IPC handlers in `src/main/ipc/` stay thin: validate, call a service, return.
- `src/shared` is the contract (schemas, types, channel names). It must not import from `main`, `preload` or `renderer`.
- No business logic in React components. Components call `window.orbyte` through hooks in `src/renderer/hooks` or `features/*`.
- Team Leads (Claude Agent SDK sessions) and developer agents (Claude Code CLI in node-pty) are separate mechanisms. Do not unify them behind one abstraction.
- Keep task or integration models provider-neutral; any Jira/Linear/GitHub integration goes behind an adapter interface.
- Do not add modules, tables, dependencies or abstractions for a phase that has not been authorized. Check `docs/ROADMAP.md`.
- Update the matching file in `docs/` when you change architecture, schema, IPC or security behavior. Mark planned work as Planned, never as Implemented.
