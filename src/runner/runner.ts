import { eq } from "drizzle-orm";

import type { AppConfig } from "../config/env";
import { parseConfig } from "../config/env";
import type { Db } from "../db/client";
import { createDb } from "../db/client";
import { getControl } from "../db/repositories/control";
import { acquireLease, releaseLease, renewLease } from "../db/repositories/leases";
import type { Mailbox } from "../db/schema";
import { syncRuns } from "../db/schema";
import { GmailClient } from "../gmail/client";
import { GmailError } from "../gmail/errors";
import { createAccessTokenSource } from "../gmail/tokens";
import { MailboxIdentityError, verifyMailboxIdentity } from "../services/mailbox";
import { runBootstrap, runIncrementalSync, runRecovery } from "../sync/gmail-sync";
import type { SyncDeps, SyncResult } from "../sync/gmail-sync";
import { processQueuedBackfills } from "./backfill";
import type { BackfillOutcome } from "./backfill";
import { admit, DeferredWorkError } from "./guard";
import {
  processQueuedMaintenanceOperations,
  runRetentionCleanup,
  syncOperationStatuses,
} from "./maintenance";
import type { CleanupOutcome, MaintenanceOutcome } from "./maintenance";
import { processDueJobs } from "./process-jobs";
import type { ProcessOutcome } from "./process-jobs";
import { TimeBudget, STAGE_ESTIMATES_MS } from "./time-budget";

export interface TickOutcome {
  status:
    | "completed"
    | "paused"
    | "lease_held"
    | "lease_lost"
    | "identity_mismatch"
    | "auth_required"
    | "error";
  mode?: string;
  sync?: SyncResult;
  jobs?: ProcessOutcome;
  backfills?: BackfillOutcome;
  maintenance?: MaintenanceOutcome;
  cleanup?: CleanupOutcome;
  durationMs: number;
}

export interface TickOverrides {
  client?: GmailClient;
  ai?: Ai;
  now?: () => number;
}

type IdentityCheck =
  | { ok: true; mailbox: Mailbox }
  | { ok: false; status: "auth_required" | "identity_mismatch" };

const checkMailboxIdentity = async (
  db: Db,
  client: GmailClient,
  config: AppConfig,
  now: number
): Promise<IdentityCheck> => {
  try {
    const { mailbox } = await verifyMailboxIdentity(db, client, config, now);
    return { mailbox, ok: true };
  } catch (error) {
    if (error instanceof MailboxIdentityError) {
      return { ok: false, status: "identity_mismatch" };
    }
    if (error instanceof GmailError && error.reason === "auth_required") {
      return { ok: false, status: "auth_required" };
    }
    throw error;
  }
};

const runSyncPhase = async (mailbox: Mailbox, deps: SyncDeps): Promise<SyncResult> => {
  try {
    if (
      mailbox.syncPhase === "recovery_scan" ||
      mailbox.syncPhase === "recovery_catchup"
    ) {
      return await runRecovery(deps);
    }
    if (mailbox.committedHistoryId) {
      return await runIncrementalSync(deps);
    }
    return await runBootstrap(deps);
  } catch (error) {
    if (error instanceof DeferredWorkError && error.reason === "wall_time") {
      return {
        completed: false,
        deferred: true,
        discovered: 0,
        phase: mailbox.syncPhase,
        recoveryStarted: false,
      };
    }
    throw error;
  }
};

export const runScheduledTick = async (
  env: Env,
  overrides: TickOverrides = {}
): Promise<TickOutcome> => {
  const startedAt = Date.now();
  const config = parseConfig({ ...env });
  const db = createDb(env.DB);
  const control = await getControl(db);
  if (control.mode === "paused") {
    return { durationMs: Date.now() - startedAt, mode: control.mode, status: "paused" };
  }

  const tokens = createAccessTokenSource({
    clientId: config.secrets.googleClientId,
    clientSecret: config.secrets.googleClientSecret,
    refreshToken: config.secrets.googleRefreshToken,
  });
  const leaseKey = `mailbox:${config.owner.accountEmail}`;
  const ownerToken = crypto.randomUUID();
  const lease = await acquireLease(
    db,
    leaseKey,
    ownerToken,
    startedAt,
    config.limits.runLeaseMs
  );
  if (!lease.acquired) {
    return {
      durationMs: Date.now() - startedAt,
      mode: control.mode,
      status: "lease_held",
    };
  }

  const budget = new TimeBudget(
    startedAt,
    config.limits.tickWallBudgetMs,
    config.limits.checkpointReserveMs
  );
  const now = overrides.now ?? (() => Date.now());
  const fence = { leaseMs: config.limits.runLeaseMs, ownerToken, resourceKey: leaseKey };
  const guard = { budget, db, fence, now };
  const client =
    overrides.client ??
    new GmailClient({
      beforeRequest: (write) => admit(guard, STAGE_ESTIMATES_MS.messageFetch, write),
      tokens,
    });
  const deps = {
    accountId: config.owner.accountEmail,
    budget,
    client,
    config,
    db,
    fence,
    now,
  };

  const runId = crypto.randomUUID();
  try {
    await db.insert(syncRuns).values({
      accountId: config.owner.accountEmail,
      id: runId,
      phase: "incremental",
      startedAt: now(),
    });
    const identity = await checkMailboxIdentity(db, client, config, now());
    if (!identity.ok) {
      await db
        .update(syncRuns)
        .set({ errorCount: 1, failureSummary: identity.status, finishedAt: now() })
        .where(eq(syncRuns.id, runId));
      return {
        durationMs: Date.now() - startedAt,
        mode: control.mode,
        status: identity.status,
      };
    }
    const { mailbox } = identity;

    const sync: SyncResult = await runSyncPhase(mailbox, {
      ...deps,
      budget: new TimeBudget(
        startedAt,
        Math.min(config.limits.tickWallBudgetMs, 50_000),
        config.limits.checkpointReserveMs
      ),
    });

    const stillOwned = await renewLease(
      db,
      leaseKey,
      ownerToken,
      now(),
      config.limits.runLeaseMs
    );
    if (!stillOwned) {
      return {
        durationMs: Date.now() - startedAt,
        mode: control.mode,
        status: "lease_lost",
        sync,
      };
    }

    const maintenance = await processQueuedMaintenanceOperations(deps);
    const jobs = await processDueJobs({
      accountId: config.owner.accountEmail,
      ai: overrides.ai ?? env.AI,
      budget,
      client,
      config,
      db,
      fence,
      mode: control.mode,
      now,
    });
    const backfills = await processQueuedBackfills(deps);
    await syncOperationStatuses(db, now());
    const cleanup = budget.canSpend(STAGE_ESTIMATES_MS.checkpoint, now())
      ? await runRetentionCleanup(db, config, now())
      : undefined;
    await db
      .update(syncRuns)
      .set({
        discoveredCount: sync.discovered,
        errorCount: jobs.failed,
        failureSummary: jobs.failed ? "job_failed" : null,
        finishedAt: now(),
        processedCount: jobs.processed,
      })
      .where(eq(syncRuns.id, runId));

    return {
      backfills,
      cleanup,
      durationMs: Date.now() - startedAt,
      jobs,
      maintenance,
      mode: control.mode,
      status: "completed",
      sync,
    };
  } catch (error) {
    const deferredReason = error instanceof DeferredWorkError ? error.reason : null;
    const gmailReason = error instanceof GmailError ? error.reason : null;
    const reason = deferredReason ?? gmailReason ?? "runner_failed";
    await db
      .update(syncRuns)
      .set({
        errorCount: deferredReason === null ? 1 : 0,
        failureSummary: reason,
        finishedAt: now(),
      })
      .where(eq(syncRuns.id, runId));
    if (deferredReason !== null) {
      let status: "completed" | "paused" | "lease_lost" = "completed";
      if (deferredReason === "lease_lost") {
        status = "lease_lost";
      } else if (deferredReason === "pending_mode") {
        status = "paused";
      }
      return {
        durationMs: Date.now() - startedAt,
        status,
      };
    }
    throw error;
  } finally {
    await releaseLease(db, leaseKey, ownerToken);
  }
};
