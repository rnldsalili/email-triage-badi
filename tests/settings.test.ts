import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://example.test";
const TOKEN = "test-admin-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

interface SettingsBody {
  mode: string;
  settingsVersion: number;
  updatedAt: string;
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

describe("settings", () => {
  it("persists a mode change and reflects it in status", async () => {
    const patch = await exports.default.fetch(`${BASE}/api/v1/settings`, {
      body: JSON.stringify({ mode: "apply" }),
      headers: { ...AUTH, "content-type": "application/json" },
      method: "PATCH",
    });
    expect(patch.status).toBe(200);
    const settings = await patch.json<SettingsBody>();
    expect(settings.mode).toBe("apply");
    expect(settings.settingsVersion).toBeGreaterThan(1);
    expect(Date.parse(settings.updatedAt)).toBeGreaterThan(0);

    const status = await exports.default.fetch(`${BASE}/api/v1/status`, {
      headers: AUTH,
    });
    const statusBody = await status.json<{ mode: string }>();
    expect(statusBody.mode).toBe("apply");
  });

  it("accepts paused mode", async () => {
    const patch = await exports.default.fetch(`${BASE}/api/v1/settings`, {
      body: JSON.stringify({ mode: "paused" }),
      headers: { ...AUTH, "content-type": "application/json" },
      method: "PATCH",
    });
    expect(patch.status).toBe(200);
    const settings = await patch.json<SettingsBody>();
    expect(settings.mode).toBe("paused");
  });

  it("rejects an invalid mode", async () => {
    const patch = await exports.default.fetch(`${BASE}/api/v1/settings`, {
      body: JSON.stringify({ mode: "auto" }),
      headers: { ...AUTH, "content-type": "application/json" },
      method: "PATCH",
    });
    expect(patch.status).toBe(400);
    const body = await patch.json<ErrorBody>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires a JSON content type", async () => {
    const patch = await exports.default.fetch(`${BASE}/api/v1/settings`, {
      body: JSON.stringify({ mode: "apply" }),
      headers: AUTH,
      method: "PATCH",
    });
    expect(patch.status).toBe(400);
    const body = await patch.json<ErrorBody>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects malformed JSON", async () => {
    const patch = await exports.default.fetch(`${BASE}/api/v1/settings`, {
      body: "{not json",
      headers: { ...AUTH, "content-type": "application/json" },
      method: "PATCH",
    });
    expect(patch.status).toBe(400);
    const body = await patch.json<ErrorBody>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an oversized body", async () => {
    const patch = await exports.default.fetch(`${BASE}/api/v1/settings`, {
      body: JSON.stringify({ mode: "apply", padding: "x".repeat(70 * 1024) }),
      headers: { ...AUTH, "content-type": "application/json" },
      method: "PATCH",
    });
    expect(patch.status).toBe(413);
    const body = await patch.json<ErrorBody>();
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
