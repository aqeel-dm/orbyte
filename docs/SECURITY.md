# Security

Distinguishes what the **code enforces** from what is only an **instruction** to AI tools. Do not describe an instruction as enforcement.

## Code-enforced today (Implemented)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true` (`src/main/app/window.ts`). Verified at runtime: `require`, `process`, `window.electron` are undefined in the renderer.
- Narrow preload: only `window.orbyte.projects.{list,pickDirectory,register,remove}`; no `ipcRenderer`.
- All handlers go through `handle()`: Zod validation, errors mapped to `Result`, internals not leaked.
- No renderer-supplied paths: directories are picked in main and registered by single-use token (10-minute TTL, in memory). Path is re-validated at registration (`realpath` + `isDirectory`).
- Git via `execFile` without a shell, read-only, 10-second timeout.
- Window navigation: `will-navigate` to another URL is prevented; `window.open` is denied (https links open in the system browser).
- CSP meta tag in `src/renderer/index.html` (`default-src 'self'`, `script-src 'self'`).
- Single-instance lock.

## Known gaps (Limitation)
1. No IPC sender/origin check in `handle()`.
2. CSP allows `style-src 'unsafe-inline'` and `connect-src` to localhost in production builds (needed for dev HMR; not tightened per build).
3. `shell.openExternal` accepts any `https://` URL requested by the renderer's window-open.
4. No project-ownership checks exist yet because no per-project resource exists; they are required once tasks, agents and terminals are added.
5. No secrets exist yet. Credentials (Agent SDK/API keys, integrations) must stay in main when introduced.
6. No automated test covers the window security options or the IPC wrapper.
7. The native folder dialog and UI were not exercised end-to-end.

## Required for later phases (Planned; not built, not enforced)
- Approval gate: the orchestrator verifies a stored approval record (task, agent, plan version, reviewer, timestamp) before any execution; changed plans invalidate it. Must be backend logic, not prompt wording.
- Developer agents run in isolated worktrees; one project cannot reach another's resources.
- Validate AI-generated structured actions (task creation, approvals) with Zod before acting.
- The renderer never launches processes; PTY and agent control are main-only and scoped by agent id.

## AI instructions only (not enforced)
Everything in `CLAUDE.md` and `.claude/rules/` is guidance to Claude Code sessions. It reduces mistakes but does not stop one.
