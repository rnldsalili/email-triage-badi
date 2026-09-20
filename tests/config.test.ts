import { describe, expect, it } from "vitest";

import { ConfigError, parseConfig } from "../src/config/env";

const baseEnv = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ADMIN_API_TOKEN: "admin-token",
  AI_GATEWAY_ID: "email-triage-badi-dev",
  AI_MODEL: "typesafe/jev",
  GMAIL_ACCOUNT_EMAIL: "owner@example.test",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REFRESH_TOKEN: "refresh-token",
  ...overrides,
});

describe(parseConfig, () => {
  it("applies documented defaults", () => {
    const config = parseConfig(baseEnv());
    expect(config.ai).toMatchObject({ model: "typesafe/jev" });
    expect(config.owner).toMatchObject({
      aliases: [],
      employerDomains: [],
      timeZone: "UTC",
    });
    expect(config.defaults).toMatchObject({
      initialLookbackDays: 7,
      mode: "dry_run",
    });
    expect(config.limits).toMatchObject({
      checkpointReserveMs: 15_000,
      cleanupBatchSize: 100,
      detailRetentionDays: 90,
      maxAiCallsPerDay: 500,
      maxBackfillMessages: 5000,
      maxBodyCharacters: 12_000,
      maxJobsPerTick: 20,
      runLeaseMs: 180_000,
      tickWallBudgetMs: 120_000,
    });
  });

  it("coerces numeric strings and parses JSON arrays", () => {
    const config = parseConfig(
      baseEnv({
        EMPLOYER_DOMAINS_JSON: '["example.com"]',
        MAX_AI_CALLS_PER_DAY: "0",
        MAX_JOBS_PER_TICK: "5",
        OWNER_ALIASES_JSON: '["alias@example.test"]',
        OWNER_TIME_ZONE: "Asia/Manila",
      })
    );
    expect(config.limits.maxJobsPerTick).toBe(5);
    expect(config.limits.maxAiCallsPerDay).toBe(0);
    expect(config.owner.aliases).toStrictEqual(["alias@example.test"]);
    expect(config.owner.employerDomains).toStrictEqual(["example.com"]);
    expect(config.owner.timeZone).toBe("Asia/Manila");
  });

  it("requires the admin token", () => {
    const env = baseEnv();
    delete env.ADMIN_API_TOKEN;
    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(/ADMIN_API_TOKEN/u);
  });

  it("rejects an invalid owner email", () => {
    expect(() => parseConfig(baseEnv({ GMAIL_ACCOUNT_EMAIL: "not-an-email" }))).toThrow(
      /GMAIL_ACCOUNT_EMAIL/u
    );
  });

  it("rejects an invalid time zone", () => {
    expect(() => parseConfig(baseEnv({ OWNER_TIME_ZONE: "Mars/Olympus" }))).toThrow(
      /OWNER_TIME_ZONE/u
    );
  });

  it("rejects malformed JSON arrays", () => {
    expect(() => parseConfig(baseEnv({ OWNER_ALIASES_JSON: "{" }))).toThrow(
      /OWNER_ALIASES_JSON/u
    );
    expect(() => parseConfig(baseEnv({ EMPLOYER_DOMAINS_JSON: '["ok", 3]' }))).toThrow(
      /EMPLOYER_DOMAINS_JSON/u
    );
  });

  it("requires the checkpoint reserve to stay below the wall budget", () => {
    expect(() => parseConfig(baseEnv({ CHECKPOINT_RESERVE_MS: "120000" }))).toThrow(
      /CHECKPOINT_RESERVE_MS/u
    );
  });

  it("requires the run lease to exceed the wall budget", () => {
    expect(() => parseConfig(baseEnv({ RUN_LEASE_MS: "120000" }))).toThrow(
      /RUN_LEASE_MS/u
    );
  });

  it("rejects an invalid default mode", () => {
    expect(() => parseConfig(baseEnv({ DEFAULT_MODE: "auto" }))).toThrow(/DEFAULT_MODE/u);
  });
});
