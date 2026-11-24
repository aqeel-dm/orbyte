CREATE TABLE `developer_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`pid` integer,
	`claude_session_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`base_commit` text NOT NULL,
	`worktree_removed` integer DEFAULT false NOT NULL,
	`current_activity` text DEFAULT '' NOT NULL,
	`exit_code` integer,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agents_project_idx` ON `developer_agents` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_one_active_per_task` ON `developer_agents` (`task_id`) WHERE "developer_agents"."status" in ('starting', 'running');