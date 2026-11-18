# Security

Distinguishes what the **code enforces** from what is only an **instruction** to AI tools. Do not describe an instruction as enforcement.
Last reviewed: Phase 1 security review (read-only agent review plus grep sweep). No critical or high findings.

## Code-enforced today (Implemented)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `webviewTag: false` (`src/main/app/window.ts`). `require`, `process` and `window.electron` being undefined in the renderer was checked **manually** over the DevTools protocol (built and dev modes); no automated test covers it.
- Narrow preload: only `window.orbyte.projects.{list,pickDirectory,register,remove}`; no `ipcRenderer`.
- All handlers go through `handle()`: Zod validation, errors mapped to `Result`. Unexpected errors reach the renderer only as a generic `INTERNAL` message; full errors are logged in main (`console.error`).
- No renderer-supplied paths: directories are picked in main and registered by single-use token (10-minute TTL, in memory, at most 20 pending, oldest evicted). Only one directory selection can be in progress (`DIALOG_BUSY`). Path is re-validated at registration (`realpath` + `isDirectory`).
- `token` and `id` inputs are limited to 64 characters.
- App-wide guards on **every** web contents (`src/main/app/security.ts`, registered before any window): `will-navigate`, `will-redirect` and `will-frame-navigate` are prevented unless the URL is the app's own entry; `will-attach-webview` is prevented; `window.open` is denied; only well-formed `https:` URLs without credentials open externally. Rules are in `app/navigation-policy.ts` (unit-tested).
- Permissions: deny-all request and check handlers on the default session.
- Git runs through `execFile` with an argument array, no shell, 10-second timeout. The commands used (`rev-parse`, `symbolic-ref`) are read-only. This does not guarantee git itself runs nothing: repository config can make git execute programs (see gaps).
- CSP is injected into `index.html` at build time (`electron.vite.config.ts`). Production: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. The dev server gets a looser CSP (inline scripts, localhost websockets) that is not present in built output.
- Single-instance lock.
- SQL goes through Drizzle (parameterized); `foreign_keys = ON`; `repo_path` has a unique index.

## Known gaps (Limitation)
1. **No IPC sender/origin check** in `handle()`. Acceptable only while the app loads nothing but its own bundle in one window.
2. **`style-src 'unsafe-inline'`** remains in the production CSP (inline style attributes from UI components). Tighten if possible.
3. **Input quality:** `name` and `description` are stored unsanitized: safe in React, but untrusted if ever placed into prompts (Phase 2+).
4. **Git hardening:** `git` is resolved from `PATH` with the inherited environment, and repository-controlled config (for example `core.fsmonitor`) can cause git to run programs. Not demonstrated for the commands currently used (a scratch-repo test did not trigger it), but unproven for `status`/`diff`. Harden (`-c core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, no hooks) before adding any new git command.
5. **`repoPath` is validated only at registration.** Re-validate on every privileged use once agents run (symlink swap).
6. **Project removal** has no ownership concept and cascade-deletes `activity_events` (audit trail lost).
7. **Electron Fuses** are not configured (unverified; no build/packaging config exists yet).
8. No per-project ownership checks exist because no per-project resource exists yet. They are required once tasks, agents and terminals are added.
9. No secrets exist yet. Credentials (Agent SDK/API keys, integrations) must stay in main when introduced.
10. Not covered by automated tests: window/webPreferences options, `installAppSecurity` wiring, the CSP output, the IPC wrapper. Navigation, `window.open`, permission denial and CSP were verified manually over the DevTools protocol. The native folder dialog and UI were not exercised end-to-end.

## Fixed after the Phase 1 review
`openExternal` URL parsing, origin-based navigation guards with redirect/frame/webview coverage, global `web-contents-created` guard, deny-all permissions, strict production CSP, pending-token cap, single-dialog lock, id/token length limits, restoring a minimized window on `second-instance`.

## Required for later phases (Planned; not built, not enforced)
- Approval gate: the orchestrator verifies a stored approval record (task, agent, plan version, reviewer, timestamp) before any execution; changed plans invalidate it. Must be backend logic, not prompt wording.
- Developer agents run in isolated worktrees; one project cannot reach another's resources.
- Validate AI-generated structured actions (task creation, approvals) with Zod before acting.
- The renderer never launches processes; PTY and agent control are main-only and scoped by agent id.
- Treat repository content and agent output as untrusted when rendering or when building prompts.

## AI instructions only (not enforced)
Everything in `CLAUDE.md` and `.claude/rules/` is guidance to Claude Code sessions. It reduces mistakes but does not stop one.
