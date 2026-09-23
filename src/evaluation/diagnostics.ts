import type { DecisionSet } from "../classifier/policy";
import { ACTION_KEYS, TOPIC_KEYS } from "../taxonomy/labels";
import type { EvalExample, EvalPrediction, EvalReport } from "./report";

const dimensionDecision = (decisions: DecisionSet, dimension: string) => {
  if (dimension === "topic") {
    return decisions.topic;
  }
  if (dimension === "urgent") {
    return decisions.urgent;
  }
  if (dimension === "needs_reply") {
    return decisions.needsReply;
  }
  return decisions.toDo;
};

const topicOutcome = (decision: DecisionSet["topic"] | undefined) => {
  if (!decision) {
    return "failure";
  }
  return decision.status === "accepted" ? (decision.key ?? "abstain") : "abstain";
};

const actionOutcome = (status: string | undefined) => {
  if (status === "positive") {
    return true;
  }
  return status === "negative" ? false : null;
};

export const diagnostics = (examples: EvalExample[], predictions: EvalPrediction[]) => {
  const byId = new Map(
    predictions.map((prediction) => [prediction.exampleId, prediction])
  );
  const topicKeys = [...TOPIC_KEYS, "other"];
  const confusion: Record<string, Record<string, number>> = {};
  const mistakes: {
    exampleId: string;
    expected: unknown;
    actual: unknown;
    dimension: string;
  }[] = [];
  const bins = Array.from({ length: 10 }, (_, index) => ({
    correct: 0,
    count: 0,
    lower: index / 10,
    upper: (index + 1) / 10,
  }));
  const eligible = examples.filter(
    (example) =>
      !example.groundTruth.topic.ambiguous &&
      typeof example.groundTruth.topic.value === "string"
  );
  for (const example of eligible) {
    const truth = String(example.groundTruth.topic.value);
    const prediction = byId.get(example.id);
    const decision = prediction?.decisions?.topic;
    const actual = topicOutcome(decision);
    confusion[truth] ??= {};
    const row = confusion[truth];
    row[actual] = (row[actual] ?? 0) + 1;
    if (actual !== truth) {
      mistakes.push({
        actual,
        dimension: "topic",
        exampleId: example.id,
        expected: truth,
      });
    }
    if (decision && decision.probability !== null) {
      const bin = bins[Math.min(9, Math.floor(decision.probability * 10))];
      if (bin) {
        bin.count += 1;
        if (decision.topKey === truth) {
          bin.correct += 1;
        }
      }
    }
  }
  const perTopic = topicKeys.map((key) => {
    const row = confusion[key] ?? {};
    const total = Object.values(row).reduce((sum, value) => sum + value, 0);
    const abstentions = row.abstain ?? 0;
    const failures = row.failure ?? 0;
    const accepted = total - abstentions - failures;
    const correct = row[key] ?? 0;
    const predicted = Object.values(confusion).reduce(
      (sum, values) => sum + (values[key] ?? 0),
      0
    );
    const precision = predicted ? correct / predicted : null;
    const recall = total ? correct / total : null;
    const f1 = total || predicted ? (2 * correct) / (total + predicted) : null;
    return {
      abstentions,
      accepted,
      accuracy: accepted ? correct / accepted : null,
      correct,
      coverage: total ? accepted / total : 0,
      eligible: total,
      f1,
      failures,
      key,
      precision,
      recall,
    };
  });
  const dimensions = ["topic", ...ACTION_KEYS] as const;
  const annotations = dimensions.map((dimension) => {
    const ambiguous = examples.filter(
      (example) => example.groundTruth[dimension].ambiguous
    );
    const excluded = examples.filter(
      (example) =>
        example.groundTruth[dimension].ambiguous ||
        example.groundTruth[dimension].value === null
    ).length;
    const abstentions = ambiguous.filter((example) => {
      const decision = byId.get(example.id)?.decisions;
      if (!decision) {
        return false;
      }
      return dimensionDecision(decision, dimension).status === "uncertain";
    }).length;
    return {
      ambiguous: ambiguous.length,
      ambiguousAbstentionRate: ambiguous.length ? abstentions / ambiguous.length : null,
      ambiguousAbstentions: abstentions,
      dimension,
      eligible: examples.length - excluded,
      excluded,
      total: examples.length,
    };
  });
  const actionCalibration = ACTION_KEYS.map((dimension) => {
    const actionBins = Array.from({ length: 10 }, (_, index) => ({
      count: 0,
      lower: index / 10,
      positives: 0,
      upper: (index + 1) / 10,
    }));
    for (const example of examples) {
      const truth = example.groundTruth[dimension];
      const decisions = byId.get(example.id)?.decisions;
      if (truth.ambiguous || typeof truth.value !== "boolean") {
        continue;
      }
      const decision = decisions ? dimensionDecision(decisions, dimension) : null;
      const actual = actionOutcome(decision?.status);
      if (actual !== truth.value) {
        mistakes.push({
          actual,
          dimension,
          exampleId: example.id,
          expected: truth.value,
        });
      }
      if (!decision || decision.probability === null) {
        continue;
      }
      const bin = actionBins[Math.min(9, Math.floor(decision.probability * 10))];
      if (bin) {
        bin.count += 1;
        if (truth.value) {
          bin.positives += 1;
        }
      }
    }
    return {
      bins: actionBins.map((bin) => ({
        ...bin,
        observedPositiveRate: bin.count ? bin.positives / bin.count : null,
      })),
      dimension,
    };
  });
  const f1s = perTopic.flatMap((topic) => (topic.f1 === null ? [] : [topic.f1]));
  return {
    actionCalibration,
    annotations,
    confusion,
    endToEndCorrectDecisionRate: eligible.length
      ? perTopic.reduce((sum, topic) => sum + topic.correct, 0) / eligible.length
      : 0,
    macroF1: f1s.length ? f1s.reduce((sum, f1) => sum + f1, 0) / f1s.length : null,
    mistakes: mistakes.slice(0, 100),
    perTopic,
    topicCalibration: bins.map((bin) => ({
      ...bin,
      accuracy: bin.count ? bin.correct / bin.count : null,
    })),
  };
};

export const releaseGates = (
  report: EvalReport,
  minimumPerTopic = 10,
  minimumActionPositives = 20
) => {
  const failures: string[] = [];
  const unverified: string[] = [];
  if (report.provenance.split !== "held_out") {
    unverified.push("held_out_split");
  }
  if ((report.topic.accuracy ?? 0) < 0.9) {
    failures.push("topic_accuracy");
  }
  if (report.topic.coverage < 0.8) {
    failures.push("topic_coverage");
  }
  for (const topic of report.diagnostics.perTopic) {
    if (topic.eligible < minimumPerTopic || topic.accepted === 0) {
      unverified.push(`topic:${topic.key}`);
    }
  }
  for (const action of report.actions) {
    if (
      action.predictedPositive < minimumActionPositives ||
      action.actualPositive < minimumActionPositives
    ) {
      unverified.push(`action:${action.dimension}`);
    }
    if (action.precision === null) {
      unverified.push(`precision:${action.dimension}`);
    } else if (action.precision < (action.dimension === "urgent" ? 0.95 : 0.9)) {
      failures.push(`precision:${action.dimension}`);
    }
  }
  return {
    failures,
    passed: failures.length === 0 && unverified.length === 0,
    unverified,
  };
};
