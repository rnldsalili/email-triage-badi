import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { idempotencyKeys, operations } from "../db/schema";
import type { Operation } from "../db/schema";
import { sha256Hex } from "../utils/crypto";
import { ApiError } from "./errors";

export interface IdempotencyRecord {
  route: string;
  key: string;
  payload: unknown;
}
export interface StoredResponse {
  status: number;
  body: unknown;
}
export interface AtomicResponse extends StoredResponse {
  writes: D1PreparedStatement[];
}

export const statement = (
  db: Db,
  query: string,
  ...values: unknown[]
): D1PreparedStatement => db.$client.prepare(query).bind(...values);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const withIdempotency = async (
  db: Db,
  accountId: string,
  record: IdempotencyRecord,
  now: number,
  prepare: () => AtomicResponse | Promise<AtomicResponse>
): Promise<StoredResponse> => {
  const requestHash = await sha256Hex(canonicalJson(record.payload));
  const legacyRequestHash = await sha256Hex(JSON.stringify(record.payload ?? null));
  const replay = async (): Promise<StoredResponse | null> => {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.accountId, accountId),
          eq(idempotencyKeys.route, record.route),
          eq(idempotencyKeys.key, record.key)
        )
      );
    if (!row) {
      return null;
    }
    if (row.requestHash !== requestHash && row.requestHash !== legacyRequestHash) {
      throw new ApiError(
        "CONFLICT",
        "Idempotency-Key was already used with a different payload"
      );
    }
    if (!row.responseJson) {
      throw new ApiError(
        "CONFLICT",
        "Legacy incomplete operation requires inspection before retrying"
      );
    }
    return JSON.parse(row.responseJson) as StoredResponse;
  };
  const existing = await replay();
  if (existing) {
    return existing;
  }
  // prepare only reads: all mutations, including the replay record, commit or roll back together.
  const { writes, ...response } = await prepare();
  const operationId =
    typeof response.body === "object" &&
    response.body !== null &&
    "operationId" in response.body
      ? String(response.body.operationId)
      : null;
  try {
    await db.$client.batch([
      statement(
        db,
        "INSERT INTO idempotency_keys (id, account_id, route, key, request_hash, operation_id, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        accountId,
        record.route,
        record.key,
        requestHash,
        operationId,
        JSON.stringify(response),
        now,
        now + 90 * 86_400_000
      ),
      ...writes,
    ]);
  } catch (error) {
    const concurrent = await replay();
    if (concurrent) {
      return concurrent;
    }
    if (
      error instanceof Error &&
      error.message.includes("NOT NULL constraint failed: messages.last_generation")
    ) {
      throw new ApiError(
        "CONFLICT",
        "Message changed while preparing the operation; retry with the same key"
      );
    }
    throw error;
  }
  return response;
};

export const operationWrite = (
  db: Db,
  id: string,
  accountId: string,
  kind: Operation["kind"],
  payload: unknown,
  now: number
) =>
  statement(
    db,
    "INSERT INTO operations (id, account_id, kind, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    accountId,
    kind,
    JSON.stringify(payload),
    now,
    now
  );

export const requireIdempotencyKey = (header: string | undefined): string => {
  const key = header?.trim();
  if (!key || key.length < 8 || key.length > 200) {
    throw new ApiError(
      "VALIDATION_ERROR",
      "Idempotency-Key header is required (8-200 characters)"
    );
  }
  return key;
};

export const markOperation = async (
  db: Db,
  id: string,
  update: Partial<{
    status: Operation["status"];
    progressJson: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    startedAt: number | null;
    completedAt: number | null;
  }>,
  now: number
): Promise<void> => {
  await db
    .update(operations)
    .set({ ...update, updatedAt: now })
    .where(eq(operations.id, id));
};
