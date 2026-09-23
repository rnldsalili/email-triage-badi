import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import responseFixture from "../fixtures/jev/response.json";
import { classifyMessage, buildJevState } from "../src/classifier/jev";
import { decide } from "../src/classifier/policy";
import { buildQuestions } from "../src/classifier/questions";
import type { QuestionSet } from "../src/classifier/questions";
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
    }
  });

  it("selects only topic criteria and preserves the standard default", () => {
    const standard = buildQuestions();
    const compact = buildQuestions("compact-v1");
    expect(Object.keys(compact.topic.criteria)).toStrictEqual(
      Object.keys(standard.topic.criteria)
    );
    expect(compact.topic.criteria).not.toStrictEqual(standard.topic.criteria);
    expect(compact.topic.instructions).toBe(standard.topic.instructions);
    for (const key of ["urgent", "needs_reply", "to_do"] as const) {
      expect(compact[key]).toStrictEqual(standard[key]);
    }
    expect({
      defaults: testConfig().ai,
      enabled: testConfig({ AI_RUBRIC: "compact-v1", GITHUB_PASSIVE_FAST_PATH: "on" }).ai,
    }).toMatchObject({
      defaults: { githubPassiveFastPath: "off", rubric: "standard" },
      enabled: { githubPassiveFastPath: "on", rubric: "compact-v1" },
    });
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
      run: (model: string, input: unknown, options: unknown) => {
        calls.push({ input, model, options });
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
        workload: "production",
      }
    );

    expect(calls).toHaveLength(1);
    const input = calls[0] as {
      model: string;
      input: { questions: Record<string, unknown>; state: Record<string, unknown> };
      options: { gateway: Record<string, unknown> };
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
    expect(input.input.questions).toStrictEqual(buildQuestions());
    expect({
      gateway: input.options.gateway,
      retriesEnabled: "retries" in input.options.gateway,
    }).toMatchObject({
      gateway: {
        collectLog: false,
        id: "email-triage-badi-dev",
        metadata: { rubric: "standard", workload: "production" },
        skipCache: true,
      },
      retriesEnabled: false,
    });
    expect(outcome).toMatchObject({
      decisions: { needsReview: false, topic: { key: "bills" } },
      durationMs: expect.any(Number),
      modelVersion: "jev-1.13.0",
      normalizedInputHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      rubricVersion: "rubric-v1",
      usage: { input_tokens: 891, output_tokens: 172 },
    });
  });

  it("propagates provider errors and cancellation", async () => {
    const ai = {
      run: () => {
        throw new Error("2021: Insufficient AI Gateway credits");
      },
    } as unknown as Ai;
    await expect(
      classifyMessage(ai, normalizedEmail(), testConfig(), 0, {
        gatewayId: "g",
        workload: "production",
      })
    ).rejects.toThrow(/Insufficient AI Gateway credits/u);
  });

  it("tags the selected compact rubric and disables evaluation gateway retries", async () => {
    let providerCalls = 0;
    let gateway: Record<string, unknown> | undefined;
    const ai = {
      run: (
        _model: string,
        input: { questions: QuestionSet },
        options: { gateway: Record<string, unknown> }
      ) => {
        providerCalls += 1;
        ({ gateway } = options);
        expect(input.questions.topic.criteria).toStrictEqual(
          buildQuestions("compact-v1").topic.criteria
        );
        return responseFixture;
      },
    } as unknown as Ai;
    let reserved = 0;
    const outcome = await classifyMessage(
      ai,
      normalizedEmail(),
      testConfig({ AI_RUBRIC: "compact-v1" }),
      5000,
      {
        gatewayId: "evaluation-gateway",
        onProviderCall: () => {
          reserved += 1;
          expect(providerCalls).toBe(0);
        },
        workload: "evaluation",
      }
    );
    expect(reserved).toBe(1);
    expect(providerCalls).toBe(1);
    expect(outcome.rubricVersion).toBe("rubric-compact-v1");
    expect(gateway).toMatchObject({
      metadata: { rubric: "compact-v1", workload: "evaluation" },
      retries: { maxAttempts: 1 },
    });
  });

  it("does not reserve or invoke the provider for a failed local preflight", async () => {
    let calls = 0;
    const ai = {
      run: () => {
        calls += 1;
        return responseFixture;
      },
    } as unknown as Ai;
    const oversized = normalizedEmail({ listId: "x".repeat(40_000) });
    await expect(
      classifyMessage(ai, oversized, testConfig(), 0, {
        gatewayId: "g",
        onProviderCall: () => {
          calls += 100;
        },
        workload: "evaluation",
      })
    ).rejects.toMatchObject({ code: "model_input_too_large" });
    expect(calls).toBe(0);
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
      workload: "production",
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
