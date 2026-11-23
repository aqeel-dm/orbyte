# Security

Distinguishes what the **code enforces** from what is only an **instruction** to AI tools. Do not describe an instruction as enforcement.
Last reviewed: Phase 1 security review (read-only agent review plus grep sweep). No critical or high findings.

## Code-enforced today (Implemented)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `webviewTag: false` (`src/main/app/window.ts`). `require`, `process` and `window.electron` being undefined in the renderer was checked **manually** over the DevTools protocol (built and dev modes); no automated test covers it.
- Narrow preload: only `window.orbyte.{projects,onboarding,teamLead,onEvent}` with fixed methods; no `ipcRenderer`. Incoming push events are re-validated with Zod in the preload and malformed ones are dropped.
- All handlers go through `handle()`: **IPC sender check** (only the top-level frame of the app's own page; fails closed until the app entry is set; `isTrustedFrame` is unit-tested as a pure function), Zod validation, errors mapped to `Result`. Unexpected errors reach the renderer only as a generic `INTERNAL` message; full errors are logged in main.
- No renderer-supplied paths: directories are picked in main and registered by single-use token (10-minute TTL, in memory, at most 20 pending, oldest evicted). Only one directory selection at a time (`DIALOG_BUSY`). Path is re-validated at registration (`realpath` + `isDirectory`).
- Input limits: `token`/`id`/`projectId` at most 64 characters; chat messages 1-20,000 characters.
- App-wide guards on **every** web contents (`src/main/app/security.ts`, registered before any window): navigation, redirect and frame navigation are prevented unless the URL is the app's own entry; webviews are prevented; `window.open` is denied; only well-formed `https:` URLs without credentials open externally. Rules are in `app/navigation-policy.ts` (unit-tested). Deny-all permission handlers on the default session.
- Git runs through `execFile` with an argument array, no shell, 10-second timeout, `-c core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`. Commands used (`rev-parse`, `symbolic-ref`) are read-only.
- CSP is injected at build time (`electron.vite.config.ts`). Production: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. The dev server gets a looser CSP that is not in built output.
- Single-instance lock. SQL goes through Drizzle (parameterized); `foreign_keys = ON`; `repo_path` is unique.
- **Team Lead is read-only by construction** (`src/main/modules/agents/team-lead/options.ts`, asserted by tests): `tools: [Read, Glob, Grep]`, `disallowedTools` includes `Edit, Write, NotebookEdit, Bash, mcp__*`, `strictMcpConfig: true`, `permissionMode: 'dontAsk'`, no `allowedTools`. Verified against the real SDK: the init message listed exactly `Glob, Grep, Read`, and an edit request was refused with no file created. This is SDK-enforced tool removal, not a prompt rule.
- Discovery (`modules/projects/discovery.ts`) is read-only and bounded (depth 3, 400 dirs, 25 CLAUDE.md files); it never follows symlinks out of the repo and never writes. Onboarding output is stored in Orbyte's database only, never in the repository.
- **Team Lead failure handling:** one turn per project; turns time out after 15 minutes (`TIMEOUT`) and chat turns are capped at 40 agent turns; `runTurn` never rejects (failures become `turn_error` and free the turn slot); a throwing event emit cannot break a turn; chat is refused while onboarding runs; refused turns emit no events; raw SDK/runtime error text is logged in main only and the renderer receives fixed messages per error code; the main process logs unhandled rejections, shows an error dialog and exits if startup fails, and on quit aborts in-flight turns (waiting up to 3 seconds) before closing the database.
- Team Lead and chat output is rendered as plain text (no HTML or markdown rendering), because it is untrusted.

## Team Lead trust model (read this before registering a repository)
- **Repo settings are opt-in per project.** Each project has `repoSettingsTrust`: `unset` (default), `trusted`, or `untrusted`. While `unset`, the Team Lead and onboarding are refused (`TRUST_REQUIRED`), enforced in main (`TeamLeadService`, `OnboardingService`) and mirrored in the UI. `trusted` loads user + project + local settings (what you chose), so the repo's hooks and settings run as they would if you ran `claude` there. `untrusted` loads user settings only. The prompt lists what the repo would bring (CLAUDE.md count, `.claude/`, and risky settings keys: `hooks`, `env`, `apiKeyHelper`, `statusLine`, `enabledPlugins`, `permissions`; names only). Existing projects upgrade to `unset`.
- **When trusted, hooks inherit Orbyte's full environment** (`env: {...process.env}`), including `ANTHROPIC_API_KEY` if set. That is the cost of trusting a repo; trust only repositories you own or have reviewed. When untrusted, only your own user-level hooks can run.
- **User-level settings, skills and plugins always load** (about 30 skills in testing), so behavior can differ per machine. Tools stay read-only regardless.
- **Without `strictMcpConfig` your personal MCP tools (including write-capable ones) were available to the Team Lead** in testing, even with `tools` restricted. `strictMcpConfig` plus `mcp__*` in `disallowedTools` removes them (verified: tool list is exactly `Glob, Grep, Read`; whether `mcp__*` works as a wildcard on its own was not tested separately, `strictMcpConfig` is the real control). Do not drop either.
- **Read containment was tested, on this machine only.** With the exact Team Lead options and this machine's user settings, `Read` of a symlink to a file outside the repo, of a symlinked directory, and of an absolute path outside the repo were all denied (`dontAsk`), while an inside file read worked; a canary string in the outside file never leaked. A user-level `permissions.allow` or `additionalDirectories` rule on another machine could widen this; Orbyte does not enforce containment itself.
- **Authentication uses your existing Claude Code login** (`apiKeySource: none` in testing). The SDK docs say third-party apps should use an API key (or Bedrock/Vertex) and that Anthropic does not allow third parties to offer claude.ai login without approval. This app is personal and local, and the choice is yours; revisit before distributing it. `ANTHROPIC_API_KEY` in the environment is the documented alternative and needs no code change.
- The Team Lead can **read any file inside the project directory, including secrets such as `.env`**, and file contents are sent to Anthropic as part of the conversation. There is no path filter. Chat and onboarding text (which may contain such content) is stored unencrypted in `orbyte.db`.
- Prompt injection from repository content is possible; impact is limited because there are no write or execute tools. Discovery names placed in the onboarding prompt are sanitized (character set, length, count), which neutralizes structure (newlines, punctuation) but cannot remove plain instruction-like words. Treat output as untrusted.

## Known gaps (Limitation)
1. `style-src 'unsafe-inline'` remains in the production CSP (inline style attributes from UI components).
2. `name` and `description` are stored unsanitized: safe in React, but untrusted if ever placed into prompts.
3. `git` is resolved from `PATH` with the inherited environment.
4. `repoPath` is validated only at registration. Re-validate on every privileged use once developer agents run (symlink swap). The Team Lead reads `repoPath` at each turn without re-validating it.
5. Auth failure detection is heuristic (matches error text, `AUTH_REQUIRED`); real not-signed-in behavior has not been exercised. The "session not found" fallback matches the SDK's current error text, observed but undocumented.
6. Electron Fuses are not configured; no packaging config exists (the SDK's native `claude` binary will need `asarUnpack` handling in Phase 7).
7. No per-project ownership checks beyond id lookup exist because no per-project resource other than the project itself exists yet; they are required for tasks, agents and terminals.
8. Smaller, not fixed: `teamLeadSessionId` is sent to the renderer though unused; `onboardingData` is not validated on read; events are broadcast to all windows (fine for one window); `useTeamLeadChat` does not reset when `projectId` changes (not reachable today, the route remounts); a resume fallback silently loses model context while chat history still shows old messages; an in-progress turn's partial text is not replayed if you leave and return to the page.
9. Not covered by automated tests: window/webPreferences options, `installAppSecurity` wiring, CSP output, a real untrusted-frame IPC call (tested only as a pure function; subframes do not receive the preload API), the real SDK (tests use a fake runner; it was exercised manually), and the quit path (`before-quit` wiring was not exercised in a running app; `TeamLeadService.shutdown` is unit-tested). The native folder dialog and visual UI polish were not verified.
10. The database would still cascade `chat_messages` and `activity_events` if a project row were deleted directly (the app never does; it archives).

## Fixed
- Phase 1 review (earlier): navigation/redirect/webview guards, strict production CSP, deny-all permissions, URL parsing for `openExternal`, token cap and single-dialog lock, id/token length limits.
- Phase 2 (this branch): IPC sender validation, archive instead of delete, `updated_at` maintenance, git hardening, per-project repo-settings trust gate, stuck-state and unhandled-rejection protection, onboarding/chat collision, graceful quit, turn timeout, no raw error text to the renderer, discovery limits and prompt sanitizing, read-containment verified.

## Required for later phases (Planned; not built, not enforced)
- Approval gate: the orchestrator verifies a stored approval record (task, agent, plan version, reviewer, timestamp) before any execution; changed plans invalidate it. Must be backend logic, not prompt wording.
- Developer agents run in isolated worktrees; one project cannot reach another's resources.
- Validate AI-generated structured actions (task creation, approvals) with Zod before acting.
- The renderer never launches processes; PTY and agent control are main-only and scoped by agent id.
- Treat repository content and agent output as untrusted when rendering or when building prompts.

## AI instructions only (not enforced)
Everything in `CLAUDE.md` and `.claude/rules/` is guidance to Claude Code sessions. It reduces mistakes but does not stop one.
