import { and, eq } from "drizzle-orm";

import type { Db } from "../client";
import { messages } from "../schema";
import type { Message } from "../schema";

export interface UpsertMessageInput {
  id: string;
  accountId: string;
  gmailMessageId: string;
  threadId: string;
  receivedAt: number;
  now: number;
}

export const getMessageByGmailId = async (
  db: Db,
  accountId: string,
  gmailMessageId: string
): Promise<Message | undefined> => {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(eq(messages.accountId, accountId), eq(messages.gmailMessageId, gmailMessageId))
    )
    .limit(1);
  return rows[0];
};

export const upsertDiscoveredMessage = async (
  db: Db,
  input: UpsertMessageInput
): Promise<{ message: Message; created: boolean }> => {
  const inserted = await db
    .insert(messages)
    .values({
      accountId: input.accountId,
      firstSeenAt: input.now,
      gmailMessageId: input.gmailMessageId,
      id: input.id,
      lastGeneration: 1,
      receivedAt: input.receivedAt,
      threadId: input.threadId,
    })
    .onConflictDoNothing()
    .returning();

  const [insertedRow] = inserted;
  if (insertedRow) {
    return { created: true, message: insertedRow };
  }

  const existing = await getMessageByGmailId(db, input.accountId, input.gmailMessageId);
  if (!existing) {
    throw new Error("message upsert conflicted but no existing row was found");
  }
  return { created: false, message: existing };
};

export const getMessageById = async (
  db: Db,
  id: string
): Promise<Message | undefined> => {
  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  return rows[0];
};

export const setMessageProcessingStatus = async (
  db: Db,
  messageId: string,
  status: Message["processingStatus"],
  generation?: number
): Promise<void> => {
  await db
    .update(messages)
    .set({ processingStatus: status })
    .where(
      and(
        eq(messages.id, messageId),
        generation === undefined ? undefined : eq(messages.lastGeneration, generation)
      )
    );
};

export const setMessageApplicationStatus = async (
  db: Db,
  messageId: string,
  status: string,
  generation?: number
): Promise<void> => {
  await db
    .update(messages)
    .set({ applicationStatus: status })
    .where(
      and(
        eq(messages.id, messageId),
        generation === undefined ? undefined : eq(messages.lastGeneration, generation)
      )
    );
};
