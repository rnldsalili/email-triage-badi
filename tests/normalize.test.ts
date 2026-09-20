import { describe, expect, it } from "vitest";

import messageFull from "../fixtures/gmail/message-full.json";
import { htmlToText } from "../src/email/html";
import { normalizeMessage, trimQuotedContent } from "../src/email/normalize";
import type { GmailMessage } from "../src/gmail/types";

const BASE_OPTIONS = { maxBodyCharacters: 12_000 };

const messageWithBody = (
  body: Record<string, unknown>,
  headers: { name: string; value: string }[] = []
): GmailMessage =>
  ({
    id: "msg-test",
    payload: {
      headers,
      mimeType: body.parts ? "multipart/alternative" : "text/plain",
      ...body,
    },
    threadId: "thread-test",
  }) as unknown as GmailMessage;

describe("html extraction", () => {
  it("removes scripts and styles and preserves block boundaries", () => {
    const text = htmlToText(
      "<html><head><style>p{color:red}</style></head><body><p>First line</p><script>alert('x')</script><p>Second&nbsp;line</p></body></html>"
    );
    expect(text).toBe("First line\nSecond line");
  });

  it("keeps link text and list items", () => {
    const text = htmlToText(
      "<ul><li>One</li><li>Two</li></ul><p>See <a href='x'>the docs</a></p>"
    );
    expect(text).toContain("One");
    expect(text).toContain("Two");
    expect(text).toContain("the docs");
  });
});

describe("quote trimming", () => {
  it("removes quoted lines and reply headers", () => {
    const trimmed = trimQuotedContent(
      "Sounds good, see you then.\n\nOn Mon, Sep 14 2026, Sam wrote:\n> Are we still on?\n> Thanks"
    );
    expect(trimmed.trimmed).toBeTruthy();
    expect(trimmed.text).toBe("Sounds good, see you then.");
  });

  it("keeps the original text when everything looks quoted", () => {
    const trimmed = trimQuotedContent("> only quoted text");
    expect(trimmed.trimmed).toBeFalsy();
    expect(trimmed.text).toBe("> only quoted text");
  });
});

describe(normalizeMessage, () => {
  it("prefers plain text over the HTML alternative", async () => {
    const normalized = await normalizeMessage(
      messageFull as unknown as GmailMessage,
      BASE_OPTIONS
    );
    expect(normalized).toMatchObject({
      bodyMissing: false,
      from: ["billing@example-invoice.test"],
      listId: "invoices.example-invoice.test",
      subject: "Your invoice INV-2291 is now available",
      to: ["owner@example.test"],
    });
    expect(normalized.bodyText).toContain("monthly invoice INV-2291");
    expect(normalized.bodyText).not.toContain("<html>");
  });

  it("falls back to HTML when no plain part exists", async () => {
    const message = messageWithBody({
      parts: [
        {
          body: {
            data: btoa("<p>Renewal notice</p><p>Your plan renews soon.</p>"),
          },
          filename: "",
          mimeType: "text/html",
          partId: "0",
        },
      ],
    });
    const normalized = await normalizeMessage(message, BASE_OPTIONS);
    expect(normalized.bodyText).toContain("Renewal notice");
    expect(normalized.bodyText).toContain("renews soon");
  });

  it("decodes non-UTF-8 charsets", async () => {
    // "Café" in ISO-8859-1
    const latin1 = new Uint8Array([0x43, 0x61, 0x66, 0xe9]);
    const base64 = btoa(String.fromCodePoint(...latin1));
    const message = messageWithBody({
      body: { data: base64 },
      headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }],
    });
    const normalized = await normalizeMessage(message, BASE_OPTIONS);
    expect(normalized.bodyText).toBe("Café");
  });

  it("reports unsupported charsets as a warning and decodes as UTF-8", async () => {
    const message = messageWithBody({
      body: { data: btoa("plain ascii") },
      headers: [{ name: "Content-Type", value: 'text/plain; charset="x-unknown"' }],
    });
    const normalized = await normalizeMessage(message, BASE_OPTIONS);
    expect(normalized.bodyText).toBe("plain ascii");
    expect(normalized.warnings).toContain("unsupported_charset:x-unknown");
  });

  it("fetches text parts stored as attachments with a size limit", async () => {
    const message = messageWithBody({
      parts: [
        {
          body: { attachmentId: "attach-text-1", size: 120 },
          filename: "",
          mimeType: "text/plain",
          partId: "0",
        },
      ],
    });
    const normalized = await normalizeMessage(message, {
      ...BASE_OPTIONS,
      fetchAttachmentData: (attachmentId) =>
        Promise.resolve(
          attachmentId === "attach-text-1" ? btoa("Fetched body text") : undefined
        ),
    });
    expect(normalized.bodyText).toBe("Fetched body text");
  });

  it("records attachment metadata without including binary content", async () => {
    const message = messageWithBody({
      parts: [
        {
          body: { data: btoa("Body text") },
          filename: "",
          mimeType: "text/plain",
          partId: "0",
        },
        {
          body: { attachmentId: "attach-pdf-1", size: 58_231 },
          filename: "payslip-september.pdf",
          mimeType: "application/pdf",
          partId: "1",
        },
      ],
    });
    const normalized = await normalizeMessage(message, BASE_OPTIONS);
    expect(normalized.attachments).toStrictEqual([
      { filename: "payslip-september.pdf", mimeType: "application/pdf", size: 58_231 },
    ]);
    expect(normalized.bodyText).toBe("Body text");
  });

  it("marks body-less messages and allows subject-only classification", async () => {
    const message = messageWithBody({
      headers: [{ name: "Subject", value: "Your payslip is ready" }],
    });
    const normalized = await normalizeMessage(message, BASE_OPTIONS);
    expect(normalized.bodyMissing).toBeTruthy();
    expect(normalized.warnings).toContain("body_missing");
    expect(normalized.subject).toBe("Your payslip is ready");
  });

  it("truncates long bodies with a marker", async () => {
    const message = messageWithBody({
      body: { data: btoa("x".repeat(500)) },
    });
    const normalized = await normalizeMessage(message, { maxBodyCharacters: 100 });
    expect(normalized.bodyTruncated).toBeTruthy();
    expect(normalized.bodyText.endsWith("[truncated]")).toBeTruthy();
    expect(normalized.bodyText).toHaveLength(100 + "[truncated]".length);
    expect(normalized.warnings).toContain("body_truncated");
  });

  it("truncates long subjects with a marker", async () => {
    const message = messageWithBody({
      body: { data: btoa("body") },
      headers: [{ name: "Subject", value: "s".repeat(600) }],
    });
    const normalized = await normalizeMessage(message, BASE_OPTIONS);
    expect(normalized.subject.endsWith("[truncated]")).toBeTruthy();
    expect(normalized.warnings).toContain("subject_truncated");
  });
});
