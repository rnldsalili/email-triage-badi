ALTER TABLE `messages` ADD `from_address` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `metadata_error_code` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `metadata_fetched_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `metadata_state` text DEFAULT 'missing' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `subject` text;--> statement-breakpoint
CREATE INDEX `messages_metadata_idx` ON `messages` (`account_id`,`metadata_state`,`first_seen_at`);