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
- Team Lead and chat output is rendered as plain text (no HTML or markdown rendering), because it is untrusted.

## Team Lead trust model (read this before registering a repository)
- **Project and local settings are loaded** (your choice: user + project + local). A registered repository's `.claude` hooks and settings therefore run under the Team Lead exactly as they would if you ran `claude` there. Only register repositories you trust. Discovery reports whether hooks are configured.
- **User-level settings, skills and plugins also load** (about 30 skills in testing), so behavior can differ per machine. Tools stay read-only regardless.
- **Without `strictMcpConfig` your personal MCP tools (including write-capable ones) were available to the Team Lead** in testing, even with `tools` restricted. `strictMcpConfig` plus `mcp__*` in `disallowedTools` removes them. Do not drop either.
- **Authentication uses your existing Claude Code login** (`apiKeySource: none` in testing). The SDK docs say third-party apps should use an API key (or Bedrock/Vertex) and that Anthropic does not allow third parties to offer claude.ai login without approval. This app is personal and local, and the choice is yours; revisit before distributing it. Setting `ANTHROPIC_API_KEY` in the environment is the documented alternative and needs no code change.
- The Team Lead can **read any file inside the project directory, including secrets such as `.env`**, and file contents are sent to Anthropic as part of the conversation. There is no path filter. Do not register directories containing secrets you would not share.
- Prompt injection from repository content is possible; impact is limited because there are no write or execute tools. Treat its output as untrusted.

## Known gaps (Limitation)
1. `style-src 'unsafe-inline'` remains in the production CSP (inline style attributes from UI components).
2. `name` and `description` are stored unsanitized: safe in React, but untrusted if ever placed into prompts.
3. `git` is resolved from `PATH` with the inherited environment.
4. `repoPath` is validated only at registration. Re-validate on every privileged use once developer agents run (symlink swap). The Team Lead reads `repoPath` at each turn without re-validating it.
5. Auth failure detection is heuristic: it matches error text (`AUTH_REQUIRED`), because the SDK documents no error codes. Real not-signed-in behavior has not been exercised.
6. Resume of a missing session is handled by matching the SDK's current error text ("No conversation found with session ID"), observed in testing but undocumented; it could change.
7. Electron Fuses are not configured; no packaging config exists (the SDK's native `claude` binary will need `asarUnpack` handling in Phase 7).
8. No per-project ownership checks beyond id lookup exist because no per-project resource other than the project itself exists yet; they are required for tasks, agents and terminals.
9. Not covered by automated tests: window/webPreferences options, `installAppSecurity` wiring, the CSP output, a real untrusted-frame IPC call (the check is tested as a pure function, and subframes do not receive the preload API anyway), and the real SDK (tests use a fake runner; the real SDK was exercised manually end to end). The native folder dialog and visual UI polish were not verified.
10. The `projects` row delete path no longer exists in code (archive replaces it), but the database still cascades `chat_messages` and `activity_events` if a project row is ever deleted directly.

## Open findings from the Phase 2 security review (not yet fixed)
Source: read-only `security-reviewer` agent plus mechanical sweep. No critical findings. "Confirmed" means I checked it in the source; "unverified" means it is the reviewer's claim and has not been tested.

1. **Repo-controlled settings run before any trust decision** (medium-high, confirmed in code). `settingSources` includes `project` and `local`, and `env` passes all of `process.env`. A registered repo's hooks (and other settings keys such as `env`, `apiKeyHelper`, `statusLine`, `enabledPlugins`; unverified against SDK docs) can run on the first chat message or onboarding, with Orbyte's environment (including `ANTHROPIC_API_KEY` if set). The UI hook warning appears only after onboarding discovery and only for the `hooks` key. So "read-only by construction" covers the Team Lead's tools, not repo hooks. Candidate fix: per-project trusted flag with a confirmation before the first turn, `['user']` only otherwise, a minimal allowlisted `env`, and discovery flagging more settings keys.
2. **Fire-and-forget failures can leave stuck state** (medium, confirmed). `runTurn` and `OnboardingService.run` have statements outside any `try`; `send` and `start` call them without a catch; there is no `unhandledRejection` handler and the bootstrap (`whenReady().then(bootstrap)`) has no catch. A DB or `webContents.send` error mid-turn can leave the UI in "working" or onboarding `in_progress` until restart. How Electron treats unhandled rejections in main is unverified.
3. **Chat and onboarding race** (medium, confirmed). `send` does not check `onboardingStatus`, and onboarding awaits discovery before taking the turn slot. A chat send in that gap makes onboarding's `runTurn` emit a `turn_error` for the project, and the chat hook does not compare `turnId` on terminal events, so it resets the running chat turn's UI and shows an error.
4. **Read containment is not enforced by Orbyte** (medium, unverified). Whether `Read` can follow a symlink inside the repo to a file outside it, or whether a user-level `permissions.allow`/`additionalDirectories` widens it, has not been tested. Whether `mcp__*` works as a wildcard is also unverified (`strictMcpConfig` is the real control; in testing the tool list was exactly `Glob, Grep, Read`).
5. **Active turns are not aborted on quit** (medium-low, confirmed): `before-quit` only closes the DB, so the `claude` subprocess can be orphaned and later writes hit a closed DB.
6. **Internal error text reaches the renderer and DB** (low-medium, confirmed): SDK/runtime `err.message` and result text are passed through verbatim to `turn_error` and `onboardingData.error`, and may include paths.
7. **Discovery names are put into the onboarding prompt without bounds or sanitizing** (low): `.claude` listings are uncapped and names can contain newlines or instruction text.
8. **Discovery limits are incomplete** (low): no per-directory entry cap or time limit; a read-after-stat window in `hasHooksKey`; `inside()` mishandles a root of `/`.
9. **No wall-clock limit on chat turns** (low): a hung SDK pins the turn until the user clicks Stop; chat has no `maxTurns`.
10. **Smaller items** (low): events broadcast to all windows (fine for one window); `teamLeadSessionId` is sent to the renderer unnecessarily and `onboardingData` is not validated on read; a resume fallback silently loses model context while the chat history still shows old messages; chat and onboarding text, which may include secrets the Team Lead read, is stored unencrypted in `orbyte.db`.

## Fixed in this phase
IPC sender validation, archive instead of delete (history kept), `updated_at` maintenance, git hardening for existing commands.

## Required for later phases (Planned; not built, not enforced)
- Approval gate: the orchestrator verifies a stored approval record (task, agent, plan version, reviewer, timestamp) before any execution; changed plans invalidate it. Must be backend logic, not prompt wording.
- Developer agents run in isolated worktrees; one project cannot reach another's resources.
- Validate AI-generated structured actions (task creation, approvals) with Zod before acting.
- The renderer never launches processes; PTY and agent control are main-only and scoped by agent id.
- Treat repository content and agent output as untrusted when rendering or when building prompts.

## AI instructions only (not enforced)
Everything in `CLAUDE.md` and `.claude/rules/` is guidance to Claude Code sessions. It reduces mistakes but does not stop one.
