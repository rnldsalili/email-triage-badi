import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../app-env";
import { ApiError } from "../http/errors";
import { assertSameOrigin } from "../http/middleware/auth";
import { readJsonBody } from "../http/validation";
import { safeTokenEqual } from "../utils/crypto";
import {
  clearedSessionCookie,
  createSessionToken,
  readCookie,
  sessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  shouldUseSecureCookie,
  verifySessionToken,
} from "../utils/session";

const credentialsSchema = z.object({ token: z.string().min(8).max(500) }).strict();

const isSecure = (c: Context<AppEnv>): boolean => shouldUseSecureCookie(c.req.url);

const jsonWithCookie = (body: unknown, cookie: string): Response =>
  Response.json(body, {
    headers: { "set-cookie": cookie },
    status: 200,
  });

export const authRoutes = new Hono<AppEnv>()
  .get("/session", async (c) => {
    const expected = c.get("config").secrets.adminApiToken;
    const cookie = readCookie(c.req.header("cookie"), SESSION_COOKIE_NAME);
    const authenticated = Boolean(
      cookie && (await verifySessionToken(expected, cookie, Date.now()))
    );
    return c.json({ authenticated });
  })
  .post("/session", async (c) => {
    const expected = c.get("config").secrets.adminApiToken;
    const body = await readJsonBody(c, credentialsSchema);
    if (!(await safeTokenEqual(body.token, expected))) {
      console.warn(
        JSON.stringify({
          event: "dashboard_login_failed",
          requestId: c.get("requestId"),
        })
      );
      throw new ApiError("UNAUTHORIZED", "Invalid credentials");
    }
    const token = await createSessionToken(expected, Date.now(), SESSION_TTL_MS);
    return jsonWithCookie(
      { authenticated: true },
      sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000), isSecure(c))
    );
  })
  .delete("/session", (c) => {
    // Logout is idempotent and callable without a session, but still requires
    // same-origin intent so a cross-site page cannot force a sign-out.
    assertSameOrigin(c);
    return jsonWithCookie({ authenticated: false }, clearedSessionCookie(isSecure(c)));
  });
