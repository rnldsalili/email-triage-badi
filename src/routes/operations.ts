import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../app-env";
import { createDb } from "../db/client";
import {
  enqueueOperation,
  getOperation,
  listOperations,
} from "../db/repositories/operations";
import { OPERATION_KINDS, OPERATION_STATUSES } from "../db/schema";
import type { Operation } from "../db/schema";
import { decodeCursor, encodeCursor } from "../http/cursor";
import { ApiError } from "../http/errors";
import {
  requireIdempotencyKey,
  withIdempotency,
  operationWrite,
} from "../http/idempotency";
import { readJsonBody } from "../http/validation";

const backfillSchema = z.object({
  maxMessages: z.number().int().positive(),
  receivedAfter: z.iso.datetime(),
  receivedBefore: z.iso.datetime(),
});

export const syncRoutes = new Hono<AppEnv>().post("/", async (c) => {
  const db = createDb(c.env.DB);
  const accountId = c.get("config").owner.accountEmail;
  const now = Date.now();
  const key = c.req.header("idempotency-key")?.trim();

  if (key) {
    const response = await withIdempotency(
      db,
      accountId,
      { key, payload: {}, route: "sync" },
      now,
      () => {
        const operationId = crypto.randomUUID();
        return {
          body: { coalesced: false, operationId },
          status: 202,
          writes: [operationWrite(db, operationId, accountId, "sync", {}, now)],
        };
      }
    );
    return c.json(response.body, response.status as 200);
  }

  const outcome = await enqueueOperation(db, {
    accountId,
    coalesceKey: "sync",
    id: crypto.randomUUID(),
    kind: "sync",
    now,
    requestJson: "{}",
  });
  return c.json({ coalesced: !outcome.created, operationId: outcome.operation.id }, 202);
});

export const backfillRoutes = new Hono<AppEnv>().post("/", async (c) => {
  const db = createDb(c.env.DB);
  const config = c.get("config");
  const accountId = config.owner.accountEmail;
  const key = requireIdempotencyKey(c.req.header("idempotency-key"));
  const body = await readJsonBody(c, backfillSchema);

  if (Date.parse(body.receivedBefore) <= Date.parse(body.receivedAfter)) {
    throw new ApiError("VALIDATION_ERROR", "receivedBefore must be after receivedAfter");
  }
  if (body.maxMessages > config.limits.maxBackfillMessages) {
    throw new ApiError(
      "VALIDATION_ERROR",
      `maxMessages exceeds MAX_BACKFILL_MESSAGES (${config.limits.maxBackfillMessages})`
    );
  }

  const now = Date.now();
  const response = await withIdempotency(
    db,
    accountId,
    { key, payload: body, route: "backfills" },
    now,
    () => {
      const operationId = crypto.randomUUID();
      return {
        body: { operationId },
        status: 202,
        writes: [operationWrite(db, operationId, accountId, "backfill", body, now)],
      };
    }
  );
  return c.json(response.body, response.status as 200);
});

const operationView = (operation: Operation) => ({
  completedAt: operation.completedAt
    ? new Date(operation.completedAt).toISOString()
    : null,
  createdAt: new Date(operation.createdAt).toISOString(),
  id: operation.id,
  kind: operation.kind,
  lastError: operation.lastErrorCode
    ? { code: operation.lastErrorCode, message: operation.lastErrorMessage }
    : null,
  progress: operation.progressJson ? JSON.parse(operation.progressJson) : null,
  request: operation.requestJson ? JSON.parse(operation.requestJson) : null,
  startedAt: operation.startedAt ? new Date(operation.startedAt).toISOString() : null,
  status: operation.status,
});

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  kind: z.enum(OPERATION_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(OPERATION_STATUSES).optional(),
});

export const operationRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw new ApiError("VALIDATION_ERROR", "Invalid list query");
    }
    const cursor = query.data.cursor ? decodeCursor(query.data.cursor) : null;
    const rows = await listOperations(db, {
      accountId,
      cursor: cursor ? { createdAt: cursor.sortKey, id: cursor.id } : undefined,
      kind: query.data.kind,
      limit: query.data.limit + 1,
      status: query.data.status,
    });
    const page = rows.slice(0, query.data.limit);
    const last = page.at(-1);
    return c.json({
      items: page.map(operationView),
      nextCursor:
        rows.length > query.data.limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null,
    });
  })
  .get("/:id", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const operation = await getOperation(db, c.req.param("id"), accountId);
    if (!operation) {
      throw new ApiError("NOT_FOUND", "Operation not found");
    }
    return c.json(operationView(operation));
  });
