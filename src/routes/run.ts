import { Hono } from "hono";

import type { AppEnv } from "../app-env";
import { runManualTick } from "../services/run-now";

export const runRoutes = new Hono<AppEnv>().post("/", async (c) => {
  const result = await runManualTick(c.env, c.get("requestId"));
  return c.json({ triggered: true, ...result }, 202);
});
