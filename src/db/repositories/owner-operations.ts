import { operationWrite, statement } from "../../http/idempotency";
import type { Db } from "../client";
import type { Job, Message } from "../schema";

export const generationWrites = (
  db: Db,
  message: Message,
  kind: Exclude<Job["kind"], "initial">,
  payload: unknown,
  now: number
) => {
  const operationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const generation = message.lastGeneration + 1;
  const writes = [
    // A stale preparation violates NOT NULL and rolls back the entire batch.
    statement(
      db,
      "UPDATE messages SET last_generation = CASE WHEN last_generation = ? THEN ? ELSE NULL END, application_status = 'queued' WHERE id = ?",
      message.lastGeneration,
      generation,
      message.id
    ),
    statement(
      db,
      "INSERT INTO jobs (id, operation_id, account_id, message_id, kind, generation, stage, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      jobId,
      operationId,
      message.accountId,
      message.id,
      kind,
      generation,
      kind === "reprocess" ? "pending" : "classified",
      JSON.stringify(payload),
      now,
      now
    ),
    statement(
      db,
      "UPDATE jobs SET stage = 'skipped', error_code = 'superseded', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE message_id = ? AND generation < ? AND stage NOT IN ('completed', 'failed', 'skipped')",
      now,
      message.id,
      generation
    ),
    operationWrite(
      db,
      operationId,
      message.accountId,
      kind,
      { messageId: message.id },
      now
    ),
  ];
  return { generation, jobId, operationId, writes };
};
