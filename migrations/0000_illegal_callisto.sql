CREATE TABLE `ai_daily_usage` (
	`account_id` text NOT NULL,
	`utc_date` text NOT NULL,
	`reserved_calls` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
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
INSERT OR IGNORE INTO `app_control` (`id`, `mode`, `settings_version`, `updated_at`) VALUES (1, 'dry_run', 1, (unixepoch() * 1000));--> statement-breakpoint
CREATE TABLE `classifications` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`model_version` text NOT NULL,
	`taxonomy_version` text NOT NULL,
	`rubric_version` text NOT NULL,
	`policy_version` text NOT NULL,
	`normalized_input_hash` text NOT NULL,
	`answer_json` text NOT NULL,
	`decision_json` text NOT NULL,
	`review_flag` integer DEFAULT false NOT NULL,
	`review_reasons_json` text DEFAULT '[]' NOT NULL,
	`usage_json` text DEFAULT '{}' NOT NULL,
	`duration_ms` integer,
	`application_status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `classifications_message_idx` ON `classifications` (`message_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `classifications_review_idx` ON `classifications` (`account_id`,`review_flag`,`created_at`);--> statement-breakpoint
CREATE TABLE `corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`revision` integer NOT NULL,
	`changed_dimensions_json` text NOT NULL,
	`replacement_values_json` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `corrections_message_revision_unique` ON `corrections` (`message_id`,`revision`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`route` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`operation_id` text,
	`response_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_unique` ON `idempotency_keys` (`account_id`,`route`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_keys_expires_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text,
	`account_id` text NOT NULL,
	`message_id` text,
	`kind` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`stage` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`deferred_reason` text,
	`lease_token` text,
	`lease_expires_at` integer,
	`error_code` text,
	`error_message` text,
	`payload_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
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
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`semantic_key` text NOT NULL,
	`gmail_label_id` text,
	`current_name` text,
	`legacy_alias_ids_json` text DEFAULT '[]' NOT NULL,
	`migration_state` text DEFAULT 'pending' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_mappings_semantic_unique` ON `label_mappings` (`account_id`,`semantic_key`);--> statement-breakpoint
CREATE TABLE `label_migration_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`account_id` text NOT NULL,
	`label_id` text,
	`semantic_key` text,
	`old_name` text,
	`new_name` text,
	`action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `label_migration_operations_operation_idx` ON `label_migration_operations` (`operation_id`);--> statement-breakpoint
CREATE TABLE `label_mutations` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`message_id` text NOT NULL,
	`generation` integer NOT NULL,
	`before_label_ids_json` text NOT NULL,
	`desired_label_ids_json` text NOT NULL,
	`add_label_ids_json` text NOT NULL,
	`remove_label_ids_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `label_mutations_message_idx` ON `label_mutations` (`message_id`);--> statement-breakpoint
CREATE INDEX `label_mutations_status_idx` ON `label_mutations` (`status`);--> statement-breakpoint
CREATE TABLE `leases` (
	`resource_key` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`committed_history_id` text,
	`scan_anchor_history_id` text,
	`scan_query` text,
	`scan_page_token` text,
	`sync_phase` text DEFAULT 'idle' NOT NULL,
	`auth_status` text DEFAULT 'unknown' NOT NULL,
	`last_sync_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_email_unique` ON `mailboxes` (`email`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`gmail_message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_generation` integer DEFAULT 0 NOT NULL,
	`latest_classification_id` text,
	`dimension_locks_json` text DEFAULT '{}' NOT NULL,
	`app_owned_label_ids_json` text DEFAULT '[]' NOT NULL,
	`last_observed_label_ids_json` text DEFAULT '[]' NOT NULL,
	`processing_status` text DEFAULT 'pending' NOT NULL,
	`application_status` text DEFAULT 'not_applied' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_account_gmail_unique` ON `messages` (`account_id`,`gmail_message_id`);--> statement-breakpoint
CREATE INDEX `messages_first_seen_idx` ON `messages` (`account_id`,`first_seen_at`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`request_json` text NOT NULL,
	`progress_json` text,
	`coalesce_key` text,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operations_account_status_idx` ON `operations` (`account_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `operations_queued_coalesce_unique` ON `operations` (`account_id`,`kind`) WHERE "operations"."coalesce_key" IS NOT NULL AND "operations"."status" = 'queued';--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`phase` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`discovered_count` integer DEFAULT 0 NOT NULL,
	`processed_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`start_cursor` text,
	`end_cursor` text,
	`failure_summary` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_account_started_idx` ON `sync_runs` (`account_id`,`started_at`);