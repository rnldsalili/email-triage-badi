import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";

import { tryClassifyPassiveGithub } from "../../src/classifier/github-passive";
import { classifyMessage } from "../../src/classifier/jev";
import {
  costComparisonDatasetSchema,
  runCostComparison,
} from "../../src/evaluation/cost-comparison";
import { testConfig } from "../helpers/config";

describe("private mailbox cost comparison", () => {
  it("compares standard Jev with the compact rubric and guarded passive rule without labeled quality claims", async () => {
    const settings = inject("costComparison");
    if (!settings) {
      throw new Error("COST_DATASET is required for the private comparison");
    }
    const dataset = costComparisonDatasetSchema.parse(settings.dataset);
    const baseConfig = testConfig({ AI_MODEL: env.AI_MODEL });
    if (baseConfig.ai.model !== "typesafe/jev") {
      throw new Error("cost_comparison_model_invalid");
    }
    const config = {
      ...baseConfig,
      ai: { ...baseConfig.ai, gatewayId: dataset.gatewayId },
      owner: dataset.owner,
    };
    const report = await runCostComparison(dataset, {
      classify: async (arm, example, normalized, now, onProviderCall) => {
        const selected = {
          ...config,
          ai: {
            ...config.ai,
            githubPassiveFastPath:
              arm === "baseline" ? ("off" as const) : ("on" as const),
            rubric: arm === "baseline" ? ("standard" as const) : ("compact-v1" as const),
          },
        };
        if (arm === "candidate") {
          const rule = await tryClassifyPassiveGithub(
            example.message,
            normalized,
            selected,
            now
          );
          if (rule) {
            return rule;
          }
        }
        return await classifyMessage(env.AI, normalized, selected, now, {
          gatewayId: dataset.gatewayId,
          onProviderCall,
          workload: "evaluation",
        });
      },
      maxCalls: settings.maxCalls,
      maxEstimatedUsd: settings.maxEstimatedUsd,
    });
    console.log(
      JSON.stringify({
        configured: {
          baselineRubric: "standard",
          candidateRubric: "compact-v1",
          model: config.ai.model,
        },
        event: "mailbox_cost_comparison",
        report,
      })
    );
    expect(report.qualityValidated).toBeFalsy();
    expect(report.baseline.attempts + report.candidate.attempts).toBeLessThanOrEqual(
      settings.maxCalls
    );
  }, 900_000);
});
