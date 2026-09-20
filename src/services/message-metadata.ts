import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { messages } from "../db/schema";
import type { Message } from "../db/schema";
import type { GmailClient } from "../gmail/client";
import { GmailError } from "../gmail/errors";
import type { GmailMessage } from "../gmail/types";

export const MAX_SUBJECT_CHARS = 500;
export const MAX_FROM_CHARS = 320;

export type MetadataState = Message["metadataState"];

export interface MessageMetadata {
  errorCode: string | null;
  fetchedAt: number;
  from: string | null;
  state: Extract<MetadataState, "available" | "unavailable" | "error">;
  subject: string | null;
}

export type MetadataRefreshResult =
  | { status: "refreshed"; metadata: MessageMetadata }
  | { status: "unavailable"; metadata: MessageMetadata }
  | { status: "error"; metadata: MessageMetadata }
  | { status: "retry_later"; errorCode: string };

const bounded = (value: string | null, max: number): string | null => {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

const headerValue = (message: GmailMessage, name: string): string | null => {
  const headers = message.payload?.headers ?? [];
  return headers.find((header) => header.name.toLowerCase() === name)?.value ?? null;
};

export const metadataFromMessage = (
  message: GmailMessage,
  now: number
): MessageMetadata => ({
  errorCode: null,
  fetchedAt: now,
  from: bounded(headerValue(message, "from"), MAX_FROM_CHARS),
  state: "available",
  subject: bounded(headerValue(message, "subject"), MAX_SUBJECT_CHARS),
});

const failedMetadata = (errorCode: string, now: number): MessageMetadata => ({
  errorCode,
  fetchedAt: now,
  from: null,
  state: "error",
  subject: null,
});

const unavailableMetadata = (now: number): MessageMetadata => ({
  errorCode: "not_found",
  fetchedAt: now,
  from: null,
  state: "unavailable",
  subject: null,
});

/**
 * Persists metadata only when it is strictly newer than what is stored, so a
 * slower concurrent fetch cannot overwrite a newer observation.
 */
export const persistMessageMetadata = async (
  db: Db,
  messageId: string,
  metadata: MessageMetadata
): Promise<void> => {
  await db
    .update(messages)
    .set({
      fromAddress: metadata.from,
      metadataErrorCode: metadata.errorCode,
      metadataFetchedAt: metadata.fetchedAt,
      metadataState: metadata.state,
      subject: metadata.subject,
    })
    .where(
      sql`${messages.id} = ${messageId} AND (${messages.metadataFetchedAt} IS NULL OR ${messages.metadataFetchedAt} < ${metadata.fetchedAt})`
    );
};

export const refreshMessageMetadata = async (
  db: Db,
  client: GmailClient,
  message: Pick<Message, "gmailMessageId" | "id">,
  now: number
): Promise<MetadataRefreshResult> => {
  let fetched: GmailMessage;
  try {
    fetched = await client.getMessage(message.gmailMessageId, "metadata", [
      "Subject",
      "From",
    ]);
  } catch (error) {
    const reason = error instanceof GmailError ? error.reason : "error";
    if (reason === "not_found") {
      const metadata = unavailableMetadata(now);
      await persistMessageMetadata(db, message.id, metadata);
      return { metadata, status: "unavailable" };
    }
    // Environmental failures keep the row pending: the account or network has to
    // recover before retrying, and re-marking it would not help.
    if (
      error instanceof GmailError &&
      (error.retryable || reason === "auth_invalid" || reason === "auth_required")
    ) {
      return { errorCode: reason, status: "retry_later" };
    }
    const metadata = failedMetadata(reason, now);
    await persistMessageMetadata(db, message.id, metadata);
    return { metadata, status: "error" };
  }
  const metadata = metadataFromMessage(fetched, now);
  await persistMessageMetadata(db, message.id, metadata);
  return { metadata, status: "refreshed" };
};

export const listMessagesMissingMetadata = (
  db: Db,
  accountId: string,
  limit: number
): Promise<{ id: string; gmailMessageId: string }[]> =>
  db.all<{ id: string; gmailMessageId: string }>(sql`
    SELECT id, gmail_message_id AS gmailMessageId
    FROM messages
    WHERE account_id = ${accountId} AND metadata_state = 'missing'
    ORDER BY first_seen_at DESC, id DESC
    LIMIT ${limit}
  `);

export const countMessageMetadata = async (
  db: Db,
  accountId: string
): Promise<{ errors: number; missing: number }> => {
  // Grouped so the query stays inside messages_metadata_idx instead of scanning
  // every message row for the account.
  const rows = await db.all<{ metadata_state: string; count: number }>(sql`
    SELECT metadata_state, COUNT(*) AS count
    FROM messages
    WHERE account_id = ${accountId} AND metadata_state IN ('missing', 'error')
    GROUP BY metadata_state
  `);
  const counts = { errors: 0, missing: 0 };
  for (const row of rows) {
    if (row.metadata_state === "missing") {
      counts.missing = row.count;
    }
    if (row.metadata_state === "error") {
      counts.errors = row.count;
    }
  }
  return counts;
};

/**
 * Explicit owner request: move terminal metadata failures back into the pending
 * set so a later attempt can retry them.
 */
export const rearmFailedMetadata = async (
  db: Db,
  accountId: string,
  limit: number
): Promise<number> => {
  const result = await db.run(sql`
    UPDATE messages
    SET metadata_state = 'missing', metadata_error_code = NULL
    WHERE id IN (
      SELECT id FROM messages
      WHERE account_id = ${accountId} AND metadata_state = 'error'
      ORDER BY first_seen_at DESC, id DESC
      LIMIT ${limit}
    )
  `);
  return result.meta.changes;
};

export const getStoredMetadata = async (
  db: Db,
  accountId: string,
  gmailMessageId: string
): Promise<
  | {
      fromAddress: string | null;
      id: string;
      metadataState: string;
      subject: string | null;
    }
  | undefined
> => {
  const rows = await db
    .select({
      fromAddress: messages.fromAddress,
      id: messages.id,
      metadataState: messages.metadataState,
      subject: messages.subject,
    })
    .from(messages)
    .where(eq(messages.gmailMessageId, gmailMessageId))
    .limit(1);
  return rows[0];
};
