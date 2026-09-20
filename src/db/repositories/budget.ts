import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import { aiDailyUsage } from "../schema";
import type { AiDailyUsage } from "../schema";

export interface ReservationResult {
  reserved: boolean;
  used: number;
}

export const reserveInferenceCall = async (
  db: Db,
  accountId: string,
  utcDate: string,
  limit: number,
  now: number
): Promise<ReservationResult> => {
  if (limit < 1) {
    return { reserved: false, used: 0 };
  }
  const row = await db.get<{ reserved_calls: number }>(sql`
    INSERT INTO ai_daily_usage (account_id, utc_date, reserved_calls, updated_at)
    VALUES (${accountId}, ${utcDate}, 1, ${now})
    ON CONFLICT(account_id, utc_date) DO UPDATE SET
      reserved_calls = reserved_calls + 1,
      updated_at = ${now}
    WHERE ai_daily_usage.reserved_calls < ${limit}
    RETURNING reserved_calls
  `);
  if (!row) {
    return { reserved: false, used: limit };
  }
  return { reserved: true, used: row.reserved_calls };
};

export const getDailyUsage = async (
  db: Db,
  accountId: string,
  utcDate: string
): Promise<AiDailyUsage | undefined> => {
  const rows = await db
    .select()
    .from(aiDailyUsage)
    .where(and(eq(aiDailyUsage.accountId, accountId), eq(aiDailyUsage.utcDate, utcDate)))
    .limit(1);
  return rows[0];
};
