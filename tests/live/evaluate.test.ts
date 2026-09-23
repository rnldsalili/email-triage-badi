import { env } from "cloudflare:workers";
import { describe, expect, it, inject } from "vitest";

import { classifyMessage } from "../../src/classifier/jev";
import { normalizeMessage } from "../../src/email/normalize";
import { datasetSchema } from "../../src/evaluation/dataset";
import { releaseGates } from "../../src/evaluation/diagnostics";
import { buildReport } from "../../src/evaluation/report";
import type { EvalExample, EvalPrediction } from "../../src/evaluation/report";
import type { GmailMessage } from "../../src/gmail/types";
import { sha256Hex } from "../../src/utils/crypto";
import { testConfig } from "../helpers/config";

const INPUT_TOKEN_COST_USD = 0.000000042;

const messageFromExample = (example: EvalExample): GmailMessage => {
  const headers = [
    { name: "Subject", value: example.subject },
    ...(example.from ? [{ name: "From", value: example.from }] : []),
    { name: "To", value: "owner@example.test" },
  ];
  return {
    id: `eval-${example.id}`,
    internalDate: String(Date.UTC(2026, 8, 18, 9, 0, 0)),
    payload: {
      body: { data: btoa(unescape(encodeURIComponent(example.body))) },
      headers,
      mimeType: "text/plain",
    },
    threadId: `eval-thread-${example.id}`,
  } as unknown as GmailMessage;
};

describe("live evaluation", () => {
  it("evaluates a selected dataset with an explicit call cap and optional release gates", async () => {
    const settings = inject("evaluation");
    const dataset = datasetSchema.parse(settings.dataset);
    const { examples } = dataset;
    expect(
      Number.isSafeInteger(settings.maxCalls) && settings.maxCalls > 0,
      "Set EVAL_MAX_CALLS explicitly"
    ).toBeTruthy();
    expect(examples.length).toBeLessThanOrEqual(settings.maxCalls);
    let attemptedCalls = 0;

    const config = testConfig();
    const predictions: EvalPrediction[] = [];
    const onProviderCall = () => {
      if (attemptedCalls >= settings.maxCalls) {
        throw new Error("evaluation_call_cap");
      }
      attemptedCalls += 1;
    };

    for await (const example of examples) {
      const started = Date.now();
      try {
        const normalized = await normalizeMessage(messageFromExample(example), {
          maxBodyCharacters: config.limits.maxBodyCharacters,
        });
        if (attemptedCalls >= settings.maxCalls) {
          throw new Error("evaluation_call_cap");
        }
        const outcome = await classifyMessage(env.AI, normalized, config, Date.now(), {
          gatewayId: settings.gatewayId,
          onProviderCall,
          workload: "evaluation",
        });
        predictions.push({
          decisions: outcome.decisions,
          durationMs: outcome.durationMs,
          exampleId: example.id,
          modelVersion: outcome.modelVersion,
          usage: outcome.usage,
        });
      } catch (error) {
        predictions.push({
          decisions: null,
          durationMs: Date.now() - started,
          exampleId: example.id,
          failureReason: error instanceof Error ? error.name : "provider_error",
          usage: null,
        });
      }
    }

    const report = buildReport(examples, predictions, {
      datasetHash: await sha256Hex(JSON.stringify(dataset)),
      datasetVersion: dataset.version,
      inputTokenCostUsd: INPUT_TOKEN_COST_USD,
      split: dataset.split,
    });

    report.usage.calls = attemptedCalls;
    const gates = releaseGates(report);
    console.log(
      JSON.stringify({ event: "live_evaluation_report", gates, report }, null, 2)
    );
    expect(
      !settings.enforce || gates.passed,
      "Held-out release gates must pass when enforced"
    ).toBeTruthy();

    expect(predictions).toHaveLength(examples.length);
    expect(report.usage.calls).toBeLessThanOrEqual(settings.maxCalls);
  });
});
