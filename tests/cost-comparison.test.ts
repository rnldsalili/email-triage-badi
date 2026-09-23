import { describe, expect, it } from "vitest";

import type { ClassificationOutcome } from "../src/classifier/jev";
import { decide } from "../src/classifier/policy";
import type { ValidatedAnswers } from "../src/classifier/schemas";
import {
  costComparisonDatasetSchema,
  runCostComparison,
} from "../src/evaluation/cost-comparison";

const answers: ValidatedAnswers = {
  needsReply: { noul: 0, type: "noul" },
  toDo: { noul: 0, type: "noul" },
  topic: {
    choice: "github",
    confidence: 0.99,
    probabilities: { github: 1 },
    type: "choice",
  },
  urgent: { noul: 0, type: "noul" },
};

const dataset = (count = 2) =>
  costComparisonDatasetSchema.parse({
    examples: Array.from({ length: count }, (_, index) => ({
      id: `example-${String(index + 1).padStart(3, "0")}`,
      message: {
        id: `gmail-${index}`,
        payload: {
          body: { data: btoa("Completed event") },
          headers: [{ name: "Subject", value: "Completed event" }],
          mimeType: "text/plain",
        },
        threadId: `thread-${index}`,
      },
      stratum: index === 0 ? "github" : "other",
    })),
    gatewayId: "local-gateway",
    owner: {
      accountEmail: "owner@example.test",
      aliases: [],
      employerDomains: [],
      timeZone: "UTC",
    },
    sampledAt: "2026-09-20T12:00:00.000Z",
    sampling: {
      githubHasMore: false,
      otherHasMore: false,
      requestedGithub: 60,
      requestedOther: 20,
      stoppedReason: null,
    },
    version: "mailbox-cost-observation-v1",
  });

const outcome = (
  input: number,
  route: "jev" | "rule" = "jev"
): ClassificationOutcome => ({
  answers:
    route === "rule"
      ? { event: "merged", ruleId: "github-passive-v1", type: "rule" }
      : answers,
  decisions: decide(answers, { bodyMissing: false }),
  durationMs: 1,
  modelVersion: route === "rule" ? "rule:github-passive-v1" : "jev-1.13.0",
  normalizedInputHash: "hash",
  policyVersion: "policy-v1",
  rubricVersion: route === "rule" ? "github-passive-v1" : "rubric-v1",
  taxonomyVersion: "taxonomy-v1",
  usage: { input_tokens: input, output_tokens: route === "rule" ? 0 : 10 },
});

const BUDGET = { maxCalls: 300, maxEstimatedUsd: 0.25 };

describe("private cost comparison", () => {
  it("pairs identical contexts sequentially and attributes rule versus prompt savings", async () => {
    const input = dataset();
    const invocations: { arm: string; id: string; normalized: unknown; now: number }[] =
      [];
    const report = await runCostComparison(input, {
      ...BUDGET,
      classify: (arm, example, normalized, now, onProviderCall) => {
        invocations.push({ arm, id: example.id, normalized, now });
        if (arm === "candidate" && example.id === "example-001") {
          return Promise.resolve(outcome(0, "rule"));
        }
        onProviderCall();
        return Promise.resolve(outcome(arm === "baseline" ? 1000 : 800));
      },
    });
    expect(invocations.map(({ arm, id }) => `${id}:${arm}`)).toStrictEqual([
      "example-001:baseline",
      "example-001:candidate",
      "example-002:candidate",
      "example-002:baseline",
    ]);
    expect([
      invocations[0]?.normalized === invocations[1]?.normalized,
      invocations[2]?.normalized === invocations[3]?.normalized,
      ...invocations.map(({ now }) => now === Date.parse(input.sampledAt)),
    ]).toStrictEqual([true, true, true, true, true, true]);
    expect(report).toMatchObject({
      agreement: { comparablePairs: 2 },
      avoidedRuleInputTokens: 1000,
      baseline: { attempts: 2 },
      byStratum: {
        github: { avoidedRuleInputTokens: 1000 },
        other: { fallbackInputTokenDelta: -200 },
      },
      candidate: { attempts: 1 },
      fallbackInputTokenDelta: -200,
      qualityValidated: false,
      ruleMatches: 1,
    });
    expect(report.combinedCostDeltaUsd).toBeCloseTo(-1200 * 0.000000042);
  });

  it("keeps known cost but marks total and agreement unknown after provider failure", async () => {
    const report = await runCostComparison(dataset(1), {
      ...BUDGET,
      classify: (arm, _example, _normalized, _now, onProviderCall) => {
        onProviderCall();
        if (arm === "candidate") {
          return Promise.reject(new Error("sensitive provider response"));
        }
        return Promise.resolve(outcome(1000));
      },
    });
    expect(report).toMatchObject({
      agreement: { excludedFailedPairs: 1 },
      baseline: { knownCostUsd: 0.000042 },
      candidate: { estimatedCostUsd: null, unknownUsageAttempts: 1 },
      combinedCostDeltaUsd: null,
      examples: [
        {
          candidate: {
            attemptedCalls: 1,
            failureCode: "provider_error",
            knownCostUsd: null,
            route: "provider_error",
          },
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("sensitive provider response");
  });

  it("does not reserve a call for local preflight failures", async () => {
    const report = await runCostComparison(dataset(1), {
      ...BUDGET,
      classify: (arm, _example, _normalized, _now, onProviderCall) => {
        if (arm === "baseline") {
          return Promise.reject(new Error("local validation failed"));
        }
        onProviderCall();
        return Promise.resolve(outcome(900));
      },
    });
    expect(report).toMatchObject({
      baseline: { attempts: 0, estimatedCostUsd: 0, failures: 1 },
      candidate: { attempts: 1 },
      examples: [{ baseline: { route: "preflight_error" } }],
    });
  });

  it("rejects insufficient reservation budgets before invoking a classifier", async () => {
    let calls = 0;
    const classify = (): Promise<ClassificationOutcome> => {
      calls += 1;
      return Promise.resolve(outcome(100));
    };
    await expect(
      runCostComparison(dataset(2), { ...BUDGET, classify, maxCalls: 3 })
    ).rejects.toThrow("cost_comparison_budget_invalid");
    await expect(
      runCostComparison(dataset(2), { ...BUDGET, classify, maxEstimatedUsd: 0.005 })
    ).rejects.toThrow("cost_comparison_budget_invalid");
    expect(calls).toBe(0);
  });

  it("rejects empty or duplicate-ID observations before dispatch", async () => {
    const classify = (): Promise<ClassificationOutcome> => Promise.resolve(outcome(100));
    await expect(
      runCostComparison({ ...dataset(1), examples: [] }, { ...BUDGET, classify })
    ).rejects.toBeInstanceOf(Error);
    const input = dataset(2);
    input.examples = input.examples.map((example) => ({
      ...example,
      id: "example-001",
    }));
    await expect(
      runCostComparison(input, { ...BUDGET, classify })
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects oversized and invalid observation contexts before dispatch", async () => {
    let calls = 0;
    const classify = (): Promise<ClassificationOutcome> => {
      calls += 1;
      return Promise.resolve(outcome(100));
    };
    const input = dataset(1);
    const overLimit = Array.from({ length: 81 }, (_, index) => ({
      ...input.examples[0],
      id: `example-${String(index + 1).padStart(3, "0")}`,
    }));
    expect(
      costComparisonDatasetSchema.safeParse({ ...input, examples: overLimit }).success
    ).toBeFalsy();
    const wrongOwner = {
      ...input,
      owner: { ...input.owner, accountEmail: "invalid" },
    };
    await expect(
      runCostComparison(wrongOwner, { ...BUDGET, classify })
    ).rejects.toBeInstanceOf(Error);
    await expect(
      runCostComparison({ ...input, sampledAt: "tomorrow" }, { ...BUDGET, classify })
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });

  it("rejects disallowed call and dollar ceilings before dispatch", async () => {
    let calls = 0;
    const classify = (): Promise<ClassificationOutcome> => {
      calls += 1;
      return Promise.resolve(outcome(100));
    };
    const input = dataset(1);
    await expect(
      runCostComparison(input, { ...BUDGET, classify, maxCalls: 301 })
    ).rejects.toThrow("cost_comparison_budget_invalid");
    await expect(
      runCostComparison(input, { ...BUDGET, classify, maxEstimatedUsd: 0.251 })
    ).rejects.toThrow("cost_comparison_budget_invalid");
    expect(calls).toBe(0);
  });
});
