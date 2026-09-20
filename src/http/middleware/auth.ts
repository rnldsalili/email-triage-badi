import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../../app-env";
import { safeTokenEqual } from "../../utils/crypto";
import { ApiError } from "../errors";

const BEARER_PATTERN = /^Bearer\s+(?<token>.+)$/iu;

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = BEARER_PATTERN.exec(header.trim())?.groups?.token;
  if (!token) {
    throw new ApiError("UNAUTHORIZED", "Missing bearer token");
  }
  const expected = c.get("config").secrets.adminApiToken;
  if (!(await safeTokenEqual(token, expected))) {
    throw new ApiError("UNAUTHORIZED", "Invalid bearer token");
  }
  return await next();
});
