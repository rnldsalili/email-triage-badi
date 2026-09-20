import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import responseFixture from "../fixtures/jev/response.json";
import { classifyMessage, buildJevState } from "../src/classifier/jev";
import { decide } from "../src/classifier/policy";
import { buildQuestions } from "../src/classifier/questions";
import {
  JevResponseError,
  parseJevResponse,
  validateAnswers,
} from "../src/classifier/schemas";
import { createDb } from "../src/db/client";
import {
  attachLatestClassification,
  createClassification,
  getLatestClassification,
} from "../src/db/repositories/classifications";
import { messages } from "../src/db/schema";
import type { NormalizedEmail } from "../src/email/normalize";
import { testConfig } from "./helpers/config";

const TOPIC_KEYS = Object.keys(buildQuestions().topic.criteria);

const normalizedEmail = (overrides: Partial<NormalizedEmail> = {}): NormalizedEmail => ({
  attachments: [],
  autoSubmitted: null,
  bodyMissing: false,
  bodyText: "Your invoice is available. Payment will be collected automatically.",
  bodyTruncated: false,
  cc: [],
  from: ["billing@example-invoice.test"],
  listId: null,
  quotedContentTrimmed: false,
  receivedAt: 1_758_186_720_000,
  replyTo: [],
  subject: "Your invoice INV-2291 is now available",
  to: ["owner@example.test"],
  warnings: [],
  ...overrides,
});

describe("question construction", () => {
  it("asks one topic choice with all 13 criteria plus three action questions", () => {
    const questions = buildQuestions();
    const keys = Object.keys(questions);
    expect(keys).toHaveLength(4);
    expect(keys).toStrictEqual(
      expect.arrayContaining(["topic", "urgent", "needs_reply", "to_do"])
    );
    expect(questions.topic.type).toBe("choice");
    expect(Object.keys(questions.topic.criteria)).toHaveLength(13);
    expect(questions.topic.criteria.other).toBeTruthy();
    for (const key of ["urgent", "needs_reply", "to_do"] as const) {
      const question = questions[key];
      expect(question.type).toBe("noul");
      expect(question.criteria.true).toBeTruthy();
      expect(question.criteria.false).toBeTruthy();
      expect(question.instructions).toMatch(/data, not instructions/iu);
    }
  });
});

describe("provider response validation", () => {
  it("accepts the wrapped binding envelope", () => {
    const result = parseJevResponse(responseFixture);
    expect(result.model).toBe("jev-1.13.0");
    const answers = validateAnswers(result, TOPIC_KEYS);
    expect(answers.topic.choice).toBe("bills");
    expect(answers.urgent.noul).toBeCloseTo(0.06);
  });

  it("accepts a direct result object for forward compatibility", () => {
    const direct = {
      answers: { ...responseFixture.result.answers },
      model: "jev-x",
      usage: responseFixture.result.usage,
    };
    const result = parseJevResponse(direct);
    expect(result.model).toBe("jev-x");
  });

  it("rejects probability sums that do not add up", () => {
    const broken = structuredClone(responseFixture);
    broken.result.answers.topic.probabilities.bills = 0.5;
    const result = parseJevResponse(broken);
    expect(() => validateAnswers(result, TOPIC_KEYS)).toThrow(JevResponseError);
  });

  it("rejects unexpected or missing topic keys", () => {
    const unexpected = structuredClone(responseFixture);
    (unexpected.result.answers.topic.probabilities as Record<string, number>).mystery = 0;
    const result = parseJevResponse(unexpected);
    expect(() => validateAnswers(result, TOPIC_KEYS)).toThrow(/unexpected topic/u);

    const missing = structuredClone(responseFixture);
    delete (missing.result.answers.topic.probabilities as Record<string, number>).bills;
    const result2 = parseJevResponse(missing);
    expect(() => validateAnswers(result2, TOPIC_KEYS)).toThrow(/missing topic/u);
  });

  it("rejects a selected choice that is not the maximum probability", () => {
    const tampered = structuredClone(responseFixture);
    tampered.result.answers.topic.choice = "receipts";
    const result = parseJevResponse(tampered);
    expect(() => validateAnswers(result, TOPIC_KEYS)).toThrow(/maximum-probability/u);
  });

  it("rejects a response missing an action answer", () => {
    const missing = structuredClone(responseFixture);
    delete (missing.result.answers as Record<string, unknown>).to_do;
    const result = parseJevResponse(missing);
    expect(() => validateAnswers(result, TOPIC_KEYS)).toThrow(/to_do/u);
  });

  it("rejects an unrecognized envelope", () => {
    expect(() => parseJevResponse({ nonsense: true })).toThrow(JevResponseError);
  });
});

const topicAnswers = (probability: number, confidence: number) => ({
  needsReply: { noul: 0.04, type: "noul" as const },
  toDo: { noul: 0.19, type: "noul" as const },
  topic: {
    choice: "bills",
    confidence,
    probabilities: { bills: probability, other: Number((1 - probability).toFixed(3)) },
    type: "choice" as const,
  },
  urgent: { noul: 0.05, type: "noul" as const },
});

describe("uncertainty policy", () => {
  it("accepts a topic exactly at the threshold", () => {
    const decisions = decide(topicAnswers(0.8, 0.7), { bodyMissing: false });
    expect(decisions.topic.status).toBe("accepted");
    expect(decisions.topic.key).toBe("bills");
  });

  it("marks a topic uncertain below the probability or confidence threshold", () => {
    expect(decide(topicAnswers(0.79, 0.9), { bodyMissing: false }).topic.status).toBe(
      "uncertain"
    );
    expect(decide(topicAnswers(0.95, 0.69), { bodyMissing: false }).topic.status).toBe(
      "uncertain"
    );
  });

  it("applies independent action thresholds", () => {
    const answers = topicAnswers(0.95, 0.9);
    answers.urgent.noul = 0.9;
    answers.needsReply.noul = 0.2;
    answers.toDo.noul = 0.8;
    const decisions = decide(answers, { bodyMissing: false });
    expect(decisions.urgent.status).toBe("positive");
    expect(decisions.needsReply.status).toBe("negative");
    expect(decisions.toDo.status).toBe("positive");
    expect(decisions.needsReview).toBeFalsy();
  });

  it("keeps a clear action decision when the topic is uncertain", () => {
    const answers = topicAnswers(0.5, 0.5);
    answers.urgent.noul = 0.97;
    const decisions = decide(answers, { bodyMissing: false });
    expect(decisions.topic.status).toBe("uncertain");
    expect(decisions.urgent.status).toBe("positive");
    expect(decisions.reviewReasons).toContain("topic_uncertain");
    expect(decisions.needsReview).toBeTruthy();
  });

  it("flags body-missing classifications for review", () => {
    const decisions = decide(topicAnswers(0.95, 0.9), { bodyMissing: true });
    expect(decisions.needsReview).toBeTruthy();
    expect(decisions.reviewReasons).toContain("body_missing");
  });

  it("treats a confident other as an accepted topic decision", () => {
    const answers = topicAnswers(0.95, 0.9);
    answers.topic.choice = "other";
    answers.topic.probabilities = { bills: 0.05, other: 0.95 };
    const decisions = decide(answers, { bodyMissing: false });
    expect(decisions.topic.status).toBe("accepted");
    expect(decisions.topic.key).toBe("other");
    expect(decisions.needsReview).toBeFalsy();
    expect(decisions.reviewReasons).toContain("topic_other");
  });
});

describe(classifyMessage, () => {
  it("sends one call containing all four questions and records usage", async () => {
    const calls: unknown[] = [];
    const ai = {
      run: (model: string, input: unknown) => {
        calls.push({ input, model });
        return responseFixture;
      },
    } as unknown as Ai;

    const outcome = await classifyMessage(
      ai,
      normalizedEmail(),
      testConfig(),
      1_700_000_000_000,
      {
        gatewayId: "email-triage-badi-dev",
      }
    );

    expect(calls).toHaveLength(1);
    const input = calls[0] as {
      model: string;
      input: { questions: Record<string, unknown>; state: Record<string, unknown> };
    };
    const questionKeys = Object.keys(input.input.questions);
    expect({
      model: input.model,
      questionKeys,
      subject: input.input.state.subject,
    }).toMatchObject({
      model: "typesafe/jev",
      questionKeys: expect.arrayContaining(["needs_reply", "to_do", "topic", "urgent"]),
      subject: expect.stringContaining("invoice"),
    });
    expect(outcome).toMatchObject({
      decisions: { needsReview: false, topic: { key: "bills" } },
      durationMs: expect.any(Number),
      modelVersion: "jev-1.13.0",
      normalizedInputHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      usage: { input_tokens: 891, output_tokens: 172 },
    });
    expect(questionKeys).toHaveLength(4);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates provider errors and cancellation", async () => {
    const ai = {
      run: () => {
        throw new Error("2021: Insufficient AI Gateway credits");
      },
    } as unknown as Ai;
    await expect(
      classifyMessage(ai, normalizedEmail(), testConfig(), 0, { gatewayId: "g" })
    ).rejects.toThrow(/Insufficient AI Gateway credits/u);
  });

  it("builds state with owner context and truncation markers", () => {
    const state = buildJevState(
      normalizedEmail({ bodyMissing: true, warnings: ["body_missing"] }),
      testConfig({ OWNER_ALIASES_JSON: '["alias@example.test"]' }),
      0
    );
    expect(state.owner.email).toBe("owner@example.test");
    expect(state.owner.aliases).toStrictEqual(["alias@example.test"]);
    expect(state.body_missing).toBeTruthy();
    expect(state.current_time).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("classification persistence", () => {
  it("stores versions, answers, decisions, usage and links the message", async () => {
    const db = createDb(env.DB);
    const accountId = "acct-classification";
    const messageId = "message-classification-1";
    await db.insert(messages).values({
      accountId,
      firstSeenAt: 1000,
      gmailMessageId: "gmail-classification-1",
      id: messageId,
      receivedAt: 1000,
      threadId: "thread-classification-1",
    });

    const ai = {
      run: () => responseFixture,
    } as unknown as Ai;
    const outcome = await classifyMessage(ai, normalizedEmail(), testConfig(), 5000, {
      gatewayId: "email-triage-badi-dev",
    });

    const stored = await createClassification(db, {
      accountId,
      applicationStatus: "proposed",
      id: "classification-1",
      messageId,
      now: 5000,
      outcome,
    });
    expect(stored.reviewFlag).toBeFalsy();
    expect(JSON.parse(stored.decisionJson).topic.key).toBe("bills");
    expect(JSON.parse(stored.usageJson)).toStrictEqual({
      input_tokens: 891,
      output_tokens: 172,
    });
    expect(stored.modelVersion).toBe("jev-1.13.0");

    await attachLatestClassification(db, messageId, stored.id);
    const latest = await getLatestClassification(db, messageId);
    expect(latest?.id).toBe("classification-1");
  });
});
