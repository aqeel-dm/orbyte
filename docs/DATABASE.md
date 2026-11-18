# Database

SQLite file `orbyte.db` in `app.getPath('userData')`, accessed with better-sqlite3 through Drizzle (`src/main/database/`).

## Setup (Implemented)
`openDatabase(file, migrationsFolder)` in `client.ts` creates the directory, opens the DB, sets `journal_mode = WAL` and `foreign_keys = ON`, and runs Drizzle migrations. Dev migrations folder: `<appPath>/drizzle`. Packaged: `process.resourcesPath/drizzle` (**Planned**: packaging must ship this folder; no electron-builder config exists yet).

## Tables (Implemented, migration `drizzle/0000_*.sql`)

**projects**: `id` (text PK, uuid), `name`, `description` (default ''), `repo_path` (unique), `default_branch` (nullable), `is_git_repo`, `config` (JSON, default `{}`, platform-level config), `team_lead_session_id` (nullable), `status` (`active|archived`), `onboarding_status` (`pending|in_progress|ready|failed`), `created_at`, `updated_at` (epoch ms, default now).

**activity_events**: `id`, `project_id` (FK to projects, `ON DELETE CASCADE`, nullable), `type`, `payload` (JSON), `created_at`. Index `activity_project_idx (project_id, created_at)`. Currently the only writer emits `project.registered`.

## Access pattern
Queries live in repositories (`modules/projects/repository.ts`). Multi-row writes use `db.transaction`. Row-to-DTO mapping happens in the repository so Drizzle types do not leak past it.

## Migration workflow
1. Edit `src/main/database/schema.ts`.
2. `pnpm db:generate` and commit the new SQL and `drizzle/meta`.
3. Migrations apply at next startup. Never edit an applied migration; add a new one.

## Currently unused
`team_lead_session_id`, `config`, `status = archived`, and `onboarding_status` values other than `pending` have no writer yet.

## Planned tables (not created)
tasks and dependencies, developer agents, plan versions, approvals, execution history, terminal session metadata. Phases 3-6.

## Limitations
- `updated_at` is set only by the column default; no code updates it on writes.
- Removing a project deletes its row and, via cascade, its activity events. The audit trail is lost on removal. Whether to soft-delete is open.
