import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const now = sql`(unixepoch() * 1000)`

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  repoPath: text('repo_path').notNull().unique(),
  defaultBranch: text('default_branch'),
  isGitRepo: integer('is_git_repo', { mode: 'boolean' }).notNull(),
  /** Platform-level config (kept separate from repo-owned instructions). */
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  teamLeadSessionId: text('team_lead_session_id'),
  status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
  onboardingStatus: text('onboarding_status', { enum: ['pending', 'in_progress', 'ready', 'failed'] })
    .notNull()
    .default('pending'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now)
})

export const activityEvents = sqliteTable(
  'activity_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: integer('created_at').notNull().default(now)
  },
  (t) => [index('activity_project_idx').on(t.projectId, t.createdAt)]
)
