import { and, desc, eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import { operations } from "../schema";
import type { Operation } from "../schema";

export interface EnqueueOperationInput {
  id: string;
  accountId: string;
  kind: Operation["kind"];
  requestJson: string;
  coalesceKey?: string;
  now: number;
}

export interface EnqueueOperationOutcome {
  operation: Operation;
  created: boolean;
}

export const enqueueOperation = async (
  db: Db,
  input: EnqueueOperationInput
): Promise<EnqueueOperationOutcome> => {
  const inserted = await db
    .insert(operations)
    .values({
      accountId: input.accountId,
      coalesceKey: input.coalesceKey ?? null,
      createdAt: input.now,
      id: input.id,
      kind: input.kind,
      requestJson: input.requestJson,
      status: "queued",
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();

  const [insertedRow] = inserted;
  if (insertedRow) {
    return { created: true, operation: insertedRow };
  }

  if (!input.coalesceKey) {
    throw new Error("operation insert conflicted without a coalesce key");
  }

  const existing = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.accountId, input.accountId),
        eq(operations.kind, input.kind),
        eq(operations.status, "queued"),
        eq(operations.coalesceKey, input.coalesceKey)
      )
    )
    .limit(1);

  const [existingRow] = existing;
  if (!existingRow) {
    throw new Error("operation coalescing could not find the existing queued operation");
  }
  return { created: false, operation: existingRow };
};

export const getOperation = async (
  db: Db,
  id: string,
  accountId?: string
): Promise<Operation | undefined> => {
  const rows = await db
    .select()
    .from(operations)
    .where(
      accountId
        ? and(eq(operations.id, id), eq(operations.accountId, accountId))
        : eq(operations.id, id)
    )
    .limit(1);
  return rows[0];
};

export interface ListOperationsFilters {
  accountId: string;
  kind?: string;
  limit: number;
  cursor?: { createdAt: number; id: string };
  status?: string;
}

export const listOperations = (
  db: Db,
  filters: ListOperationsFilters
): Promise<Operation[]> => {
  const conditions = [sql`${operations.accountId} = ${filters.accountId}`];
  if (filters.kind) {
    conditions.push(sql`${operations.kind} = ${filters.kind}`);
  }
  if (filters.status) {
    conditions.push(sql`${operations.status} = ${filters.status}`);
  }
  if (filters.cursor) {
    conditions.push(
      sql`(${operations.createdAt} < ${filters.cursor.createdAt} OR (${operations.createdAt} = ${filters.cursor.createdAt} AND ${operations.id} < ${filters.cursor.id}))`
    );
  }
  return db
    .select()
    .from(operations)
    .where(sql.join(conditions, sql` AND `))
    .orderBy(desc(operations.createdAt), desc(operations.id))
    .limit(filters.limit);
};
