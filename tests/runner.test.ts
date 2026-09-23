import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import responseFixture from "../fixtures/jev/response.json";
import { createDb } from "../src/db/client";
import { createInitialJob, createGenerationJob } from "../src/db/repositories/jobs";
import { acquireLease } from "../src/db/repositories/leases";
import { getMailbox } from "../src/db/repositories/mailboxes";
import { enqueueOperation } from "../src/db/repositories/operations";
import {
  aiDailyUsage,
  classifications,
  labelMappings,
  appControl,
  jobs,
  leases,
  mailboxes,
  messages,
  operations,
} from "../src/db/schema";
import type { Job } from "../src/db/schema";
import { GmailError } from "../src/gmail/errors";
import { processQueuedBackfills } from "../src/runner/backfill";
import { processDueJobs } from "../src/runner/process-jobs";
import { runScheduledTick } from "../src/runner/runner";
import { TimeBudget } from "../src/runner/time-budget";
import { runBootstrap, runIncrementalSync, runRecovery } from "../src/sync/gmail-sync";
import type { SyncDeps } from "../src/sync/gmail-sync";
import { testConfig } from "./helpers/config";
import { resetDatabase, seedMailbox } from "./helpers/db";
import { fakeGmail, fullMessage, minimalMessage } from "./helpers/gmail-fake";
import type { FakeGmail } from "./helpers/gmail-fake";

const NOW = 1_700_000_000_000;
const ACCOUNT = "owner@example.test";
const passiveGithubMessage = (id: string, body = "Merged #123 into main.") => {
  const text = `${body}\n\n-- \nReply to this email directly or view it on GitHub:\nhttps://github.com/acme/widget/pull/123#event-456\nYou are receiving this because your review was requested.\n\nMessage ID: <acme/widget/pull/123/issue_event/456@github.com>\n`;
  return {
    ...minimalMessage(id),
    payload: {
      body: { data: btoa(text) },
      headers: [
        { name: "From", value: "GitHub <notifications@github.com>" },
        { name: "To", value: ACCOUNT },
        { name: "Subject", value: "[acme/widget] Pull request #123 merged" },
        { name: "List-Id", value: "acme/widget <widget.acme.github.com>" },
        {
          name: "Message-ID",
          value: "<acme/widget/pull/123/issue_event/456@github.com>",
        },
        { name: "X-GitHub-Reason", value: "review_requested" },
        { name: "X-GitHub-Recipient-Address", value: ACCOUNT },
        {
          name: "Authentication-Results",
          value:
            "mx.google.com; dkim=pass header.i=@github.com; dmarc=pass header.from=github.com",
        },
      ],
      mimeType: "text/plain",
    },
  };
};

const deps = (
  db: ReturnType<typeof createDb>,
  client: FakeGmail["client"],
  options: {
    now?: () => number;
    budget?: TimeBudget;
    config?: ReturnType<typeof testConfig>;
  } = {}
): SyncDeps => ({
  accountId: ACCOUNT,
  budget: options.budget ?? new TimeBudget(NOW, 120_000, 15_000),
  client,
  config: options.config ?? testConfig(),
  db,
  now: options.now ?? (() => NOW),
});

const fakeAi = (payload: unknown = responseFixture) =>
  ({ run: () => payload }) as unknown as Ai;

const jobRows = (db: ReturnType<typeof createDb>): Promise<Job[]> =>
  db.select().from(jobs);

describe("bootstrap and history sync", () => {
  it("scans the inbox, catches arrivals during the scan and commits the cursor", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db);

    const scanPages = [
      { messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "page-2" },
      { messages: [{ id: "m2", threadId: "t2" }] },
    ];
    let scanIndex = 0;
    const gmail = fakeGmail({
      getMessage: (id) => minimalMessage(id, { receivedAt: NOW - 1000 }),
      listHistory: () => ({
        history: [
          { id: "h1", messagesAdded: [{ message: { id: "m3", threadId: "t3" } }] },
        ],
        historyId: "2000",
      }),
      listMessages: () => {
        const page = scanPages[scanIndex];
        scanIndex += 1;
        return page ?? { messages: [] };
      },
    });

    const result = await runBootstrap(deps(db, gmail.client));

    expect(result).toMatchObject({ completed: true, discovered: 3 });
    const mailbox = await getMailbox(db);
    expect(mailbox).toMatchObject({
      committedHistoryId: "2000",
      scanAnchorHistoryId: null,
      syncPhase: "idle",
    });
    await expect(jobRows(db)).resolves.toHaveLength(3);
  });

  it("creates one initial job per message when history repeats ids across pages", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db, { committedHistoryId: "1000" });

    let historyCall = 0;
    const gmail = fakeGmail({
      getMessage: (id) => minimalMessage(id),
      listHistory: () => {
        historyCall += 1;
        if (historyCall === 1) {
          return {
            history: [
              { id: "h1", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] },
              { id: "h2", messagesAdded: [{ message: { id: "m2", threadId: "t2" } }] },
            ],
            nextPageToken: "history-2",
          };
        }
        return {
          history: [
            { id: "h3", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] },
            { id: "h4", messagesAdded: [{ message: { id: "m3", threadId: "t3" } }] },
          ],
          historyId: "2000",
        };
      },
    });

    const result = await runIncrementalSync(deps(db, gmail.client));

    expect(result.completed).toBeTruthy();
    expect(result.discovered).toBe(3);
    await expect(jobRows(db)).resolves.toHaveLength(3);
    const mailboxRow = await getMailbox(db);
    expect(mailboxRow?.committedHistoryId).toBe("2000");
  });

  it("defers without committing the cursor and resumes without duplicates", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db, { committedHistoryId: "1000" });

    let clock = NOW;
    let historyCall = 0;
    const gmail = fakeGmail({
      getMessage: (id) => {
        clock += 5000;
        return minimalMessage(id);
      },
      listHistory: () => {
        historyCall += 1;
        if (historyCall === 1) {
          return {
            history: [
              { id: "h1", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] },
            ],
            nextPageToken: "history-2",
          };
        }
        return {
          history: [
            { id: "h2", messagesAdded: [{ message: { id: "m2", threadId: "t2" } }] },
          ],
          historyId: "2000",
        };
      },
    });

    const first = await runIncrementalSync(
      deps(db, gmail.client, {
        budget: new TimeBudget(NOW, 24_000, 0),
        now: () => clock,
      })
    );
    const firstMailbox = await getMailbox(db);
    expect({
      ...first,
      committedHistoryId: firstMailbox?.committedHistoryId,
    }).toMatchObject({
      committedHistoryId: "1000",
      completed: false,
      deferred: true,
    });
    await expect(jobRows(db)).resolves.toHaveLength(1);

    clock = NOW;
    const second = await runIncrementalSync(deps(db, gmail.client));
    const secondMailbox = await getMailbox(db);
    expect({
      ...second,
      committedHistoryId: secondMailbox?.committedHistoryId,
    }).toMatchObject({
      committedHistoryId: "2000",
      completed: true,
    });
    await expect(jobRows(db)).resolves.toHaveLength(2);
  });

  it("keeps the cursor unchanged when history fails before any job is durable", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db, { committedHistoryId: "1000" });

    const gmail = fakeGmail({
      listHistory: () => {
        throw new GmailError("server_error", "history unavailable", 500);
      },
    });

    await expect(runIncrementalSync(deps(db, gmail.client))).rejects.toMatchObject({
      reason: "server_error",
    });
    const failedMailbox = await getMailbox(db);
    expect(failedMailbox?.committedHistoryId).toBe("1000");
    await expect(jobRows(db)).resolves.toHaveLength(0);
  });

  it("recovers from an expired history cursor with a full inbox scan", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db, { committedHistoryId: "1000" });

    let historyMode: "expired" | "catchup" = "expired";
    const gmail = fakeGmail({
      getMessage: (id) => minimalMessage(id, { receivedAt: NOW - 90 * 86_400_000 }),
      getProfile: () => ({
        ...responseFixture,
        emailAddress: ACCOUNT,
        historyId: "1500",
      }),
      listHistory: () => {
        if (historyMode === "expired") {
          throw new GmailError("not_found", "history expired", 404);
        }
        return {
          history: [],
          historyId: "3000",
        };
      },
      listMessages: () => ({ messages: [{ id: "m-old", threadId: "t-old" }] }),
    });

    const triggered = await runIncrementalSync(deps(db, gmail.client));
    const recovering = await getMailbox(db);
    expect({ ...triggered, ...recovering }).toMatchObject({
      recoveryStarted: true,
      scanAnchorHistoryId: "1500",
      syncPhase: "recovery_scan",
    });

    historyMode = "catchup";
    const recovered = await runRecovery(deps(db, gmail.client));
    const recoveredMailbox = await getMailbox(db);
    expect({
      ...recovered,
      committedHistoryId: recoveredMailbox?.committedHistoryId,
    }).toMatchObject({
      committedHistoryId: "3000",
      completed: true,
    });
    await expect(jobRows(db)).resolves.toHaveLength(1);
  });

  it("ignores label-only events and evaluates messages that gain INBOX", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMailbox(db, { committedHistoryId: "1000" });

    const gmail = fakeGmail({
      getMessage: (id) =>
        minimalMessage(id, { labels: id === "m-inbox" ? ["INBOX"] : ["Label_9"] }),
      listHistory: () => ({
        history: [
          {
            id: "h1",
            labelsAdded: [
              { labelIds: ["Label_9"], message: { id: "m-travel", threadId: "t1" } },
            ],
          },
          {
            id: "h2",
            labelsAdded: [
              { labelIds: ["INBOX"], message: { id: "m-inbox", threadId: "t2" } },
            ],
          },
        ],
        historyId: "2000",
      }),
    });

    const result = await runIncrementalSync(deps(db, gmail.client));
    expect(result.completed).toBeTruthy();
    const rows = await jobRows(db);
    expect(rows).toHaveLength(1);
    expect(gmail.calls.filter((call) => call.method === "getMessage")).toHaveLength(1);
  });
});

describe("job processing", () => {
  const seedJob = async (db: ReturnType<typeof createDb>, gmailId = "gm-1") => {
    await resetDatabase(db);
    const mailboxId = await seedMailbox(db, { committedHistoryId: "1000" });
    void mailboxId;
    const messageId = crypto.randomUUID();
    await db.insert(messages).values({
      accountId: ACCOUNT,
      firstSeenAt: NOW - 1000,
      gmailMessageId: gmailId,
      id: messageId,
      lastGeneration: 1,
      receivedAt: NOW - 1000,
      threadId: "t-1",
    });
    await createInitialJob(db, {
      accountId: ACCOUNT,
      id: crypto.randomUUID(),
      messageId,
      now: NOW,
    });
    return messageId;
  };

  it("classifies in dry-run, completes the job and never mutates Gmail", async () => {
    const db = createDb(env.DB);
    const messageId = await seedJob(db);
    const gmail = fakeGmail({
      getMessage: (id, format) =>
        format === "full"
          ? fullMessage(id, "Your invoice is ready. Payment is collected automatically.")
          : minimalMessage(id),
    });

    const outcome = await processDueJobs({
      accountId: ACCOUNT,
      ai: fakeAi(),
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: gmail.client,
      config: testConfig(),
      db,
      mode: "dry_run",
      now: () => NOW,
    });

    expect(outcome.processed).toBe(1);
    const rows = await jobRows(db);
    expect(rows[0]?.stage).toBe("completed");
    const storedMessage = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(storedMessage[0]?.applicationStatus).toBe("not_applied_dry_run");
    expect(storedMessage[0]?.processingStatus).toBe("completed");
    expect(gmail.calls.map((call) => call.method)).toStrictEqual(["getMessage"]);
  });

  it("stores the subject and sender while classifying", async () => {
    const db = createDb(env.DB);
    const messageId = await seedJob(db);
    const gmail = fakeGmail({
      getMessage: (id) => fullMessage(id, "Body"),
    });

    await processDueJobs({
      accountId: ACCOUNT,
      ai: fakeAi(),
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: gmail.client,
      config: testConfig(),
      db,
      mode: "dry_run",
      now: () => NOW,
    });

    const stored = await db
      .select({
        fromAddress: messages.fromAddress,
        metadataFetchedAt: messages.metadataFetchedAt,
        metadataState: messages.metadataState,
        subject: messages.subject,
      })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(stored[0]).toStrictEqual({
      fromAddress: "Sender <sender@example.test>",
      metadataFetchedAt: NOW,
      metadataState: "available",
      subject: "Subject for gm-1",
    });
  });

  it("persists a zero-inference completed GitHub event at an exhausted AI cap, then reprocesses with Jev", async () => {
    const db = createDb(env.DB);
    const messageId = await seedJob(db);
    const gmail = fakeGmail({ getMessage: (id) => passiveGithubMessage(id) });
    let aiCalls = 0;
    const ai = {
      run: () => {
        aiCalls += 1;
        return responseFixture;
      },
    } as unknown as Ai;

    const first = await processDueJobs({
      accountId: ACCOUNT,
      ai,
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: gmail.client,
      config: testConfig({ GITHUB_PASSIVE_FAST_PATH: "on", MAX_AI_CALLS_PER_DAY: "0" }),
      db,
      mode: "dry_run",
      now: () => NOW,
    });
    const [rule] = await db.select().from(classifications);
    const [messageRow] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId));
    const firstReservations = await db.select().from(aiDailyUsage);
    expect({
      aiCalls,
      dailyReservations: firstReservations.length,
      decisions: JSON.parse(rule?.decisionJson ?? "{}"),
      model: rule?.modelVersion,
      processed: first.processed,
      status: messageRow?.processingStatus,
    }).toMatchObject({
      aiCalls: 0,
      dailyReservations: 0,
      decisions: {
        needsReply: { status: "negative" },
        toDo: { status: "negative" },
        topic: { key: "github", probability: null },
        urgent: { probability: null, status: "negative" },
      },
      model: "rule:github-passive-v1",
      processed: 1,
      status: "completed",
    });

    await db
      .update(messages)
      .set({ lastGeneration: 2 })
      .where(eq(messages.id, messageId));
    await createGenerationJob(db, {
      accountId: ACCOUNT,
      generation: 2,
      id: crypto.randomUUID(),
      kind: "reprocess",
      messageId,
      now: NOW + 1000,
    });
    const second = await processDueJobs({
      accountId: ACCOUNT,
      ai,
      budget: new TimeBudget(NOW + 1000, 120_000, 15_000),
      client: gmail.client,
      config: testConfig({ GITHUB_PASSIVE_FAST_PATH: "on", MAX_AI_CALLS_PER_DAY: "1" }),
      db,
      mode: "dry_run",
      now: () => NOW + 1000,
    });
    const rows = await db.select().from(classifications);
    const secondReservations = await db.select().from(aiDailyUsage);
    expect({
      aiCalls,
      dailyReservations: secondReservations.length,
      processed: second.processed,
      versions: rows.map((row) => row.modelVersion).toSorted(),
    }).toStrictEqual({
      aiCalls: 1,
      dailyReservations: 1,
      processed: 1,
      versions: ["jev-1.13.0", "rule:github-passive-v1"],
    });
  });

  it("applies a rule topic through the existing ownership-aware label path", async () => {
    const db = createDb(env.DB);
    const messageId = await seedJob(db);
    await db.update(appControl).set({ mode: "apply" });
    await db.insert(labelMappings).values({
      accountId: ACCOUNT,
      currentName: "Triage/GitHub",
      gmailLabelId: "Label_github",
      id: crypto.randomUUID(),
      legacyAliasIdsJson: "[]",
      migrationState: "ready",
      semanticKey: "github",
      updatedAt: NOW,
    });
    let aiCalls = 0;
    const gmail = fakeGmail({
      getMessage: (id, format) =>
        format === "minimal"
          ? { ...minimalMessage(id), labelIds: ["INBOX", "Label_personal"] }
          : { ...passiveGithubMessage(id), labelIds: ["INBOX", "Label_personal"] },
      modifyMessage: (id, changes) => ({
        id,
        labelIds: ["INBOX", "Label_personal", ...(changes.addLabelIds ?? [])],
        threadId: `thread-${id}`,
      }),
    });
    const outcome = await processDueJobs({
      accountId: ACCOUNT,
      ai: {
        run: () => {
          aiCalls += 1;
          return responseFixture;
        },
      } as unknown as Ai,
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: gmail.client,
      config: testConfig({ GITHUB_PASSIVE_FAST_PATH: "on", MAX_AI_CALLS_PER_DAY: "0" }),
      db,
      mode: "apply",
      now: () => NOW,
    });
    expect(outcome.processed).toBe(1);
    expect(aiCalls).toBe(0);
    const mutation = gmail.calls.find((call) => call.method === "modifyMessage");
    expect(mutation?.args[1]).toStrictEqual({
      addLabelIds: ["Label_github"],
      removeLabelIds: [],
    });
    const [saved] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(saved?.appOwnedLabelIdsJson).toContain("Label_github");
  });

  it("does not bypass the AI cap for a GitHub discussion requiring judgment", async () => {
    const db = createDb(env.DB);
    await seedJob(db);
    const gmail = fakeGmail({
      getMessage: (id) =>
        passiveGithubMessage(id, "@reviewer commented on the PR: please respond today."),
    });
    let aiCalls = 0;
    const outcome = await processDueJobs({
      accountId: ACCOUNT,
      ai: {
        run: () => {
          aiCalls += 1;
          return responseFixture;
        },
      } as unknown as Ai,
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: gmail.client,
      config: testConfig({ GITHUB_PASSIVE_FAST_PATH: "on", MAX_AI_CALLS_PER_DAY: "0" }),
      db,
      mode: "dry_run",
      now: () => NOW,
    });
    expect(outcome.deferred).toBe(1);
    expect(aiCalls).toBe(0);
    await expect(db.select().from(classifications)).resolves.toHaveLength(0);
  });

  it("defers inference jobs at the daily cap without consuming retries", async () => {
    const db = createDb(env.DB);
    await seedJob(db);
    const gmail = fakeGmail({
      getMessage: (id) => fullMessage(id, "Body"),
    });

    const outcome = await processDueJobs({
      accountId: ACCOUNT,
      ai: fakeAi(),
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: gmail.client,
      config: testConfig({ MAX_AI_CALLS_PER_DAY: "0" }),
      db,
      mode: "dry_run",
      now: () => NOW,
    });

    expect(outcome.deferred).toBe(1);
    const rows = await jobRows(db);
    expect(rows[0]).toMatchObject({
      attempts: 0,
      deferredReason: "ai_budget",
      nextAttemptAt: Date.UTC(2023, 10, 15, 0, 0, 0),
      stage: "retry_wait",
    });
    const usage = await db.select().from(aiDailyUsage);
    expect(usage).toHaveLength(0);
  });

  it("defers jobs when the wall-time budget is exhausted before inference", async () => {
    const db = createDb(env.DB);
    await seedJob(db);
    const gmail = fakeGmail({ getMessage: (id) => fullMessage(id, "Body") });
    let aiCalls = 0;

    const outcome = await processDueJobs({
      accountId: ACCOUNT,
      ai: {
        run: () => {
          aiCalls += 1;
          return responseFixture;
        },
      } as unknown as Ai,
      budget: new TimeBudget(NOW, 5000, 0),
      client: gmail.client,
      config: testConfig(),
      db,
      mode: "dry_run",
      now: () => NOW + 10_000,
    });

    expect(outcome.deferred).toBe(0);
    expect(aiCalls).toBe(0);
    const [pendingJob] = await jobRows(db);
    expect(pendingJob?.stage).toBe("pending");
  });

  it("schedules retries for transient failures and fails invalid AI responses after one retry", async () => {
    const db = createDb(env.DB);
    await seedJob(db);
    const failing = fakeGmail({
      getMessage: () => {
        throw new GmailError("server_error", "boom", 500);
      },
    });
    await processDueJobs({
      accountId: ACCOUNT,
      ai: fakeAi(),
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: failing.client,
      config: testConfig(),
      db,
      mode: "dry_run",
      now: () => NOW,
    });
    const [retried] = await jobRows(db);
    expect(retried).toMatchObject({
      attempts: 1,
      errorCode: "server_error",
      stage: "retry_wait",
    });
    expect(retried?.nextAttemptAt).toBeGreaterThan(NOW);

    const db2 = createDb(env.DB);
    await seedJob(db2);
    const ok = fakeGmail({ getMessage: (id) => fullMessage(id, "Body") });
    await processDueJobs({
      accountId: ACCOUNT,
      ai: fakeAi({ nonsense: true }),
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: ok.client,
      config: testConfig(),
      db: db2,
      mode: "dry_run",
      now: () => NOW,
    });
    const [firstInvalid] = await jobRows(db2);
    expect(firstInvalid).toMatchObject({
      errorCode: "invalid_ai_response",
      stage: "retry_wait",
    });

    await processDueJobs({
      accountId: ACCOUNT,
      ai: fakeAi({ nonsense: true }),
      budget: new TimeBudget(NOW + 600_000, 120_000, 15_000),
      client: ok.client,
      config: testConfig(),
      db: db2,
      mode: "dry_run",
      now: () => NOW + 600_000,
    });
    const [invalid] = await jobRows(db2);
    expect(invalid).toMatchObject({
      attempts: 2,
      errorCode: "invalid_ai_response",
      stage: "failed",
    });
  });

  it("skips messages that left the inbox before application", async () => {
    const db = createDb(env.DB);
    await seedJob(db);
    const gmail = fakeGmail({
      getMessage: (id) => fullMessage(id, "Archived", { labels: ["Label_9"] }),
    });
    const outcome = await processDueJobs({
      accountId: ACCOUNT,
      ai: fakeAi(),
      budget: new TimeBudget(NOW, 120_000, 15_000),
      client: gmail.client,
      config: testConfig(),
      db,
      mode: "dry_run",
      now: () => NOW,
    });
    expect(outcome.skipped).toBe(1);
    const [skippedJob] = await jobRows(db);
    expect(skippedJob?.stage).toBe("skipped");
  });
});

describe("backfill", () => {
  const enqueueBackfill = async (db: ReturnType<typeof createDb>, maxMessages = 2) => {
    await enqueueOperation(db, {
      accountId: ACCOUNT,
      id: "op-backfill-1",
      kind: "backfill",
      now: NOW,
      requestJson: JSON.stringify({
        maxMessages,
        receivedAfter: "2026-09-01T00:00:00Z",
        receivedBefore: "2026-09-10T00:00:00Z",
      }),
    });
  };

  it("scans a bounded range, honors the cap and reports capped work", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await enqueueBackfill(db);

    let page = 0;
    const gmail = fakeGmail({
      getMessage: (id) =>
        minimalMessage(id, { receivedAt: Date.parse("2026-09-05T00:00:00Z") }),
      listMessages: () => {
        page += 1;
        if (page === 1) {
          return {
            messages: [
              { id: "b1", threadId: "t1" },
              { id: "b2", threadId: "t2" },
            ],
            nextPageToken: "bp2",
          };
        }
        return { messages: [{ id: "b3", threadId: "t3" }] };
      },
    });

    const outcome = await processQueuedBackfills(deps(db, gmail.client));
    expect(outcome.completed).toBe(1);
    await expect(jobRows(db)).resolves.toHaveLength(2);

    const rows = await db.select().from(operations);
    expect(rows[0]?.status).toBe("completed");
    const progress = JSON.parse(rows[0]?.progressJson ?? "{}");
    expect(progress).toMatchObject({ capped: true, discovered: 2 });
  });

  it("excludes messages outside the requested range", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await enqueueBackfill(db, 10);

    const gmail = fakeGmail({
      getMessage: (id) => {
        const dates: Record<string, string> = {
          "in-range": "2026-09-05T00:00:00Z",
          "too-early": "2026-08-30T00:00:00Z",
          "too-late": "2026-09-11T00:00:00Z",
        };
        return minimalMessage(id, { receivedAt: Date.parse(dates[id] ?? "") });
      },
      listMessages: () => ({
        messages: [
          { id: "in-range", threadId: "t1" },
          { id: "too-early", threadId: "t2" },
          { id: "too-late", threadId: "t3" },
        ],
      }),
    });

    const outcome = await processQueuedBackfills(deps(db, gmail.client));
    expect(outcome.completed).toBe(1);
    const rows = await jobRows(db);
    expect(rows).toHaveLength(1);
  });

  it("resumes a deferred backfill from its stored progress", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await enqueueBackfill(db, 10);

    const gmail = fakeGmail({
      getMessage: (id) =>
        minimalMessage(id, { receivedAt: Date.parse("2026-09-05T00:00:00Z") }),
      listMessages: () => ({ messages: [{ id: "b1", threadId: "t1" }] }),
    });

    const deferred = await processQueuedBackfills(
      deps(db, gmail.client, { budget: new TimeBudget(NOW, 1000, 0) })
    );
    expect(deferred.deferred).toBe(1);
    const stillRunning = await db.select().from(operations);
    expect(stillRunning[0]?.status).toBe("running");

    const completed = await processQueuedBackfills(deps(db, gmail.client));
    expect(completed.completed).toBe(1);
    await expect(jobRows(db)).resolves.toHaveLength(1);
  });
});

describe("tick runner", () => {
  it("respects paused mode and refuses a second concurrent runner", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.update(appControl).set({ mode: "paused" });

    const paused = await runScheduledTick(env);
    expect(paused.status).toBe("paused");

    await db.update(appControl).set({ mode: "dry_run" });
    const gmail = fakeGmail({
      getProfile: () => ({
        emailAddress: env.GMAIL_ACCOUNT_EMAIL,
        historyId: "1000",
      }),
    });
    await db.insert(leases).values({
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ownerToken: "other-runner",
      resourceKey: `mailbox:${env.GMAIL_ACCOUNT_EMAIL}`,
      updatedAt: Date.now(),
    });

    const held = await runScheduledTick(env, {
      ai: fakeAi(),
      client: gmail.client,
    });
    expect(held.status).toBe("lease_held");
  });

  it("grants a mailbox lease to exactly one concurrent acquirer", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const key = `mailbox:${ACCOUNT}`;
    const [first, second] = await Promise.all([
      acquireLease(db, key, "runner-a", NOW, 60_000),
      acquireLease(db, key, "runner-b", NOW, 60_000),
    ]);
    expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1);
  });

  it("completes a full dry-run tick and releases its lease", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.update(appControl).set({ mode: "dry_run" });

    const gmail = fakeGmail({
      getProfile: () => ({
        emailAddress: env.GMAIL_ACCOUNT_EMAIL,
        historyId: "1000",
      }),
      listHistory: () => ({ history: [], historyId: "2000" }),
    });

    const outcome = await runScheduledTick(env, {
      ai: fakeAi(),
      client: gmail.client,
      now: () => NOW,
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.mode).toBe("dry_run");
    await expect(db.select().from(mailboxes)).resolves.toHaveLength(1);
    await expect(db.select().from(leases)).resolves.toHaveLength(0);
  });
});
