import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import responseFixture from "../fixtures/jev/response.json";
import { classifyMessage } from "../src/classifier/jev";
import { createDb } from "../src/db/client";
import { claimDueJobs } from "../src/db/repositories/jobs";
import { acquireLease } from "../src/db/repositories/leases";
import { commitHistoryCursor, getMailbox } from "../src/db/repositories/mailboxes";
import {
  appControl,
  classifications,
  idempotencyKeys,
  jobs,
  labelMigrationOperations,
  labelMutations,
  messages,
  operations,
  mailboxes,
} from "../src/db/schema";
import { normalizeMessage } from "../src/email/normalize";
import { GmailClient } from "../src/gmail/client";
import { GmailError } from "../src/gmail/errors";
import { operationWrite, statement, withIdempotency } from "../src/http/idempotency";
import { admit } from "../src/runner/guard";
import {
  processQueuedMaintenanceOperations,
  runRetentionCleanup,
} from "../src/runner/maintenance";
import { processDueJobs } from "../src/runner/process-jobs";
import { TimeBudget } from "../src/runner/time-budget";
import { applyClassifiedJob } from "../src/services/label-apply";
import { executeLabelMigration } from "../src/services/label-migration";
import { buildMigrationPlan, persistInventory } from "../src/services/labels";
import { buildStatus } from "../src/services/status";
import { runBootstrap, runIncrementalSync } from "../src/sync/gmail-sync";
import { LABEL_DEFINITIONS, LABEL_KEYS, PARENT_CONTAINERS } from "../src/taxonomy/labels";
import { readBoundedText } from "../src/utils/bounded-body";
import { testConfig } from "./helpers/config";
import { resetDatabase, seedMailbox } from "./helpers/db";
import { fakeGmail, fullMessage, minimalMessage } from "./helpers/gmail-fake";

const NOW = 1_700_000_000_000;
const ACCOUNT = "owner@example.test";
const db = createDb(env.DB);
const deps = (client = fakeGmail({}).client) => ({
  accountId: ACCOUNT,
  budget: new TimeBudget(NOW, 120_000, 15_000),
  client,
  config: testConfig(),
  db,
  now: () => NOW,
});
const allLabels = () => [
  ...LABEL_KEYS.map((key) => ({
    id: `Label_${key}`,
    name: LABEL_DEFINITIONS[key].name,
    type: "user" as const,
  })),
  ...PARENT_CONTAINERS.map((name) => ({
    id: `parent_${name}`,
    name,
    type: "user" as const,
  })),
];
const seedResult = async () => {
  await db.insert(messages).values({
    accountId: ACCOUNT,
    firstSeenAt: NOW,
    gmailMessageId: "gm",
    id: "m",
    lastGeneration: 1,
    latestClassificationId: "c",
    receivedAt: NOW,
    threadId: "t",
  });
  await db.insert(classifications).values({
    accountId: ACCOUNT,
    answerJson: "{}",
    createdAt: NOW,
    decisionJson: JSON.stringify({
      needsReply: { probability: 0, status: "negative" },
      needsReview: false,
      reviewReasons: [],
      toDo: { probability: 0, status: "negative" },
      topic: {
        confidence: 1,
        key: "bills",
        probability: 1,
        status: "accepted",
        topKey: "bills",
      },
      urgent: { probability: 0, status: "negative" },
    }),
    id: "c",
    messageId: "m",
    modelVersion: "jev",
    normalizedInputHash: "hash",
    policyVersion: "policy-v1",
    rubricVersion: "rubric-v1",
    taxonomyVersion: "taxonomy-v1",
  });
  await db.insert(jobs).values({
    accountId: ACCOUNT,
    createdAt: NOW,
    generation: 1,
    id: "j",
    kind: "initial",
    messageId: "m",
    payloadJson: JSON.stringify({ classificationId: "c" }),
    stage: "classified",
    updatedAt: NOW,
  });
  const [job] = await db.select().from(jobs);
  if (!job) {
    throw new Error("Missing fixture job");
  }
  return job;
};

describe("implementation hardening", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  describe("runtime admission and recovery", () => {
    it("defers inference when fetching used up the stage allowance", async () => {
      await seedResult();
      await db.update(jobs).set({ payloadJson: null, stage: "pending" });
      let clock = NOW;
      const gmail = fakeGmail({
        getMessage: () => {
          clock += 61_000;
          return Promise.resolve(fullMessage("gm", "hello"));
        },
      });
      let calls = 0;
      const ai = {
        run: () => {
          calls += 1;
          return responseFixture;
        },
      } as unknown as Ai;
      await processDueJobs({
        ...deps(gmail.client),
        ai,
        mode: "dry_run",
        now: () => clock,
      });
      const [job] = await db.select().from(jobs);
      expect({
        attempts: job?.attempts,
        calls,
        reason: job?.deferredReason,
      }).toStrictEqual({ attempts: 0, calls: 0, reason: "wall_time" });
    });

    it("preserves a correction that arrives while inference is in flight", async () => {
      await seedResult();
      await db.update(jobs).set({ payloadJson: null, stage: "pending" });
      const gmail = fakeGmail({
        getMessage: () => Promise.resolve(fullMessage("gm", "invoice")),
      });
      let correctionStatus = 0;
      const ai = {
        run: async () => {
          const response = await exports.default.fetch(
            "https://example.test/api/v1/messages/gm/corrections",
            {
              body: JSON.stringify({ topic: "work" }),
              headers: {
                authorization: "Bearer test-admin-token",
                "content-type": "application/json",
                "idempotency-key": "inflight-correction",
              },
              method: "POST",
            }
          );
          correctionStatus = response.status;
          return responseFixture;
        },
      } as unknown as Ai;
      await processDueJobs({ ...deps(gmail.client), ai, mode: "dry_run" });
      const [message] = await db.select().from(messages);
      const [latest] = await db
        .select()
        .from(classifications)
        .where(eq(classifications.id, message?.latestClassificationId ?? ""));
      expect(correctionStatus).toBe(202);
      expect(JSON.parse(latest?.decisionJson ?? "{}")).toMatchObject({
        topic: { key: "work" },
      });
      expect(message?.lastGeneration).toBe(2);
    });

    it("keeps a queued migration untouched after switching to dry-run", async () => {
      await db.insert(operations).values({
        accountId: ACCOUNT,
        id: "migration",
        kind: "migrate",
        requestJson: "{}",
      });
      const gmail = fakeGmail({});
      await processQueuedMaintenanceOperations(deps(gmail.client));
      expect(gmail.calls).toHaveLength(0);
      const [operation] = await db.select().from(operations);
      expect(operation?.status).toBe("queued");
    });

    it("rechecks mode after reading labels and before mutation", async () => {
      const job = await seedResult();
      await db.update(appControl).set({ mode: "apply" });
      await persistInventory(db, ACCOUNT, buildMigrationPlan(allLabels()), NOW);
      const gmail = fakeGmail({
        getMessage: async () => {
          await db.update(appControl).set({ mode: "dry_run" });
          return minimalMessage("gm");
        },
      });
      await expect(applyClassifiedJob(deps(gmail.client), job)).rejects.toMatchObject({
        reason: "pending_mode",
      });
      expect(gmail.calls.some((call) => call.method === "modifyMessage")).toBeFalsy();
    });

    it("stops inference when paused during message fetch", async () => {
      await seedResult();
      await db.update(jobs).set({ payloadJson: null, stage: "pending" });
      const gmail = fakeGmail({
        getMessage: async () => {
          await db.update(appControl).set({ mode: "paused" });
          return fullMessage("gm", "hello");
        },
      });
      let calls = 0;
      const ai = {
        run: () => {
          calls += 1;
          throw new Error("Unexpected inference");
        },
      } as unknown as Ai;
      await processDueJobs({ ...deps(gmail.client), ai, mode: "dry_run" });
      const [job] = await db.select().from(jobs);
      expect({
        attempts: job?.attempts,
        calls,
        reason: job?.deferredReason,
      }).toStrictEqual({ attempts: 0, calls: 0, reason: "pending_mode" });
    });

    it("does not let twenty apply-only jobs starve dry-run work", async () => {
      for await (const i of Array.from({ length: 20 }, (_, index) => index)) {
        await db.insert(jobs).values({
          accountId: ACCOUNT,
          createdAt: NOW - 100,
          id: `blocked-${i}`,
          kind: "correction",
          stage: "classified",
          updatedAt: NOW,
        });
      }
      await db.insert(jobs).values({
        accountId: ACCOUNT,
        createdAt: NOW,
        id: "eligible",
        kind: "initial",
        updatedAt: NOW,
      });
      const claimed = await claimDueJobs(db, {
        accountId: ACCOUNT,
        leaseMs: 180_000,
        limit: 20,
        mode: "dry_run",
        now: NOW,
        ownerToken: "test",
      });
      expect(claimed.map((job) => job.id)).toStrictEqual(["eligible"]);
    });

    it("rejects a stale runner and fences its cursor update", async () => {
      const mailboxId = await seedMailbox(db, { committedHistoryId: "1000" });
      await acquireLease(db, "mailbox", "old", NOW, 1000);
      await acquireLease(db, "mailbox", "new", NOW + 1001, 180_000);
      const fence = { leaseMs: 180_000, ownerToken: "old", resourceKey: "mailbox" };
      await expect(
        admit({ ...deps(), fence, now: () => NOW + 1001 })
      ).rejects.toMatchObject({ reason: "lease_lost" });
      await commitHistoryCursor(db, mailboxId, "2000", NOW + 1001, fence);
      await expect(getMailbox(db)).resolves.toMatchObject({ committedHistoryId: "1000" });
    });

    it("resets an invalid history page without advancing its cursor", async () => {
      await seedMailbox(db, { committedHistoryId: "1000" });
      await db.update(mailboxes).set({ historyPageToken: "expired-page" });
      const gmail = fakeGmail({
        listHistory: ({ pageToken }) => {
          if (pageToken) {
            throw new GmailError("invalid_request", "expired page", 400);
          }
          return Promise.resolve({ history: [], historyId: "2000" });
        },
      });
      await runIncrementalSync(deps(gmail.client));
      await expect(getMailbox(db)).resolves.toMatchObject({
        committedHistoryId: "1000",
        historyPageToken: null,
      });
      await runIncrementalSync(deps(gmail.client));
      await expect(getMailbox(db)).resolves.toMatchObject({ committedHistoryId: "2000" });
    });

    it("skips vanished messages without mistaking them for expired history", async () => {
      await seedMailbox(db, { committedHistoryId: "1000" });
      const gmail = fakeGmail({
        listHistory: () =>
          Promise.resolve({
            history: [
              { id: "h", messagesAdded: [{ message: { id: "gone", threadId: "t" } }] },
            ],
            historyId: "2000",
          }),
      });
      await expect(runIncrementalSync(deps(gmail.client))).resolves.toMatchObject({
        completed: true,
        recoveryStarted: false,
      });
      expect(gmail.calls.some((call) => call.method === "getProfile")).toBeFalsy();
    });

    it("restarts recovery when a bootstrap catch-up anchor expires", async () => {
      await seedMailbox(db);
      await db
        .update(mailboxes)
        .set({ scanAnchorHistoryId: "old", syncPhase: "bootstrap_catchup" });
      const gmail = fakeGmail({
        listHistory: () => Promise.reject(new GmailError("not_found", "expired", 404)),
      });
      await runBootstrap(deps(gmail.client));
      await expect(getMailbox(db)).resolves.toMatchObject({
        scanAnchorHistoryId: "1000",
        scanPageToken: null,
        syncPhase: "recovery_scan",
      });
    });

    it("re-walks stored scan refs without Gmail fetches so a long page completes", async () => {
      await seedMailbox(db);
      const ids = ["gm-1", "gm-2", "gm-3", "gm-4", "gm-5", "gm-6"];
      let clock = NOW;
      const gmail = fakeGmail({
        getMessage: (id) => {
          clock += 6000;
          return Promise.resolve(minimalMessage(id));
        },
        listMessages: () =>
          Promise.resolve({
            messages: ids.map((id) => ({ id, threadId: `t-${id}` })),
          }),
      });
      const tickDeps = () => ({
        ...deps(gmail.client),
        budget: new TimeBudget(clock, 50_000, 15_000),
        now: () => clock,
      });
      const runTicks = async (remaining: number): Promise<boolean> => {
        if (remaining <= 0) {
          return false;
        }
        const outcome = await runBootstrap(tickDeps());
        return outcome.completed || (await runTicks(remaining - 1));
      };

      const completed = await runTicks(10);
      const fetches = gmail.calls.filter((call) => call.method === "getMessage");
      expect({ completed, fetches: fetches.length }).toStrictEqual({
        completed: true,
        fetches: ids.length,
      });
      await expect(getMailbox(db)).resolves.toMatchObject({
        committedHistoryId: "1000",
        syncPhase: "idle",
      });
    });
  });

  describe("durable journals and atomic owner operations", () => {
    it("retries failed application using its saved result without inference", async () => {
      await seedResult();
      await db.update(jobs).set({ stage: "failed" });
      await db.update(appControl).set({ mode: "apply" });
      await persistInventory(db, ACCOUNT, buildMigrationPlan(allLabels()), NOW);
      const response = await exports.default.fetch(
        "https://example.test/api/v1/messages/gm/retry",
        {
          headers: {
            authorization: "Bearer test-admin-token",
            "idempotency-key": "saved-result-retry",
          },
          method: "POST",
        }
      );
      const body = await response.json<{ operationId: string; stage: string }>();
      const gmail = fakeGmail({
        getMessage: () => Promise.resolve(minimalMessage("gm")),
        modifyMessage: (id, changes) =>
          Promise.resolve({
            id,
            labelIds: ["INBOX", ...(changes.addLabelIds ?? [])],
            threadId: "t",
          }),
      });
      let calls = 0;
      const ai = {
        run: () => {
          calls += 1;
          throw new Error("Unexpected inference");
        },
      } as unknown as Ai;
      await processDueJobs({ ...deps(gmail.client), ai, mode: "apply" });
      const [job] = await db.select().from(jobs);
      expect({
        calls,
        operationId: job?.operationId,
        stage: job?.stage,
        status: response.status,
      }).toStrictEqual({
        calls: 0,
        operationId: body.operationId,
        stage: "completed",
        status: 202,
      });
      expect(body.stage).toBe("classified");
    });

    it("commits only one operation for simultaneous identical requests", async () => {
      const record = { key: "concurrent-key", payload: {}, route: "sync" };
      const prepare = () => {
        const operationId = crypto.randomUUID();
        return {
          body: { operationId },
          status: 202,
          writes: [operationWrite(db, operationId, ACCOUNT, "sync", {}, NOW)],
        };
      };
      const [first, second] = await Promise.all([
        withIdempotency(db, ACCOUNT, record, NOW, prepare),
        withIdempotency(db, ACCOUNT, record, NOW, prepare),
      ]);
      expect(first).toStrictEqual(second);
      await expect(db.select().from(operations)).resolves.toHaveLength(1);
    });

    it("recovers a successful rename whose completion was never recorded", async () => {
      await db.update(appControl).set({ mode: "apply" });
      const labels = allLabels().map((label) =>
        label.id === "Label_receipts"
          ? { ...label, name: "Transaction Receipt and Confirmation" }
          : label
      );
      const gmail = fakeGmail({
        listLabels: () => Promise.resolve(structuredClone(labels)),
        renameLabel: (id, name) => {
          const label = labels.find((candidate) => candidate.id === id);
          if (label) {
            label.name = name;
          }
          return Promise.reject(new Error("Interrupted after Gmail succeeded"));
        },
      });
      await expect(
        executeLabelMigration(deps(gmail.client), "migration")
      ).rejects.toThrow("Interrupted");
      const before = await db
        .select()
        .from(labelMigrationOperations)
        .where(eq(labelMigrationOperations.action, "rename"));
      expect(before[0]).toMatchObject({
        oldName: "Transaction Receipt and Confirmation",
        status: "pending",
      });
      await executeLabelMigration(deps(gmail.client), "migration");
      const after = await db
        .select()
        .from(labelMigrationOperations)
        .where(eq(labelMigrationOperations.action, "rename"));
      expect(after[0]).toMatchObject({
        id: before[0]?.id,
        labelId: "Label_receipts",
        oldName: "Transaction Receipt and Confirmation",
        status: "completed",
      });
      expect(gmail.calls.filter((call) => call.method === "renameLabel")).toHaveLength(1);
    });

    it("rolls back operation writes and the replay key together on failure", async () => {
      const record = { key: "atomic-key", payload: {}, route: "sync" };
      await expect(
        withIdempotency(db, ACCOUNT, record, NOW, () => ({
          body: { operationId: "op" },
          status: 202,
          writes: [
            operationWrite(db, "op", ACCOUNT, "sync", {}, NOW),
            statement(
              db,
              "INSERT INTO jobs (id, account_id, kind, generation) VALUES (?, ?, ?, ?)",
              "invalid",
              ACCOUNT,
              "initial",
              0
            ),
          ],
        }))
      ).rejects.toThrow("CHECK constraint");
      await expect(db.select().from(operations)).resolves.toHaveLength(0);
      await expect(db.select().from(idempotencyKeys)).resolves.toHaveLength(0);
      await withIdempotency(db, ACCOUNT, record, NOW, () => ({
        body: { operationId: "op" },
        status: 202,
        writes: [operationWrite(db, "op", ACCOUNT, "sync", {}, NOW)],
      }));
      await expect(db.select().from(operations)).resolves.toHaveLength(1);
    });

    it("replays a committed operation after the response is lost", async () => {
      const record = { key: "response-lost", payload: { a: 1, b: 2 }, route: "sync" };
      const first = await withIdempotency(db, ACCOUNT, record, NOW, () => ({
        body: { operationId: "op" },
        status: 202,
        writes: [operationWrite(db, "op", ACCOUNT, "sync", {}, NOW)],
      }));
      const replay = await withIdempotency(
        db,
        ACCOUNT,
        { ...record, payload: JSON.parse('{"b":2,"a":1}') },
        NOW,
        () => {
          throw new Error("Must not run twice");
        }
      );
      expect(replay).toStrictEqual(first);
      await expect(db.select().from(operations)).resolves.toHaveLength(1);
    });

    it("does not mark an obsolete mutation satisfied by dropping stale IDs", async () => {
      const job = await seedResult();
      await db.update(appControl).set({ mode: "apply" });
      await persistInventory(db, ACCOUNT, buildMigrationPlan(allLabels()), NOW);
      await db.insert(labelMutations).values({
        addLabelIdsJson: '["deleted-label"]',
        beforeLabelIdsJson: '["INBOX"]',
        desiredLabelIdsJson: '["INBOX","deleted-label"]',
        generation: 1,
        id: "stale",
        jobId: job.id,
        messageId: "m",
        removeLabelIdsJson: "[]",
        status: "pending",
      });
      const gmail = fakeGmail({
        getMessage: () => Promise.resolve(minimalMessage("gm")),
        modifyMessage: (id, changes) =>
          Promise.resolve({
            id,
            labelIds: ["INBOX", ...(changes.addLabelIds ?? [])],
            threadId: "t",
          }),
      });
      await expect(applyClassifiedJob(deps(gmail.client), job)).resolves.toMatchObject({
        added: ["Label_bills"],
        status: "applied",
      });
      const [old] = await db
        .select()
        .from(labelMutations)
        .where(eq(labelMutations.id, "stale"));
      expect(old?.status).toBe("superseded");
    });

    it("expires the latest result while preserving message identity", async () => {
      await seedResult();
      await db.update(jobs).set({ stage: "completed" });
      await runRetentionCleanup(db, testConfig(), NOW + 100 * 86_400_000);
      await expect(db.select().from(classifications)).resolves.toHaveLength(0);
      const [message] = await db.select().from(messages);
      expect(message).toMatchObject({ id: "m", latestClassificationId: null });
      await expect(db.select().from(jobs)).resolves.toHaveLength(1);
    });

    it("retains an idempotency key for as long as its operation exists", async () => {
      await withIdempotency(
        db,
        ACCOUNT,
        { key: "long-operation", payload: {}, route: "sync" },
        NOW,
        () => ({
          body: { operationId: "op" },
          status: 202,
          writes: [operationWrite(db, "op", ACCOUNT, "sync", {}, NOW)],
        })
      );
      await runRetentionCleanup(db, testConfig(), NOW + 200 * 86_400_000);
      await expect(db.select().from(idempotencyKeys)).resolves.toHaveLength(1);
    });
  });

  describe("boundaries and reporting", () => {
    it("rejects unapproved user labels at the Gmail adapter boundary", () => {
      const client = new GmailClient({
        tokens: { getAccessToken: () => Promise.resolve("test"), invalidate: () => {} },
      });
      expect(() =>
        client.modifyMessage("gm", { addLabelIds: ["unrelated"] }, new Set(["approved"]))
      ).toThrow("unapproved");
      expect(() =>
        client.modifyMessage("gm", { addLabelIds: ["INBOX"] }, new Set(["INBOX"]))
      ).toThrow("system label");
    });

    it("enforces response size while streaming without trusting Content-Length", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelled = true;
        },
        pull: (controller) => {
          controller.enqueue(new Uint8Array(100));
        },
      });
      await expect(readBoundedText(new Response(body), 150)).rejects.toMatchObject({
        code: "input_too_large",
      });
      expect(cancelled).toBeTruthy();
    });

    it("bounds the full model request including header metadata", async () => {
      const normalized = await normalizeMessage(fullMessage("gm", "short body"), {
        maxBodyCharacters: 12_000,
      });
      normalized.listId = "x".repeat(40_000);
      const ai = {
        run: () => {
          throw new Error("Must not send oversized input");
        },
      } as unknown as Ai;
      await expect(
        classifyMessage(ai, normalized, testConfig(), NOW, { gatewayId: "test" })
      ).rejects.toMatchObject({ code: "model_input_too_large" });
    });

    it("requires all fifteen label mappings before reporting ready", async () => {
      await persistInventory(
        db,
        ACCOUNT,
        buildMigrationPlan(allLabels().slice(0, 1)),
        NOW
      );
      await expect(buildStatus(db, testConfig(), NOW)).resolves.toMatchObject({
        labels: { migration: "not_ready" },
      });
      await persistInventory(db, ACCOUNT, buildMigrationPlan(allLabels()), NOW);
      await expect(buildStatus(db, testConfig(), NOW)).resolves.toMatchObject({
        labels: { mapped: 15, migration: "ready" },
      });
    });
  });
});
