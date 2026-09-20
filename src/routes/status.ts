import { Hono } from "hono";

import type { AppEnv } from "../app-env";
import { createDb } from "../db/client";
import { buildStatus } from "../services/status";

export const statusRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = await buildStatus(db, c.get("config"), Date.now());
  return c.json(status);
});
