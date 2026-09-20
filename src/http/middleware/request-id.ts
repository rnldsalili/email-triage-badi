import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../../app-env";

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  try {
    return await next();
  } finally {
    c.header("x-request-id", id);
  }
});
