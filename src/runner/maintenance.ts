import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { AppConfig } from "../config/env";
import type { Db } from "../db/client";
import { getControl } from "../db/repositories/control";
import type { LeaseFence } from "../db/repositories/leases";
import { getMailbox } from "../db/repositories/mailboxes";
import { jobs, operations } from "../db/schema";
import { markOperation } from "../http/idempotency";
import { executeLabelMigration } from "../services/label-migration";
import { buildMigrationPlan, persistInventory } from "../services/labels";
import {
  countMessageMetadata,
  listMessagesMissingMetadata,
  refreshMessageMetadata,
} from "../services/message-metadata";
import { runBootstrap, runIncrementalSync, runRecovery } from "../sync/gmail-sync";
import type { SyncDeps } from "../sync/gmail-sync";
import { admit, DeferredWorkError } from "./guard";
import { STAGE_ESTIMATES_MS } from "./time-budget";
import type { TimeBudget } from "./time-budget";

export interface MaintenanceDeps {
  db: Db;
  client: SyncDeps["client"];
  config: AppConfig;
  accountId: string;
  now: () => number;
  budget: TimeBudget;
  fence?: LeaseFence;
}

export interface MaintenanceOutcome {
  processed: number;
  completed: number;
  failed: number;
  deferred: number;
}

const MAINTENANCE_KINDS = [
  "sync",
  "migration_plan",
  "migrate",
  "metadata_refresh",
] as const;

const refreshPendingMetadata = async (
  deps: MaintenanceDeps,
  pending: { gmailMessageId: string; id: string }[]
): Promise<{ errors: number; refreshed: number; retryLater: string | null }> => {
  let refreshed = 0;
  let errors = 0;
  let retryLater: string | null = null;
  const step = async (index: number): Promise<void> => {
    const message = pending[index];
    if (!message || !deps.budget.canSpend(STAGE_ESTIMATES_MS.metadataFetch, deps.now())) {
      return;
    }
    await admit(deps, STAGE_ESTIMATES_MS.metadataFetch);
    const result = await refreshMessageMetadata(
      deps.db,
      deps.client,
      message,
      deps.now()
    );
    if (result.status === "retry_later") {
      // Environmental failure: stop this batch so the account can recover, and
      // leave the row pending for a later tick.
      retryLater = result.errorCode;
      return;
    }
    if (result.status === "error") {
      errors += 1;
    } else {
      refreshed += 1;
    }
    await step(index + 1);
  };
  await step(0);
  return { errors, refreshed, retryLater };
};

const runMetadataRefresh = async (
  deps: MaintenanceDeps,
  operationId: string
): Promise<"completed" | "deferred"> => {
  const pending = await listMessagesMissingMetadata(
    deps.db,
    deps.accountId,
    deps.config.limits.maxMetadataRefreshPerTick
  );
  const { errors, refreshed, retryLater } = await refreshPendingMetadata(deps, pending);
  const remaining = await countMessageMetadata(deps.db, deps.accountId);
  const progressJson = JSON.stringify({
    errors,
    failed: remaining.errors,
    lastErrorCode: retryLater,
    refreshed,
    remaining: remaining.missing,
  });
  if (remaining.missing === 0 && retryLater === null) {
    await markOperation(
      deps.db,
      operationId,
      { completedAt: deps.now(), progressJson, status: "completed" },
      deps.now()
    );
    return "completed";
  }
  await markOperation(
    deps.db,
    operationId,
    { progressJson, status: "queued" },
    deps.now()
  );
  return "deferred";
};

const runSyncOperation = async (
  deps: MaintenanceDeps,
  operationId: string
): Promise<"completed" | "deferred"> => {
  const mailbox = await getMailbox(deps.db);
  let result: Awaited<ReturnType<typeof runIncrementalSync>>;
  if (
    mailbox?.syncPhase === "recovery_scan" ||
    mailbox?.syncPhase === "recovery_catchup"
  ) {
    result = await runRecovery(deps);
  } else if (mailbox?.committedHistoryId) {
    result = await runIncrementalSync(deps);
  } else {
    result = await runBootstrap(deps);
  }
  const progressJson = JSON.stringify({ discovered: result.discovered });
  if (result.completed) {
    await markOperation(
      deps.db,
      operationId,
      { completedAt: deps.now(), progressJson, status: "completed" },
      deps.now()
    );
    return "completed";
  }
  await markOperation(deps.db, operationId, { progressJson }, deps.now());
  return "deferred";
};

export const processQueuedMaintenanceOperations = async (
  deps: MaintenanceDeps
): Promise<MaintenanceOutcome> => {
  const outcome: MaintenanceOutcome = {
    completed: 0,
    deferred: 0,
    failed: 0,
    processed: 0,
  };
  const { mode } = await getControl(deps.db);
  if (mode === "paused") {
    return outcome;
  }
  const queued = await deps.db
    .select()
    .from(operations)
    .where(
      and(
        inArray(operations.kind, [...MAINTENANCE_KINDS]),
        mode === "apply" ? undefined : sql`${operations.kind} != 'migrate'`,
        inArray(operations.status, ["queued", "running"])
      )
    )
    // Oldest-touched first: an operation that defers or fails repeatedly is
    // re-marked each tick, which rotates it behind other queued work.
    .orderBy(asc(operations.updatedAt))
    .limit(1);

  const [operation] = queued;
  if (!operation) {
    return outcome;
  }

  await markOperation(
    deps.db,
    operation.id,
    { startedAt: operation.startedAt ?? deps.now(), status: "running" },
    deps.now()
  );
  outcome.processed += 1;

  try {
    await admit(deps);
    if (operation.kind === "sync") {
      if ((await runSyncOperation(deps, operation.id)) === "completed") {
        outcome.completed += 1;
      } else {
        outcome.deferred += 1;
      }
      return outcome;
    }

    if (!deps.budget.canSpend(STAGE_ESTIMATES_MS.mutation, deps.now())) {
      await markOperation(deps.db, operation.id, { status: "queued" }, deps.now());
      outcome.deferred += 1;
      return outcome;
    }

    if (operation.kind === "metadata_refresh") {
      if ((await runMetadataRefresh(deps, operation.id)) === "completed") {
        outcome.completed += 1;
      } else {
        outcome.deferred += 1;
      }
      return outcome;
    }

    if (operation.kind === "migration_plan") {
      const labels = await deps.client.listLabels();
      const plan = buildMigrationPlan(labels);
      await persistInventory(deps.db, deps.accountId, plan, deps.now());
      await markOperation(
        deps.db,
        operation.id,
        {
          completedAt: deps.now(),
          progressJson: JSON.stringify({
            conflicts: plan.conflicts.map((entry) => entry.semanticKey),
            containers: plan.parentContainers.length,
            entries: plan.entries.length,
          }),
          status: "completed",
        },
        deps.now()
      );
      outcome.completed += 1;
      return outcome;
    }

    const result = await executeLabelMigration(deps, operation.id);
    if (result.completed) {
      await markOperation(
        deps.db,
        operation.id,
        {
          completedAt: deps.now(),
          progressJson: JSON.stringify(result),
          status: "completed",
        },
        deps.now()
      );
      outcome.completed += 1;
    } else {
      await markOperation(
        deps.db,
        operation.id,
        { progressJson: JSON.stringify(result) },
        deps.now()
      );
      outcome.deferred += 1;
    }
    return outcome;
  } catch (error) {
    if (error instanceof DeferredWorkError) {
      outcome.deferred += 1;
      if (error.reason === "lease_lost") {
        throw error;
      }
      return outcome;
    }
    await markOperation(
      deps.db,
      operation.id,
      {
        completedAt: deps.now(),
        lastErrorCode: "maintenance_failed",
        lastErrorMessage: "Operation failed; see server logs for details",
        status: "failed",
      },
      deps.now()
    );
    outcome.failed += 1;
    return outcome;
  }
};

export const syncOperationStatuses = async (db: Db, now: number): Promise<number> => {
  const active = await db
    .select()
    .from(operations)
    .where(
      and(
        inArray(operations.kind, ["reprocess", "apply", "correction", "retry"]),
        inArray(operations.status, ["queued", "running"])
      )
    )
    .limit(50);

  let updated = 0;
  for await (const operation of active) {
    const related = await db
      .select({ stage: jobs.stage })
      .from(jobs)
      .where(eq(jobs.operationId, operation.id));
    if (related.length === 0) {
      continue;
    }
    const failed = related.some((job) => job.stage === "failed");
    const finished = related.every(
      (job) => job.stage === "completed" || job.stage === "skipped"
    );
    if (failed) {
      await markOperation(
        db,
        operation.id,
        { completedAt: now, lastErrorCode: "job_failed", status: "failed" },
        now
      );
      updated += 1;
    } else if (finished) {
      await markOperation(
        db,
        operation.id,
        { completedAt: now, status: "completed" },
        now
      );
      updated += 1;
    } else if (operation.status === "queued") {
      await markOperation(db, operation.id, { status: "running" }, now);
      updated += 1;
    }
  }
  return updated;
};

export interface CleanupOutcome {
  idempotencyKeys: number;
  syncRuns: number;
  classifications: number;
  operations: number;
  labelMutations: number;
}

export const runRetentionCleanup = async (
  db: Db,
  config: AppConfig,
  now: number
): Promise<CleanupOutcome> => {
  const batch = config.limits.cleanupBatchSize;
  const cutoff = now - config.limits.detailRetentionDays * 86_400_000;

  const keys = await db.run(sql`
    DELETE FROM idempotency_keys WHERE id IN (
      SELECT k.id FROM idempotency_keys k WHERE k.expires_at < ${now}
      AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = k.operation_id)
      LIMIT ${batch}
    )
  `);
  const runs = await db.run(sql`
    DELETE FROM sync_runs WHERE id IN (
      SELECT id FROM sync_runs WHERE started_at < ${cutoff} LIMIT ${batch}
    )
  `);
  const [classificationRows] = await db.$client.batch([
    db.$client
      .prepare(`DELETE FROM classifications WHERE id IN (
      SELECT c.id FROM classifications c WHERE c.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM jobs j JOIN messages m ON m.id = j.message_id WHERE j.message_id = c.message_id AND j.stage NOT IN ('completed', 'skipped', 'failed') AND (m.latest_classification_id = c.id OR json_extract(j.payload_json, '$.classificationId') = c.id))
      AND NOT EXISTS (SELECT 1 FROM label_mutations p JOIN messages m ON m.id = p.message_id WHERE p.message_id = c.message_id AND p.status = 'pending' AND m.latest_classification_id = c.id)
      LIMIT ?
    )`)
      .bind(cutoff, batch),
    db.$client
      .prepare(`UPDATE messages SET latest_classification_id = NULL WHERE id IN (
      SELECT m.id FROM messages m WHERE m.latest_classification_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM classifications c WHERE c.id = m.latest_classification_id) LIMIT ?
    )`)
      .bind(batch),
  ]);
  const operationRows = await db.run(sql`
    DELETE FROM operations WHERE id IN (
      SELECT id FROM operations
      WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL AND completed_at < ${cutoff}
      LIMIT ${batch}
    )
  `);
  const mutationRows = await db.run(sql`
    DELETE FROM label_mutations WHERE id IN (
      SELECT id FROM label_mutations
      WHERE status != 'pending' AND updated_at < ${cutoff}
      LIMIT ${batch}
    )
  `);

  return {
    classifications: classificationRows?.meta.changes ?? 0,
    idempotencyKeys: keys.meta.changes,
    labelMutations: mutationRows.meta.changes,
    operations: operationRows.meta.changes,
    syncRuns: runs.meta.changes,
  };
};
