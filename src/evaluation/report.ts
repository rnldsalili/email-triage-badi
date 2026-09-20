import type { DecisionSet } from "../classifier/policy";
import { POLICY_VERSION, RUBRIC_VERSION, TAXONOMY_VERSION } from "../config/versions";
import type { ActionKey } from "../taxonomy/labels";
import { diagnostics } from "./diagnostics";

export interface DimensionAnnotation {
  value: string | boolean | null;
  ambiguous: boolean;
}

export interface EvalExample {
  id: string;
  subject: string;
  from?: string;
  body: string;
  groundTruth: {
    topic: DimensionAnnotation;
    urgent: DimensionAnnotation;
    needs_reply: DimensionAnnotation;
    to_do: DimensionAnnotation;
  };
}

export interface EvalPrediction {
  exampleId: string;
  decisions: DecisionSet | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  durationMs: number | null;
  failureReason?: string;
  modelVersion?: string;
  attemptedCalls?: number;
}

export interface ActionMetrics {
  dimension: ActionKey;
  eligible: number;
  ambiguous: number;
  predictedPositive: number;
  actualPositive: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  uncertainOnPositive: number;
  uncertain: number;
  precision: number | null;
  recall: number | null;
}

export interface EvalReport {
  provenance: {
    timestamp: string;
    datasetHash: string | null;
    split: string;
    modelVersions: string[];
    policyVersion: string;
    rubricVersion: string;
    taxonomyVersion: string;
  };
  diagnostics: ReturnType<typeof diagnostics>;
  datasetVersion: string;
  examples: number;
  failures: number;
  topic: {
    eligible: number;
    ambiguous: number;
    accepted: number;
    correctAccepted: number;
    accuracy: number | null;
    coverage: number;
    otherAccepted: number;
    labelAssignmentCoverage: number;
    uncertain: number;
  };
  actions: ActionMetrics[];
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    callsWithUnknownUsage: number;
  };
  latency: {
    medianMs: number | null;
    p95Ms: number | null;
  };
}

export interface ReportOptions {
  datasetVersion: string;
  inputTokenCostUsd: number;
  datasetHash?: string;
  split?: string;
  timestamp?: string;
}

const ACTION_DIMENSIONS: ActionKey[] = ["urgent", "needs_reply", "to_do"];

const percentile = (sorted: number[], fraction: number): number | null => {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? null;
};

const median = (sorted: number[]): number | null => {
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return (lower + upper) / 2;
};

export const buildReport = (
  examples: EvalExample[],
  predictions: EvalPrediction[],
  options: ReportOptions
): EvalReport => {
  const byId = new Map(
    predictions.map((prediction) => [prediction.exampleId, prediction])
  );
  const failures = examples.filter((example) => !byId.get(example.id)?.decisions).length;

  const topicEligible = examples.filter(
    (example) =>
      !example.groundTruth.topic.ambiguous && example.groundTruth.topic.value !== null
  );
  const topicAmbiguous = examples.filter(
    (example) => example.groundTruth.topic.ambiguous
  ).length;

  let accepted = 0;
  let correctAccepted = 0;
  let otherAccepted = 0;
  let namedAccepted = 0;

  for (const example of topicEligible) {
    const prediction = byId.get(example.id);
    const decision = prediction?.decisions?.topic;
    if (decision?.status !== "accepted" || decision.key === null) {
      continue;
    }
    accepted += 1;
    if (decision.key === example.groundTruth.topic.value) {
      correctAccepted += 1;
    }
    if (decision.key === "other") {
      otherAccepted += 1;
    } else {
      namedAccepted += 1;
    }
  }

  const actions: ActionMetrics[] = ACTION_DIMENSIONS.map((dimension) => {
    const eligibleExamples = examples.filter(
      (example) =>
        !example.groundTruth[dimension].ambiguous &&
        typeof example.groundTruth[dimension].value === "boolean"
    );
    const ambiguous = examples.filter(
      (example) => example.groundTruth[dimension].ambiguous
    ).length;

    let predictedPositive = 0;
    let actualPositive = 0;
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let uncertainOnPositive = 0;
    let uncertain = 0;

    for (const example of eligibleExamples) {
      const annotation = example.groundTruth[dimension].value as boolean;
      const prediction = byId.get(example.id);
      const actionDecisions = prediction?.decisions;
      const decision = actionDecisions
        ? {
            needs_reply: actionDecisions.needsReply,
            to_do: actionDecisions.toDo,
            urgent: actionDecisions.urgent,
          }[dimension]
        : null;

      if (annotation) {
        actualPositive += 1;
      }
      if (!decision) {
        if (annotation) {
          falseNegatives += 1;
        }
        continue;
      }
      if (decision.status === "uncertain") {
        uncertain += 1;
        if (annotation) {
          uncertainOnPositive += 1;
          falseNegatives += 1;
        }
        continue;
      }
      if (decision.status === "positive") {
        predictedPositive += 1;
        if (annotation) {
          truePositives += 1;
        } else {
          falsePositives += 1;
        }
      } else if (annotation) {
        falseNegatives += 1;
      }
    }

    return {
      actualPositive,
      ambiguous,
      dimension,
      eligible: eligibleExamples.length,
      falseNegatives,
      falsePositives,
      precision: predictedPositive > 0 ? truePositives / predictedPositive : null,
      predictedPositive,
      recall: actualPositive > 0 ? truePositives / actualPositive : null,
      truePositives,
      uncertain,
      uncertainOnPositive,
    };
  });

  const successful = predictions.filter((prediction) => prediction.decisions);
  const inputTokens = predictions.reduce(
    (total, prediction) => total + (prediction.usage?.input_tokens ?? 0),
    0
  );
  const outputTokens = predictions.reduce(
    (total, prediction) => total + (prediction.usage?.output_tokens ?? 0),
    0
  );
  const durations = successful
    .map((prediction) => prediction.durationMs)
    .filter((duration): duration is number => duration !== null)
    .toSorted((left, right) => left - right);

  return {
    actions,
    datasetVersion: options.datasetVersion,
    diagnostics: diagnostics(examples, predictions),
    examples: examples.length,
    failures,
    latency: {
      medianMs: median(durations),
      p95Ms: percentile(durations, 0.95),
    },
    provenance: {
      datasetHash: options.datasetHash ?? null,
      modelVersions: [
        ...new Set(
          predictions.flatMap((prediction) =>
            prediction.modelVersion ? [prediction.modelVersion] : []
          )
        ),
      ],
      policyVersion: POLICY_VERSION,
      rubricVersion: RUBRIC_VERSION,
      split: options.split ?? "synthetic",
      taxonomyVersion: TAXONOMY_VERSION,
      timestamp: options.timestamp ?? new Date().toISOString(),
    },
    topic: {
      accepted,
      accuracy: accepted > 0 ? correctAccepted / accepted : null,
      ambiguous: topicAmbiguous,
      correctAccepted,
      coverage: topicEligible.length > 0 ? accepted / topicEligible.length : 0,
      eligible: topicEligible.length,
      labelAssignmentCoverage:
        topicEligible.length > 0 ? namedAccepted / topicEligible.length : 0,
      otherAccepted,
      uncertain: topicEligible.length - accepted,
    },
    usage: {
      calls: predictions.reduce(
        (sum, prediction) => sum + (prediction.attemptedCalls ?? 1),
        0
      ),
      callsWithUnknownUsage: predictions.filter((prediction) => !prediction.usage).length,
      estimatedCostUsd: inputTokens * options.inputTokenCostUsd,
      inputTokens,
      outputTokens,
    },
  };
};
