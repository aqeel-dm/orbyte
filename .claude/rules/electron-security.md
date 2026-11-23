---
paths:
  - "src/main/**"
  - "src/preload/**"
  - "src/shared/**"
  - "src/renderer/index.html"
---

# Electron security rules

- Never weaken `webPreferences` in `src/main/app/window.ts`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `webviewTag: false`.
- Never expose `ipcRenderer`, `require`, or a generic invoke/send in the preload. Expose fixed named methods that call fixed channels.
- Every new channel needs all of: a constant in `src/shared/constants/ipc.ts`, a Zod schema in `src/shared/schemas/`, a method on `OrbyteApi`, and registration through `handle()` in `src/main/ipc/handle.ts`. Never call `ipcMain.handle` directly.
- Never accept a filesystem path, shell command, or executable from the renderer for a privileged action. Use main-side selection plus opaque tokens/ids, as `ProjectService.prepare/register` does.
- Spawn processes with `execFile`/`spawn` and an argument array. Never use `exec` or `shell: true`. Set timeouts.
- Any operation on a project resource must verify that the resource belongs to the given project id. Never let one project reach another's files, worktrees, agents or terminals.
- Validate AI-generated structured output (tasks, approvals, plans) with Zod before acting on it.
- Credentials and API keys stay in main. Never send them over IPC or log them.
- Return errors as `Result` with a stable `code`. Do not leak stack traces or internal paths to the renderer.
- Do not loosen the CSP (`electron.vite.config.ts`) or the guards in `src/main/app/security.ts`, or add `openExternal`/navigation paths, without recording the change in `docs/SECURITY.md`.
- Keep the Team Lead read-only. Do not change `src/main/modules/agents/team-lead/options.ts` to add tools, `allowedTools`, `bypassPermissions`, or remove `strictMcpConfig` / `mcp__*` from `disallowedTools` without updating `docs/SECURITY.md` and the options test.
- Approval for execution must be a backend check against a stored record. Prompt text or permission modes are never the enforcement.
