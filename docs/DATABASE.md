# Database

SQLite file `orbyte.db` in `app.getPath('userData')`, accessed with better-sqlite3 through Drizzle (`src/main/database/`).

## Setup (Implemented)
`openDatabase(file, migrationsFolder)` in `client.ts` creates the directory, opens the DB, sets `journal_mode = WAL` and `foreign_keys = ON`, and runs Drizzle migrations. Dev migrations folder: `<appPath>/drizzle`. Packaged: `process.resourcesPath/drizzle` (**Planned**: packaging must ship this folder; no electron-builder config exists yet).

## Tables (Implemented, migrations `0000` and `0001`)

**projects**: `id` (text PK, uuid), `name`, `description` (default ''), `repo_path` (unique), `default_branch` (nullable), `is_git_repo`, `config` (JSON, default `{}`, platform-level config, unused), `team_lead_session_id` (nullable, the SDK session to resume), `onboarding_data` (JSON, nullable: discovery result, Team Lead summary, proposed workflow guidance, error, timestamps; migration 0001), `status` (`active|archived`), `onboarding_status` (`pending|in_progress|ready|failed`), `created_at`, `updated_at` (epoch ms, default now).

**chat_messages** (migration 0001): `id`, `project_id` (FK to projects, `ON DELETE CASCADE`, not null), `role` (`user|assistant`), `content`, `created_at`. Index `chat_project_idx (project_id, created_at)`. Listed oldest first by `created_at` then `rowid` (insertion order; same-millisecond ties). Holds what the user saw; the model's own context lives in the SDK session file under `~/.claude/projects/`.

**activity_events**: `id`, `project_id` (FK to projects, `ON DELETE CASCADE`, nullable), `type`, `payload` (JSON), `created_at`. Index `activity_project_idx (project_id, created_at)`. Event types written: `project.registered`, `project.archived`, `project.restored`, `onboarding.started`, `onboarding.discovered`, `onboarding.completed`, `onboarding.failed`, `onboarding.interrupted`, `teamlead.session_started`, `teamlead.session_cleared`.

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
- Migration 0001 is additive (new table, one nullable column); a test upgrades a real 0000-era database and checks the existing row survives.
