import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../../app-env";
import { safeTokenEqual } from "../../utils/crypto";
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  readCookie,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "../../utils/session";
import { ApiError } from "../errors";

const BEARER_PATTERN = /^Bearer\s+(?<token>.+)$/iu;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const bearerToken = (header: string): string | null =>
  BEARER_PATTERN.exec(header.trim())?.groups?.token ?? null;

export const assertSameOrigin = (c: Context<AppEnv>): void => {
  if (c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    throw new ApiError("FORBIDDEN", "Missing dashboard request header");
  }
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    throw new ApiError("FORBIDDEN", "Cross-site requests are not allowed");
  }
  const origin = c.req.header("origin");
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== new URL(c.req.url).host) {
      throw new ApiError("FORBIDDEN", "Cross-origin requests are not allowed");
    }
  }
};

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.get("config").secrets.adminApiToken;
  const bearer = bearerToken(c.req.header("authorization") ?? "");
  if (bearer) {
    if (!(await safeTokenEqual(bearer, expected))) {
      throw new ApiError("UNAUTHORIZED", "Invalid bearer token");
    }
    return await next();
  }

  const cookie = readCookie(c.req.header("cookie"), SESSION_COOKIE_NAME);
  if (!cookie || !(await verifySessionToken(expected, cookie, Date.now()))) {
    throw new ApiError("UNAUTHORIZED", "Missing or invalid credentials");
  }
  if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
    assertSameOrigin(c);
  }
  return await next();
});
