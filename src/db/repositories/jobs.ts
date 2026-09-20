import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { Mode } from "../../config/env";
import type { Db } from "../client";
import { jobs } from "../schema";
import type { Job } from "../schema";

export interface CreateInitialJobInput {
  id: string;
  accountId: string;
  messageId: string;
  now: number;
}

export const createInitialJob = async (
  db: Db,
  input: CreateInitialJobInput
): Promise<boolean> => {
  const result = await db.run(sql`
    INSERT INTO jobs (id, account_id, message_id, kind, generation, stage, created_at, updated_at)
    VALUES (${input.id}, ${input.accountId}, ${input.messageId}, 'initial', 1, 'pending', ${input.now}, ${input.now})
    ON CONFLICT DO NOTHING
  `);
  if (result.meta.changes === 1) {
    return true;
  }

  const reactivated = await db.run(sql`
    UPDATE jobs
    SET stage = 'pending',
        error_code = NULL,
        error_message = NULL,
        deferred_reason = NULL,
        next_attempt_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = ${input.now}
    WHERE account_id = ${input.accountId}
      AND message_id = ${input.messageId}
      AND kind = 'initial'
      AND stage = 'skipped'
      AND error_code IN ('not_in_inbox', 'message_record_missing')
  `);
  return reactivated.meta.changes === 1;
};

export interface CreateGenerationJobInput {
  id: string;
  accountId: string;
  messageId: string;
  kind: Job["kind"];
  generation: number;
  operationId?: string;
  payloadJson?: string;
  now: number;
}

export const createGenerationJob = async (
  db: Db,
  input: CreateGenerationJobInput
): Promise<boolean> => {
  const result = await db.run(sql`
    INSERT INTO jobs (
      id, operation_id, account_id, message_id, kind, generation, stage,
      payload_json, created_at, updated_at
    )
    VALUES (
      ${input.id}, ${input.operationId ?? null}, ${input.accountId}, ${input.messageId},
      ${input.kind}, ${input.generation}, 'pending', ${input.payloadJson ?? null},
      ${input.now}, ${input.now}
    )
    ON CONFLICT DO NOTHING
  `);
  return result.meta.changes === 1;
};

export interface ClaimDueJobsInput {
  accountId: string;
  now: number;
  leaseMs: number;
  limit: number;
  ownerToken: string;
  mode?: Mode;
}

export const claimDueJobs = (db: Db, input: ClaimDueJobsInput): Promise<Job[]> => {
  if (input.mode === "paused") {
    return Promise.resolve([]);
  }
  const claimable = and(
    eq(jobs.accountId, input.accountId),
    input.mode === "dry_run"
      ? and(
          inArray(jobs.kind, ["initial", "reprocess"]),
          inArray(jobs.stage, ["pending", "classifying", "retry_wait"])
        )
      : undefined,
    inArray(jobs.stage, [
      "pending",
      "classifying",
      "classified",
      "applying",
      "retry_wait",
    ]),
    or(isNull(jobs.leaseExpiresAt), lte(jobs.leaseExpiresAt, input.now)),
    or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, input.now))
  );

  const dueIds = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(claimable)
    .orderBy(
      sql`CASE WHEN ${jobs.kind} = 'correction' THEN 0 WHEN ${jobs.kind} = 'apply' THEN 1 ELSE 2 END`,
      sql`COALESCE(${jobs.nextAttemptAt}, 0)`,
      jobs.createdAt
    )
    .limit(input.limit);

  return db
    .update(jobs)
    .set({
      attempts: sql`${jobs.attempts} + 1`,
      leaseExpiresAt: input.now + input.leaseMs,
      leaseToken: input.ownerToken,
      updatedAt: input.now,
    })
    .where(inArray(jobs.id, dueIds))
    .returning();
};

export const getLatestJobForMessage = async (
  db: Db,
  accountId: string,
  messageId: string
): Promise<Job | undefined> => {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.accountId, accountId), eq(jobs.messageId, messageId)))
    .orderBy(desc(jobs.generation), desc(jobs.createdAt))
    .limit(1);
  return rows[0];
};

export const allocateMessageGeneration = async (
  db: Db,
  messageId: string
): Promise<number | undefined> => {
  const row = await db.get<{ last_generation: number }>(sql`
    UPDATE messages
    SET last_generation = last_generation + 1
    WHERE id = ${messageId}
    RETURNING last_generation
  `);
  return row?.last_generation;
};

export const supersedeOlderJobs = async (
  db: Db,
  messageId: string,
  generation: number,
  now: number
): Promise<void> => {
  await db.run(sql`
    UPDATE jobs
    SET stage = 'skipped',
        error_code = 'superseded',
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = ${now}
    WHERE message_id = ${messageId}
      AND generation < ${generation}
      AND stage NOT IN ('completed', 'failed', 'skipped')
  `);
};

export const resetJobForRetry = async (
  db: Db,
  jobId: string,
  stage: Job["stage"],
  now: number
): Promise<void> => {
  await db
    .update(jobs)
    .set({
      attempts: 0,
      deferredReason: null,
      errorCode: null,
      errorMessage: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      stage,
      updatedAt: now,
    })
    .where(eq(jobs.id, jobId));
};
