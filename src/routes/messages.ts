import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../app-env";
import type { DecisionSet } from "../classifier/policy";
import type { AppConfig } from "../config/env";
import { POLICY_VERSION, TAXONOMY_VERSION } from "../config/versions";
import { createDb } from "../db/client";
import { getClassificationById } from "../db/repositories/classifications";
import { getControl } from "../db/repositories/control";
import { getLatestJobForMessage } from "../db/repositories/jobs";
import { getMessageDetailRow, listMessageRows } from "../db/repositories/message-queries";
import { getMessageByGmailId } from "../db/repositories/messages";
import { enqueueOperation } from "../db/repositories/operations";
import { generationWrites } from "../db/repositories/owner-operations";
import { corrections } from "../db/schema";
import { GmailClient } from "../gmail/client";
import { createAccessTokenSource } from "../gmail/tokens";
import { decodeCursor, encodeCursor } from "../http/cursor";
import { ApiError } from "../http/errors";
import {
  requireIdempotencyKey,
  withIdempotency,
  statement,
  operationWrite,
} from "../http/idempotency";
import { readJsonBody } from "../http/validation";
import { mergeCorrections } from "../services/corrections";
import {
  countMessageMetadata,
  rearmFailedMetadata,
  refreshMessageMetadata,
} from "../services/message-metadata";
import { TOPIC_KEYS } from "../taxonomy/labels";

let clientFactory: (config: AppConfig) => GmailClient = (config) =>
  new GmailClient({
    tokens: createAccessTokenSource({
      clientId: config.secrets.googleClientId,
      clientSecret: config.secrets.googleClientSecret,
      refreshToken: config.secrets.googleRefreshToken,
    }),
  });

export const setMessageClientFactory = (
  factory: (config: AppConfig) => GmailClient
): void => {
  clientFactory = factory;
};

const actionValue = (status: string): boolean | null => {
  if (status === "positive") {
    return true;
  }
  if (status === "negative") {
    return false;
  }
  return null;
};

const resultFields = (row: {
  classificationId: string | null;
  classifiedAt: number | null;
  decisionJson: string | null;
  reviewFlag: number | null;
  reviewReasonsJson: string | null;
  modelVersion: string | null;
  taxonomyVersion: string | null;
  rubricVersion: string | null;
  policyVersion: string | null;
}) => {
  const decision = row.decisionJson
    ? (JSON.parse(row.decisionJson) as {
        topic: { status: string; key: string | null };
        urgent: { status: string };
        needsReply: { status: string };
        toDo: { status: string };
      })
    : null;
  return {
    actions: decision
      ? {
          needs_reply: actionValue(decision.needsReply.status),
          to_do: actionValue(decision.toDo.status),
          urgent: actionValue(decision.urgent.status),
        }
      : { needs_reply: null, to_do: null, urgent: null },
    classificationId: row.classificationId,
    classifiedAt: row.classifiedAt ? new Date(row.classifiedAt).toISOString() : null,
    model: row.modelVersion,
    needsReview: row.reviewFlag === 1,
    policyVersion: row.policyVersion,
    reviewReasons: row.reviewReasonsJson
      ? (JSON.parse(row.reviewReasonsJson) as string[])
      : [],
    rubricVersion: row.rubricVersion,
    taxonomyVersion: row.taxonomyVersion,
    topic: decision?.topic.key ?? null,
    topicDecisionStatus: decision?.topic.status ?? null,
  };
};

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  needsReview: z.enum(["true", "false"]).optional(),
  processingStatus: z.string().optional(),
  topic: z.string().optional(),
});

const correctionSchema = z
  .object({
    actions: z
      .object({
        needs_reply: z.boolean().optional(),
        to_do: z.boolean().optional(),
        urgent: z.boolean().optional(),
      })
      .strict()
      .optional(),
    note: z.string().max(1000).optional(),
    topic: z.union([z.enum(TOPIC_KEYS), z.literal("other"), z.null()]).optional(),
  })
  .strict();

const reprocessSchema = z.object({ reason: z.string().max(500).optional() }).strict();
const applySchema = z.object({ classificationId: z.string().min(1) }).strict();
const metadataRefreshSchema = z.object({ retryErrors: z.boolean().optional() }).strict();

const requireMessage = async (
  db: ReturnType<typeof createDb>,
  accountId: string,
  gmailMessageId: string
) => {
  const message = await getMessageByGmailId(db, accountId, gmailMessageId);
  if (!message) {
    throw new ApiError("NOT_FOUND", "Message not found");
  }
  return message;
};

export const messageRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw new ApiError("VALIDATION_ERROR", "Invalid list query");
    }

    const cursor = query.data.cursor ? decodeCursor(query.data.cursor) : null;
    const rows = await listMessageRows(db, accountId, {
      cursor: cursor ? { firstSeenAt: cursor.sortKey, id: cursor.id } : undefined,
      limit: query.data.limit + 1,
      needsReview:
        query.data.needsReview === undefined
          ? undefined
          : query.data.needsReview === "true",
      processingStatus: query.data.processingStatus,
      topic: query.data.topic,
    });

    const page = rows.slice(0, query.data.limit);
    const last = page.at(-1);
    return c.json({
      items: page.map((row) => ({
        applicationStatus: row.applicationStatus,
        from: row.fromAddress,
        messageId: row.gmailMessageId,
        metadataState: row.metadataState,
        processingStatus: row.processingStatus,
        receivedAt: new Date(row.receivedAt).toISOString(),
        subject: row.subject,
        threadId: row.threadId,
        ...resultFields(row),
      })),
      nextCursor:
        rows.length > query.data.limit && last
          ? encodeCursor(last.firstSeenAt, last.id)
          : null,
    });
  })
  .get("/:id", async (c) => {
    const db = createDb(c.env.DB);
    const config = c.get("config");
    const accountId = config.owner.accountEmail;
    const row = await getMessageDetailRow(db, accountId, c.req.param("id"));
    if (!row) {
      throw new ApiError("NOT_FOUND", "Message not found");
    }

    const answers = row.answerJson ? (JSON.parse(row.answerJson) as unknown) : null;
    const correctionRows = await db
      .select()
      .from(corrections)
      .where(eq(corrections.messageId, row.id))
      .orderBy(desc(corrections.revision));
    const job = await getLatestJobForMessage(db, accountId, row.id);

    const includeGmailMetadata = c.req.query("includeGmailMetadata") === "true";
    const gmailMetadata: Record<string, unknown> = includeGmailMetadata
      ? {
          errorCode: row.metadataErrorCode,
          fetchedAt: row.metadataFetchedAt
            ? new Date(row.metadataFetchedAt).toISOString()
            : null,
          from: row.fromAddress,
          status: row.metadataState,
          subject: row.subject,
        }
      : {
          errorCode: null,
          fetchedAt: null,
          from: null,
          status: "not_requested",
          subject: null,
        };

    return c.json({
      answers,
      applicationStatus: row.applicationStatus,
      corrections: correctionRows.map((correction) => ({
        changedDimensions: JSON.parse(correction.changedDimensionsJson) as string[],
        createdAt: new Date(correction.createdAt).toISOString(),
        id: correction.id,
        note: correction.note,
        replacementValues: JSON.parse(correction.replacementValuesJson) as unknown,
        revision: correction.revision,
      })),
      from: row.fromAddress,
      gmailMetadata,
      job: job
        ? {
            attempts: job.attempts,
            deferredReason: job.deferredReason,
            errorCode: job.errorCode,
            errorMessage: job.errorMessage,
            id: job.id,
            kind: job.kind,
            nextAttemptAt: job.nextAttemptAt
              ? new Date(job.nextAttemptAt).toISOString()
              : null,
            stage: job.stage,
            updatedAt: new Date(job.updatedAt).toISOString(),
          }
        : null,
      messageId: row.gmailMessageId,
      metadataState: row.metadataState,
      ownership: {
        appOwnedLabelIds: JSON.parse(row.appOwnedLabelIdsJson) as string[],
        dimensionStates: JSON.parse(row.dimensionLocksJson) as unknown,
        lastObservedLabelIds: JSON.parse(row.lastObservedLabelIdsJson) as string[],
      },
      processingStatus: row.processingStatus,
      receivedAt: new Date(row.receivedAt).toISOString(),
      subject: row.subject,
      threadId: row.threadId,
      ...resultFields(row),
    });
  })
  .post("/metadata-refresh", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const hasBody = (c.req.header("content-length") ?? "0") !== "0";
    const body = hasBody ? await readJsonBody(c, metadataRefreshSchema) : {};
    const now = Date.now();
    if (body.retryErrors) {
      await rearmFailedMetadata(db, accountId, 100);
    }
    const counts = await countMessageMetadata(db, accountId);
    const outcome = await enqueueOperation(db, {
      accountId,
      coalesceKey: "metadata_refresh",
      id: crypto.randomUUID(),
      kind: "metadata_refresh",
      now,
      requestJson: JSON.stringify({ retryErrors: body.retryErrors ?? false }),
    });
    return c.json(
      {
        coalesced: !outcome.created,
        errors: counts.errors,
        operationId: outcome.operation.id,
        pending: counts.missing,
      },
      202
    );
  })
  .post("/:id/metadata", async (c) => {
    const db = createDb(c.env.DB);
    const config = c.get("config");
    const accountId = config.owner.accountEmail;
    const message = await requireMessage(db, accountId, c.req.param("id"));
    const result = await refreshMessageMetadata(
      db,
      clientFactory(config),
      message,
      Date.now()
    );
    if (result.status === "retry_later") {
      throw new ApiError(
        "DEPENDENCY_UNAVAILABLE",
        "Gmail is temporarily unavailable; retry shortly"
      );
    }
    return c.json({
      errorCode: result.metadata.errorCode,
      fetchedAt: new Date(result.metadata.fetchedAt).toISOString(),
      from: result.metadata.from,
      status: result.metadata.state,
      subject: result.metadata.subject,
    });
  })
  .post("/:id/reprocess", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const message = await requireMessage(db, accountId, c.req.param("id"));
    const key = requireIdempotencyKey(c.req.header("idempotency-key"));
    const hasBody = (c.req.header("content-length") ?? "0") !== "0";
    const body = hasBody ? await readJsonBody(c, reprocessSchema) : {};
    const now = Date.now();
    const reservation = await withIdempotency(
      db,
      accountId,
      { key, payload: { body, messageId: message.id }, route: "messages/reprocess" },
      now,
      () => {
        const { writes, ...response } = generationWrites(
          db,
          message,
          "reprocess",
          body,
          now
        );
        return { body: response, status: 202, writes };
      }
    );
    return c.json(reservation.body, reservation.status as 200);
  })
  .post("/:id/apply", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const message = await requireMessage(db, accountId, c.req.param("id"));
    const key = requireIdempotencyKey(c.req.header("idempotency-key"));
    const body = await readJsonBody(c, applySchema);
    const now = Date.now();
    const reservation = await withIdempotency(
      db,
      accountId,
      { key, payload: { messageId: message.id, ...body }, route: "messages/apply" },
      now,
      async () => {
        const control = await getControl(db);
        if (control.mode !== "apply") {
          throw new ApiError("CONFLICT", "Applying a saved result requires apply mode");
        }
        const classification = await getClassificationById(db, body.classificationId);
        if (!classification || classification.messageId !== message.id) {
          throw new ApiError("NOT_FOUND", "Classification not found for this message");
        }
        if (classification.id !== message.latestClassificationId) {
          throw new ApiError("CONFLICT", "Classification has been superseded");
        }
        if (
          classification.taxonomyVersion !== TAXONOMY_VERSION ||
          classification.policyVersion !== POLICY_VERSION
        ) {
          throw new ApiError(
            "CONFLICT",
            "Classification uses an incompatible taxonomy or policy version"
          );
        }

        const { writes, ...response } = generationWrites(
          db,
          message,
          "apply",
          { classificationId: body.classificationId },
          now
        );
        return { body: response, status: 202, writes };
      }
    );
    return c.json(reservation.body, reservation.status as 200);
  })
  .post("/:id/corrections", async (c) => {
    const db = createDb(c.env.DB);
    const config = c.get("config");
    const accountId = config.owner.accountEmail;
    const message = await requireMessage(db, accountId, c.req.param("id"));
    const key = requireIdempotencyKey(c.req.header("idempotency-key"));
    const body = await readJsonBody(c, correctionSchema);
    const hasTopic = body.topic !== undefined;
    const actionEntries = Object.entries(body.actions ?? {}).filter(
      ([, value]) => value !== undefined
    );
    if (!hasTopic && actionEntries.length === 0) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Correction must change at least one dimension"
      );
    }

    const changedDimensions = [
      ...(hasTopic ? ["topic"] : []),
      ...actionEntries.map(([keyName]) => keyName),
    ];
    const now = Date.now();
    const reservation = await withIdempotency(
      db,
      accountId,
      { key, payload: { messageId: message.id, ...body }, route: "messages/corrections" },
      now,
      async () => {
        const previous = await db
          .select()
          .from(corrections)
          .where(eq(corrections.messageId, message.id))
          .orderBy(desc(corrections.revision));
        const correction = {
          changedDimensionsJson: JSON.stringify(changedDimensions),
          createdAt: now,
          id: crypto.randomUUID(),
          messageId: message.id,
          note: body.note ?? null,
          replacementValuesJson: JSON.stringify({
            ...(hasTopic ? { topic: body.topic } : {}),
            ...(actionEntries.length > 0
              ? { actions: Object.fromEntries(actionEntries) }
              : {}),
          }),
          revision: (previous[0]?.revision ?? 0) + 1,
        };

        const control = await getControl(db);
        const applicationStatus = control.mode === "apply" ? "queued" : "pending_mode";

        const { operationId, jobId, writes } = generationWrites(
          db,
          message,
          "correction",
          { correctionId: correction.id },
          now
        );
        writes.push(
          statement(
            db,
            "INSERT INTO corrections (id, message_id, revision, changed_dimensions_json, replacement_values_json, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            correction.id,
            message.id,
            correction.revision,
            correction.changedDimensionsJson,
            correction.replacementValuesJson,
            correction.note,
            now
          )
        );
        for (const dimension of changedDimensions) {
          writes.push(
            statement(
              db,
              "UPDATE messages SET dimension_locks_json = json_set(dimension_locks_json, ?, json(?)), application_status = ? WHERE id = ?",
              `$.${dimension}`,
              JSON.stringify({ locked: true, userControlled: false }),
              applicationStatus,
              message.id
            )
          );
        }
        if (message.latestClassificationId) {
          const classification = await getClassificationById(
            db,
            message.latestClassificationId
          );
          if (classification) {
            const decisions = mergeCorrections(
              JSON.parse(classification.decisionJson) as DecisionSet,
              [...previous, correction]
            );
            const dimensions = [...previous, correction].flatMap(
              (item) => JSON.parse(item.changedDimensionsJson) as string[]
            );
            const reasons = (
              JSON.parse(classification.reviewReasonsJson) as string[]
            ).filter(
              (reason) =>
                !dimensions.some((dimension) => reason.startsWith(`${dimension}_`))
            );
            const derivedId = crypto.randomUUID();
            writes.push(
              statement(
                db,
                "INSERT INTO classifications (id, account_id, message_id, model_version, taxonomy_version, rubric_version, policy_version, normalized_input_hash, answer_json, decision_json, review_flag, review_reasons_json, usage_json, duration_ms, application_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                derivedId,
                accountId,
                message.id,
                classification.modelVersion,
                classification.taxonomyVersion,
                classification.rubricVersion,
                classification.policyVersion,
                classification.normalizedInputHash,
                classification.answerJson,
                JSON.stringify(decisions),
                Number(reasons.length > 0),
                JSON.stringify(reasons),
                "{}",
                null,
                "corrected",
                now
              ),
              statement(
                db,
                "UPDATE messages SET latest_classification_id = ? WHERE id = ?",
                derivedId,
                message.id
              )
            );
          }
        }

        const response = {
          applicationStatus,
          correctionId: correction.id,
          jobId,
          operationId,
          revision: correction.revision,
        };
        return { body: response, status: 202, writes };
      }
    );
    return c.json(reservation.body, reservation.status as 200);
  })
  .post("/:id/retry", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const message = await requireMessage(db, accountId, c.req.param("id"));
    const key = requireIdempotencyKey(c.req.header("idempotency-key"));
    const now = Date.now();
    const reservation = await withIdempotency(
      db,
      accountId,
      { key, payload: { messageId: message.id }, route: "messages/retry" },
      now,
      async () => {
        const job = await getLatestJobForMessage(db, accountId, message.id);
        if (!job) {
          throw new ApiError("NOT_FOUND", "No job exists for this message");
        }
        if (job.stage !== "failed" && job.stage !== "retry_wait") {
          throw new ApiError("CONFLICT", "Job is not in a retryable state");
        }
        const payload = JSON.parse(job.payloadJson ?? "{}") as {
          classificationId?: string;
        };
        const stage =
          payload.classificationId || job.kind === "apply" || job.kind === "correction"
            ? "classified"
            : "pending";
        const operationId = crypto.randomUUID();
        const writes = [
          operationWrite(db, operationId, accountId, "retry", { jobId: job.id }, now),
          statement(
            db,
            "UPDATE jobs SET stage = ?, operation_id = ?, attempts = 0, next_attempt_at = NULL, deferred_reason = NULL, error_code = NULL, error_message = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
            stage,
            operationId,
            now,
            job.id
          ),
        ];
        return { body: { jobId: job.id, operationId, stage }, status: 202, writes };
      }
    );
    return c.json(reservation.body, reservation.status as 200);
  });
