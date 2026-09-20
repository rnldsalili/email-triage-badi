import { describe, expect, it, vi } from "vitest";

import error401 from "../fixtures/gmail/error-401.json";
import error403Quota from "../fixtures/gmail/error-403-quota.json";
import error403RateLimit from "../fixtures/gmail/error-403-rate-limit.json";
import error404 from "../fixtures/gmail/error-404.json";
import historyPage1 from "../fixtures/gmail/history-page1.json";
import historyPage2 from "../fixtures/gmail/history-page2.json";
import labelsFixture from "../fixtures/gmail/labels.json";
import messageFull from "../fixtures/gmail/message-full.json";
import messagesPage1 from "../fixtures/gmail/messages-page1.json";
import messagesPage2 from "../fixtures/gmail/messages-page2.json";
import profileFixture from "../fixtures/gmail/profile.json";
import { GmailClient } from "../src/gmail/client";
import { GmailError } from "../src/gmail/errors";
import { createAccessTokenSource } from "../src/gmail/tokens";
import type { AccessTokenSource } from "../src/gmail/tokens";
import { jsonResponse, scriptedFetch, tokenResponse } from "./helpers/fetch";

const BASE_URL = "https://gmail.test/gmail/v1/users/me";

const stubTokens = (token = "access-1"): AccessTokenSource => ({
  getAccessToken: () => Promise.resolve(token),
  invalidate: vi.fn<() => void>(),
});

const strictFetch = function strictFetch(this: unknown, input: RequestInfo | URL) {
  if (this !== undefined && this !== globalThis) {
    throw new Error("Illegal invocation");
  }
  void input;
  return Promise.resolve(jsonResponse(profileFixture));
} as unknown as typeof fetch;

describe("access token source", () => {
  it("caches tokens until invalidated", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => tokenResponse("access-1"),
      () => tokenResponse("access-2"),
    ]);
    const tokens = createAccessTokenSource({
      clientId: "id",
      clientSecret: "secret",
      fetchImpl,
      now: () => 0,
      refreshToken: "refresh",
    });

    await expect(tokens.getAccessToken()).resolves.toBe("access-1");
    await expect(tokens.getAccessToken()).resolves.toBe("access-1");
    expect(calls).toHaveLength(1);

    tokens.invalidate();
    await expect(tokens.getAccessToken()).resolves.toBe("access-2");
    expect(calls).toHaveLength(2);
  });

  it("maps invalid_grant to auth_required", async () => {
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse({ error: "invalid_grant" }, 400),
    ]);
    const tokens = createAccessTokenSource({
      clientId: "id",
      clientSecret: "secret",
      fetchImpl,
      refreshToken: "refresh",
    });

    await expect(tokens.getAccessToken()).rejects.toMatchObject({
      reason: "auth_required",
    });
  });

  it("maps transport failures to network_error", async () => {
    const fetchImpl = (() => {
      throw new Error("connection reset");
    }) as typeof fetch;
    const tokens = createAccessTokenSource({
      clientId: "id",
      clientSecret: "secret",
      fetchImpl,
      refreshToken: "refresh",
    });

    await expect(tokens.getAccessToken()).rejects.toMatchObject({
      reason: "network_error",
    });
  });

  it("rejects malformed token responses", async () => {
    const { fetchImpl } = scriptedFetch([() => jsonResponse({ nope: true })]);
    const tokens = createAccessTokenSource({
      clientId: "id",
      clientSecret: "secret",
      fetchImpl,
      refreshToken: "refresh",
    });

    await expect(tokens.getAccessToken()).rejects.toMatchObject({
      reason: "invalid_response",
    });
  });
});

describe("gmail client", () => {
  it("refreshes once on 401 and retries the request", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => tokenResponse("access-1"),
      () => jsonResponse(error401, 401),
      () => tokenResponse("access-2"),
      () => jsonResponse(profileFixture),
    ]);
    const tokens = createAccessTokenSource({
      clientId: "id",
      clientSecret: "secret",
      fetchImpl,
      now: () => 0,
      refreshToken: "refresh",
    });
    const client = new GmailClient({ baseUrl: BASE_URL, fetchImpl, tokens });

    const profile = await client.getProfile();
    expect(profile.emailAddress).toBe("owner@example.test");
    expect(calls).toHaveLength(4);
    expect(calls[3]?.init?.headers).toMatchObject({
      authorization: "Bearer access-2",
    });
  });

  it("fails with auth_invalid when 401 persists after refresh", async () => {
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse(error401, 401),
      () => jsonResponse(error401, 401),
    ]);
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl,
      tokens: stubTokens(),
    });

    await expect(client.getProfile()).rejects.toMatchObject({ reason: "auth_invalid" });
  });

  it("maps rate-limit and quota 403 reasons", async () => {
    const rateLimited = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl: scriptedFetch([() => jsonResponse(error403RateLimit, 403)]).fetchImpl,
      tokens: stubTokens(),
    });
    await expect(rateLimited.getProfile()).rejects.toMatchObject({
      reason: "rate_limited",
      retryable: true,
    });

    const quota = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl: scriptedFetch([() => jsonResponse(error403Quota, 403)]).fetchImpl,
      tokens: stubTokens(),
    });
    await expect(quota.getProfile()).rejects.toMatchObject({
      reason: "quota_exceeded",
      retryable: true,
    });
  });

  it("maps 404 to not_found", async () => {
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl: scriptedFetch([() => jsonResponse(error404, 404)]).fetchImpl,
      tokens: stubTokens(),
    });
    await expect(client.getMessage("missing-id")).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("rejects malformed responses as invalid_response", async () => {
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl: scriptedFetch([
        () => jsonResponse({ emailAddress: "" }),
        () => jsonResponse({ emailAddress: "" }),
      ]).fetchImpl,
      tokens: stubTokens(),
    });
    const failure = await client.getProfile().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GmailError);
    expect(failure).toMatchObject({ reason: "invalid_response" });
  });

  it("invokes the fetch implementation with a valid this reference", async () => {
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl: strictFetch,
      tokens: stubTokens(),
    });
    const profile = await client.getProfile();
    expect(profile.emailAddress).toBe("owner@example.test");
  });

  it("requests the first page with the given query and size", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => jsonResponse(messagesPage1)]);
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl,
      tokens: stubTokens(),
    });

    const first = await client.listMessages({ maxResults: 2, query: "in:inbox" });
    const url = new URL(calls[0]?.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      maxResults: "2",
      q: "in:inbox",
    });
    expect(first).toMatchObject({ nextPageToken: "page-2" });
    expect(first.messages).toHaveLength(2);
  });

  it("follows a page token and stops at the final page", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse(messagesPage1),
      () => jsonResponse(messagesPage2),
    ]);
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl,
      tokens: stubTokens(),
    });

    await client.listMessages({ maxResults: 2, query: "in:inbox" });
    const second = await client.listMessages({ pageToken: "page-2" });
    expect(second.messages).toHaveLength(1);
    expect(second.nextPageToken).toBeUndefined();
    expect(calls[1]?.url).toContain("pageToken=page-2");
  });

  it("lists labels and walks history pages", async () => {
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse(labelsFixture),
      () => jsonResponse(historyPage1),
      () => jsonResponse(historyPage2),
    ]);
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl,
      tokens: stubTokens(),
    });

    const labels = await client.listLabels();
    expect({
      count: labels.length,
      creditCardId: labels.find((label) => label.name === "Credit Card")?.id,
    }).toStrictEqual({ count: 12, creditCardId: "Label_1" });

    const history = await client.listHistory({ startHistoryId: "1000000" });
    expect(history).toMatchObject({ nextPageToken: "history-page-2" });
    expect(history.history).toHaveLength(2);
    const finalHistory = await client.listHistory({
      pageToken: "history-page-2",
      startHistoryId: "1000000",
    });
    expect(finalHistory.historyId).toBe("1000042");
  });

  it("requests message formats and attachments", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse(messageFull),
      () => jsonResponse(messageFull),
      () => jsonResponse({ data: "aGVsbG8=", size: 210 }),
    ]);
    const client = new GmailClient({
      baseUrl: BASE_URL,
      fetchImpl,
      tokens: stubTokens(),
    });

    const full = await client.getMessage("msg-1001");
    await client.getMessage("msg-1001", "minimal");
    const attachment = await client.getAttachment("msg-1001", "attach-1");

    expect(full).toMatchObject({
      payload: { mimeType: "multipart/alternative" },
    });
    expect({
      attachmentData: attachment.data,
      attachmentUrl: calls[2]?.url,
      fullUrl: calls[0]?.url,
      minimalUrl: calls[1]?.url,
    }).toMatchObject({
      attachmentData: "aGVsbG8=",
      attachmentUrl: expect.stringContaining("/messages/msg-1001/attachments/attach-1"),
      fullUrl: expect.stringContaining("format=full"),
      minimalUrl: expect.stringContaining("format=minimal"),
    });
  });
});
