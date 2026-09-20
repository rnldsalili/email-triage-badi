import type { AppConfig } from "../config/env";
import { POLICY_VERSION, RUBRIC_VERSION, TAXONOMY_VERSION } from "../config/versions";
import type { NormalizedEmail } from "../email/normalize";
import { InputLimitError } from "../utils/bounded-body";
import { sha256Hex } from "../utils/crypto";
import { decide } from "./policy";
import type { DecisionSet } from "./policy";
import { buildQuestions } from "./questions";
import { parseJevResponse, validateAnswers } from "./schemas";
import type { JevResult, ValidatedAnswers } from "./schemas";

export interface JevState {
  subject: string;
  body: string;
  from: string[];
  to: string[];
  cc: string[];
  reply_to: string[];
  owner: {
    email: string;
    aliases: string[];
    time_zone: string;
    employer_domains: string[];
  };
  received_at: string | null;
  current_time: string;
  list_id: string | null;
  auto_submitted: string | null;
  attachments: { filename: string; mime_type: string }[];
  body_missing: boolean;
  body_truncated: boolean;
  quoted_content_trimmed: boolean;
  warnings: string[];
}

export const buildJevState = (
  normalized: NormalizedEmail,
  config: AppConfig,
  now: number
): JevState => ({
  attachments: normalized.attachments.map((attachment) => ({
    filename: attachment.filename,
    mime_type: attachment.mimeType,
  })),
  auto_submitted: normalized.autoSubmitted,
  body: normalized.bodyText,
  body_missing: normalized.bodyMissing,
  body_truncated: normalized.bodyTruncated,
  cc: normalized.cc,
  current_time: new Date(now).toISOString(),
  from: normalized.from,
  list_id: normalized.listId,
  owner: {
    aliases: config.owner.aliases,
    email: config.owner.accountEmail,
    employer_domains: config.owner.employerDomains,
    time_zone: config.owner.timeZone,
  },
  quoted_content_trimmed: normalized.quotedContentTrimmed,
  received_at: normalized.receivedAt
    ? new Date(normalized.receivedAt).toISOString()
    : null,
  reply_to: normalized.replyTo,
  subject: normalized.subject,
  to: normalized.to,
  warnings: normalized.warnings,
});

export interface ClassificationOutcome {
  modelVersion: string;
  answers: ValidatedAnswers;
  decisions: DecisionSet;
  usage: { input_tokens: number; output_tokens: number };
  durationMs: number;
  normalizedInputHash: string;
  taxonomyVersion: string;
  rubricVersion: string;
  policyVersion: string;
}

export interface ClassifyOptions {
  gatewayId: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;

export const classifyMessage = async (
  ai: Ai,
  normalized: NormalizedEmail,
  config: AppConfig,
  now: number,
  options: ClassifyOptions
): Promise<ClassificationOutcome> => {
  const state = buildJevState(normalized, config, now);
  const questions = buildQuestions();
  // A UTF-8 byte per token is a deliberately conservative upper bound for
  // byte-fallback tokenizers. Reserve 2,000 of Jev's 32k context for framing/output.
  if (
    new TextEncoder().encode(JSON.stringify({ questions, state })).byteLength > 30_000
  ) {
    throw new InputLimitError("model_input_too_large");
  }
  const normalizedInputHash = await sha256Hex(JSON.stringify(state));

  const started = Date.now();
  const rawResponse = await ai.run(
    config.ai.model,
    { questions, state },
    {
      gateway: {
        collectLog: false,
        id: options.gatewayId,
        skipCache: true,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }
  );
  const durationMs = Date.now() - started;

  const result: JevResult = parseJevResponse(rawResponse);
  const answers = validateAnswers(result, Object.keys(questions.topic.criteria));
  const decisions = decide(answers, { bodyMissing: normalized.bodyMissing });

  return {
    answers,
    decisions,
    durationMs,
    modelVersion: result.model,
    normalizedInputHash,
    policyVersion: POLICY_VERSION,
    rubricVersion: RUBRIC_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    usage: result.usage,
  };
};
