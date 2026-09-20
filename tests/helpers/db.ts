import type { Db } from "../../src/db/client";
import {
  aiDailyUsage,
  appControl,
  classifications,
  corrections,
  idempotencyKeys,
  jobs,
  labelMappings,
  labelMigrationOperations,
  labelMutations,
  leases,
  mailboxes,
  messages,
  operations,
  syncRuns,
} from "../../src/db/schema";

export const resetDatabase = async (db: Db): Promise<void> => {
  await db.delete(jobs);
  await db.delete(classifications);
  await db.delete(labelMutations);
  await db.delete(corrections);
  await db.delete(messages);
  await db.delete(operations);
  await db.delete(labelMigrationOperations);
  await db.delete(labelMappings);
  await db.delete(mailboxes);
  await db.delete(aiDailyUsage);
  await db.delete(leases);
  await db.delete(syncRuns);
  await db.delete(idempotencyKeys);
  await db.update(appControl).set({ mode: "dry_run", settingsVersion: 1 });
};

export const seedMailbox = async (
  db: Db,
  overrides: { id?: string; email?: string; committedHistoryId?: string | null } = {}
): Promise<string> => {
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(mailboxes).values({
    committedHistoryId: overrides.committedHistoryId ?? null,
    email: overrides.email ?? "owner@example.test",
    id,
  });
  return id;
};
