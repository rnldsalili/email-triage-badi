import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://example.test";
const TOKEN = "test-admin-token";

interface StatusBody {
  mode: string;
  mailbox: unknown;
  jobs: { queued: number; due: number; failed: number; deferredByBudget: number };
  aiBudget: { used: number; limit: number; resetsAt: string; deferredJobs: number };
  versions: {
    build: string;
    model: string;
    taxonomy: string;
    rubric: string;
    policy: string;
  };
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

describe("health and authentication", () => {
  it("serves public health without authentication", async () => {
    const response = await exports.default.fetch(`${BASE}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.json<{ status: string; version: string }>();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
  });

  it("rejects a missing bearer token with a stable envelope", async () => {
    const response = await exports.default.fetch(`${BASE}/api/v1/status`);
    expect(response.status).toBe(401);
    const body = await response.json<ErrorBody>();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.requestId).toBeTruthy();
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("rejects an invalid bearer token", async () => {
    const response = await exports.default.fetch(`${BASE}/api/v1/status`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
    const body = await response.json<ErrorBody>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns status for the configured owner token", async () => {
    const response = await exports.default.fetch(`${BASE}/api/v1/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json<StatusBody>();
    expect(body).toMatchObject({
      aiBudget: { limit: 500, used: 0 },
      jobs: { queued: 0 },
      mailbox: null,
      mode: "dry_run",
      versions: { build: "0.1.0", model: "typesafe/jev" },
    });
    expect(Date.parse(body.aiBudget.resetsAt)).toBeGreaterThan(Date.now());
  });

  it("returns a not-found envelope for unknown routes", async () => {
    const response = await exports.default.fetch(`${BASE}/api/v1/unknown`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json<ErrorBody>();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
