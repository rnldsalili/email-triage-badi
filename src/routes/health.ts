import { Hono } from "hono";

import type { AppEnv } from "../app-env";
import { BUILD_VERSION } from "../config/versions";

export const healthRoutes = new Hono<AppEnv>().get("/healthz", (c) =>
  c.json({ status: "ok", version: BUILD_VERSION })
);
