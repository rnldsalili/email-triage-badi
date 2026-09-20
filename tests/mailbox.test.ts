import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import profileFixture from "../fixtures/gmail/profile.json";
import { createDb } from "../src/db/client";
import { getMailbox } from "../src/db/repositories/mailboxes";
import { mailboxes } from "../src/db/schema";
import { GmailClient } from "../src/gmail/client";
import { GmailError } from "../src/gmail/errors";
import type { AccessTokenSource } from "../src/gmail/tokens";
import { MailboxIdentityError, verifyMailboxIdentity } from "../src/services/mailbox";
import { testConfig } from "./helpers/config";
import { jsonResponse, scriptedFetch } from "./helpers/fetch";

const BASE_URL = "https://gmail.test/gmail/v1/users/me";

const tokensFor = (token = "access-1"): AccessTokenSource => ({
  getAccessToken: () => Promise.resolve(token),
  invalidate: () => {},
});

const resetMailboxes = async (db: ReturnType<typeof createDb>) => {
  await db.delete(mailboxes);
};

describe("mailbox identity verification", () => {
  it("persists a verified mailbox as ok", async () => {
    const db = createDb(env.DB);
    await resetMailboxes(db);
    const { fetchImpl } = scriptedFetch([() => jsonResponse(profileFixture)]);
    const client = new GmailClient({ baseUrl: BASE_URL, fetchImpl, tokens: tokensFor() });

    const { mailbox, profile } = await verifyMailboxIdentity(
      db,
      client,
      testConfig(),
      1000
    );

    expect(profile.emailAddress).toBe("owner@example.test");
    expect(mailbox.authStatus).toBe("ok");
    const stored = await getMailbox(db);
    expect(stored?.email).toBe("owner@example.test");
    expect(stored?.authStatus).toBe("ok");
  });

  it("blocks a mismatched account without persisting it", async () => {
    const db = createDb(env.DB);
    await resetMailboxes(db);
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse({ ...profileFixture, emailAddress: "intruder@example.test" }),
    ]);
    const client = new GmailClient({ baseUrl: BASE_URL, fetchImpl, tokens: tokensFor() });

    await expect(
      verifyMailboxIdentity(db, client, testConfig(), 1000)
    ).rejects.toBeInstanceOf(MailboxIdentityError);
    await expect(getMailbox(db)).resolves.toBeUndefined();
  });

  it("persists auth_required when the refresh token is revoked", async () => {
    const db = createDb(env.DB);
    await resetMailboxes(db);
    const ok = scriptedFetch([() => jsonResponse(profileFixture)]);
    await verifyMailboxIdentity(
      db,
      new GmailClient({
        baseUrl: BASE_URL,
        fetchImpl: ok.fetchImpl,
        tokens: tokensFor(),
      }),
      testConfig(),
      1000
    );

    const revoked: AccessTokenSource = {
      getAccessToken: () => {
        throw new GmailError("auth_required", "refresh token revoked");
      },
      invalidate: () => {},
    };
    const failingFetch = (() => {
      throw new Error("gmail fetch should not run without a token");
    }) as typeof fetch;
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl: failingFetch,
      tokens: revoked,
    });

    await expect(
      verifyMailboxIdentity(db, client, testConfig(), 2000)
    ).rejects.toMatchObject({ reason: "auth_required" });

    const stored = await getMailbox(db);
    expect(stored?.authStatus).toBe("auth_required");
  });
});
