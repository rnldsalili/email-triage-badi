import { parseConfig } from "../../src/config/env";
import type { AppConfig } from "../../src/config/env";

export const testConfig = (overrides: Record<string, unknown> = {}): AppConfig =>
  parseConfig({
    ADMIN_API_TOKEN: "test-admin-token",
    AI_GATEWAY_ID: "email-triage-badi-dev",
    AI_MODEL: "typesafe/jev",
    GMAIL_ACCOUNT_EMAIL: "owner@example.test",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "refresh-token",
    ...overrides,
  });
