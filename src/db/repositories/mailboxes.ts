import { and, eq } from "drizzle-orm";

import type { Db } from "../client";
import { mailboxes } from "../schema";
import type { Mailbox } from "../schema";
import { leasePredicate } from "./leases";
import type { LeaseFence } from "./leases";

export const getMailbox = async (db: Db): Promise<Mailbox | undefined> => {
  const rows = await db.select().from(mailboxes).limit(1);
  return rows[0];
};

export interface UpsertMailboxInput {
  id: string;
  email: string;
  now: number;
}

export const upsertMailbox = async (
  db: Db,
  input: UpsertMailboxInput
): Promise<Mailbox> => {
  const rows = await db
    .insert(mailboxes)
    .values({
      createdAt: input.now,
      email: input.email,
      id: input.id,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      set: { updatedAt: input.now },
      target: mailboxes.email,
    })
    .returning();
  const [row] = rows;
  if (!row) {
    throw new Error("mailbox upsert returned no row");
  }
  return row;
};

export const setMailboxAuthStatus = async (
  db: Db,
  mailboxId: string,
  status: Mailbox["authStatus"],
  now: number
): Promise<void> => {
  await db
    .update(mailboxes)
    .set({ authStatus: status, updatedAt: now })
    .where(eq(mailboxes.id, mailboxId));
};

export interface MailboxScanStateUpdate {
  phase?: Mailbox["syncPhase"];
  scanAnchorHistoryId?: string | null;
  scanQuery?: string | null;
  scanPageToken?: string | null;
  historyPageToken?: string | null;
  now: number;
}

export const updateMailboxScanState = async (
  db: Db,
  mailboxId: string,
  update: MailboxScanStateUpdate,
  fence?: LeaseFence
): Promise<void> => {
  await db
    .update(mailboxes)
    .set({
      ...(update.phase === undefined ? {} : { syncPhase: update.phase }),
      ...(update.scanAnchorHistoryId === undefined
        ? {}
        : { scanAnchorHistoryId: update.scanAnchorHistoryId }),
      ...(update.scanQuery === undefined ? {} : { scanQuery: update.scanQuery }),
      ...(update.scanPageToken === undefined
        ? {}
        : { scanPageToken: update.scanPageToken }),
      ...(update.historyPageToken === undefined
        ? {}
        : { historyPageToken: update.historyPageToken }),
      updatedAt: update.now,
    })
    .where(and(eq(mailboxes.id, mailboxId), leasePredicate(fence, update.now)));
};

export const commitHistoryCursor = async (
  db: Db,
  mailboxId: string,
  historyId: string,
  now: number,
  fence?: LeaseFence
): Promise<void> => {
  await db
    .update(mailboxes)
    .set({
      committedHistoryId: historyId,
      historyPageToken: null,
      lastSyncAt: now,
      scanAnchorHistoryId: null,
      scanPageToken: null,
      scanQuery: null,
      syncPhase: "idle",
      updatedAt: now,
    })
    .where(and(eq(mailboxes.id, mailboxId), leasePredicate(fence, now)));
};
