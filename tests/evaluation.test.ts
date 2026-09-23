import { describe, expect, it } from "vitest";

import type { DecisionSet, TopicKeyOrOther } from "../src/classifier/policy";
import { validateHeldOutSplit } from "../src/evaluation/dataset";
import { releaseGates } from "../src/evaluation/diagnostics";
import { buildReport } from "../src/evaluation/report";
import type { EvalExample, EvalPrediction } from "../src/evaluation/report";

const example = (
  id: string,
  topic: string | null,
  options: {
    topicAmbiguous?: boolean;
    urgent?: boolean | null;
    needsReply?: boolean | null;
    toDo?: boolean | null;
    actionAmbiguous?: boolean;
  } = {}
): EvalExample => ({
  body: id,
  groundTruth: {
    needs_reply: {
      ambiguous: options.actionAmbiguous ?? false,
      value: options.needsReply ?? false,
    },
    to_do: {
      ambiguous: options.actionAmbiguous ?? false,
      value: options.toDo ?? false,
    },
    topic: { ambiguous: options.topicAmbiguous ?? false, value: topic },
    urgent: {
      ambiguous: options.actionAmbiguous ?? false,
      value: options.urgent ?? false,
    },
  },
  id,
  subject: id,
});

const decisions = (
  topic: {
    status: "accepted" | "uncertain";
    key: TopicKeyOrOther | null;
    topKey: TopicKeyOrOther;
  },
  actions: {
    urgent: "positive" | "negative" | "uncertain";
    needsReply: "positive" | "negative" | "uncertain";
    toDo: "positive" | "negative" | "uncertain";
  }
): DecisionSet => ({
  needsReply: { probability: 0.5, status: actions.needsReply },
  needsReview: false,
  reviewReasons: [],
  toDo: { probability: 0.5, status: actions.toDo },
  topic: {
    ...topic,
    confidence: 0.9,
    probability: 0.9,
  },
  urgent: { probability: 0.5, status: actions.urgent },
});

const OPTIONS = { datasetVersion: "test", inputTokenCostUsd: 0.000000042 };

describe("evaluation report", () => {
  it("reports category failures and fails release gates on sparse samples", () => {
    const examples = [example("missing", "payslips"), example("accepted", "other")];
    const predictions: EvalPrediction[] = [
      {
        decisions: decisions(
          { key: "other", status: "accepted", topKey: "other" },
          { needsReply: "negative", toDo: "negative", urgent: "negative" }
        ),
        durationMs: 10,
        exampleId: "accepted",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ];
    const report = buildReport(examples, predictions, {
      ...OPTIONS,
      datasetHash: "fixture-hash",
      split: "held_out",
    });
    const gates = releaseGates(report);
    expect(report.diagnostics.confusion).toMatchObject({
      other: { other: 1 },
      payslips: { failure: 1 },
    });
    expect(
      report.diagnostics.perTopic.find((topic) => topic.key === "payslips")
    ).toMatchObject({ coverage: 0, failures: 1 });
    expect(gates).toMatchObject({ failures: ["topic_coverage"], passed: false });
    expect(gates.unverified).toContain("precision:urgent");
  });

  it("reports ambiguous-dimension abstention without discarding clear action truth", () => {
    const examples = [
      example("ambiguous", null, { needsReply: true, topicAmbiguous: true }),
    ];
    const predictions: EvalPrediction[] = [
      {
        decisions: decisions(
          { key: null, status: "uncertain", topKey: "other" },
          { needsReply: "positive", toDo: "negative", urgent: "negative" }
        ),
        durationMs: 10,
        exampleId: "ambiguous",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ];
    const report = buildReport(examples, predictions, OPTIONS);
    expect(
      report.diagnostics.annotations.find((dimension) => dimension.dimension === "topic")
    ).toMatchObject({ ambiguous: 1, ambiguousAbstentionRate: 1, eligible: 0 });
    expect(
      report.actions.find((dimension) => dimension.dimension === "needs_reply")
    ).toMatchObject({ eligible: 1, precision: 1, recall: 1 });
  });

  it("counts categorical rule decisions without inventing calibration probabilities", () => {
    const rule = decisions(
      { key: "github", status: "accepted", topKey: "github" },
      { needsReply: "negative", toDo: "negative", urgent: "negative" }
    );
    rule.topic.confidence = null;
    rule.topic.probability = null;
    rule.urgent.probability = null;
    rule.needsReply.probability = null;
    rule.toDo.probability = null;
    const report = buildReport(
      [example("passive-event", "github")],
      [
        {
          decisions: rule,
          durationMs: 0,
          exampleId: "passive-event",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      ],
      OPTIONS
    );
    expect(report.topic).toMatchObject({ accepted: 1, accuracy: 1 });
    expect(report.actions.map((action) => action.falsePositives)).toStrictEqual([
      0, 0, 0,
    ]);
    expect(
      report.diagnostics.topicCalibration.reduce((sum, bin) => sum + bin.count, 0)
    ).toBe(0);
    expect(
      report.diagnostics.actionCalibration.every((item) =>
        item.bins.every((bin) => bin.count === 0)
      )
    ).toBeTruthy();
  });

  it("rejects development/held-out leakage across thread groups", () => {
    const development = {
      examples: [{ ...example("dev", "work"), threadId: "same-thread" }],
      split: "development",
      version: "dev-v1",
    };
    const heldOut = {
      examples: [{ ...example("held", "work"), threadId: "same-thread" }],
      split: "held_out",
      version: "held-v1",
    };
    expect(() => validateHeldOutSplit(development, heldOut)).toThrow("overlap");
    expect(() =>
      validateHeldOutSplit(development, {
        ...heldOut,
        examples: [{ ...example("held", "work"), threadId: "different-thread" }],
      })
    ).not.toThrow();
  });

  it("computes topic accuracy and coverage over eligible unambiguous examples", () => {
    const examples = [
      example("correct", "bills", { toDo: true }),
      example("wrong", "receipts"),
      example("uncertain", "work"),
      example("failed", "github"),
      example("ambiguous-topic", null, { topicAmbiguous: true }),
    ];
    const predictions: EvalPrediction[] = [
      {
        decisions: decisions(
          { key: "bills", status: "accepted", topKey: "bills" },
          { needsReply: "negative", toDo: "positive", urgent: "negative" }
        ),
        durationMs: 1000,
        exampleId: "correct",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        decisions: decisions(
          { key: "promotions", status: "accepted", topKey: "promotions" },
          { needsReply: "negative", toDo: "negative", urgent: "negative" }
        ),
        durationMs: 2000,
        exampleId: "wrong",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        decisions: decisions(
          { key: null, status: "uncertain", topKey: "work" },
          { needsReply: "negative", toDo: "negative", urgent: "negative" }
        ),
        durationMs: 3000,
        exampleId: "uncertain",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        decisions: null,
        durationMs: null,
        exampleId: "failed",
        failureReason: "provider_error",
        usage: null,
      },
      {
        decisions: decisions(
          { key: "other", status: "accepted", topKey: "other" },
          { needsReply: "negative", toDo: "negative", urgent: "negative" }
        ),
        durationMs: 1500,
        exampleId: "ambiguous-topic",
        usage: { input_tokens: 50, output_tokens: 5 },
      },
    ];

    const report = buildReport(examples, predictions, OPTIONS);

    expect(report.topic).toMatchObject({
      accepted: 2,
      accuracy: expect.closeTo(0.5),
      ambiguous: 1,
      correctAccepted: 1,
      coverage: expect.closeTo(0.5),
      eligible: 4,
      labelAssignmentCoverage: expect.closeTo(0.5),
      otherAccepted: 0,
    });
    expect(report.usage).toMatchObject({
      calls: 5,
      callsWithUnknownUsage: 1,
      estimatedCostUsd: expect.closeTo(350 * 0.000000042),
      inputTokens: 350,
    });
    expect(report.failures).toBe(1);
    expect(report.latency.medianMs).toBe(1750);
  });

  it("computes per-action precision, recall and uncertain counts", () => {
    const examples = [
      example("tp", "work", { needsReply: true, toDo: true, urgent: true }),
      example("fp", "work", { needsReply: false, toDo: false, urgent: false }),
      example("fn", "work", { needsReply: true, toDo: true, urgent: true }),
      example("uncertain-positive", "work", {
        needsReply: true,
        toDo: true,
        urgent: true,
      }),
      example("ambiguous-action", "work", { actionAmbiguous: true, urgent: null }),
    ];
    const predictions: EvalPrediction[] = [
      {
        decisions: decisions(
          { key: "work", status: "accepted", topKey: "work" },
          { needsReply: "positive", toDo: "positive", urgent: "positive" }
        ),
        durationMs: 10,
        exampleId: "tp",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      {
        decisions: decisions(
          { key: "work", status: "accepted", topKey: "work" },
          { needsReply: "positive", toDo: "positive", urgent: "positive" }
        ),
        durationMs: 20,
        exampleId: "fp",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      {
        decisions: decisions(
          { key: "work", status: "accepted", topKey: "work" },
          { needsReply: "negative", toDo: "negative", urgent: "negative" }
        ),
        durationMs: 30,
        exampleId: "fn",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      {
        decisions: decisions(
          { key: "work", status: "accepted", topKey: "work" },
          { needsReply: "uncertain", toDo: "uncertain", urgent: "uncertain" }
        ),
        durationMs: 40,
        exampleId: "uncertain-positive",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      {
        decisions: decisions(
          { key: "work", status: "accepted", topKey: "work" },
          { needsReply: "positive", toDo: "positive", urgent: "positive" }
        ),
        durationMs: 50,
        exampleId: "ambiguous-action",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    ];

    const report = buildReport(examples, predictions, OPTIONS);
    const urgent = report.actions.find((action) => action.dimension === "urgent");
    expect(urgent).toMatchObject({
      actualPositive: 3,
      ambiguous: 1,
      eligible: 4,
      falseNegatives: 2,
      falsePositives: 1,
      predictedPositive: 2,
      truePositives: 1,
      uncertain: 1,
      uncertainOnPositive: 1,
    });
    expect(urgent?.precision).toBeCloseTo(0.5);
    expect(urgent?.recall).toBeCloseTo(1 / 3);
  });

  it("returns undefined accuracy when nothing was accepted and fails coverage", () => {
    const examples = [example("a", "work")];
    const predictions: EvalPrediction[] = [
      {
        decisions: decisions(
          { key: null, status: "uncertain", topKey: "work" },
          { needsReply: "negative", toDo: "negative", urgent: "negative" }
        ),
        durationMs: 5,
        exampleId: "a",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    ];
    const report = buildReport(examples, predictions, OPTIONS);
    expect(report.topic.accuracy).toBeNull();
    expect(report.topic.coverage).toBe(0);
  });
});
