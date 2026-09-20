import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import responseFixture from "../fixtures/jev/response.json";
import { createDb } from "../src/db/client";
import { createInitialJob, claimDueJobs } from "../src/db/repositories/jobs";
import { enqueueOperation } from "../src/db/repositories/operations";
import {
  appControl,
  classifications,
  jobs,
  labelMappings,
  labelMutations,
  mailboxes,
  messages,
} from "../src/db/schema";
import { GmailError } from "../src/gmail/errors";
import { processDueJobs } from "../src/runner/process-jobs";
import { TimeBudget } from "../src/runner/time-budget";
import { runBootstrap, runIncrementalSync } from "../src/sync/gmail-sync";
import { LABEL_DEFINITIONS, LABEL_KEYS } from "../src/taxonomy/labels";
import { testConfig } from "./helpers/config";
import { resetDatabase, seedMailbox } from "./helpers/db";
import { fakeGmail, minimalMessage } from "./helpers/gmail-fake";

const NOW = 1_700_000_000_000;
const ACCOUNT = "owner@example.test";

const syncDeps = (
  db: ReturnType<typeof createDb>,
  client: ReturnType<typeof fakeGmail>["client"],
  options: { now?: () => number; budget?: TimeBudget } = {}
) => ({
  accountId: ACCOUNT,
  budget: options.budget ?? new TimeBudget(NOW, 120_000, 15_000),
  client,
  config: testConfig(),
  db,
  now: options.now ?? (() => NOW),
});

const seedMappings = async (db: ReturnType<typeof createDb>) => {
  for await (const key of LABEL_KEYS) {
    await db.insert(labelMappings).values({
      accountId: ACCOUNT,
      currentName: LABEL_DEFINITIONS[key].name,
      gmailLabelId: `Label_${key}`,
      id: crypto.randomUUID(),
      legacyAliasIdsJson: "[]",
      migrationState: "ready",
      semanticKey: key,
      updatedAt: NOW,
    });
  }
};

const seedClassifiedJob = async (
  db: ReturnType<typeof createDb>,
  options: {
    appOwned?: string[];
    lastObserved?: string[];
    dimensionStates?: Record<string, { locked: boolean; userControlled: boolean }>;
    lastGeneration?: number;
    jobGeneration?: number;
    decisions?: Record<string, unknown>;
  } = {}
) => {
  await resetDatabase(db);
  await seedMailbox(db, { committedHistoryId: "1000" });
  await seedMappings(db);
  await db.update(appControl).set({ mode: "apply" });

  const messageId = crypto.randomUUID();
  await db.insert(messages).values({
    accountId: ACCOUNT,
    appOwnedLabelIdsJson: JSON.stringify(options.appOwned ?? []),
    dimensionLocksJson: JSON.stringify(options.dimensionStates ?? {}),
    firstSeenAt: NOW - 1000,
    gmailMessageId: "gm-reg-1",
    id: messageId,
    lastGeneration: options.lastGeneration ?? 1,
    lastObservedLabelIdsJson: JSON.stringify(options.lastObserved ?? []),
    latestClassificationId: "classification-reg-1",
    receivedAt: NOW - 1000,
    threadId: "t-reg-1",
  });
  await db.insert(classifications).values({
    accountId: ACCOUNT,
    answerJson: "{}",
    applicationStatus: "proposed",
    createdAt: NOW,
    decisionJson: JSON.stringify(
      options.decisions ?? {
        needsReply: { probability: 0.05, status: "negative" },
        needsReview: false,
        reviewReasons: [],
        toDo: { probability: 0.05, status: "negative" },
        topic: {
          confidence: 0.95,
          key: "bills",
          probability: 0.95,
          status: "accepted",
          topKey: "bills",
        },
        urgent: { probability: 0.05, status: "negative" },
      }
    ),
    durationMs: 10,
    id: "classification-reg-1",
    messageId,
    modelVersion: "jev-1.13.0",
    normalizedInputHash: "hash",
    policyVersion: "policy-v1",
    reviewFlag: false,
    reviewReasonsJson: "[]",
    rubricVersion: "rubric-v1",
    taxonomyVersion: "taxonomy-v1",
    usageJson: "{}",
  });

  const jobId = crypto.randomUUID();
  await db.insert(jobs).values({
    accountId: ACCOUNT,
    createdAt: NOW,
    generation: options.jobGeneration ?? 1,
    id: jobId,
    kind: "initial",
    messageId,
    stage: "classified",
    updatedAt: NOW,
  });
  return { jobId, messageId };
};

const processDeps = (
  db: ReturnType<typeof createDb>,
  client: ReturnType<typeof fakeGmail>["client"],
  ai: Ai,
  nowMs: number = NOW
) => ({
  accountId: ACCOUNT,
  ai,
  budget: new TimeBudget(nowMs, 120_000, 15_000),
  client,
  config: testConfig(),
  db,
  mode: "apply" as const,
  now: () => nowMs,
});

describe("sync resume correctness", () => {
  it("resumes bootstrap catch-up from the history token without replaying the inbox scan", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db);
    await db
      .update(mailboxes)
      .set({
        historyPageToken: "history-2",
        scanAnchorHistoryId: "1000",
        scanPageToken: null,
        syncPhase: "bootstrap_catchup",
      })
      .where(eq(mailboxes.email, ACCOUNT));

    const gmail = fakeGmail({
      listHistory: () => ({ history: [], historyId: "2000" }),
      listMessages: () => {
        throw new Error("the inbox scan must not be replayed during catch-up");
      },
    });

    const result = await runBootstrap(syncDeps(db, gmail.client));

    expect(result.completed).toBeTruthy();
    expect(gmail.calls.some((call) => call.method === "listMessages")).toBeFalsy();
    const [mailbox] = await db.select().from(mailboxes);
    expect(mailbox?.committedHistoryId).toBe("2000");
    expect(mailbox?.historyPageToken).toBeNull();
  });

  it("does not drop a message when the inner budget check trips", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db, { committedHistoryId: "1000" });

    const gmail = fakeGmail({
      getMessage: (id) => minimalMessage(id),
      listHistory: (params) => {
        if (params.pageToken === "history-2") {
          return { history: [], historyId: "2000" };
        }
        return {
          history: [
            { id: "h1", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] },
          ],
          nextPageToken: "history-2",
        };
      },
    });

    let budgetCalls = 0;
    const firstRunBudget = {
      canSpend: () => {
        budgetCalls += 1;
        return budgetCalls <= 1;
      },
      remaining: () => 0,
    } as unknown as TimeBudget;

    const first = await runIncrementalSync(
      syncDeps(db, gmail.client, { budget: firstRunBudget })
    );
    expect(first).toMatchObject({ completed: false, deferred: true });
    await expect(db.select().from(jobs)).resolves.toHaveLength(0);
    const [mailboxRow] = await db.select().from(mailboxes);
    expect(mailboxRow?.committedHistoryId).toBe("1000");

    const resumed = await runIncrementalSync(
      syncDeps(db, gmail.client, { budget: new TimeBudget(NOW, 120_000, 15_000) })
    );
    expect(resumed.completed).toBeTruthy();
    await expect(db.select().from(jobs)).resolves.toHaveLength(1);
  });
});

describe("job recovery and generation safety", () => {
  it("reclaims jobs stuck in classifying after their lease expires", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db);
    const messageId = crypto.randomUUID();
    await db.insert(messages).values({
      accountId: ACCOUNT,
      firstSeenAt: NOW,
      gmailMessageId: "gm-stuck",
      id: messageId,
      receivedAt: NOW,
      threadId: "t-stuck",
    });
    await createInitialJob(db, {
      accountId: ACCOUNT,
      id: "job-stuck",
      messageId,
      now: NOW,
    });
    await db
      .update(jobs)
      .set({
        leaseExpiresAt: NOW - 1,
        leaseToken: "dead-runner",
        stage: "classifying",
      })
      .where(eq(jobs.id, "job-stuck"));

    const claimed = await claimDueJobs(db, {
      accountId: ACCOUNT,
      leaseMs: 60_000,
      limit: 10,
      now: NOW,
      ownerToken: "new-runner",
    });
    expect(claimed.map((job) => job.id)).toStrictEqual(["job-stuck"]);
  });

  it("does not re-run inference when an apply attempt fails after classification", async () => {
    const db = createDb(env.DB);
    await seedClassifiedJob(db);
    let aiCalls = 0;
    let modifyCalls = 0;
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-reg-1",
        labelIds: ["INBOX"],
        threadId: "t-reg-1",
      }),
      modifyMessage: () => {
        modifyCalls += 1;
        throw new GmailError("server_error", "temporary failure", 500);
      },
    });

    await processDueJobs(
      processDeps(db, gmail.client, {
        run: () => {
          aiCalls += 1;
          return responseFixture;
        },
      } as unknown as Ai)
    );
    let [job] = await db.select().from(jobs);
    expect({
      attempts: job?.attempts,
      next: job?.nextAttemptAt,
      stage: job?.stage,
    }).toStrictEqual({
      attempts: 1,
      next: expect.any(Number),
      stage: "classified",
    });
    expect(modifyCalls).toBe(1);

    await processDueJobs(
      processDeps(
        db,
        gmail.client,
        {
          run: () => {
            aiCalls += 1;
            return responseFixture;
          },
        } as unknown as Ai,
        NOW + 600_000
      )
    );
    [job] = await db.select().from(jobs);
    expect(aiCalls).toBe(0);
    expect(modifyCalls).toBe(2);
  });

  it("refuses to apply a superseded generation", async () => {
    const db = createDb(env.DB);
    await seedClassifiedJob(db, { jobGeneration: 1, lastGeneration: 3 });
    let modifyCalls = 0;
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-reg-1",
        labelIds: ["INBOX"],
        threadId: "t-reg-1",
      }),
      modifyMessage: (id, changes) => {
        modifyCalls += 1;
        return {
          id,
          labelIds: ["INBOX", ...(changes.addLabelIds ?? [])],
          threadId: "t-reg-1",
        };
      },
    });

    const outcome = await processDueJobs(
      processDeps(db, gmail.client, {
        run: () => responseFixture,
      } as unknown as Ai)
    );
    expect(outcome.skipped).toBe(1);
    expect(modifyCalls).toBe(0);
    const [jobRow] = await db.select().from(jobs);
    expect(jobRow?.errorCode).toBe("superseded_generation");
  });

  it("supersedes older unfinished jobs when a new generation is allocated", async () => {
    const db = createDb(env.DB);
    await seedClassifiedJob(db);
    const { allocateMessageGeneration, supersedeOlderJobs } =
      await import("../src/db/repositories/jobs");
    const [messageRow] = await db.select().from(messages);
    const messageId = messageRow?.id ?? "";
    const generation = (await allocateMessageGeneration(db, messageId)) ?? 0;
    expect(generation).toBe(2);
    await supersedeOlderJobs(db, messageId, generation, NOW);
    const [oldJob] = await db.select().from(jobs);
    expect(oldJob?.stage).toBe("skipped");
    expect(oldJob?.errorCode).toBe("superseded");
  });
});

describe("mutation journal and ownership", () => {
  it("restores ownership when reconciling a satisfied pending intent", async () => {
    const db = createDb(env.DB);
    const { messageId, jobId } = await seedClassifiedJob(db);
    await db.insert(labelMutations).values({
      addLabelIdsJson: JSON.stringify(["Label_bills"]),
      beforeLabelIdsJson: JSON.stringify(["INBOX"]),
      createdAt: NOW,
      desiredLabelIdsJson: JSON.stringify(["INBOX", "Label_bills"]),
      generation: 1,
      id: "intent-reg-1",
      jobId,
      messageId,
      removeLabelIdsJson: JSON.stringify([]),
      status: "pending",
      updatedAt: NOW,
    });
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-reg-1",
        labelIds: ["INBOX", "Label_bills"],
        threadId: "t-reg-1",
      }),
      modifyMessage: () => {
        throw new Error("must not modify when the intent is already satisfied");
      },
    });

    const outcome = await processDueJobs(
      processDeps(db, gmail.client, {
        run: () => responseFixture,
      } as unknown as Ai)
    );
    expect(outcome.processed).toBe(1);
    const stored = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(JSON.parse(stored[0]?.appOwnedLabelIdsJson ?? "[]")).toContain("Label_bills");
    const [mutationRow] = await db.select().from(labelMutations);
    expect(mutationRow?.status).toBe("applied");
  });

  it("applies an explicit correction even when the owner changed that label", async () => {
    const db = createDb(env.DB);
    const { messageId } = await seedClassifiedJob(db, {
      appOwned: ["Label_bills"],
      dimensionStates: { topic: { locked: false, userControlled: false } },
      lastObserved: ["INBOX", "Label_bills"],
    });
    await db.insert(jobs).values({
      accountId: ACCOUNT,
      createdAt: NOW,
      generation: 1,
      id: "correction-job-1",
      kind: "correction",
      messageId,
      stage: "classified",
      updatedAt: NOW,
    });
    const { recordCorrection } = await import("../src/db/repositories/corrections");
    const { setDimensionLocks } = await import("../src/services/corrections");
    await recordCorrection(db, {
      changedDimensionsJson: JSON.stringify(["topic"]),
      id: "correction-reg-1",
      messageId,
      now: NOW,
      replacementValuesJson: JSON.stringify({ topic: "applications" }),
    });
    await setDimensionLocks(db, messageId, ["topic"]);
    const [existingJob] = await db.select().from(jobs);
    await db
      .update(jobs)
      .set({ errorCode: "superseded", stage: "skipped" })
      .where(eq(jobs.id, existingJob?.id ?? ""));

    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-reg-1",
        labelIds: ["INBOX"],
        threadId: "t-reg-1",
      }),
      modifyMessage: (id, changes) => ({
        id,
        labelIds: ["INBOX", ...(changes.addLabelIds ?? [])],
        threadId: "t-reg-1",
      }),
    });

    await processDueJobs(
      processDeps(db, gmail.client, {
        run: () => responseFixture,
      } as unknown as Ai)
    );

    const modify = gmail.calls.find((call) => call.method === "modifyMessage");
    expect(modify?.args[1]).toMatchObject({ addLabelIds: ["Label_applications"] });
  });

  it("removes user-owned labels when an explicit correction replaces the dimension", async () => {
    const db = createDb(env.DB);
    const { messageId } = await seedClassifiedJob(db, {
      appOwned: [],
      lastObserved: ["INBOX", "Label_bills"],
    });
    await db.insert(jobs).values({
      accountId: ACCOUNT,
      createdAt: NOW,
      generation: 1,
      id: "correction-job-2",
      kind: "correction",
      messageId,
      stage: "classified",
      updatedAt: NOW,
    });
    await db
      .update(jobs)
      .set({ errorCode: "superseded", stage: "skipped" })
      .where(eq(jobs.kind, "initial"));
    const { recordCorrection } = await import("../src/db/repositories/corrections");
    await recordCorrection(db, {
      changedDimensionsJson: JSON.stringify(["topic"]),
      id: "correction-reg-2",
      messageId,
      now: NOW,
      replacementValuesJson: JSON.stringify({ topic: "applications" }),
    });
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-reg-1",
        labelIds: ["INBOX", "Label_bills"],
        threadId: "t-reg-1",
      }),
      modifyMessage: (id, changes) => ({
        id,
        labelIds: ["INBOX", ...(changes.addLabelIds ?? [])].filter(
          (labelId) => !(changes.removeLabelIds ?? []).includes(labelId)
        ),
        threadId: "t-reg-1",
      }),
    });

    await processDueJobs(
      processDeps(db, gmail.client, {
        run: () => responseFixture,
      } as unknown as Ai)
    );

    const modify = gmail.calls.find(
      (call) =>
        call.method === "modifyMessage" &&
        (call.args[1] as { removeLabelIds?: string[] }).removeLabelIds?.includes(
          "Label_bills"
        )
    );
    expect(modify?.args[1]).toMatchObject({
      addLabelIds: ["Label_applications"],
      removeLabelIds: ["Label_bills"],
    });
  });
});

describe("operation coalescing with distinct keys", () => {
  it("allows two queued operations of the same kind with different coalesce keys", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const first = await enqueueOperation(db, {
      accountId: ACCOUNT,
      coalesceKey: "sync",
      id: "op-key-a",
      kind: "sync",
      now: NOW,
      requestJson: "{}",
    });
    const second = await enqueueOperation(db, {
      accountId: ACCOUNT,
      coalesceKey: "sync-followup",
      id: "op-key-b",
      kind: "sync",
      now: NOW,
      requestJson: "{}",
    });
    expect(first.created).toBeTruthy();
    expect(second.created).toBeTruthy();
  });
});

describe("INBOX re-entry", () => {
  it("reactivates an initial job that was skipped for leaving the inbox", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db, { committedHistoryId: "1000" });
    const messageId = crypto.randomUUID();
    await db.insert(messages).values({
      accountId: ACCOUNT,
      firstSeenAt: NOW,
      gmailMessageId: "gm-reentry",
      id: messageId,
      lastGeneration: 1,
      receivedAt: NOW,
      threadId: "t-reentry",
    });
    await createInitialJob(db, {
      accountId: ACCOUNT,
      id: "job-reentry",
      messageId,
      now: NOW,
    });
    await db
      .update(jobs)
      .set({ errorCode: "not_in_inbox", stage: "skipped" })
      .where(eq(jobs.id, "job-reentry"));

    const gmail = fakeGmail({
      getMessage: (id) => minimalMessage(id, { labels: ["INBOX"] }),
      listHistory: () => ({
        history: [
          {
            id: "h1",
            labelsAdded: [
              {
                labelIds: ["INBOX"],
                message: { id: "gm-reentry", threadId: "t-reentry" },
              },
            ],
          },
        ],
        historyId: "2000",
      }),
    });

    const result = await runIncrementalSync(syncDeps(db, gmail.client));
    expect(result.completed).toBeTruthy();
    const [job] = await db.select().from(jobs);
    expect(job?.stage).toBe("pending");
    expect(job?.errorCode).toBeNull();
  });
});
