import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { OnboardingData } from '@shared/schemas/onboarding'
import type { SubmittedPlan } from '@shared/schemas/plan'
import type { ProposalItem } from '@shared/schemas/task'

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
  /** Onboarding findings and Team Lead summary. Orbyte-owned; never written into the repo. */
  onboardingData: text('onboarding_data', { mode: 'json' }).$type<OnboardingData>(),
  status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
  /** unset = Team Lead blocked until the user decides; trusted loads repo settings; untrusted ignores them. */
  repoSettingsTrust: text('repo_settings_trust', { enum: ['unset', 'trusted', 'untrusted'] }).notNull().default('unset'),
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

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull().default(now)
  },
  (t) => [index('chat_project_idx').on(t.projectId, t.createdAt)]
)

const taskStatuses = [
  'backlog', 'ready', 'planning', 'awaiting_approval', 'in_progress', 'in_review', 'blocked', 'completed', 'cancelled'
] as const

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: taskStatuses }).notNull().default('backlog'),
    priority: text('priority', { enum: ['low', 'medium', 'high', 'urgent'] }).notNull().default('medium'),
    /** Provenance: who created the task. */
    source: text('source', { enum: ['user', 'team_lead'] }).notNull(),
    /** Stored for later phases (4-6); nothing writes these yet except their defaults. */
    assignedAgentId: text('assigned_agent_id'),
    implementationPlan: text('implementation_plan'),
    approvalStatus: text('approval_status', { enum: ['none', 'pending', 'approved', 'rejected'] }).notNull().default('none'),
    executionStatus: text('execution_status', { enum: ['idle', 'running', 'succeeded', 'failed', 'interrupted'] }).notNull().default('idle'),
    resultSummary: text('result_summary'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now)
  },
  (t) => [index('tasks_project_idx').on(t.projectId, t.status)]
)

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: text('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' })
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }), check('task_dependencies_no_self', sql`${t.taskId} <> ${t.dependsOnTaskId}`)]
)

export const taskProposals = sqliteTable(
  'task_proposals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull().default(''),
    items: text('items', { mode: 'json' }).$type<ProposalItem[]>().notNull(),
    status: text('status', { enum: ['pending', 'approved', 'dismissed'] }).notNull().default('pending'),
    createdTaskIds: text('created_task_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: integer('created_at').notNull().default(now),
    decidedAt: integer('decided_at')
  },
  (t) => [index('proposals_project_idx').on(t.projectId, t.status)]
)

export const developerAgents = sqliteTable(
  'developer_agents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['starting', 'running', 'exited', 'failed', 'stopped', 'interrupted'] }).notNull(),
    pid: integer('pid'),
    /** The Claude Code session id Orbyte chose with --session-id (for resuming later). Never sent to the renderer. */
    claudeSessionId: text('claude_session_id').notNull(),
    worktreePath: text('worktree_path').notNull(),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    baseCommit: text('base_commit').notNull(),
    worktreeRemoved: integer('worktree_removed', { mode: 'boolean' }).notNull().default(false),
    currentActivity: text('current_activity').notNull().default(''),
    exitCode: integer('exit_code'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now)
  },
  (t) => [
    index('agents_project_idx').on(t.projectId, t.status),
    // At most one live agent per task, enforced by the database as well as the service.
    uniqueIndex('agents_one_active_per_task').on(t.taskId).where(sql`${t.status} in ('starting', 'running')`)
  ]
)

export const taskPlans = sqliteTable(
  'task_plans',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull().references(() => developerAgents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content', { mode: 'json' }).$type<SubmittedPlan>().notNull(),
    /** sha256 of the canonical plan content; approvals are tied to it and re-checked by the gate. */
    contentHash: text('content_hash').notNull(),
    status: text('status', { enum: ['current', 'superseded'] }).notNull().default('current'),
    submittedAt: integer('submitted_at').notNull().default(now)
  },
  (t) => [uniqueIndex('plans_task_version').on(t.taskId, t.version), index('plans_task_status_idx').on(t.taskId, t.status)]
)

export const planReviews = sqliteTable(
  'plan_reviews',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    planId: text('plan_id').notNull().references(() => taskPlans.id, { onDelete: 'cascade' }),
    planVersion: integer('plan_version').notNull(),
    reviewer: text('reviewer', { enum: ['team_lead'] }).notNull(),
    recommendation: text('recommendation', { enum: ['approve', 'revise', 'reject'] }).notNull(),
    summary: text('summary').notNull(),
    concerns: text('concerns', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: integer('created_at').notNull().default(now)
  },
  (t) => [index('reviews_plan_idx').on(t.planId)]
)

export const planApprovals = sqliteTable(
  'plan_approvals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull().references(() => developerAgents.id, { onDelete: 'cascade' }),
    planId: text('plan_id').notNull().references(() => taskPlans.id, { onDelete: 'cascade' }),
    planVersion: integer('plan_version').notNull(),
    planHash: text('plan_hash').notNull(),
    reviewer: text('reviewer', { enum: ['user'] }).notNull(),
    status: text('status', { enum: ['approved', 'rejected'] }).notNull(),
    reason: text('reason').notNull().default(''),
    decidedAt: integer('decided_at').notNull().default(now),
    invalidatedAt: integer('invalidated_at'),
    invalidationReason: text('invalidation_reason')
  },
  (t) => [
    index('approvals_task_idx').on(t.taskId),
    // At most one VALID approval per task, enforced by the database as well as the service.
    uniqueIndex('approvals_one_valid_per_task').on(t.taskId).where(sql`${t.status} = 'approved' and ${t.invalidatedAt} is null`)
  ]
)
