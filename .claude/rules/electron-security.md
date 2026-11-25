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
- Keep the Team Lead read-only. Do not change `src/main/modules/agents/team-lead/options.ts` to add built-in tools, `bypassPermissions`, or remove `strictMcpConfig`. `allowedTools` may list only Orbyte's own tools (`TEAM_LEAD_TOOL_NAMES`), only for chat turns. Update `docs/SECURITY.md` and the options test with any change.
- Task authorization: the Team Lead may only record proposals. Tasks are created only by `ProposalService.approve` (user action) or `TaskService.create` (user action from the renderer). Bind project ids server-side in tools; never accept a project id from the model. Task and proposal operations must verify the record's project id and return the same error as for a missing record.
- Never load repo-owned Claude settings for a project unless `repoSettingsTrust === 'trusted'` (`options.ts` and the gates in `TeamLeadService`/`OnboardingService`). Never send raw SDK/runtime error text to the renderer; map it to a fixed message and log the detail in main.
- Developer agents: start the real `claude` CLI directly with a fixed argument array from `launch.ts` (never a shell, never a renderer-supplied command or path); never add `--dangerously-skip-permissions`, bypass or accept-edits modes to the planning launch, and never drop `--tools=Read,Glob,Grep` or `--strict-mcp-config` from it; keep the environment an exact allowlist; run git for worktrees only through `GitWorktrees`; check the project id on every agent and terminal call; deliver terminal output only to windows that attached to that agent. Record any change in `docs/SECURITY.md`.
- Plans and approvals: only the user's `plans:approve` may create an approval record; the Team Lead's review and the agent's plan never can. Only `ApprovalService.authorizeExecution` passes `approvalVerified: true`, after `verify` re-checks the stored state; never expose it to the renderer. Review turns run in a fresh unsaved session with only the review tool. Keep the planning launch to `--tools=Read,Glob,Grep`, `--strict-mcp-config`, and Orbyte's own plan server.
- Approval for execution must be a backend check against a stored record. Prompt text or permission modes are never the enforcement.
- Execution and completion: only `CompletionService` passes `completionVerified: true`; completing needs a Team Lead review of the current result, the user's acceptance, and an unchanged fresh git snapshot. Treat everything an execution agent reports as an unverified claim and label it so. Never pre-approve a Bash prefix in the execution launch, never let the agent edit `.claude/**`, `.mcp.json` or `.git`, and run evidence git only through `GitWorktrees.snapshot` (inherited `GIT_*` stripped, config off, `.git` pointer verified). Record any change in `docs/SECURITY.md`.
- Logging and maintenance: use `log` from `src/main/logging/logger.ts`, never `console`, in main (logs are redacted and private; never log secrets or full environments). Maintenance actions take ids from a fresh scan, never paths from the renderer, stay inside Orbyte's own directories, and never delete a worktree with uncommitted changes.
