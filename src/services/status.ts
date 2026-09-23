import { sql } from "drizzle-orm";

import type { AppConfig } from "../config/env";
import {
  BUILD_VERSION,
  POLICY_VERSION,
  rubricVersion,
  TAXONOMY_VERSION,
} from "../config/versions";
import type { Db } from "../db/client";
import { getDailyUsage } from "../db/repositories/budget";
import { getControl } from "../db/repositories/control";
import { mailboxes } from "../db/schema";
import { LABEL_KEYS } from "../taxonomy/labels";
import { nextUtcMidnight, utcDateString } from "../utils/time";
import { countMessageMetadata } from "./message-metadata";

export interface StatusResponse {
  mode: string;
  mailbox: {
    email: string;
    authStatus: string;
    syncPhase: string;
    lastSyncAt: string | null;
  } | null;
  jobs: {
    queued: number;
    due: number;
    failed: number;
    deferredByBudget: number;
  };
  operations: {
    queued: number;
    failed: number;
  };
  messages: {
    metadataErrors: number;
    missingMetadata: number;
  };
  aiBudget: {
    used: number;
    limit: number;
    resetsAt: string;
    deferredJobs: number;
  };
  labels: {
    migration: string;
    mapped: number;
    conflicts: number;
  };
  versions: {
    build: string;
    model: string;
    taxonomy: string;
    rubric: string;
    policy: string;
  };
  updatedAt: string;
  lastCompletionAt: string | null;
  lastError: { code: string; at: string } | null;
}

const countJobs = async (db: Db, now: number) => {
  const row = await db.get<{
    queued: number | null;
    due: number | null;
    failed: number | null;
    deferred: number | null;
  }>(sql`
    SELECT
      SUM(CASE WHEN stage IN ('pending', 'classified', 'applying', 'retry_wait') THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN stage IN ('pending', 'retry_wait', 'classified', 'applying', 'classifying') AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}) AND (lease_expires_at IS NULL OR lease_expires_at <= ${now}) THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN stage = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN deferred_reason = 'ai_budget' THEN 1 ELSE 0 END) AS deferred
    FROM jobs
  `);
  return {
    deferredByBudget: row?.deferred ?? 0,
    due: row?.due ?? 0,
    failed: row?.failed ?? 0,
    queued: row?.queued ?? 0,
  };
};

const countOperations = async (db: Db) => {
  const row = await db.get<{ queued: number | null; failed: number | null }>(sql`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM operations
  `);
  return { failed: row?.failed ?? 0, queued: row?.queued ?? 0 };
};

const labelReadiness = async (db: Db) => {
  const rows = await db.all<{ migration_state: string; count: number }>(sql`
    SELECT migration_state, COUNT(*) AS count
    FROM label_mappings
    GROUP BY migration_state
  `);
  let mapped = 0;
  let conflicts = 0;
  let ready = 0;
  for (const row of rows) {
    if (row.migration_state === "ready") {
      mapped += row.count;
      ready += row.count;
    }
    if (row.migration_state === "conflict") {
      conflicts += row.count;
    }
  }
  return {
    conflicts,
    mapped,
    migration: ready === LABEL_KEYS.length && conflicts === 0 ? "ready" : "not_ready",
  };
};

export const buildStatus = async (
  db: Db,
  config: AppConfig,
  now: number
): Promise<StatusResponse> => {
  const [control, mailboxRows, budgetUsage, jobCounts, operationCounts, labels] =
    await Promise.all([
      getControl(db),
      db.select().from(mailboxes).limit(1),
      getDailyUsage(db, config.owner.accountEmail, utcDateString(now)),
      countJobs(db, now),
      countOperations(db),
      labelReadiness(db),
    ]);

  const [mailbox] = mailboxRows;
  const used = budgetUsage?.reservedCalls ?? 0;
  const [metadataCounts, completion, error] = await Promise.all([
    countMessageMetadata(db, config.owner.accountEmail),
    db.get<{ at: number | null }>(
      sql`SELECT MAX(updated_at) AS at FROM jobs WHERE stage = 'completed'`
    ),
    db.get<{ code: string; at: number }>(
      sql`SELECT failure_summary AS code, finished_at AS at FROM sync_runs WHERE error_count > 0 AND failure_summary IS NOT NULL ORDER BY started_at DESC LIMIT 1`
    ),
  ]);

  return {
    aiBudget: {
      deferredJobs: jobCounts.deferredByBudget,
      limit: config.limits.maxAiCallsPerDay,
      resetsAt: new Date(nextUtcMidnight(now)).toISOString(),
      used,
    },
    jobs: jobCounts,
    labels,
    lastCompletionAt: completion?.at ? new Date(completion.at).toISOString() : null,
    lastError: error ? { at: new Date(error.at).toISOString(), code: error.code } : null,
    mailbox: mailbox
      ? {
          authStatus: mailbox.authStatus,
          email: mailbox.email,
          lastSyncAt: mailbox.lastSyncAt
            ? new Date(mailbox.lastSyncAt).toISOString()
            : null,
          syncPhase: mailbox.syncPhase,
        }
      : null,
    messages: {
      metadataErrors: metadataCounts.errors,
      missingMetadata: metadataCounts.missing,
    },
    mode: control.mode,
    operations: operationCounts,
    updatedAt: new Date(now).toISOString(),
    versions: {
      build: BUILD_VERSION,
      model: config.ai.model,
      policy: POLICY_VERSION,
      rubric: rubricVersion(config.ai.rubric),
      taxonomy: TAXONOMY_VERSION,
    },
  };
};
