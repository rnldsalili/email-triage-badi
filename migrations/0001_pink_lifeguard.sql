DROP INDEX `operations_queued_coalesce_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `operations_queued_coalesce_unique` ON `operations` (`account_id`,`kind`,`coalesce_key`) WHERE "operations"."coalesce_key" IS NOT NULL AND "operations"."status" = 'queued';--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `history_page_token` text;