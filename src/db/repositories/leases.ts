import { sql } from "drizzle-orm";

import type { Db } from "../client";

export interface LeaseFence {
  resourceKey: string;
  ownerToken: string;
  leaseMs: number;
}

export const leasePredicate = (fence: LeaseFence | undefined, now: number) =>
  fence
    ? sql`EXISTS (SELECT 1 FROM leases WHERE resource_key = ${fence.resourceKey} AND owner_token = ${fence.ownerToken} AND expires_at > ${now})`
    : sql`1 = 1`;

export interface LeaseResult {
  acquired: boolean;
  expiresAt: number | null;
}

export const acquireLease = async (
  db: Db,
  resourceKey: string,
  ownerToken: string,
  now: number,
  leaseMs: number
): Promise<LeaseResult> => {
  const expiresAt = now + leaseMs;
  const result = await db.run(sql`
    INSERT INTO leases (resource_key, owner_token, acquired_at, expires_at, updated_at)
    VALUES (${resourceKey}, ${ownerToken}, ${now}, ${expiresAt}, ${now})
    ON CONFLICT(resource_key) DO UPDATE SET
      owner_token = excluded.owner_token,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE leases.expires_at <= ${now}
  `);
  const acquired = result.meta.changes === 1;
  return { acquired, expiresAt: acquired ? expiresAt : null };
};

export const renewLease = async (
  db: Db,
  resourceKey: string,
  ownerToken: string,
  now: number,
  leaseMs: number
): Promise<boolean> => {
  const result = await db.run(sql`
    UPDATE leases
    SET expires_at = ${now + leaseMs}, updated_at = ${now}
    WHERE resource_key = ${resourceKey}
      AND owner_token = ${ownerToken}
      AND expires_at > ${now}
  `);
  return result.meta.changes === 1;
};

export const releaseLease = async (
  db: Db,
  resourceKey: string,
  ownerToken: string
): Promise<boolean> => {
  const result = await db.run(sql`
    DELETE FROM leases
    WHERE resource_key = ${resourceKey} AND owner_token = ${ownerToken}
  `);
  return result.meta.changes === 1;
};
