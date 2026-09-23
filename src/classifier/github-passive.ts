import type { AppConfig } from "../config/env";
import { POLICY_VERSION, TAXONOMY_VERSION } from "../config/versions";
import { decodeBodyData, headerMap } from "../email/mime";
import type { NormalizedEmail } from "../email/normalize";
import type { GmailMessage, GmailMessagePart } from "../gmail/types";
import { sha256Hex } from "../utils/crypto";
import type { ClassificationOutcome } from "./jev";

export const GITHUB_PASSIVE_RULE_VERSION = "github-passive-v1";

const REQUIRED_HEADERS = [
  "from",
  "subject",
  "list-id",
  "message-id",
  "x-github-reason",
  "x-github-recipient-address",
  "authentication-results",
] as const;
const UNSAFE_SUBJECT = /security|vulnerab|password|sign[ -]?in|urgent|deadline/iu;
const EVENT_MESSAGE =
  /^(?<event>Merged #(?<mergedPr>\d+) into [A-Za-z0-9_./-]+\.|Closed #(?<closedPr>\d+)\.)\n\n-- ?\nReply to this email directly or view it on GitHub:\nhttps:\/\/github\.com\/(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)\/pull\/(?<urlPr>\d+)#event-(?<urlEvent>\d+)\nYou are receiving this because (?<reason>your review was requested|you are subscribed to this thread)\.\n\nMessage ID: <(?<messageId>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/issue_event\/\d+@github\.com)>$/u;

const authenticated = (value: string): boolean => {
  const unfolded = value.replaceAll(/\r?\n[ \t]+/gu, " ");
  if (unfolded.includes("\n") || unfolded.includes("\r")) {
    return false;
  }
  const parts = unfolded.split(";").map((part) => part.trim());
  if (!/^mx\.google\.com$/iu.test(parts[0] ?? "")) {
    return false;
  }
  let dkim = 0;
  let dmarc = 0;
  for (const part of parts.slice(1)) {
    const kind = /^(?<mechanism>dkim|dmarc)=(?<result>[a-z]+)/iu.exec(part);
    if (!kind) {
      continue;
    }
    if (kind.groups?.result?.toLowerCase() !== "pass") {
      return false;
    }
    if (kind.groups?.mechanism?.toLowerCase() === "dkim") {
      if (!/(?:^|\s)header\.i=@github\.com(?:\s|$)/iu.test(part)) {
        return false;
      }
      dkim += 1;
    } else {
      if (!/(?:^|\s)header\.from=github\.com(?:\s|$)/iu.test(part)) {
        return false;
      }
      dmarc += 1;
    }
  }
  return dkim === 1 && dmarc === 1;
};

const decodePlainPart = (part: GmailMessagePart): string | null => {
  const encoded = part.body?.data;
  if (!encoded || encoded.length > 22_000) {
    return null;
  }
  const contentTypes =
    part.headers?.filter((header) => header.name.toLowerCase() === "content-type") ?? [];
  if (contentTypes.length > 1) {
    return null;
  }
  const contentType = contentTypes[0]?.value ?? "";
  const charsetMatches = [
    ...contentType.matchAll(/charset\s*=\s*"?(?<charset>[^";\s]+)"?/giu),
  ];
  if (charsetMatches.length > 1) {
    return null;
  }
  const charset = charsetMatches[0]?.groups?.charset;
  if (charset && !/^(?:utf-8|us-ascii)$/iu.test(charset)) {
    return null;
  }
  try {
    const decoded = decodeBodyData(encoded, charset);
    if (
      decoded.warning ||
      decoded.text.length > 16_384 ||
      decoded.text.includes("\uFFFD") ||
      /(?<!\r)\r(?!\n)/u.test(decoded.text)
    ) {
      return null;
    }
    return decoded.text.replaceAll("\r\n", "\n").replaceAll(/\n+$/gu, "");
  } catch {
    return null;
  }
};

const plainBody = (payload: GmailMessagePart | undefined): string | null => {
  if (!payload) {
    return null;
  }
  let count = 0;
  let plain: GmailMessagePart | undefined;
  const inspect = (part: GmailMessagePart, depth: number): boolean => {
    count += 1;
    if (count > 200 || depth > 30 || (part.filename ?? "").trim()) {
      return false;
    }
    if (part.mimeType?.toLowerCase() === "text/plain") {
      if (plain || !part.body?.data || part.body.attachmentId) {
        return false;
      }
      plain = part;
    }
    for (const child of part.parts ?? []) {
      if (!inspect(child, depth + 1)) {
        return false;
      }
    }
    return true;
  };
  if (!inspect(payload, 0) || !plain) {
    return null;
  }
  return decodePlainPart(plain);
};

const verifiedRouting = (
  message: GmailMessage,
  config: AppConfig
): { headers: Map<string, string>; recipient: string } | null => {
  const rawHeaders = message.payload?.headers;
  if (!rawHeaders) {
    return null;
  }
  for (const name of REQUIRED_HEADERS) {
    if (
      rawHeaders.filter((header) => header.name.trim().toLowerCase() === name).length !==
      1
    ) {
      return null;
    }
  }
  if (
    rawHeaders.some((header) => header.name.trim().toLowerCase() === "x-github-severity")
  ) {
    return null;
  }
  const headers = headerMap(rawHeaders);
  const recipient = headers.get("x-github-recipient-address")?.trim().toLowerCase();
  if (
    !recipient ||
    ![config.owner.accountEmail, ...config.owner.aliases].some(
      (address) => address.toLowerCase() === recipient
    ) ||
    !authenticated(headers.get("authentication-results") ?? "")
  ) {
    return null;
  }
  return { headers, recipient };
};

const completeEvent = (
  fullBody: string,
  normalized: NormalizedEmail,
  headers: Map<string, string>
): { event: "merged" | "closed"; reason: string } | null => {
  const fields = EVENT_MESSAGE.exec(fullBody)?.groups;
  if (!fields || normalized.bodyText !== fields.event) {
    return null;
  }
  const pr = fields.mergedPr ?? fields.closedPr;
  const messageId = `${fields.owner}/${fields.repo}/pull/${pr}/issue_event/${fields.urlEvent}@github.com`;
  const expectedListId = `${fields.owner}/${fields.repo} <${fields.repo}.${fields.owner}.github.com>`;
  const reason =
    fields.reason === "your review was requested" ? "review_requested" : "subscribed";
  if (
    pr !== fields.urlPr ||
    fields.messageId !== messageId ||
    headers.get("message-id") !== `<${messageId}>` ||
    headers.get("list-id")?.toLowerCase() !== expectedListId.toLowerCase() ||
    headers.get("x-github-reason") !== reason
  ) {
    return null;
  }
  return { event: fields.mergedPr ? "merged" : "closed", reason };
};

export const tryClassifyPassiveGithub = async (
  message: GmailMessage,
  normalized: NormalizedEmail,
  config: AppConfig,
  _now: number
): Promise<ClassificationOutcome | null> => {
  const start = Date.now();
  if (
    normalized.from.length !== 1 ||
    normalized.from[0]?.toLowerCase() !== "notifications@github.com" ||
    normalized.attachments.length !== 0 ||
    normalized.bodyMissing ||
    normalized.bodyTruncated ||
    normalized.warnings.some((warning) => warning !== "quoted_content_trimmed") ||
    UNSAFE_SUBJECT.test(normalized.subject)
  ) {
    return null;
  }
  const routing = verifiedRouting(message, config);
  if (!routing) {
    return null;
  }
  const fullBody = plainBody(message.payload);
  const event = fullBody ? completeEvent(fullBody, normalized, routing.headers) : null;
  if (!fullBody || !event) {
    return null;
  }
  const { headers, recipient } = routing;
  const { reason } = event;
  const normalizedInputHash = await sha256Hex(
    JSON.stringify({
      aliases: config.owner.aliases,
      authentication: headers.get("authentication-results"),
      body: fullBody,
      from: headers.get("from"),
      listId: headers.get("list-id"),
      messageId: headers.get("message-id"),
      owner: config.owner.accountEmail,
      reason,
      recipient,
      subject: headers.get("subject"),
      version: GITHUB_PASSIVE_RULE_VERSION,
    })
  );
  return {
    answers: {
      event: event.event,
      ruleId: GITHUB_PASSIVE_RULE_VERSION,
      type: "rule",
    },
    decisions: {
      needsReply: { probability: null, status: "negative" },
      needsReview: false,
      reviewReasons: [],
      toDo: { probability: null, status: "negative" },
      topic: {
        confidence: null,
        key: "github",
        probability: null,
        status: "accepted",
        topKey: "github",
      },
      urgent: { probability: null, status: "negative" },
    },
    durationMs: Date.now() - start,
    modelVersion: `rule:${GITHUB_PASSIVE_RULE_VERSION}`,
    normalizedInputHash,
    policyVersion: POLICY_VERSION,
    rubricVersion: GITHUB_PASSIVE_RULE_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
};
