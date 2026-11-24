CREATE TABLE `plan_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`plan_version` integer NOT NULL,
	`plan_hash` text NOT NULL,
	`reviewer` text NOT NULL,
	`status` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`decided_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`invalidated_at` integer,
	`invalidation_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `developer_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `task_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approvals_task_idx` ON `plan_approvals` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_one_valid_per_task` ON `plan_approvals` (`task_id`) WHERE "plan_approvals"."status" = 'approved' and "plan_approvals"."invalidated_at" is null;--> statement-breakpoint
CREATE TABLE `plan_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`plan_version` integer NOT NULL,
	`reviewer` text NOT NULL,
	`recommendation` text NOT NULL,
	`summary` text NOT NULL,
	`concerns` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `task_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reviews_plan_idx` ON `plan_reviews` (`plan_id`);--> statement-breakpoint
CREATE TABLE `task_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'current' NOT NULL,
	`submitted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `developer_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_task_version` ON `task_plans` (`task_id`,`version`);--> statement-breakpoint
CREATE INDEX `plans_task_status_idx` ON `task_plans` (`task_id`,`status`);