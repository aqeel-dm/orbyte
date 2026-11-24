CREATE TABLE `execution_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `progress_execution_idx` ON `execution_progress` (`execution_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `execution_results` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`summary` text NOT NULL,
	`tests` text DEFAULT '[]' NOT NULL,
	`evidence` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`status` text DEFAULT 'current' NOT NULL,
	`submitted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `developer_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `results_task_version` ON `execution_results` (`task_id`,`version`);--> statement-breakpoint
CREATE INDEX `results_task_status_idx` ON `execution_results` (`task_id`,`status`);--> statement-breakpoint
CREATE TABLE `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`plan_version` integer NOT NULL,
	`plan_hash` text NOT NULL,
	`approval_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`feedback` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `developer_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `task_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `executions_task_idx` ON `executions` (`task_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `executions_agent_unique` ON `executions` (`agent_id`);--> statement-breakpoint
CREATE TABLE `result_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`result_id` text NOT NULL,
	`result_version` integer NOT NULL,
	`snapshot_hash` text NOT NULL,
	`reviewer` text NOT NULL,
	`decision` text NOT NULL,
	`feedback` text DEFAULT '' NOT NULL,
	`decided_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`invalidated_at` integer,
	`invalidation_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`result_id`) REFERENCES `execution_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decisions_task_idx` ON `result_decisions` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_one_valid_acceptance` ON `result_decisions` (`task_id`) WHERE "result_decisions"."decision" = 'accepted' and "result_decisions"."invalidated_at" is null;--> statement-breakpoint
CREATE TABLE `result_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`result_id` text NOT NULL,
	`result_version` integer NOT NULL,
	`reviewer` text NOT NULL,
	`recommendation` text NOT NULL,
	`summary` text NOT NULL,
	`concerns` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`result_id`) REFERENCES `execution_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `result_reviews_result_idx` ON `result_reviews` (`result_id`);--> statement-breakpoint
ALTER TABLE `developer_agents` ADD `kind` text DEFAULT 'planning' NOT NULL;