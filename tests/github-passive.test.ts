import { describe, expect, it } from "vitest";

import { tryClassifyPassiveGithub } from "../src/classifier/github-passive";
import { normalizeMessage } from "../src/email/normalize";
import type { GmailMessage } from "../src/gmail/types";
import { testConfig } from "./helpers/config";

const merged = "Merged #123 into main.";
const closed = "Closed #123.";
const footer = (event = merged, reason = "your review was requested") =>
  `${event}\n\n-- \nReply to this email directly or view it on GitHub:\nhttps://github.com/acme/widget/pull/123#event-456\nYou are receiving this because ${reason}.\n\nMessage ID: <acme/widget/pull/123/issue_event/456@github.com>\n`;
const message = (body = footer()): GmailMessage => ({
  id: "synthetic-github-1",
  internalDate: "1700000000000",
  labelIds: ["INBOX"],
  payload: {
    body: { data: btoa(body) },
    headers: [
      { name: "From", value: "GitHub <notifications@github.com>" },
      { name: "To", value: "owner@example.test" },
      { name: "Subject", value: "[acme/widget] Pull request #123 merged" },
      { name: "List-Id", value: "acme/widget <widget.acme.github.com>" },
      { name: "Message-ID", value: "<acme/widget/pull/123/issue_event/456@github.com>" },
      { name: "X-GitHub-Reason", value: "review_requested" },
      { name: "X-GitHub-Recipient-Address", value: "owner@example.test" },
      {
        name: "Authentication-Results",
        value:
          "mx.google.com; dkim=pass header.i=@github.com header.s=2024; spf=pass; dmarc=pass header.from=github.com",
      },
      { name: "Content-Type", value: "text/plain; charset=UTF-8" },
    ],
    mimeType: "text/plain",
  },
  threadId: "synthetic-thread-1",
});

const decide = async (email: GmailMessage, maxBodyCharacters = 12_000) => {
  const normalized = await normalizeMessage(email, { maxBodyCharacters });
  return tryClassifyPassiveGithub(email, normalized, testConfig(), 1_700_000_000_000);
};

const replaceHeader = (
  email: GmailMessage,
  name: string,
  value: string
): GmailMessage => ({
  ...email,
  payload: {
    ...email.payload,
    headers: email.payload?.headers?.map((header) =>
      header.name.toLowerCase() === name.toLowerCase() ? { ...header, value } : header
    ),
  },
});

describe("completed GitHub pull request rule", () => {
  it("classifies only complete authenticated merge and close envelopes without fake model confidence", async () => {
    const cases = [
      [footer(), "merged"],
      [footer(closed, "you are subscribed to this thread"), "closed"],
    ] as const;
    const results = await Promise.all(
      cases.map(([body, event]) => {
        const email =
          event === "closed"
            ? replaceHeader(message(body), "X-GitHub-Reason", "subscribed")
            : message(body);
        return decide(email);
      })
    );
    for (const [index, result] of results.entries()) {
      const event = cases[index]?.[1];
      expect(result?.answers).toMatchObject({ event, type: "rule" });
      expect(result?.modelVersion).toBe("rule:github-passive-v1");
      expect(result?.usage).toStrictEqual({ input_tokens: 0, output_tokens: 0 });
      expect(result?.decisions).toMatchObject({
        needsReply: { probability: null, status: "negative" },
        needsReview: false,
        toDo: { probability: null, status: "negative" },
        topic: { confidence: null, key: "github", probability: null, status: "accepted" },
        urgent: { probability: null, status: "negative" },
      });
      expect(result?.normalizedInputHash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("does not classify a review-requested discussion, even with valid GitHub routing headers", async () => {
    const discussion = message(
      footer().replace(
        merged,
        "@reviewer commented on this pull request. Please answer by tomorrow."
      )
    );
    await expect(decide(discussion)).resolves.toBeNull();
    await expect(
      decide(message(footer().replace(merged, "Deployment review pending; approve now.")))
    ).resolves.toBeNull();
    await expect(
      decide(message(footer().replace(merged, "Workflow failed; deployment blocked.")))
    ).resolves.toBeNull();
  });

  it("falls back to AI for changed content or mismatched identifiers", async () => {
    const changed = [
      `Intro\n${footer()}`,
      footer().replace("\nMessage ID:", "\nAn extra request needs a reply.\nMessage ID:"),
      footer().replace("event-456", "event-457"),
      footer().replace("/pull/123#", "/pull/124#"),
      footer().replace("Merged #123", "Merged #124"),
      footer().replace("https://github.com", "https://example.test"),
      footer().replace("your review was requested", "you were mentioned"),
    ];
    await expect(
      Promise.all(changed.map((body) => decide(message(body))))
    ).resolves.toStrictEqual(Array.from({ length: changed.length }, () => null));
    await expect(
      decide(replaceHeader(message(), "Message-ID", "<different@github.com>"))
    ).resolves.toBeNull();
    await expect(
      decide(replaceHeader(message(), "List-Id", "other/repo <repo.other.github.com>"))
    ).resolves.toBeNull();
    await expect(
      decide(
        replaceHeader(message(), "X-GitHub-Recipient-Address", "stranger@example.test")
      )
    ).resolves.toBeNull();
    await expect(
      decide(replaceHeader(message(), "X-GitHub-Reason", "comment"))
    ).resolves.toBeNull();
  });

  it("rejects ambiguous authentication and duplicate or missing routing headers", async () => {
    const changedHeaders = [
      [
        "Authentication-Results",
        "mx.google.com; dkim=fail header.i=@github.com; dmarc=pass header.from=github.com",
      ],
      [
        "Authentication-Results",
        "another.mx; dkim=pass header.i=@github.com; dmarc=pass header.from=github.com",
      ],
      ["From", "Attacker <notifications@example.test>"],
      ["Subject", "URGENT security: [acme/widget] Pull request #123 merged"],
    ] as const;
    await expect(
      Promise.all(
        changedHeaders.map(([name, value]) =>
          decide(replaceHeader(message(), name, value))
        )
      )
    ).resolves.toStrictEqual(Array.from({ length: changedHeaders.length }, () => null));
    const original = message();
    await expect(
      decide({
        ...original,
        payload: { ...original.payload, headers: original.payload?.headers?.slice(1) },
      })
    ).resolves.toBeNull();
    await expect(
      decide({
        ...original,
        payload: {
          ...original.payload,
          headers: [
            ...(original.payload?.headers ?? []),
            {
              name: "authentication-results",
              value:
                "mx.google.com; dkim=pass header.i=@github.com; dmarc=pass header.from=github.com",
            },
          ],
        },
      })
    ).resolves.toBeNull();
    await expect(
      decide({
        ...original,
        payload: {
          ...original.payload,
          headers: [
            ...(original.payload?.headers ?? []),
            { name: "X-GitHub-Severity", value: "high" },
          ],
        },
      })
    ).resolves.toBeNull();
  });

  it("does not use incomplete or ambiguous MIME content", async () => {
    const original = message();
    await expect(decide(original, 10)).resolves.toBeNull();
    await expect(
      decide({
        ...original,
        payload: { ...original.payload, filename: "note.txt" },
      })
    ).resolves.toBeNull();
    await expect(
      decide(replaceHeader(original, "Content-Type", "text/plain; charset=iso-8859-1"))
    ).resolves.toBeNull();
    await expect(
      decide({
        ...original,
        payload: {
          ...original.payload,
          body: undefined,
          mimeType: "multipart/mixed",
          parts: [original.payload ?? {}, original.payload ?? {}],
        },
      })
    ).resolves.toBeNull();
    await expect(
      decide({
        ...original,
        payload: { ...original.payload, mimeType: "text/html" },
      })
    ).resolves.toBeNull();
  });
});
