# Database

SQLite file `orbyte.db` in `app.getPath('userData')`, accessed with better-sqlite3 through Drizzle (`src/main/database/`).

## Setup (Implemented)
`openDatabase(file, migrationsFolder)` in `client.ts` creates the directory, opens the DB, sets `journal_mode = WAL` and `foreign_keys = ON`, and runs Drizzle migrations. Dev migrations folder: `<appPath>/drizzle`. Packaged: `process.resourcesPath/drizzle` (**Planned**: packaging must ship this folder; no electron-builder config exists yet).

## Tables (Implemented, migrations `0000` to `0006`)

**projects**: `id` (text PK, uuid), `name`, `description` (default ''), `repo_path` (unique), `default_branch` (nullable), `is_git_repo`, `config` (JSON, default `{}`, platform-level config, unused), `team_lead_session_id` (nullable, the SDK session to resume), `repo_settings_trust` (`unset|trusted|untrusted`, default `unset`, migration 0002; gates the Team Lead), `onboarding_data` (JSON, nullable: discovery result, Team Lead summary, proposed workflow guidance, error, timestamps; migration 0001), `status` (`active|archived`), `onboarding_status` (`pending|in_progress|ready|failed`), `created_at`, `updated_at` (epoch ms, default now).

**chat_messages** (migration 0001): `id`, `project_id` (FK to projects, `ON DELETE CASCADE`, not null), `role` (`user|assistant`), `content`, `created_at`. Index `chat_project_idx (project_id, created_at)`. Listed oldest first by `created_at` then `rowid` (insertion order; same-millisecond ties). Holds what the user saw; the model's own context lives in the SDK session file under `~/.claude/projects/`.

**tasks** (migration 0003): `id`, `project_id` (FK cascade), `title`, `description`, `status` (nine values, see `src/shared/task-state.ts`), `priority` (`low|medium|high|urgent`), `source` (`user|team_lead`, provenance), `assigned_agent_id`, `implementation_plan`, `approval_status` (`none|pending|approved|rejected`), `execution_status` (`idle|running|succeeded|failed|interrupted`), `result_summary`, `created_at`, `updated_at`. Index `tasks_project_idx (project_id, status)`. `execution_status` `succeeded` means the run produced a result, not that tests passed. Tasks are never deleted (cancel instead).

**task_dependencies**: `(task_id, depends_on_task_id)` primary key, both FK cascade, `CHECK (task_id <> depends_on_task_id)`. Existence, same-project, not-cancelled and cycle checks are enforced in `modules/tasks/dependencies.ts`, not by the database.

**task_proposals**: `id`, `project_id` (FK cascade), `summary`, `items` (JSON array of proposal items), `status` (`pending|approved|dismissed`), `created_task_ids` (JSON), `created_at`, `decided_at`. A proposal is a Team Lead suggestion; it is not a task.

**developer_agents** (migration 0004): `id`, `project_id` and `task_id` (FKs, cascade), `name`, `status` (`starting|running|exited|failed|stopped|interrupted`), `pid`, `claude_session_id` (the id Orbyte passes with `--session-id`, for resuming; never sent to the renderer), `worktree_path`, `branch`, `base_branch`, `base_commit`, `worktree_removed`, `current_activity`, `exit_code`, `started_at`, `ended_at`, timestamps. Indexes: `agents_project_idx`, and a **partial unique index** `agents_one_active_per_task` (one `starting`/`running` agent per task). Terminal output is not in the database: it is saved at exit as a file under `userData/terminal-logs/<agentId>.log`.

**task_plans** (migration 0005): `id`, `project_id`, `task_id`, `agent_id` (FKs, cascade), `version` (1, 2, 3 per task; unique with `task_id`), `content` (JSON: summary, steps, files, tests, risks), `content_hash` (sha256 of the canonical content), `status` (`current|superseded`), `submitted_at`. A changed plan is always a new version.

**plan_reviews**: the Team Lead's advice: `plan_id` (FK), `plan_version`, `reviewer` (`team_lead` only), `recommendation` (`approve|revise|reject`), `summary`, `concerns` (JSON), `created_at`. Advice never authorizes anything.

**plan_approvals**: the user's decisions: `task_id`, `agent_id`, `plan_id`, `plan_version`, `plan_hash`, `reviewer` (`user` only), `status` (`approved|rejected`), `reason`, `decided_at`, `invalidated_at`, `invalidation_reason`. A **partial unique index** `approvals_one_valid_per_task` allows at most one approved, non-invalidated row per task. Invalidated means superseded by a new plan version, revoked, rejected, consumed by an execution start, or the task left awaiting approval.

**developer_agents.kind** (migration 0006): `planning` or `execution`. An execution agent is a new row that shares the planning agent's worktree, branch and base commit.

**executions** (0006): one run of an execution agent: `project_id`, `task_id`, `agent_id` (unique), `plan_id`, `plan_version`, `plan_hash`, `approval_id` (null for a revision run authorized by a change request), `status` (`running|result_submitted|ended_without_result|stopped|failed`), `feedback`, `started_at`, `ended_at`. **execution_progress**: the agent's own progress notes (capped at 200 per run). **execution_results**: numbered versions per task (unique with `task_id`): `summary` and `tests` (the agent's claims), `evidence` (JSON collected by Orbyte from git), `snapshot_hash`, `status` (`current|superseded`). **result_reviews**: the Team Lead's advice (`recommendation`, `summary`, `concerns`). **result_decisions**: the user's decisions (`accepted|changes_requested`, `snapshot_hash`, `feedback`, `invalidated_at`); a **partial unique index** `decisions_one_valid_acceptance` allows one valid acceptance per task.

**activity_events**: `id`, `project_id` (FK to projects, `ON DELETE CASCADE`, nullable), `type`, `payload` (JSON), `created_at`. Index `activity_project_idx (project_id, created_at)`. Event types written: `project.registered`, `project.archived`, `project.restored`, `onboarding.started`, `onboarding.discovered`, `onboarding.completed`, `onboarding.failed`, `onboarding.interrupted`, `teamlead.session_started`, `teamlead.session_cleared`, `project.trust_changed`, `task.created`, `task.updated`, `task.transitioned` (from, to, actor), `proposal.recorded`, `proposal.approved`, `proposal.dismissed`, `agent.created`, `agent.started`, `agent.exited`, `agent.failed`, `agent.stopped`, `agent.interrupted`, `agent.worktree_removed`, `plan.submitted`, `plan.reviewed`, `plan.approved`, `plan.rejected`, `approval.invalidated`, `execution.authorized`, `execution.started`, `execution.ended`, `execution.revision_authorized`, `result.submitted`, `result.reviewed`, `result.accepted`, `result.changes_requested`, `acceptance.invalidated`, `recovery.completed` (startup summary: interrupted agents and runs, orphan inboxes removed, orphan worktrees found; no project id).

## Access pattern
Queries live in repositories (`modules/projects/repository.ts`). Multi-row writes use `db.transaction`. Row-to-DTO mapping happens in the repository so Drizzle types do not leak past it.

## Migration workflow
1. Edit `src/main/database/schema.ts`.
2. `pnpm db:generate` and commit the new SQL and `drizzle/meta`.
3. Migrations apply at next startup. Never edit an applied migration; add a new one.

## Currently unused
`config` has no writer yet.

## Planned tables (not created)
tasks and dependencies, developer agents, plan versions, approvals, execution history, terminal session metadata. Phases 3-6.

## Limitations
- Projects are archived (`status = 'archived'`), never deleted by the app, so history is kept. A direct row delete would still cascade to `chat_messages` and `activity_events`.
- `updated_at` is set explicitly by every repository update path.
- Onboarding left `in_progress` by an app exit is marked `failed` with error code `INTERRUPTED` at next startup.
- Migrations 0001 to 0005 are additive (0002 adds `repo_settings_trust` with default `unset`, so existing projects must be decided on before the Team Lead runs). (new table, one nullable column); a test upgrades a real 0000-era database and checks the existing row survives.
