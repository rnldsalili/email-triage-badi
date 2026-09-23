import { z } from "zod";

import type { ClassificationOutcome } from "../classifier/jev";
import { normalizeMessage } from "../email/normalize";
import type { NormalizedEmail } from "../email/normalize";
import { gmailMessageSchema } from "../gmail/types";
import { sha256Hex } from "../utils/crypto";

const INPUT_USD_PER_TOKEN = 0.000000042;
const FUNDING_MULTIPLIER = 1.05;
const RESERVED_USD_PER_CALL = 32_000 * INPUT_USD_PER_TOKEN * FUNDING_MULTIPLIER;
const MAX_EXAMPLES = 80;
const MAX_CALLS = 300;
const MAX_USD = 0.25;

const ownerSchema = z.object({
  accountEmail: z.email(),
  aliases: z.array(z.email()),
  employerDomains: z.array(z.string()),
  timeZone: z
    .string()
    .min(1)
    .refine((zone) => {
      try {
        return Boolean(
          new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone
        );
      } catch {
        return false;
      }
    }),
});

export const costComparisonDatasetSchema = z
  .object({
    examples: z
      .array(
        z
          .object({
            id: z.string().regex(/^example-\d{3}$/u),
            stratum: z.enum(["github", "other"]),
          })
          .extend({ message: gmailMessageSchema })
      )
      .min(1)
      .max(MAX_EXAMPLES),
    gatewayId: z.string().min(1),
    owner: ownerSchema,
    sampledAt: z.iso
      .datetime({ offset: true })
      .refine((value) => Number.isFinite(Date.parse(value))),
    sampling: z
      .object({
        requestedGithub: z.literal(60),
        requestedOther: z.literal(20),
      })
      .extend({
        githubHasMore: z.boolean(),
        otherHasMore: z.boolean(),
      })
      .extend({
        stoppedReason: z.enum(["rate_limited", "auth_failure"]).nullable(),
      })
      .extend({
        skippedErrors: z
          .partialRecord(
            z.enum([
              "not_found",
              "server_error",
              "network_error",
              "invalid_response",
              "invalid_request",
              "unknown_error",
              "dataset_size_limit",
            ]),
            z.number().int().nonnegative()
          )
          .default({}),
      }),
    version: z.literal("mailbox-cost-observation-v1"),
  })
  .superRefine((dataset, ctx) => {
    if (
      new Set(dataset.examples.map((example) => example.id)).size !==
      dataset.examples.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate example ID",
        path: ["examples"],
      });
    }
  });

export type CostComparisonDataset = z.infer<typeof costComparisonDatasetSchema>;
export type CostComparisonExample = CostComparisonDataset["examples"][number];

export interface CostComparisonSettings {
  dataset: unknown;
  maxCalls: number;
  maxEstimatedUsd: number;
}

type Arm = "baseline" | "candidate";
type Stratum = CostComparisonExample["stratum"];
type Dimension = "topic" | "urgent" | "needs_reply" | "to_do";
type Route = "jev" | "rule" | "preflight_error" | "provider_error";

interface ArmExample {
  route: Route;
  attemptedCalls: 0 | 1;
  inputTokens: number | null;
  outputTokens: number | null;
  knownCostUsd: number | null;
  topicKey: string | null;
  topicStatus: string | null;
  urgent: string | null;
  needs_reply: string | null;
  to_do: string | null;
  modelVersion: string | null;
  rubricVersion: string | null;
  failureCode: "preflight_error" | "provider_error" | "budget_exhausted" | null;
}

interface ExampleReport {
  id: string;
  stratum: Stratum;
  baseline: ArmExample;
  candidate: ArmExample;
}

interface ArmSummary {
  attempts: number;
  successes: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  unknownUsageAttempts: number;
  knownCostUsd: number;
  estimatedCostUsd: number | null;
  estimatedFundedCostUsd: number | null;
  modelVersions: string[];
  rubricVersions: string[];
}

interface Agreement {
  topic: number;
  urgent: number;
  needs_reply: number;
  to_do: number;
  comparablePairs: number;
  excludedFailedPairs: number;
}

interface ComparisonSummary {
  baseline: ArmSummary;
  candidate: ArmSummary;
  ruleMatches: number;
  avoidedRuleInputTokens: number | null;
  fallbackInputTokenDelta: number | null;
  combinedCostDeltaUsd: number | null;
  combinedCostReduction: number | null;
  agreement: Agreement;
  disagreements: { exampleId: string; dimensions: Dimension[] }[];
}

export interface CostComparisonReport extends ComparisonSummary {
  datasetHash: string;
  sampledAt: string;
  sampling: CostComparisonDataset["sampling"];
  qualityValidated: false;
  sampleCounts: { github: number; other: number };
  byStratum: Record<Stratum, ComparisonSummary & { sampleCount: number }>;
  examples: ExampleReport[];
  processedExamples: number;
  stoppedReason: "actual_usage_exceeded_reservation" | "budget_exhausted" | null;
}

const emptyResult = (
  route: "preflight_error" | "provider_error",
  attemptedCalls: 0 | 1,
  failureCode: ArmExample["failureCode"]
): ArmExample => ({
  attemptedCalls,
  failureCode,
  inputTokens: null,
  knownCostUsd: attemptedCalls === 0 ? 0 : null,
  modelVersion: null,
  needs_reply: null,
  outputTokens: null,
  route,
  rubricVersion: null,
  to_do: null,
  topicKey: null,
  topicStatus: null,
  urgent: null,
});

const safeVersion = (version: string): string =>
  /^[A-Za-z0-9._:/-]{1,100}$/u.test(version) ? version : "unrecognized";

const successfulResult = (
  outcome: ClassificationOutcome,
  attemptedCalls: 0 | 1
): ArmExample => {
  const { decisions, usage } = outcome;
  const validUsage =
    Number.isSafeInteger(usage.input_tokens) &&
    usage.input_tokens >= 0 &&
    Number.isSafeInteger(usage.output_tokens) &&
    usage.output_tokens >= 0;
  return {
    attemptedCalls,
    failureCode: null,
    inputTokens: validUsage ? usage.input_tokens : null,
    knownCostUsd: validUsage ? usage.input_tokens * INPUT_USD_PER_TOKEN : null,
    modelVersion: safeVersion(outcome.modelVersion),
    needs_reply: decisions.needsReply.status,
    outputTokens: validUsage ? usage.output_tokens : null,
    route: "type" in outcome.answers && outcome.answers.type === "rule" ? "rule" : "jev",
    rubricVersion: safeVersion(outcome.rubricVersion),
    to_do: decisions.toDo.status,
    topicKey: decisions.topic.key,
    topicStatus: decisions.topic.status,
    urgent: decisions.urgent.status,
  };
};

const summarizeArm = (examples: ExampleReport[], arm: Arm): ArmSummary => {
  const values = examples.map((example) => example[arm]);
  const cost = values.reduce((sum, value) => sum + (value.knownCostUsd ?? 0), 0);
  const complete = values.every((value) => value.knownCostUsd !== null);
  return {
    attempts: values.reduce((sum, value) => sum + value.attemptedCalls, 0),
    estimatedCostUsd: complete ? cost : null,
    estimatedFundedCostUsd: complete ? cost * FUNDING_MULTIPLIER : null,
    failures: values.filter((value) => value.failureCode !== null).length,
    inputTokens: values.reduce((sum, value) => sum + (value.inputTokens ?? 0), 0),
    knownCostUsd: cost,
    modelVersions: [
      ...new Set(
        values
          .map((value) => value.modelVersion)
          .filter((value): value is string => value !== null)
      ),
    ].toSorted(),
    outputTokens: values.reduce((sum, value) => sum + (value.outputTokens ?? 0), 0),
    rubricVersions: [
      ...new Set(
        values
          .map((value) => value.rubricVersion)
          .filter((value): value is string => value !== null)
      ),
    ].toSorted(),
    successes: values.filter((value) => value.failureCode === null).length,
    unknownUsageAttempts: values.filter(
      (value) => value.attemptedCalls === 1 && value.inputTokens === null
    ).length,
  };
};

const tokenDelta = (
  previous: number | null,
  before: number | null,
  after: number | null
): number | null => {
  if (previous === null || before === null || after === null) {
    return null;
  }
  return previous + after - before;
};

const summarizeDecisions = (
  examples: ExampleReport[]
): Pick<ComparisonSummary, "agreement" | "disagreements"> => {
  const agreement: Agreement = {
    comparablePairs: 0,
    excludedFailedPairs: 0,
    needs_reply: 0,
    to_do: 0,
    topic: 0,
    urgent: 0,
  };
  const disagreements: ComparisonSummary["disagreements"] = [];
  for (const example of examples) {
    const { baseline, candidate } = example;
    if (baseline.topicStatus === null || candidate.topicStatus === null) {
      agreement.excludedFailedPairs += 1;
      continue;
    }
    agreement.comparablePairs += 1;
    const dimensions: Dimension[] = [];
    if (
      baseline.topicStatus === candidate.topicStatus &&
      baseline.topicKey === candidate.topicKey
    ) {
      agreement.topic += 1;
    } else {
      dimensions.push("topic");
    }
    for (const dimension of ["urgent", "needs_reply", "to_do"] as const) {
      if (baseline[dimension] === candidate[dimension]) {
        agreement[dimension] += 1;
      } else {
        dimensions.push(dimension);
      }
    }
    if (dimensions.length > 0) {
      disagreements.push({ dimensions, exampleId: example.id });
    }
  }
  return { agreement, disagreements };
};

const summarize = (examples: ExampleReport[]): ComparisonSummary => {
  const baseline = summarizeArm(examples, "baseline");
  const candidate = summarizeArm(examples, "candidate");
  let avoidedRuleInputTokens: number | null = 0;
  let fallbackInputTokenDelta: number | null = 0;
  let ruleMatches = 0;
  for (const example of examples) {
    if (example.candidate.route === "rule") {
      ruleMatches += 1;
      avoidedRuleInputTokens = tokenDelta(
        avoidedRuleInputTokens,
        0,
        example.baseline.inputTokens
      );
    } else {
      fallbackInputTokenDelta = tokenDelta(
        fallbackInputTokenDelta,
        example.baseline.inputTokens,
        example.candidate.inputTokens
      );
    }
  }
  let combinedCostDeltaUsd: number | null = null;
  let combinedCostReduction: number | null = null;
  if (
    baseline.estimatedCostUsd !== null &&
    candidate.estimatedCostUsd !== null &&
    baseline.failures === 0 &&
    candidate.failures === 0
  ) {
    combinedCostDeltaUsd = candidate.estimatedCostUsd - baseline.estimatedCostUsd;
    if (baseline.estimatedCostUsd > 0) {
      combinedCostReduction = 1 - candidate.estimatedCostUsd / baseline.estimatedCostUsd;
    }
  }
  return {
    ...summarizeDecisions(examples),
    avoidedRuleInputTokens,
    baseline,
    candidate,
    combinedCostDeltaUsd,
    combinedCostReduction,
    fallbackInputTokenDelta,
    ruleMatches,
  };
};

type Classify = (
  arm: Arm,
  example: CostComparisonExample,
  normalized: NormalizedEmail,
  now: number,
  onProviderCall: () => void
) => Promise<ClassificationOutcome>;

interface ComparisonOptions {
  classify: Classify;
  maxCalls: number;
  maxEstimatedUsd: number;
}

type StoppedReason = CostComparisonReport["stoppedReason"];

interface BudgetState {
  actualFundedUsd: number;
  attempts: number;
  reservedUsd: number;
  stoppedReason: StoppedReason;
}

const validateBudget = (
  examples: number,
  { maxCalls, maxEstimatedUsd }: ComparisonOptions
): void => {
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls <= 0 ||
    maxCalls > MAX_CALLS ||
    !Number.isFinite(maxEstimatedUsd) ||
    maxEstimatedUsd <= 0 ||
    maxEstimatedUsd > MAX_USD ||
    maxCalls < examples * 2 ||
    maxEstimatedUsd + Number.EPSILON < examples * 2 * RESERVED_USD_PER_CALL
  ) {
    throw new Error("cost_comparison_budget_invalid");
  }
};

const reserveProviderCall = (state: BudgetState, options: ComparisonOptions): void => {
  if (
    state.attempts >= options.maxCalls ||
    state.reservedUsd + RESERVED_USD_PER_CALL >
      options.maxEstimatedUsd + Number.EPSILON ||
    state.actualFundedUsd > options.maxEstimatedUsd
  ) {
    state.stoppedReason = "budget_exhausted";
    throw new Error("cost_comparison_budget_exhausted");
  }
  state.attempts += 1;
  state.reservedUsd += RESERVED_USD_PER_CALL;
};

const isAuthOrBillingFailure = (error: unknown): boolean => {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? error.status
      : null;
  if (status === 401 || status === 402 || status === 403) {
    return true;
  }
  return (
    error instanceof Error &&
    /(?:^|\W)(?:401|402|403|payment.required|insufficient.credits|billing|authentication|unauthorized|forbidden)(?:\W|$)/iu.test(
      `${error.name} ${error.message}`
    )
  );
};

const accountForActualUsage = (
  value: ArmExample,
  state: BudgetState,
  options: ComparisonOptions
): void => {
  if (value.inputTokens === null || value.knownCostUsd === null) {
    return;
  }
  state.actualFundedUsd += value.knownCostUsd * FUNDING_MULTIPLIER;
  if (
    value.inputTokens > 32_000 ||
    state.actualFundedUsd > state.reservedUsd + Number.EPSILON ||
    state.actualFundedUsd > options.maxEstimatedUsd + Number.EPSILON
  ) {
    state.stoppedReason = "actual_usage_exceeded_reservation";
  }
};

const classifyArm = async (
  arm: Arm,
  example: CostComparisonExample,
  normalized: NormalizedEmail,
  now: number,
  options: ComparisonOptions,
  state: BudgetState
): Promise<ArmExample> => {
  if (state.stoppedReason !== null) {
    return emptyResult("preflight_error", 0, "budget_exhausted");
  }
  let entered = false;
  const onProviderCall = () => {
    if (entered) {
      throw new Error("duplicate_provider_entry");
    }
    reserveProviderCall(state, options);
    entered = true;
  };
  try {
    const outcome = await options.classify(arm, example, normalized, now, onProviderCall);
    const value = successfulResult(outcome, entered ? 1 : 0);
    if (
      (arm === "baseline" && value.route !== "jev") ||
      (value.route === "jev" && !entered) ||
      (value.route === "rule" &&
        (entered || value.inputTokens !== 0 || value.outputTokens !== 0))
    ) {
      throw new Error("cost_comparison_contract_violation");
    }
    if (entered) {
      accountForActualUsage(value, state, options);
    }
    return value;
  } catch (error) {
    if (entered && isAuthOrBillingFailure(error)) {
      throw new Error("cost_comparison_provider_auth_or_billing_failure", {
        cause: error,
      });
    }
    if (state.stoppedReason !== null) {
      return emptyResult("preflight_error", 0, "budget_exhausted");
    }
    if (entered) {
      return emptyResult("provider_error", 1, "provider_error");
    }
    return emptyResult("preflight_error", 0, "preflight_error");
  }
};

const classifyPair = async (
  example: CostComparisonExample,
  index: number,
  normalized: NormalizedEmail,
  now: number,
  options: ComparisonOptions,
  state: BudgetState
): Promise<ExampleReport> => {
  const first: Arm = index % 2 === 0 ? "baseline" : "candidate";
  const second: Arm = first === "baseline" ? "candidate" : "baseline";
  const firstResult = await classifyArm(first, example, normalized, now, options, state);
  const secondResult = await classifyArm(
    second,
    example,
    normalized,
    now,
    options,
    state
  );
  const baseline = first === "baseline" ? firstResult : secondResult;
  const candidate = first === "candidate" ? firstResult : secondResult;
  return { baseline, candidate, id: example.id, stratum: example.stratum };
};

const processExamples = async (
  dataset: CostComparisonDataset,
  now: number,
  options: ComparisonOptions,
  state: BudgetState,
  results: ExampleReport[],
  index: number
): Promise<void> => {
  const example = dataset.examples[index];
  if (!example) {
    return;
  }
  let normalized: NormalizedEmail;
  try {
    normalized = await normalizeMessage(example.message, {
      maxBodyCharacters: 12_000,
    });
  } catch {
    const failure = emptyResult("preflight_error", 0, "preflight_error");
    results.push({
      baseline: failure,
      candidate: failure,
      id: example.id,
      stratum: example.stratum,
    });
    await processExamples(dataset, now, options, state, results, index + 1);
    return;
  }
  results.push(await classifyPair(example, index, normalized, now, options, state));
  if (state.stoppedReason === null) {
    await processExamples(dataset, now, options, state, results, index + 1);
  }
};

/** Samples are intentionally enriched and unlabeled: agreement is not an accuracy claim. */
export const runCostComparison = async (
  datasetInput: CostComparisonDataset,
  options: ComparisonOptions
): Promise<CostComparisonReport> => {
  const dataset = costComparisonDatasetSchema.parse(datasetInput);
  validateBudget(dataset.examples.length, options);
  const results: ExampleReport[] = [];
  const state: BudgetState = {
    actualFundedUsd: 0,
    attempts: 0,
    reservedUsd: 0,
    stoppedReason: null,
  };
  await processExamples(
    dataset,
    Date.parse(dataset.sampledAt),
    options,
    state,
    results,
    0
  );
  const sampleCounts = {
    github: dataset.examples.filter((example) => example.stratum === "github").length,
    other: dataset.examples.filter((example) => example.stratum === "other").length,
  };
  return {
    ...summarize(results),
    byStratum: {
      github: {
        ...summarize(results.filter((example) => example.stratum === "github")),
        sampleCount: sampleCounts.github,
      },
      other: {
        ...summarize(results.filter((example) => example.stratum === "other")),
        sampleCount: sampleCounts.other,
      },
    },
    datasetHash: await sha256Hex(JSON.stringify(dataset)),
    examples: results,
    processedExamples: results.length,
    qualityValidated: false,
    sampleCounts,
    sampledAt: dataset.sampledAt,
    sampling: dataset.sampling,
    stoppedReason: state.stoppedReason,
  };
};
