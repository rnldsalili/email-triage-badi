import { sql } from "drizzle-orm";

import type { Db } from "../client";
import type { Job } from "../schema";

export interface JobProgressUpdate {
  stage: Job["stage"];
  attempts?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  nextAttemptAt?: number | null;
  deferredReason?: string | null;
  clearLease?: boolean;
  now: number;
}
export const updateJobProgress = async (
  db: Db,
  jobId: string,
  update: JobProgressUpdate,
  leaseToken?: string
): Promise<boolean> => {
  const result = await db.run(sql`
    UPDATE jobs
    SET stage = ${update.stage},
        attempts = ${update.attempts ?? sql`attempts`},
        error_code = ${update.errorCode === undefined ? sql`error_code` : update.errorCode},
        error_message = ${
          update.errorMessage === undefined ? sql`error_message` : update.errorMessage
        },
        next_attempt_at = ${
          update.nextAttemptAt === undefined ? sql`next_attempt_at` : update.nextAttemptAt
        },
        deferred_reason = ${
          update.deferredReason === undefined
            ? sql`deferred_reason`
            : update.deferredReason
        },
        lease_token = ${update.clearLease ? null : sql`lease_token`},
        lease_expires_at = ${update.clearLease ? null : sql`lease_expires_at`},
        updated_at = ${update.now}
    WHERE id = ${jobId}
      ${leaseToken ? sql`AND lease_token = ${leaseToken} AND lease_expires_at > ${update.now}` : sql``}
  `);
  return result.meta.changes === 1;
};
