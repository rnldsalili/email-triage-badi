import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb } from "../src/db/client";
import { appControl, messages, operations } from "../src/db/schema";
import {
  createSessionToken,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  shouldUseSecureCookie,
  verifySessionToken,
} from "../src/utils/session";
import { resetDatabase } from "./helpers/db";

const BASE = "https://example.test";
const TOKEN = "test-admin-token";
const ACCOUNT = env.GMAIL_ACCOUNT_EMAIL;

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
  exports.default.fetch(`${BASE}${path}`, init);

const login = async (): Promise<string> => {
  const response = await request("/api/v1/auth/session", {
    body: JSON.stringify({ token: TOKEN }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("etb_session=");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  return cookie.split(";")[0] ?? "";
};

const cookieHeaders = (cookie: string, unsafe = false): Record<string, string> =>
  unsafe ? { cookie, [CSRF_HEADER]: CSRF_HEADER_VALUE } : { cookie };

describe("dashboard session authentication", () => {
  it("exchanges the admin token for a session cookie and keeps bearer access", async () => {
    const cookie = await login();

    const session = await request("/api/v1/auth/session", {
      headers: cookieHeaders(cookie),
    });
    await expect(session.json()).resolves.toStrictEqual({ authenticated: true });

    const anonymous = await request("/api/v1/auth/session");
    await expect(anonymous.json()).resolves.toStrictEqual({ authenticated: false });

    const withCookie = await request("/api/v1/status", {
      headers: cookieHeaders(cookie),
    });
    expect(withCookie.status).toBe(200);

    const withBearer = await request("/api/v1/status", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(withBearer.status).toBe(200);
  });

  it("rejects bad credentials, forged cookies and expired sessions", async () => {
    const badLogin = await request("/api/v1/auth/session", {
      body: JSON.stringify({ token: "wrong-admin-token" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(badLogin.status).toBe(401);

    const forged = await request("/api/v1/status", {
      headers: { cookie: "etb_session=9999999999999.nonce.deadbeef" },
    });
    expect(forged.status).toBe(401);

    const expired = await createSessionToken(TOKEN, Date.now() - 60_000, 1000);
    const expiredResponse = await request("/api/v1/status", {
      headers: { cookie: `etb_session=${expired}` },
    });
    expect(expiredResponse.status).toBe(401);
  });

  it("requires a same-origin dashboard header for cookie-authenticated mutations", async () => {
    const cookie = await login();

    const withoutHeader = await request("/api/v1/sync", {
      headers: cookieHeaders(cookie),
      method: "POST",
    });
    expect(withoutHeader.status).toBe(403);

    const crossSite = await request("/api/v1/sync", {
      headers: { ...cookieHeaders(cookie, true), "sec-fetch-site": "cross-site" },
      method: "POST",
    });
    expect(crossSite.status).toBe(403);

    const crossOrigin = await request("/api/v1/sync", {
      headers: { ...cookieHeaders(cookie, true), origin: "https://evil.example" },
      method: "POST",
    });
    expect(crossOrigin.status).toBe(403);

    const allowed = await request("/api/v1/sync", {
      headers: { ...cookieHeaders(cookie, true), origin: BASE },
      method: "POST",
    });
    expect(allowed.status).toBe(202);
  });

  it("clears the session cookie on logout", async () => {
    const cookie = await login();
    const logout = await request("/api/v1/auth/session", {
      headers: cookieHeaders(cookie, true),
      method: "DELETE",
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    // Sessions are stateless: rotating the admin token invalidates every cookie.
    const rotated = await verifySessionToken(
      "rotated-admin-token",
      cookie.replace("etb_session=", ""),
      Date.now()
    );
    expect(rotated).toBeFalsy();
  });

  it("rejects a cross-site sign-out", async () => {
    const response = await request("/api/v1/auth/session", {
      headers: { "sec-fetch-site": "cross-site" },
      method: "DELETE",
    });
    expect(response.status).toBe(403);
  });
});

describe("session cookie security", () => {
  it("marks cookies Secure everywhere except plain-HTTP loopback", () => {
    expect(
      shouldUseSecureCookie("https://email-triage.tellbadi.com/api/v1/auth/session")
    ).toBeTruthy();
    expect(
      shouldUseSecureCookie("http://email-triage.tellbadi.com/api/v1/auth/session")
    ).toBeTruthy();
    expect(
      shouldUseSecureCookie("http://localhost:8787/api/v1/auth/session")
    ).toBeFalsy();
    expect(
      shouldUseSecureCookie("http://127.0.0.1:8787/api/v1/auth/session")
    ).toBeFalsy();
  });

  it("sets Secure on an HTTPS login response", async () => {
    const response = await request("/api/v1/auth/session", {
      body: JSON.stringify({ token: TOKEN }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("dashboard read endpoints", () => {
  it("lists operations newest first with cursor pagination and filters", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.insert(operations).values([
      {
        accountId: ACCOUNT,
        createdAt: 1_700_000_000_000,
        id: "op-a",
        kind: "sync",
        requestJson: "{}",
        status: "completed",
        updatedAt: 1_700_000_000_000,
      },
      {
        accountId: ACCOUNT,
        createdAt: 1_700_000_001_000,
        id: "op-b",
        kind: "backfill",
        requestJson: JSON.stringify({ maxMessages: 10 }),
        status: "queued",
        updatedAt: 1_700_000_001_000,
      },
      {
        accountId: ACCOUNT,
        createdAt: 1_700_000_002_000,
        id: "op-c",
        kind: "metadata_refresh",
        requestJson: "{}",
        status: "failed",
        updatedAt: 1_700_000_002_000,
      },
    ]);

    const first = await request("/api/v1/operations?limit=2", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      items: { id: string; kind: string; request: unknown }[];
      nextCursor: string | null;
    }>();
    expect(firstBody.items.map((item) => item.id)).toStrictEqual(["op-c", "op-b"]);
    expect(firstBody.items[1]?.request).toStrictEqual({ maxMessages: 10 });

    const second = await request(
      `/api/v1/operations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } }
    );
    const secondBody = await second.json<{
      items: { id: string }[];
      nextCursor: string | null;
    }>();
    expect({
      ids: secondBody.items.map((item) => item.id),
      nextCursor: secondBody.nextCursor,
    }).toStrictEqual({ ids: ["op-a"], nextCursor: null });
  });

  it("filters the operation list and rejects unknown filters", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.insert(operations).values([
      {
        accountId: ACCOUNT,
        createdAt: 1_700_000_000_000,
        id: "op-a",
        kind: "sync",
        requestJson: "{}",
        status: "completed",
        updatedAt: 1_700_000_000_000,
      },
      {
        accountId: ACCOUNT,
        createdAt: 1_700_000_002_000,
        id: "op-c",
        kind: "metadata_refresh",
        requestJson: "{}",
        status: "failed",
        updatedAt: 1_700_000_002_000,
      },
    ]);

    const filtered = await request("/api/v1/operations?status=failed", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const filteredBody = await filtered.json<{ items: { id: string }[] }>();
    expect(filteredBody.items.map((item) => item.id)).toStrictEqual(["op-c"]);

    const invalid = await request("/api/v1/operations?kind=unknown-kind", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(invalid.status).toBe(400);
  });

  it("returns UI configuration without secrets", async () => {
    const response = await request("/api/v1/config", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      limits: { maxBackfillMessages: number };
      modes: string[];
      owner: { email: string; timeZone: string };
    }>();
    expect(body.modes).toStrictEqual(["paused", "dry_run", "apply"]);
    expect(body.owner.email).toBe(ACCOUNT);
    expect(body.limits.maxBackfillMessages).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(
      /test-admin-token|test-google-client-secret/u
    );
  });

  it("reports messages awaiting metadata in status", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.insert(messages).values([
      {
        accountId: ACCOUNT,
        firstSeenAt: 1_700_000_000_000,
        gmailMessageId: "gm-metadata-status",
        id: "message-metadata-status",
        receivedAt: 1_700_000_000_000,
        threadId: "t-metadata",
      },
      {
        accountId: ACCOUNT,
        firstSeenAt: 1_700_000_000_001,
        gmailMessageId: "gm-metadata-error",
        id: "message-metadata-error",
        metadataErrorCode: "permission_denied",
        metadataState: "error",
        receivedAt: 1_700_000_000_001,
        threadId: "t-metadata-2",
      },
    ]);

    const response = await request("/api/v1/status", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await response.json<{
      messages: { metadataErrors: number; missingMetadata: number };
    }>();
    expect(body.messages).toStrictEqual({ metadataErrors: 1, missingMetadata: 1 });
  });

  it("re-arms terminal metadata failures on an explicit refresh", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.insert(messages).values({
      accountId: ACCOUNT,
      firstSeenAt: 1_700_000_000_000,
      gmailMessageId: "gm-metadata-rearm",
      id: "message-metadata-rearm",
      metadataErrorCode: "permission_denied",
      metadataState: "error",
      receivedAt: 1_700_000_000_000,
      threadId: "t-rearm",
    });

    const response = await request("/api/v1/messages/metadata-refresh", {
      body: JSON.stringify({ retryErrors: true }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.json<{
      coalesced: boolean;
      errors: number;
      operationId: string;
      pending: number;
    }>();
    const stored = await db
      .select({
        metadataErrorCode: messages.metadataErrorCode,
        metadataState: messages.metadataState,
      })
      .from(messages)
      .where(eq(messages.gmailMessageId, "gm-metadata-rearm"));

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ coalesced: false, errors: 0, pending: 1 });
    expect(stored).toStrictEqual([{ metadataErrorCode: null, metadataState: "missing" }]);

    // The queued operation is what actually retries the message.
    const queued = await db
      .select()
      .from(operations)
      .where(eq(operations.id, body.operationId));
    expect(queued[0]?.kind).toBe("metadata_refresh");
  });
});

describe("label migration plan reference", () => {
  it("requires a completed plan operation when one is supplied", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.update(appControl).set({ mode: "apply" });
    await db.insert(operations).values([
      {
        accountId: ACCOUNT,
        createdAt: 1_700_000_000_000,
        id: "plan-complete",
        kind: "migration_plan",
        requestJson: "{}",
        status: "completed",
        updatedAt: 1_700_000_000_000,
      },
      {
        accountId: ACCOUNT,
        createdAt: 1_700_000_000_000,
        id: "plan-queued",
        kind: "migration_plan",
        requestJson: "{}",
        status: "queued",
        updatedAt: 1_700_000_000_000,
      },
    ]);

    const invalid = await request("/api/v1/labels/migrate", {
      body: JSON.stringify({ planOperationId: "plan-queued" }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "plan-key-invalid",
      },
      method: "POST",
    });
    expect(invalid.status).toBe(400);

    const missing = await request("/api/v1/labels/migrate", {
      body: JSON.stringify({ planOperationId: "does-not-exist" }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "plan-key-missing",
      },
      method: "POST",
    });
    expect(missing.status).toBe(400);

    const valid = await request("/api/v1/labels/migrate", {
      body: JSON.stringify({ planOperationId: "plan-complete" }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "plan-key-valid",
      },
      method: "POST",
    });
    expect(valid.status).toBe(202);
    const validBody = await valid.json<{
      operationId: string;
      planOperationId: string;
    }>();
    expect(validBody.planOperationId).toBe("plan-complete");

    const stored = await db
      .select()
      .from(operations)
      .where(eq(operations.id, validBody.operationId));
    expect(JSON.parse(stored[0]?.requestJson ?? "{}")).toStrictEqual({
      planOperationId: "plan-complete",
    });
  });
});

describe("dashboard asset routing", () => {
  it("serves the SPA shell for dashboard paths", async () => {
    const response = await env.ASSETS.fetch(new Request("https://example.test/messages"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain('<div id="root">');
  });

  it("keeps API paths on the Worker", async () => {
    const unauthenticated = await request("/api/v1/nonexistent");
    expect(unauthenticated.status).toBe(401);

    const authenticated = await request("/api/v1/nonexistent", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authenticated.status).toBe(404);
    await expect(authenticated.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});

describe("manual run trigger", () => {
  it("accepts an authenticated manual tick request", async () => {
    const response = await request("/api/v1/run", {
      headers: { authorization: `Bearer ${TOKEN}` },
      method: "POST",
    });
    expect(response.status).toBe(202);
    const body = await response.json<{ status: string; triggered: boolean }>();
    expect(body.triggered).toBeTruthy();
    // No mailbox or Gmail credentials are configured in the test environment, so
    // the tick reports an error instead of silently doing nothing.
    expect(body.status).toBe("error");
  });

  it("rejects unauthenticated manual ticks", async () => {
    const response = await request("/api/v1/run", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("reports a paused mode without starting work", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.update(appControl).set({ mode: "paused" });

    const response = await request("/api/v1/run", {
      headers: { authorization: `Bearer ${TOKEN}` },
      method: "POST",
    });
    const body = await response.json<{
      durationMs: number;
      mode: string | null;
      status: string;
    }>();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ mode: "paused", status: "paused" });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("cursor validation", () => {
  it("rejects malformed cursors on both list endpoints", async () => {
    const messageList = await request("/api/v1/messages?cursor=not-a-cursor", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const operationList = await request("/api/v1/operations?cursor=not-a-cursor", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(messageList.status).toBe(400);
    expect(operationList.status).toBe(400);
    await expect(messageList.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });
});
