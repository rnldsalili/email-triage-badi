CREATE TABLE `ai_daily_usage` (
	`account_id` text NOT NULL,
	`reserved_calls` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`utc_date` text NOT NULL,
	PRIMARY KEY(`account_id`, `utc_date`),
	CONSTRAINT "ai_daily_usage_reserved_check" CHECK("ai_daily_usage"."reserved_calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE `app_control` (
	`id` integer PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'dry_run' NOT NULL,
	`settings_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "app_control_mode_check" CHECK("app_control"."mode" IN ('paused', 'dry_run', 'apply'))
);
--> statement-breakpoint
INSERT OR IGNORE INTO `app_control` (`id`, `mode`, `settings_version`, `updated_at`) VALUES (1, 'dry_run', 1, (unixepoch() * 1000));
--> statement-breakpoint
CREATE TABLE `classifications` (
	`account_id` text NOT NULL,
	`answer_json` text NOT NULL,
	`application_status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`decision_json` text NOT NULL,
	`duration_ms` integer,
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`model_version` text NOT NULL,
	`normalized_input_hash` text NOT NULL,
	`policy_version` text NOT NULL,
	`review_flag` integer DEFAULT false NOT NULL,
	`review_reasons_json` text DEFAULT '[]' NOT NULL,
	`rubric_version` text NOT NULL,
	`taxonomy_version` text NOT NULL,
	`usage_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `classifications_message_idx` ON `classifications` (`message_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `classifications_review_idx` ON `classifications` (`account_id`,`review_flag`,`created_at`);--> statement-breakpoint
CREATE TABLE `corrections` (
	`changed_dimensions_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`note` text,
	`replacement_values_json` text NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `corrections_message_revision_unique` ON `corrections` (`message_id`,`revision`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`account_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`operation_id` text,
	`request_hash` text NOT NULL,
	`response_json` text,
	`route` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_unique` ON `idempotency_keys` (`account_id`,`route`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_keys_expires_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`account_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deferred_reason` text,
	`error_code` text,
	`error_message` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`lease_expires_at` integer,
	`lease_token` text,
	`message_id` text,
	`next_attempt_at` integer,
	`operation_id` text,
	`payload_json` text,
	`stage` text DEFAULT 'pending' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "jobs_generation_check" CHECK("jobs"."generation" >= 1),
	CONSTRAINT "jobs_attempts_check" CHECK("jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_generation_unique` ON `jobs` (`account_id`,`message_id`,`kind`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_initial_message_unique` ON `jobs` (`account_id`,`message_id`) WHERE "jobs"."kind" = 'initial';--> statement-breakpoint
CREATE INDEX `jobs_stage_next_attempt_idx` ON `jobs` (`stage`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `jobs_message_idx` ON `jobs` (`account_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `label_mappings` (
	`account_id` text NOT NULL,
	`current_name` text,
	`gmail_label_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`legacy_alias_ids_json` text DEFAULT '[]' NOT NULL,
	`migration_state` text DEFAULT 'pending' NOT NULL,
	`semantic_key` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_mappings_semantic_unique` ON `label_mappings` (`account_id`,`semantic_key`);--> statement-breakpoint
CREATE TABLE `label_migration_operations` (
	`account_id` text NOT NULL,
	`action` text NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`error_code` text,
	`id` text PRIMARY KEY NOT NULL,
	`label_id` text,
	`new_name` text,
	`old_name` text,
	`operation_id` text NOT NULL,
	`semantic_key` text,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `label_migration_operations_operation_idx` ON `label_migration_operations` (`operation_id`);--> statement-breakpoint
CREATE TABLE `label_mutations` (
	`add_label_ids_json` text NOT NULL,
	`before_label_ids_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`desired_label_ids_json` text NOT NULL,
	`generation` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`message_id` text NOT NULL,
	`remove_label_ids_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `label_mutations_message_idx` ON `label_mutations` (`message_id`);--> statement-breakpoint
CREATE INDEX `label_mutations_status_idx` ON `label_mutations` (`status`);--> statement-breakpoint
CREATE TABLE `leases` (
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`owner_token` text NOT NULL,
	`resource_key` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`auth_status` text DEFAULT 'unknown' NOT NULL,
	`committed_history_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`email` text NOT NULL,
	`history_page_token` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_sync_at` integer,
	`scan_anchor_history_id` text,
	`scan_page_token` text,
	`scan_query` text,
	`sync_phase` text DEFAULT 'idle' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_email_unique` ON `mailboxes` (`email`);--> statement-breakpoint
CREATE TABLE `messages` (
	`account_id` text NOT NULL,
	`app_owned_label_ids_json` text DEFAULT '[]' NOT NULL,
	`application_status` text DEFAULT 'not_applied' NOT NULL,
	`dimension_locks_json` text DEFAULT '{}' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`gmail_message_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_generation` integer DEFAULT 0 NOT NULL,
	`last_observed_label_ids_json` text DEFAULT '[]' NOT NULL,
	`latest_classification_id` text,
	`processing_status` text DEFAULT 'pending' NOT NULL,
	`received_at` integer NOT NULL,
	`thread_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_account_gmail_unique` ON `messages` (`account_id`,`gmail_message_id`);--> statement-breakpoint
CREATE INDEX `messages_first_seen_idx` ON `messages` (`account_id`,`first_seen_at`);--> statement-breakpoint
CREATE TABLE `operations` (
	`account_id` text NOT NULL,
	`coalesce_key` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_error_code` text,
	`last_error_message` text,
	`progress_json` text,
	`request_json` text NOT NULL,
	`started_at` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operations_account_status_idx` ON `operations` (`account_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `operations_queued_coalesce_unique` ON `operations` (`account_id`,`kind`,`coalesce_key`) WHERE "operations"."coalesce_key" IS NOT NULL AND "operations"."status" = 'queued';--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`account_id` text NOT NULL,
	`discovered_count` integer DEFAULT 0 NOT NULL,
	`end_cursor` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`failure_summary` text,
	`finished_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`processed_count` integer DEFAULT 0 NOT NULL,
	`start_cursor` text,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_runs_account_started_idx` ON `sync_runs` (`account_id`,`started_at`);