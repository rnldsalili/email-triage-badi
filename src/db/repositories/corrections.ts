import { asc, eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import { corrections } from "../schema";
import type { Correction } from "../schema";

export const getLatestCorrectionRevision = async (
  db: Db,
  messageId: string
): Promise<number> => {
  const row = await db.get<{ revision: number | null }>(sql`
    SELECT MAX(revision) AS revision FROM corrections WHERE message_id = ${messageId}
  `);
  return row?.revision ?? 0;
};

export interface RecordCorrectionInput {
  id: string;
  messageId: string;
  changedDimensionsJson: string;
  replacementValuesJson: string;
  note?: string | null;
  now: number;
}

export const recordCorrection = async (
  db: Db,
  input: RecordCorrectionInput
): Promise<Correction> => {
  const revision = (await getLatestCorrectionRevision(db, input.messageId)) + 1;
  const rows = await db
    .insert(corrections)
    .values({
      changedDimensionsJson: input.changedDimensionsJson,
      createdAt: input.now,
      id: input.id,
      messageId: input.messageId,
      note: input.note ?? null,
      replacementValuesJson: input.replacementValuesJson,
      revision,
    })
    .returning();
  const [row] = rows;
  if (!row) {
    throw new Error("correction insert returned no row");
  }
  return row;
};

export const listCorrections = (db: Db, messageId: string): Promise<Correction[]> =>
  db
    .select()
    .from(corrections)
    .where(eq(corrections.messageId, messageId))
    .orderBy(asc(corrections.revision));
