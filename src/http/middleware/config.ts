import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../../app-env";
import { parseConfig } from "../../config/env";

export const loadConfig = createMiddleware<AppEnv>(async (c, next) => {
  c.set("config", parseConfig({ ...c.env }));
  return await next();
});
