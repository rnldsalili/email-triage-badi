import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const epochMs = sql`(unixepoch() * 1000)`;

export const SYNC_PHASES = [
  "idle",
  "bootstrap_scan",
  "bootstrap_catchup",
  "incremental",
  "recovery_scan",
  "recovery_catchup",
] as const;

export const AUTH_STATUSES = ["unknown", "ok", "auth_required"] as const;

export const MODES = ["paused", "dry_run", "apply"] as const;

export const OPERATION_KINDS = [
  "sync",
  "backfill",
  "migration_plan",
  "migrate",
  "metadata_refresh",
  "reprocess",
  "apply",
  "correction",
  "retry",
] as const;

export const OPERATION_STATUSES = ["queued", "running", "completed", "failed"] as const;

export const JOB_KINDS = ["initial", "reprocess", "apply", "correction"] as const;

export const JOB_STAGES = [
  "pending",
  "classifying",
  "classified",
  "applying",
  "retry_wait",
  "completed",
  "failed",
  "skipped",
] as const;

export const MIGRATION_STATES = ["pending", "ready", "conflict", "missing"] as const;

export const MESSAGE_METADATA_STATES = [
  "missing",
  "available",
  "unavailable",
  "error",
] as const;

export const MUTATION_STATUSES = ["pending", "applied", "superseded", "failed"] as const;

export const mailboxes = sqliteTable("mailboxes", {
  authStatus: text("auth_status", { enum: AUTH_STATUSES }).notNull().default("unknown"),
  committedHistoryId: text("committed_history_id"),
  createdAt: integer("created_at").notNull().default(epochMs),
  email: text("email").notNull().unique(),
  historyPageToken: text("history_page_token"),
  id: text("id").primaryKey(),
  lastSyncAt: integer("last_sync_at"),
  scanAnchorHistoryId: text("scan_anchor_history_id"),
  scanPageToken: text("scan_page_token"),
  scanQuery: text("scan_query"),
  syncPhase: text("sync_phase", { enum: SYNC_PHASES }).notNull().default("idle"),
  updatedAt: integer("updated_at").notNull().default(epochMs),
});

export const appControl = sqliteTable(
  "app_control",
  {
    id: integer("id").primaryKey(),
    mode: text("mode", { enum: MODES }).notNull().default("dry_run"),
    settingsVersion: integer("settings_version").notNull().default(1),
    updatedAt: integer("updated_at").notNull().default(epochMs),
  },
  (table) => [
    check("app_control_mode_check", sql`${table.mode} IN ('paused', 'dry_run', 'apply')`),
  ]
);

export const leases = sqliteTable("leases", {
  acquiredAt: integer("acquired_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  ownerToken: text("owner_token").notNull(),
  resourceKey: text("resource_key").primaryKey(),
  updatedAt: integer("updated_at").notNull(),
});

export const operations = sqliteTable(
  "operations",
  {
    accountId: text("account_id").notNull(),
    coalesceKey: text("coalesce_key"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(epochMs),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: OPERATION_KINDS }).notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    progressJson: text("progress_json"),
    requestJson: text("request_json").notNull(),
    startedAt: integer("started_at"),
    status: text("status", { enum: OPERATION_STATUSES }).notNull().default("queued"),
    updatedAt: integer("updated_at").notNull().default(epochMs),
  },
  (table) => [
    index("operations_account_status_idx").on(table.accountId, table.status),
    uniqueIndex("operations_queued_coalesce_unique")
      .on(table.accountId, table.kind, table.coalesceKey)
      .where(sql`${table.coalesceKey} IS NOT NULL AND ${table.status} = 'queued'`),
  ]
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    accountId: text("account_id").notNull(),
    createdAt: integer("created_at").notNull().default(epochMs),
    expiresAt: integer("expires_at").notNull(),
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    operationId: text("operation_id"),
    requestHash: text("request_hash").notNull(),
    responseJson: text("response_json"),
    route: text("route").notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_unique").on(table.accountId, table.route, table.key),
    index("idempotency_keys_expires_idx").on(table.expiresAt),
  ]
);

export const aiDailyUsage = sqliteTable(
  "ai_daily_usage",
  {
    accountId: text("account_id").notNull(),
    reservedCalls: integer("reserved_calls").notNull().default(0),
    updatedAt: integer("updated_at").notNull().default(epochMs),
    utcDate: text("utc_date").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.utcDate] }),
    check("ai_daily_usage_reserved_check", sql`${table.reservedCalls} >= 0`),
  ]
);

export const labelMappings = sqliteTable(
  "label_mappings",
  {
    accountId: text("account_id").notNull(),
    currentName: text("current_name"),
    gmailLabelId: text("gmail_label_id"),
    id: text("id").primaryKey(),
    legacyAliasIdsJson: text("legacy_alias_ids_json").notNull().default("[]"),
    migrationState: text("migration_state", { enum: MIGRATION_STATES })
      .notNull()
      .default("pending"),
    semanticKey: text("semantic_key").notNull(),
    updatedAt: integer("updated_at").notNull().default(epochMs),
  },
  (table) => [
    uniqueIndex("label_mappings_semantic_unique").on(table.accountId, table.semanticKey),
  ]
);

export const labelMigrationOperations = sqliteTable(
  "label_migration_operations",
  {
    accountId: text("account_id").notNull(),
    action: text("action", {
      enum: ["rename", "create", "reuse", "conflict"],
    }).notNull(),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(epochMs),
    errorCode: text("error_code"),
    id: text("id").primaryKey(),
    labelId: text("label_id"),
    newName: text("new_name"),
    oldName: text("old_name"),
    operationId: text("operation_id").notNull(),
    semanticKey: text("semantic_key"),
    status: text("status", { enum: ["pending", "completed", "failed"] })
      .notNull()
      .default("pending"),
  },
  (table) => [index("label_migration_operations_operation_idx").on(table.operationId)]
);

export const messages = sqliteTable(
  "messages",
  {
    accountId: text("account_id").notNull(),
    appOwnedLabelIdsJson: text("app_owned_label_ids_json").notNull().default("[]"),
    applicationStatus: text("application_status").notNull().default("not_applied"),
    dimensionLocksJson: text("dimension_locks_json").notNull().default("{}"),
    firstSeenAt: integer("first_seen_at").notNull(),
    fromAddress: text("from_address"),
    gmailMessageId: text("gmail_message_id").notNull(),
    id: text("id").primaryKey(),
    lastGeneration: integer("last_generation").notNull().default(0),
    lastObservedLabelIdsJson: text("last_observed_label_ids_json")
      .notNull()
      .default("[]"),
    latestClassificationId: text("latest_classification_id"),
    metadataErrorCode: text("metadata_error_code"),
    metadataFetchedAt: integer("metadata_fetched_at"),
    metadataState: text("metadata_state", { enum: MESSAGE_METADATA_STATES })
      .notNull()
      .default("missing"),
    processingStatus: text("processing_status", { enum: JOB_STAGES })
      .notNull()
      .default("pending"),
    receivedAt: integer("received_at").notNull(),
    subject: text("subject"),
    threadId: text("thread_id").notNull(),
  },
  (table) => [
    uniqueIndex("messages_account_gmail_unique").on(
      table.accountId,
      table.gmailMessageId
    ),
    index("messages_first_seen_idx").on(table.accountId, table.firstSeenAt),
    index("messages_metadata_idx").on(
      table.accountId,
      table.metadataState,
      table.firstSeenAt
    ),
  ]
);

export const jobs = sqliteTable(
  "jobs",
  {
    accountId: text("account_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull().default(epochMs),
    deferredReason: text("deferred_reason"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    generation: integer("generation").notNull().default(1),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: JOB_KINDS }).notNull(),
    leaseExpiresAt: integer("lease_expires_at"),
    leaseToken: text("lease_token"),
    messageId: text("message_id"),
    nextAttemptAt: integer("next_attempt_at"),
    operationId: text("operation_id"),
    payloadJson: text("payload_json"),
    stage: text("stage", { enum: JOB_STAGES }).notNull().default("pending"),
    updatedAt: integer("updated_at").notNull().default(epochMs),
  },
  (table) => [
    uniqueIndex("jobs_generation_unique").on(
      table.accountId,
      table.messageId,
      table.kind,
      table.generation
    ),
    uniqueIndex("jobs_initial_message_unique")
      .on(table.accountId, table.messageId)
      .where(sql`${table.kind} = 'initial'`),
    index("jobs_stage_next_attempt_idx").on(table.stage, table.nextAttemptAt),
    index("jobs_message_idx").on(table.accountId, table.messageId),
    check("jobs_generation_check", sql`${table.generation} >= 1`),
    check("jobs_attempts_check", sql`${table.attempts} >= 0`),
  ]
);

export const classifications = sqliteTable(
  "classifications",
  {
    accountId: text("account_id").notNull(),
    answerJson: text("answer_json").notNull(),
    applicationStatus: text("application_status").notNull().default("proposed"),
    createdAt: integer("created_at").notNull().default(epochMs),
    decisionJson: text("decision_json").notNull(),
    durationMs: integer("duration_ms"),
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull(),
    modelVersion: text("model_version").notNull(),
    normalizedInputHash: text("normalized_input_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    reviewFlag: integer("review_flag", { mode: "boolean" }).notNull().default(false),
    reviewReasonsJson: text("review_reasons_json").notNull().default("[]"),
    rubricVersion: text("rubric_version").notNull(),
    taxonomyVersion: text("taxonomy_version").notNull(),
    usageJson: text("usage_json").notNull().default("{}"),
  },
  (table) => [
    index("classifications_message_idx").on(table.messageId, table.createdAt),
    index("classifications_review_idx").on(
      table.accountId,
      table.reviewFlag,
      table.createdAt
    ),
  ]
);

export const labelMutations = sqliteTable(
  "label_mutations",
  {
    addLabelIdsJson: text("add_label_ids_json").notNull(),
    beforeLabelIdsJson: text("before_label_ids_json").notNull(),
    createdAt: integer("created_at").notNull().default(epochMs),
    desiredLabelIdsJson: text("desired_label_ids_json").notNull(),
    generation: integer("generation").notNull(),
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    messageId: text("message_id").notNull(),
    removeLabelIdsJson: text("remove_label_ids_json").notNull(),
    status: text("status", { enum: MUTATION_STATUSES }).notNull().default("pending"),
    updatedAt: integer("updated_at").notNull().default(epochMs),
  },
  (table) => [
    index("label_mutations_message_idx").on(table.messageId),
    index("label_mutations_status_idx").on(table.status),
  ]
);

export const corrections = sqliteTable(
  "corrections",
  {
    changedDimensionsJson: text("changed_dimensions_json").notNull(),
    createdAt: integer("created_at").notNull().default(epochMs),
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull(),
    note: text("note"),
    replacementValuesJson: text("replacement_values_json").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    uniqueIndex("corrections_message_revision_unique").on(
      table.messageId,
      table.revision
    ),
  ]
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    accountId: text("account_id").notNull(),
    discoveredCount: integer("discovered_count").notNull().default(0),
    endCursor: text("end_cursor"),
    errorCount: integer("error_count").notNull().default(0),
    failureSummary: text("failure_summary"),
    finishedAt: integer("finished_at"),
    id: text("id").primaryKey(),
    phase: text("phase", { enum: SYNC_PHASES }).notNull(),
    processedCount: integer("processed_count").notNull().default(0),
    startCursor: text("start_cursor"),
    startedAt: integer("started_at").notNull(),
  },
  (table) => [index("sync_runs_account_started_idx").on(table.accountId, table.startedAt)]
);

export type Mailbox = typeof mailboxes.$inferSelect;
export type NewMailbox = typeof mailboxes.$inferInsert;
export type AppControl = typeof appControl.$inferSelect;
export type Lease = typeof leases.$inferSelect;
export type Operation = typeof operations.$inferSelect;
export type NewOperation = typeof operations.$inferInsert;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type AiDailyUsage = typeof aiDailyUsage.$inferSelect;
export type LabelMapping = typeof labelMappings.$inferSelect;
export type LabelMigrationOperation = typeof labelMigrationOperations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Classification = typeof classifications.$inferSelect;
export type LabelMutation = typeof labelMutations.$inferSelect;
export type Correction = typeof corrections.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
