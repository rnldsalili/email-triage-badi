import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../app-env";
import { MODES } from "../config/env";
import { createDb } from "../db/client";
import { setMode } from "../db/repositories/control";
import { readJsonBody } from "../http/validation";

const settingsSchema = z.object({
  mode: z.enum(MODES),
});

export const settingsRoutes = new Hono<AppEnv>().patch("/", async (c) => {
  const body = await readJsonBody(c, settingsSchema);
  const db = createDb(c.env.DB);
  const control = await setMode(db, body.mode, Date.now());
  return c.json({
    mode: control.mode,
    settingsVersion: control.settingsVersion,
    updatedAt: new Date(control.updatedAt).toISOString(),
  });
});
