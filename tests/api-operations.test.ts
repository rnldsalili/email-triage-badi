import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb } from "../src/db/client";
import {
  appControl,
  classifications,
  corrections,
  idempotencyKeys,
  jobs,
  messages,
  operations,
} from "../src/db/schema";
import { GmailError } from "../src/gmail/errors";
import { setMessageClientFactory } from "../src/routes/messages";
import { resetDatabase } from "./helpers/db";
import { fakeGmail, fullMessage } from "./helpers/gmail-fake";

const BASE = "https://example.test";
const TOKEN = "test-admin-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const ACCOUNT = env.GMAIL_ACCOUNT_EMAIL;

const api = (
  path: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${TOKEN}`);
  }
  let { body } = init;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return exports.default.fetch(`${BASE}${path}`, { ...init, body, headers });
};

const seedMessageWithClassification = async (
  db: ReturnType<typeof createDb>,
  options: {
    gmailId?: string;
    topic?: string;
    needsReview?: boolean;
    processingStatus?: string;
  } = {}
) => {
  const gmailId = options.gmailId ?? "gm-api-1";
  const messageId = crypto.randomUUID();
  await db.insert(messages).values({
    accountId: ACCOUNT,
    applicationStatus: "not_applied_dry_run",
    firstSeenAt: 1_700_000_000_000,
    gmailMessageId: gmailId,
    id: messageId,
    lastGeneration: 1,
    latestClassificationId: `classification-${messageId}`,
    processingStatus: (options.processingStatus ?? "completed") as "completed",
    receivedAt: 1_700_000_000_000,
    threadId: "thread-api-1",
  });
  await db.insert(classifications).values({
    accountId: ACCOUNT,
    answerJson: JSON.stringify({
      topic: {
        choice: options.topic ?? "bills",
        confidence: 0.9,
        probabilities: {},
        type: "choice",
      },
    }),
    applicationStatus: "proposed",
    createdAt: 1_700_000_000_000,
    decisionJson: JSON.stringify({
      needsReply: { probability: 0.05, status: "negative" },
      needsReview: options.needsReview ?? false,
      reviewReasons: options.needsReview ? ["to_do_uncertain"] : [],
      toDo: { probability: 0.05, status: "negative" },
      topic: {
        confidence: 0.95,
        key: options.topic ?? "bills",
        probability: 0.95,
        status: "accepted",
        topKey: options.topic ?? "bills",
      },
      urgent: { probability: 0.05, status: "negative" },
    }),
    durationMs: 100,
    id: `classification-${messageId}`,
    messageId,
    modelVersion: "jev-1.13.0",
    normalizedInputHash: "hash",
    policyVersion: "policy-v1",
    reviewFlag: options.needsReview ?? false,
    reviewReasonsJson: JSON.stringify(options.needsReview ? ["to_do_uncertain"] : []),
    rubricVersion: "rubric-v1",
    taxonomyVersion: "taxonomy-v1",
    usageJson: "{}",
  });
  return { gmailId, messageId };
};

describe("operations API", () => {
  it("replays idempotent backfill requests and rejects conflicting payloads", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const payload = {
      maxMessages: 100,
      receivedAfter: "2026-09-01T00:00:00Z",
      receivedBefore: "2026-09-10T00:00:00Z",
    };

    const first = await api("/api/v1/backfills", {
      headers: { "idempotency-key": "backfill-key-1" },
      json: payload,
      method: "POST",
    });
    const firstBody = await first.json<{ operationId: string }>();

    const replay = await api("/api/v1/backfills", {
      headers: { "idempotency-key": "backfill-key-1" },
      json: payload,
      method: "POST",
    });
    const replayBody = await replay.json<{ operationId: string }>();

    const conflict = await api("/api/v1/backfills", {
      headers: { "idempotency-key": "backfill-key-1" },
      json: { ...payload, maxMessages: 200 },
      method: "POST",
    });
    const conflictBody = await conflict.json<{ error: { code: string } }>();

    expect({
      conflictCode: conflictBody.error.code,
      conflictStatus: conflict.status,
      firstStatus: first.status,
      replayOperationId: replayBody.operationId,
      replayStatus: replay.status,
    }).toStrictEqual({
      conflictCode: "CONFLICT",
      conflictStatus: 409,
      firstStatus: 202,
      replayOperationId: firstBody.operationId,
      replayStatus: 202,
    });
    await expect(db.select().from(operations)).resolves.toHaveLength(1);
  });

  it("validates backfill ranges and caps", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const invalid = await api("/api/v1/backfills", {
      headers: { "idempotency-key": "backfill-key-2" },
      json: {
        maxMessages: 10,
        receivedAfter: "2026-09-10T00:00:00Z",
        receivedBefore: "2026-09-01T00:00:00Z",
      },
      method: "POST",
    });
    expect(invalid.status).toBe(400);

    const tooLarge = await api("/api/v1/backfills", {
      headers: { "idempotency-key": "backfill-key-3" },
      json: {
        maxMessages: 100_000,
        receivedAfter: "2026-09-01T00:00:00Z",
        receivedBefore: "2026-09-10T00:00:00Z",
      },
      method: "POST",
    });
    expect(tooLarge.status).toBe(400);

    const missingKey = await api("/api/v1/backfills", {
      json: {
        maxMessages: 10,
        receivedAfter: "2026-09-01T00:00:00Z",
        receivedBefore: "2026-09-10T00:00:00Z",
      },
      method: "POST",
    });
    expect(missingKey.status).toBe(400);
  });

  it("coalesces sync requests without an idempotency key", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const first = await api("/api/v1/sync", { method: "POST" });
    expect(first.status).toBe(202);
    const firstBody = await first.json<{ operationId: string; coalesced: boolean }>();
    expect(firstBody.coalesced).toBeFalsy();

    const second = await api("/api/v1/sync", { method: "POST" });
    const secondBody = await second.json<{ operationId: string; coalesced: boolean }>();
    expect(secondBody.operationId).toBe(firstBody.operationId);
    expect(secondBody.coalesced).toBeTruthy();
    await expect(db.select().from(operations)).resolves.toHaveLength(1);
  });

  it("returns 409 while an idempotent request is still being processed", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.insert(idempotencyKeys).values({
      accountId: ACCOUNT,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      id: crypto.randomUUID(),
      key: "in-progress-key-1",
      operationId: null,
      requestHash: "unused-hash",
      responseJson: null,
      route: "sync",
    });

    const response = await api("/api/v1/sync", {
      headers: { "idempotency-key": "in-progress-key-1" },
      method: "POST",
    });
    expect(response.status).toBe(409);
    await expect(db.select().from(operations)).resolves.toHaveLength(0);
  });

  it("exposes label definitions, mappings and migration readiness", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const response = await api("/api/v1/labels", { headers: AUTH });
    expect(response.status).toBe(200);
    const body = await response.json<{
      definitions: unknown[];
      legacyMappings: unknown[];
      conflicts: string[];
    }>();
    expect(body.definitions).toHaveLength(15);
    expect(body.legacyMappings).toHaveLength(6);
    expect(body.conflicts).toStrictEqual([]);
  });

  it("requires apply mode for label migration", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.update(appControl).set({ mode: "dry_run" });
    const response = await api("/api/v1/labels/migrate", {
      headers: { "idempotency-key": "migrate-key-1" },
      method: "POST",
    });
    expect(response.status).toBe(409);

    await db.update(appControl).set({ mode: "apply" });
    const accepted = await api("/api/v1/labels/migrate", {
      headers: { "idempotency-key": "migrate-key-1" },
      method: "POST",
    });
    expect(accepted.status).toBe(202);
  });

  it("reports operation progress and 404s for unknown ids", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const created = await api("/api/v1/sync", { method: "POST" });
    const { operationId } = await created.json<{ operationId: string }>();

    const found = await api(`/api/v1/operations/${operationId}`, { headers: AUTH });
    expect(found.status).toBe(200);
    const body = await found.json<{ kind: string; status: string }>();
    expect(body.kind).toBe("sync");
    expect(body.status).toBe("queued");

    const missing = await api("/api/v1/operations/does-not-exist", { headers: AUTH });
    expect(missing.status).toBe(404);
  });
});

describe("messages API", () => {
  it("lists stored results with filters and cursor pagination", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await seedMessageWithClassification(db, { gmailId: "gm-a", topic: "bills" });
    await seedMessageWithClassification(db, {
      gmailId: "gm-b",
      needsReview: true,
      topic: "work",
    });

    const all = await api("/api/v1/messages", { headers: AUTH });
    const allBody = await all.json<{
      items: { messageId: string }[];
      nextCursor: string | null;
    }>();
    expect({
      count: allBody.items.length,
      nextCursor: allBody.nextCursor,
    }).toStrictEqual({ count: 2, nextCursor: null });

    const firstPage = await api("/api/v1/messages?limit=1", { headers: AUTH });
    const firstPageBody = await firstPage.json<{
      items: { messageId: string }[];
      nextCursor: string | null;
    }>();
    expect({
      count: firstPageBody.items.length,
      hasCursor: Boolean(firstPageBody.nextCursor),
    }).toStrictEqual({ count: 1, hasCursor: true });

    const secondPage = await api(
      `/api/v1/messages?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor ?? "")}`,
      { headers: AUTH }
    );
    const secondPageBody = await secondPage.json<{ items: { messageId: string }[] }>();
    expect({
      count: secondPageBody.items.length,
      distinct: secondPageBody.items[0]?.messageId !== firstPageBody.items[0]?.messageId,
    }).toStrictEqual({ count: 1, distinct: true });

    const review = await api("/api/v1/messages?needsReview=true", { headers: AUTH });
    const reviewBody = await review.json<{ items: { messageId: string }[] }>();

    const topic = await api("/api/v1/messages?topic=work", { headers: AUTH });
    const topicBody = await topic.json<{ items: { messageId: string }[] }>();
    expect({
      review: reviewBody.items.map((item) => item.messageId),
      topicCount: topicBody.items.length,
    }).toStrictEqual({ review: ["gm-b"], topicCount: 1 });

    const invalid = await api("/api/v1/messages?limit=500", { headers: AUTH });
    expect(invalid.status).toBe(400);
  });

  it("returns detail with ownership, corrections and stored metadata", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, { gmailId: "gm-detail" });
    await db
      .update(messages)
      .set({
        fromAddress: "Sender <sender@example.test>",
        metadataFetchedAt: 1_700_000_000_000,
        metadataState: "available",
        subject: "Subject line",
      })
      .where(eq(messages.gmailMessageId, gmailId));

    const withMetadata = await api(
      `/api/v1/messages/${gmailId}?includeGmailMetadata=true`,
      { headers: AUTH }
    );
    expect(withMetadata.status).toBe(200);
    const body = await withMetadata.json<{
      corrections: unknown[];
      gmailMetadata: { status: string; subject: string | null };
      messageId: string;
      ownership: { appOwnedLabelIds: string[] };
    }>();
    expect(body).toMatchObject({
      corrections: [],
      gmailMetadata: { status: "available", subject: "Subject line" },
      messageId: gmailId,
    });

    const notRequested = await api(`/api/v1/messages/${gmailId}`, { headers: AUTH });
    const notRequestedBody = await notRequested.json<{
      gmailMetadata: { status: string };
    }>();

    const missing = await api("/api/v1/messages/gm-missing", { headers: AUTH });

    expect({
      missingStatus: missing.status,
      notRequestedStatus: notRequestedBody.gmailMetadata.status,
    }).toStrictEqual({ missingStatus: 404, notRequestedStatus: "not_requested" });
  });

  it("never calls Gmail while reading a message detail", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, {
      gmailId: "gm-no-call",
    });
    const gmail = fakeGmail({
      getMessage: () => {
        throw new Error("detail reads must not call Gmail");
      },
    });
    setMessageClientFactory(() => gmail.client);

    const detail = await api(`/api/v1/messages/${gmailId}?includeGmailMetadata=true`, {
      headers: AUTH,
    });
    const body = await detail.json<{ gmailMetadata: { status: string } }>();

    expect(gmail.calls).toStrictEqual([]);
    expect(body.gmailMetadata.status).toBe("missing");
  });

  it("stores fetched metadata and reuses it without another Gmail call", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, { gmailId: "gm-store" });

    setMessageClientFactory(
      () =>
        fakeGmail({
          getMessage: (id) => ({
            ...fullMessage(id, ""),
            payload: {
              headers: [
                { name: "Subject", value: "Subject line" },
                { name: "From", value: "Sender <sender@example.test>" },
              ],
              mimeType: "text/plain",
            },
          }),
        }).client
    );
    await api(`/api/v1/messages/${gmailId}/metadata`, { headers: AUTH, method: "POST" });

    const stored = await db
      .select({
        fromAddress: messages.fromAddress,
        metadataState: messages.metadataState,
        subject: messages.subject,
      })
      .from(messages)
      .where(eq(messages.gmailMessageId, gmailId));
    expect(stored).toStrictEqual([
      {
        fromAddress: "Sender <sender@example.test>",
        metadataState: "available",
        subject: "Subject line",
      },
    ]);

    const reusedFake = fakeGmail({
      getMessage: () => {
        throw new Error("should not fetch stored metadata");
      },
    });
    setMessageClientFactory(() => reusedFake.client);
    const reused = await api(`/api/v1/messages/${gmailId}?includeGmailMetadata=true`, {
      headers: AUTH,
    });
    expect(reusedFake.calls).toStrictEqual([]);
    expect(reused.status).toBe(200);
  });

  it("keeps transient metadata failures pending", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, { gmailId: "gm-retry" });
    setMessageClientFactory(
      () =>
        fakeGmail({
          getMessage: () => {
            throw new GmailError("server_error", "Gmail is unavailable");
          },
        }).client
    );

    const failing = await api(`/api/v1/messages/${gmailId}/metadata`, {
      headers: AUTH,
      method: "POST",
    });
    const failingBody = await failing.json<{ error: { code: string } }>();
    const stillMissing = await db
      .select({ metadataState: messages.metadataState })
      .from(messages)
      .where(eq(messages.gmailMessageId, gmailId));

    expect(failing.status).toBe(503);
    expect(failingBody.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(stillMissing).toStrictEqual([{ metadataState: "missing" }]);
  });

  it("records terminal metadata failures so they can be retried explicitly", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, {
      gmailId: "gm-terminal",
    });
    setMessageClientFactory(
      () =>
        fakeGmail({
          getMessage: () => {
            throw new GmailError("permission_denied", "no access to this message");
          },
        }).client
    );

    const response = await api(`/api/v1/messages/${gmailId}/metadata`, {
      headers: AUTH,
      method: "POST",
    });
    const body = await response.json<{ status: string }>();
    const stored = await db
      .select({
        metadataErrorCode: messages.metadataErrorCode,
        metadataState: messages.metadataState,
      })
      .from(messages)
      .where(eq(messages.gmailMessageId, gmailId));

    expect(body.status).toBe("error");
    expect(stored).toStrictEqual([
      { metadataErrorCode: "permission_denied", metadataState: "error" },
    ]);
  });

  it("lists stored metadata without calling Gmail", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, { gmailId: "gm-list" });
    await db
      .update(messages)
      .set({
        fromAddress: "Sender <sender@example.test>",
        metadataFetchedAt: 1_700_000_000_000,
        metadataState: "available",
        subject: "Listed subject",
      })
      .where(eq(messages.gmailMessageId, gmailId));
    const gmail = fakeGmail({
      getMessage: () => {
        throw new Error("list requests must not call Gmail");
      },
    });
    setMessageClientFactory(() => gmail.client);

    const response = await api("/api/v1/messages", { headers: AUTH });
    const body = await response.json<{
      items: { from: string | null; metadataState: string; subject: string | null }[];
    }>();

    expect(gmail.calls).toStrictEqual([]);
    expect(body.items[0]).toMatchObject({
      from: "Sender <sender@example.test>",
      metadataState: "available",
      subject: "Listed subject",
    });
  });

  it("refreshes metadata on demand and returns the stored values", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, { gmailId: "gm-force" });
    await db
      .update(messages)
      .set({
        metadataFetchedAt: 1_700_000_000_000,
        metadataState: "available",
        subject: "Stale subject",
      })
      .where(eq(messages.gmailMessageId, gmailId));
    setMessageClientFactory(
      () =>
        fakeGmail({
          getMessage: (id) => ({
            ...fullMessage(id, ""),
            payload: {
              headers: [{ name: "Subject", value: "Fresh subject" }],
              mimeType: "text/plain",
            },
          }),
        }).client
    );

    const refreshed = await api(`/api/v1/messages/${gmailId}/metadata`, {
      headers: AUTH,
      method: "POST",
    });
    const body = await refreshed.json<{ status: string; subject: string | null }>();
    const detail = await api(`/api/v1/messages/${gmailId}?includeGmailMetadata=true`, {
      headers: AUTH,
    });
    const detailBody = await detail.json<{
      gmailMetadata: { status: string; subject: string | null };
    }>();

    expect(refreshed.status).toBe(200);
    expect(body).toStrictEqual({
      errorCode: null,
      fetchedAt: expect.any(String),
      from: null,
      status: "available",
      subject: "Fresh subject",
    });
    expect(detailBody.gmailMetadata).toMatchObject({
      status: "available",
      subject: "Fresh subject",
    });
  });

  it("persists corrections, locks dimensions and replays idempotently", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { messageId, gmailId } = await seedMessageWithClassification(db, {
      gmailId: "gm-correct",
    });

    const first = await api(`/api/v1/messages/${gmailId}/corrections`, {
      headers: { "idempotency-key": "correction-key-1" },
      json: {
        actions: { needs_reply: true },
        note: "Recruiter conversation",
        topic: "applications",
      },
      method: "POST",
    });
    const firstBody = await first.json<{
      correctionId: string;
      revision: number;
      applicationStatus: string;
    }>();

    const replay = await api(`/api/v1/messages/${gmailId}/corrections`, {
      headers: { "idempotency-key": "correction-key-1" },
      json: {
        actions: { needs_reply: true },
        note: "Recruiter conversation",
        topic: "applications",
      },
      method: "POST",
    });
    const replayBody = await replay.json<{ correctionId: string }>();
    await expect(db.select().from(corrections)).resolves.toHaveLength(1);

    const stored = await db.select().from(messages).where(eq(messages.id, messageId));
    const locks: Record<string, { locked?: boolean }> = JSON.parse(
      stored[0]?.dimensionLocksJson ?? "{}"
    );

    const second = await api(`/api/v1/messages/${gmailId}/corrections`, {
      headers: { "idempotency-key": "correction-key-2" },
      json: { actions: { to_do: false } },
      method: "POST",
    });
    const secondBody = await second.json<{ revision: number }>();

    const empty = await api(`/api/v1/messages/${gmailId}/corrections`, {
      headers: { "idempotency-key": "correction-key-3" },
      json: {},
      method: "POST",
    });

    const jobRows = await db.select().from(jobs);

    const detail = await api(`/api/v1/messages/${gmailId}`, { headers: AUTH });
    const detailBody = await detail.json<{ topic: string | null }>();

    expect({
      firstRevision: firstBody.revision,
      firstStatus: first.status,
      locks,
      replayCorrectionId: replayBody.correctionId,
      replayStatus: replay.status,
      secondRevision: secondBody.revision,
      secondStatus: second.status,
    }).toMatchObject({
      firstRevision: 1,
      firstStatus: 202,
      locks: { needs_reply: { locked: true }, topic: { locked: true } },
      replayCorrectionId: firstBody.correctionId,
      replayStatus: 202,
      secondRevision: 2,
      secondStatus: 202,
    });
    expect(firstBody).toMatchObject({ applicationStatus: "pending_mode" });
    expect(jobRows.filter((job) => job.kind === "correction")).toHaveLength(2);
    expect({ emptyStatus: empty.status, topic: detailBody.topic }).toStrictEqual({
      emptyStatus: 400,
      topic: "applications",
    });
  });

  it("enqueues reprocessing with a new generation and replays idempotently", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, {
      gmailId: "gm-reprocess",
    });

    const first = await api(`/api/v1/messages/${gmailId}/reprocess`, {
      headers: { "idempotency-key": "reprocess-key-1" },
      json: { reason: "rubric-v2" },
      method: "POST",
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json<{ jobId: string; generation: number }>();
    expect(firstBody.generation).toBe(2);

    const replay = await api(`/api/v1/messages/${gmailId}/reprocess`, {
      headers: { "idempotency-key": "reprocess-key-1" },
      json: { reason: "rubric-v2" },
      method: "POST",
    });
    const replayBody = await replay.json<{ jobId: string }>();
    expect(replayBody.jobId).toBe(firstBody.jobId);

    const second = await api(`/api/v1/messages/${gmailId}/reprocess`, {
      headers: { "idempotency-key": "reprocess-key-2" },
      json: {},
      method: "POST",
    });
    const secondBody = await second.json<{ generation: number }>();
    expect(secondBody.generation).toBe(3);
  });

  it("requires apply mode for saved-result application", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { gmailId } = await seedMessageWithClassification(db, {
      gmailId: "gm-apply-api",
    });
    await db.update(appControl).set({ mode: "dry_run" });

    const rejected = await api(`/api/v1/messages/${gmailId}/apply`, {
      headers: { "idempotency-key": "apply-key-1" },
      json: { classificationId: "does-not-exist" },
      method: "POST",
    });
    expect(rejected.status).toBe(409);

    const stored = await db.select().from(classifications);
    const classificationId = stored[0]?.id ?? "";
    await db.update(appControl).set({ mode: "apply" });
    const accepted = await api(`/api/v1/messages/${gmailId}/apply`, {
      headers: { "idempotency-key": "apply-key-1" },
      json: { classificationId },
      method: "POST",
    });
    expect(accepted.status).toBe(202);

    const wrong = await api(`/api/v1/messages/${gmailId}/apply`, {
      headers: { "idempotency-key": "apply-key-2" },
      json: { classificationId: "does-not-exist" },
      method: "POST",
    });
    expect(wrong.status).toBe(404);
  });

  it("rejects applying a superseded classification", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { messageId, gmailId } = await seedMessageWithClassification(db, {
      gmailId: "gm-superseded",
    });
    await db.update(appControl).set({ mode: "apply" });
    const [original] = await db.select().from(classifications);
    await db.insert(classifications).values({
      accountId: ACCOUNT,
      answerJson: "{}",
      applicationStatus: "proposed",
      createdAt: Date.now(),
      decisionJson: original?.decisionJson ?? "{}",
      durationMs: 10,
      id: "classification-newer",
      messageId,
      modelVersion: "jev-1.13.0",
      normalizedInputHash: "hash-2",
      policyVersion: "policy-v1",
      reviewFlag: false,
      reviewReasonsJson: "[]",
      rubricVersion: "rubric-v1",
      taxonomyVersion: "taxonomy-v1",
      usageJson: "{}",
    });
    await db
      .update(messages)
      .set({ latestClassificationId: "classification-newer" })
      .where(eq(messages.id, messageId));

    const response = await api(`/api/v1/messages/${gmailId}/apply`, {
      headers: { "idempotency-key": "apply-superseded-1" },
      json: { classificationId: original?.id ?? "" },
      method: "POST",
    });
    expect(response.status).toBe(409);
  });

  it("resets failed jobs for retry and rejects non-retryable ones", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const { messageId, gmailId } = await seedMessageWithClassification(db, {
      gmailId: "gm-retry",
    });
    await db.insert(jobs).values({
      accountId: ACCOUNT,
      attempts: 5,
      createdAt: 1_700_000_000_000,
      errorCode: "server_error",
      errorMessage: "boom",
      generation: 1,
      id: "failed-job-1",
      kind: "initial",
      messageId,
      stage: "failed",
      updatedAt: 1_700_000_000_000,
    });

    const response = await api(`/api/v1/messages/${gmailId}/retry`, {
      headers: { "idempotency-key": "retry-key-1" },
      method: "POST",
    });
    expect(response.status).toBe(202);
    const stored = await db.select().from(jobs).where(eq(jobs.id, "failed-job-1"));
    expect(stored[0]?.stage).toBe("pending");
    expect(stored[0]?.attempts).toBe(0);

    const notRetryable = await api(`/api/v1/messages/${gmailId}/retry`, {
      headers: { "idempotency-key": "retry-key-2" },
      method: "POST",
    });
    expect(notRetryable.status).toBe(409);
  });
});
