import { eq, sql } from "drizzle-orm";

import type { Mode } from "../../config/env";
import type { Db } from "../client";
import { appControl } from "../schema";
import type { AppControl } from "../schema";

export const getControl = async (db: Db): Promise<AppControl> => {
  const rows = await db.select().from(appControl).where(eq(appControl.id, 1)).limit(1);
  const [row] = rows;
  if (!row) {
    throw new Error("app_control singleton row is missing; apply migrations");
  }
  return row;
};

export const setMode = async (db: Db, mode: Mode, now: number): Promise<AppControl> => {
  const rows = await db
    .update(appControl)
    .set({
      mode,
      settingsVersion: sql`${appControl.settingsVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(appControl.id, 1))
    .returning();
  const [row] = rows;
  if (!row) {
    throw new Error("app_control singleton row is missing; apply migrations");
  }
  return row;
};
