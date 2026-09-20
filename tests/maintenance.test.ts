import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb } from "../src/db/client";
import { enqueueOperation } from "../src/db/repositories/operations";
import {
  classifications,
  jobs,
  labelMutations,
  messages,
  operations,
  syncRuns,
} from "../src/db/schema";
import {
  processQueuedMaintenanceOperations,
  runRetentionCleanup,
  syncOperationStatuses,
} from "../src/runner/maintenance";
import { TimeBudget } from "../src/runner/time-budget";
import { testConfig } from "./helpers/config";
import { resetDatabase, seedMailbox } from "./helpers/db";
import { fakeGmail } from "./helpers/gmail-fake";

const NOW = 1_700_000_000_000;
const ACCOUNT = "owner@example.test";

const deps = (
  db: ReturnType<typeof createDb>,
  client: ReturnType<typeof fakeGmail>["client"],
  budget = new TimeBudget(NOW, 120_000, 15_000)
) => ({
  accountId: ACCOUNT,
  budget,
  client,
  config: testConfig(),
  db,
  now: () => NOW,
});

describe("maintenance operations", () => {
  it("executes a queued migration plan and persists inventory", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await enqueueOperation(db, {
      accountId: ACCOUNT,
      coalesceKey: "migration_plan",
      id: "op-plan-1",
      kind: "migration_plan",
      now: NOW,
      requestJson: "{}",
    });
    const gmail = fakeGmail({
      listLabels: () => [{ id: "Label_1", name: "Credit Card", type: "user" }],
    });

    const outcome = await processQueuedMaintenanceOperations(deps(db, gmail.client));

    expect(outcome.completed).toBe(1);
    const stored = await db
      .select()
      .from(operations)
      .where(eq(operations.id, "op-plan-1"));
    expect(stored[0]?.status).toBe("completed");
    const progress = JSON.parse(stored[0]?.progressJson ?? "{}");
    expect(progress.entries).toBe(15);
  });

  it("defers maintenance when the wall-time budget is exhausted", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await enqueueOperation(db, {
      accountId: ACCOUNT,
      id: "op-plan-2",
      kind: "migration_plan",
      now: NOW,
      requestJson: "{}",
    });
    const gmail = fakeGmail({});
    const outcome = await processQueuedMaintenanceOperations(
      deps(db, gmail.client, new TimeBudget(NOW, 1000, 0))
    );
    expect(outcome.deferred).toBe(1);
    const stored = await db
      .select()
      .from(operations)
      .where(eq(operations.id, "op-plan-2"));
    expect(stored[0]?.status).toBe("queued");
  });

  it("completes operations when their jobs finish", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db);
    await enqueueOperation(db, {
      accountId: ACCOUNT,
      id: "op-reprocess-1",
      kind: "reprocess",
      now: NOW,
      requestJson: "{}",
    });
    await db.insert(jobs).values({
      accountId: ACCOUNT,
      createdAt: NOW,
      generation: 1,
      id: "job-op-1",
      kind: "reprocess",
      operationId: "op-reprocess-1",
      stage: "completed",
      updatedAt: NOW,
    });

    const updated = await syncOperationStatuses(db, NOW + 1000);
    expect(updated).toBe(1);
    const stored = await db
      .select()
      .from(operations)
      .where(eq(operations.id, "op-reprocess-1"));
    expect(stored[0]?.status).toBe("completed");
  });
});

describe("retention cleanup", () => {
  it("removes expired detail rows while preserving dedup, locks and pending intents", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const config = testConfig({ DETAIL_RETENTION_DAYS: "90" });
    const old = NOW - 200 * 86_400_000;

    const messageId = crypto.randomUUID();
    await db.insert(messages).values({
      accountId: ACCOUNT,
      firstSeenAt: old,
      gmailMessageId: "gm-cleanup-1",
      id: messageId,
      latestClassificationId: "classification-latest",
      receivedAt: old,
      threadId: "t-1",
    });
    await db.insert(classifications).values([
      {
        accountId: ACCOUNT,
        answerJson: "{}",
        createdAt: old,
        decisionJson: "{}",
        id: "classification-latest",
        messageId,
        modelVersion: "jev-1.13.0",
        normalizedInputHash: "hash",
        policyVersion: "policy-v1",
        rubricVersion: "rubric-v1",
        taxonomyVersion: "taxonomy-v1",
      },
      {
        accountId: ACCOUNT,
        answerJson: "{}",
        createdAt: old,
        decisionJson: "{}",
        id: "classification-old",
        messageId,
        modelVersion: "jev-1.13.0",
        normalizedInputHash: "hash",
        policyVersion: "policy-v1",
        rubricVersion: "rubric-v1",
        taxonomyVersion: "taxonomy-v1",
      },
    ]);
    await db.insert(labelMutations).values([
      {
        addLabelIdsJson: "[]",
        beforeLabelIdsJson: "[]",
        createdAt: old,
        desiredLabelIdsJson: "[]",
        generation: 1,
        id: "mutation-pending",
        jobId: "job-x",
        messageId,
        removeLabelIdsJson: "[]",
        status: "pending",
        updatedAt: old,
      },
      {
        addLabelIdsJson: "[]",
        beforeLabelIdsJson: "[]",
        createdAt: old,
        desiredLabelIdsJson: "[]",
        generation: 1,
        id: "mutation-applied",
        jobId: "job-y",
        messageId,
        removeLabelIdsJson: "[]",
        status: "applied",
        updatedAt: old,
      },
    ]);
    await db.insert(syncRuns).values({
      accountId: ACCOUNT,
      id: "sync-old",
      phase: "incremental",
      startedAt: old,
    });

    const outcome = await runRetentionCleanup(db, config, NOW);

    expect(outcome).toMatchObject({
      classifications: 1,
      labelMutations: 1,
      syncRuns: 1,
    });

    const remainingClassifications = await db.select().from(classifications);
    expect(remainingClassifications.map((row) => row.id)).toStrictEqual([
      "classification-latest",
    ]);
    const remainingMutations = await db.select().from(labelMutations);
    expect(remainingMutations.map((row) => row.id)).toStrictEqual(["mutation-pending"]);
    await expect(db.select().from(messages)).resolves.toHaveLength(1);
  });
});
