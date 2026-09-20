import { z } from "zod";

export const jevNoulAnswerSchema = z.object({
  noul: z.number().min(0).max(1),
  type: z.literal("noul"),
});

export const jevChoiceAnswerSchema = z.object({
  choice: z.string().min(1),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  type: z.literal("choice"),
});

export const jevAnswerSchema = z.union([jevNoulAnswerSchema, jevChoiceAnswerSchema]);

export const jevUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

export const jevResultSchema = z.looseObject({
  answers: z.record(z.string(), jevAnswerSchema),
  model: z.string().min(1),
  usage: jevUsageSchema,
});

export type JevResult = z.infer<typeof jevResultSchema>;
export type JevNoulAnswer = z.infer<typeof jevNoulAnswerSchema>;
export type JevChoiceAnswer = z.infer<typeof jevChoiceAnswerSchema>;

export class JevResponseError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Jev response validation failed: ${detail}`);
    this.name = "JevResponseError";
    this.detail = detail;
  }
}

export const parseJevResponse = (payload: unknown): JevResult => {
  const envelope = z.looseObject({ result: jevResultSchema }).safeParse(payload);
  if (envelope.success) {
    return envelope.data.result;
  }

  const direct = jevResultSchema.safeParse(payload);
  if (direct.success) {
    return direct.data;
  }

  const [issue] = direct.error.issues;
  throw new JevResponseError(
    issue
      ? `${issue.path.join(".") || "response"}: ${issue.message}`
      : "unrecognized envelope"
  );
};

export interface ValidatedAnswers {
  topic: JevChoiceAnswer;
  urgent: JevNoulAnswer;
  needsReply: JevNoulAnswer;
  toDo: JevNoulAnswer;
}

export const validateAnswers = (
  result: JevResult,
  expectedTopicKeys: string[]
): ValidatedAnswers => {
  const { topic } = result.answers;
  if (topic?.type !== "choice") {
    throw new JevResponseError("answers.topic must be a choice answer");
  }
  const expected = new Set(expectedTopicKeys);
  const keys = Object.keys(topic.probabilities);
  for (const key of keys) {
    if (!expected.has(key)) {
      throw new JevResponseError(`unexpected topic probability key: ${key}`);
    }
  }
  for (const key of expectedTopicKeys) {
    if (!(key in topic.probabilities)) {
      throw new JevResponseError(`missing topic probability key: ${key}`);
    }
  }
  const sum = keys.reduce((total, key) => total + (topic.probabilities[key] ?? 0), 0);
  if (Math.abs(sum - 1) > 0.001) {
    throw new JevResponseError(`topic probabilities sum to ${sum.toFixed(4)}`);
  }
  const selected = topic.probabilities[topic.choice];
  if (selected === undefined) {
    throw new JevResponseError(`selected topic ${topic.choice} is not a criterion key`);
  }
  const maxProbability = Math.max(...Object.values(topic.probabilities));
  if (selected < maxProbability - 0.001) {
    throw new JevResponseError("selected topic is not the maximum-probability option");
  }

  const { urgent } = result.answers;
  const needsReply = result.answers.needs_reply;
  const toDo = result.answers.to_do;
  if (urgent?.type !== "noul") {
    throw new JevResponseError("answers.urgent must be a noul answer");
  }
  if (needsReply?.type !== "noul") {
    throw new JevResponseError("answers.needs_reply must be a noul answer");
  }
  if (toDo?.type !== "noul") {
    throw new JevResponseError("answers.to_do must be a noul answer");
  }

  return { needsReply, toDo, topic, urgent };
};
