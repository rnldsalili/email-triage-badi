import type { GmailMessage, GmailMessagePart } from "../gmail/types";
import { InputLimitError } from "../utils/bounded-body";
import { htmlToText } from "./html";
import {
  decodeBase64Url,
  decodeBodyData,
  decodeText,
  headerMap,
  parseAddressList,
  truncate,
} from "./mime";

const DEFAULT_MAX_SUBJECT_CHARACTERS = 500;
const DEFAULT_ATTACHMENT_FETCH_LIMIT_BYTES = 256 * 1024;
const MAX_ENCODED_PART_CHARACTERS = 1_500_000;
const MAX_HTML_INPUT_CHARACTERS = 1_000_000;

export interface AttachmentMetadata {
  filename: string;
  mimeType: string;
  size: number | null;
}

export interface NormalizedEmail {
  subject: string;
  from: string[];
  to: string[];
  cc: string[];
  replyTo: string[];
  listId: string | null;
  autoSubmitted: string | null;
  receivedAt: number | null;
  attachments: AttachmentMetadata[];
  bodyText: string;
  bodyTruncated: boolean;
  bodyMissing: boolean;
  quotedContentTrimmed: boolean;
  warnings: string[];
}

export interface NormalizeOptions {
  maxBodyCharacters: number;
  maxSubjectCharacters?: number;
  attachmentFetchLimitBytes?: number;
  fetchAttachmentData?: (attachmentId: string) => Promise<string | undefined>;
}

interface TextCandidate {
  kind: "plain" | "html";
  text: string;
}

const TRIM_MARKERS = [
  /^-{2,}\s*original message\s*-{2,}$/iu,
  /^on .{5,200} wrote:$/iu,
  /^_{5,}$/u,
];

export const trimQuotedContent = (
  text: string
): {
  text: string;
  trimmed: boolean;
} => {
  const lines = text.replaceAll(/\r\n?/gu, "\n").split("\n");
  const kept: string[] = [];
  let trimmed = false;

  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith(">")) {
      trimmed = true;
      continue;
    }
    if (TRIM_MARKERS.some((pattern) => pattern.test(stripped))) {
      trimmed = true;
      break;
    }
    if (stripped === "--" || stripped === "-- ") {
      trimmed = true;
      break;
    }
    kept.push(line);
  }

  const result = kept
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
  if (result.length === 0) {
    return { text: text.trim(), trimmed: false };
  }
  return { text: result, trimmed };
};

const decodePartBody = async (
  part: GmailMessagePart,
  options: NormalizeOptions,
  warnings: string[]
): Promise<string | undefined> => {
  if (part.body?.data) {
    if (part.body.data.length > MAX_ENCODED_PART_CHARACTERS) {
      warnings.push("body_part_too_large");
      return undefined;
    }
    const charset = headerMap(part.headers).get("content-type");
    const charsetMatch = charset
      ? /charset="?(?<charset>[^";]+)"?/iu.exec(charset)
      : null;
    const decoded = decodeBodyData(part.body.data, charsetMatch?.groups?.charset);
    if (decoded.warning) {
      warnings.push(decoded.warning);
    }
    return decoded.text;
  }

  if (part.body?.attachmentId && options.fetchAttachmentData) {
    const limit =
      options.attachmentFetchLimitBytes ?? DEFAULT_ATTACHMENT_FETCH_LIMIT_BYTES;
    if ((part.body.size ?? 0) > limit) {
      warnings.push("attachment_text_part_too_large");
      return undefined;
    }
    const data = await options.fetchAttachmentData(part.body.attachmentId);
    if (!data) {
      warnings.push("attachment_text_part_unavailable");
      return undefined;
    }
    const charset = headerMap(part.headers).get("content-type");
    const charsetMatch = charset
      ? /charset="?(?<charset>[^";]+)"?/iu.exec(charset)
      : null;
    const decoded = decodeText(decodeBase64Url(data), charsetMatch?.groups?.charset);
    if (decoded.warning) {
      warnings.push(decoded.warning);
    }
    return decoded.text;
  }

  return undefined;
};

const isAttachmentPart = (part: GmailMessagePart): boolean => {
  const hasFilename = (part.filename ?? "").trim().length > 0;
  return hasFilename;
};

const collectParts = (
  part: GmailMessagePart,
  attachments: AttachmentMetadata[]
): void => {
  if (isAttachmentPart(part)) {
    attachments.push({
      filename: (part.filename ?? "").trim(),
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? null,
    });
  }
  for (const child of part.parts ?? []) {
    collectParts(child, attachments);
  }
};

const collectTextCandidates = async (
  part: GmailMessagePart,
  options: NormalizeOptions,
  warnings: string[],
  candidates: TextCandidate[]
): Promise<void> => {
  const mimeType = (part.mimeType ?? "").toLowerCase();

  if (isAttachmentPart(part)) {
    return;
  }

  if (mimeType === "text/plain") {
    const text = await decodePartBody(part, options, warnings);
    if (text !== undefined) {
      candidates.push({ kind: "plain", text });
    }
    return;
  }
  if (mimeType === "text/html") {
    const html = await decodePartBody(part, options, warnings);
    if (html !== undefined) {
      const bounded =
        html.length > MAX_HTML_INPUT_CHARACTERS
          ? html.slice(0, MAX_HTML_INPUT_CHARACTERS)
          : html;
      if (html.length > MAX_HTML_INPUT_CHARACTERS) {
        warnings.push("html_input_truncated");
      }
      candidates.push({ kind: "html", text: htmlToText(bounded) });
    }
    return;
  }

  for await (const child of part.parts ?? []) {
    await collectTextCandidates(child, options, warnings, candidates);
  }
};

export const normalizeMessage = async (
  message: GmailMessage,
  options: NormalizeOptions
): Promise<NormalizedEmail> => {
  const { payload } = message;
  let partCount = 0;
  const checkParts = (part: GmailMessagePart, depth: number) => {
    if ((partCount += 1) > 200 || depth > 30) {
      throw new InputLimitError("mime_structure_too_large");
    }
    for (const child of part.parts ?? []) {
      checkParts(child, depth + 1);
    }
  };
  if (payload) {
    checkParts(payload, 0);
  }
  const headers = headerMap(payload?.headers);
  const warnings: string[] = [];

  const maxSubject = options.maxSubjectCharacters ?? DEFAULT_MAX_SUBJECT_CHARACTERS;
  const subject = truncate(headers.get("subject")?.trim() ?? "", maxSubject);
  if ((headers.get("subject")?.trim().length ?? 0) > maxSubject) {
    warnings.push("subject_truncated");
  }

  const attachments: AttachmentMetadata[] = [];
  if (payload) {
    collectParts(payload, attachments);
  }

  const candidates: TextCandidate[] = [];
  if (payload) {
    await collectTextCandidates(payload, options, warnings, candidates);
  }

  const plain = candidates.filter(
    (candidate) => candidate.kind === "plain" && candidate.text.trim().length > 0
  );
  const html = candidates.filter(
    (candidate) => candidate.kind === "html" && candidate.text.trim().length > 0
  );
  const selected = plain.length > 0 ? plain : html;

  let bodyMissing = false;
  let bodyTruncated = false;
  let quotedContentTrimmed = false;
  let bodyText = "";

  if (selected.length > 0) {
    const joined = selected
      .map((candidate) => candidate.text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
    if (joined.length === 0) {
      bodyMissing = true;
      warnings.push("body_empty");
    } else {
      const trimmed = trimQuotedContent(joined);
      bodyText = trimmed.text;
      quotedContentTrimmed = trimmed.trimmed;
      if (trimmed.trimmed) {
        warnings.push("quoted_content_trimmed");
      }
      if (bodyText.length > options.maxBodyCharacters) {
        bodyText = `${bodyText.slice(0, options.maxBodyCharacters)}[truncated]`;
        bodyTruncated = true;
        warnings.push("body_truncated");
      }
    }
  } else {
    bodyMissing = true;
    warnings.push("body_missing");
  }

  const internalDate = message.internalDate ? Number(message.internalDate) : Number.NaN;

  return {
    attachments,
    autoSubmitted: headers.get("auto-submitted") ?? null,
    bodyMissing,
    bodyText,
    bodyTruncated,
    cc: parseAddressList(headers.get("cc")),
    from: parseAddressList(headers.get("from")),
    listId: headers.get("list-id") ?? null,
    quotedContentTrimmed,
    receivedAt: Number.isFinite(internalDate) ? internalDate : null,
    replyTo: parseAddressList(headers.get("reply-to")),
    subject,
    to: parseAddressList(headers.get("to")),
    warnings,
  };
};
