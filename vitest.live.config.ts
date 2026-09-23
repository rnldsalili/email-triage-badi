import { resolve, sep } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { validateHeldOutSplit } from "./src/evaluation/dataset";
import { costComparisonDatasetSchema } from "./src/evaluation/cost-comparison";
import type { CostComparisonSettings } from "./src/evaluation/cost-comparison";

const costDatasetPath = process.env.COST_DATASET;
const privateRoot = resolve("eval/private");
let costComparison: CostComparisonSettings | undefined;
if (costDatasetPath) {
  const absolute = resolve(costDatasetPath);
  try {
    if (!absolute.startsWith(`${privateRoot}${sep}`) ||
      !realpathSync(absolute).startsWith(`${realpathSync(privateRoot)}${sep}`) ||
      statSync(absolute).size > 16 * 1024 * 1024) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("cost_dataset_invalid_path_or_size");
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new Error("cost_dataset_invalid_json");
  }
  const parsed = costComparisonDatasetSchema.safeParse(data);
  if (!parsed.success) throw new Error("cost_dataset_invalid");
  const maxCalls = Number(process.env.EVAL_MAX_CALLS ?? "0");
  const maxEstimatedUsd = Number(process.env.COST_MAX_USD ?? "0");
  if (!Number.isSafeInteger(maxCalls) || maxCalls <= 0 || maxCalls > 300 ||
    !Number.isFinite(maxEstimatedUsd) || maxEstimatedUsd <= 0 || maxEstimatedUsd > 0.25) {
    throw new Error("cost_comparison_budget_invalid");
  }
  costComparison = { dataset: parsed.data, maxCalls, maxEstimatedUsd };
}

const dataset = JSON.parse(readFileSync(process.env.EVAL_DATASET ?? "fixtures/eval/dataset.json", "utf8"));
if (process.env.EVAL_ENFORCE === "1") {
  if (!process.env.EVAL_DEVELOPMENT_DATASET) throw new Error("EVAL_DEVELOPMENT_DATASET is required to check split leakage");
  validateHeldOutSplit(JSON.parse(readFileSync(process.env.EVAL_DEVELOPMENT_DATASET, "utf8")), dataset);
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    provide: {
      evaluation: {
        dataset,
        maxCalls: Number(process.env.EVAL_MAX_CALLS ?? "0"),
        enforce: process.env.EVAL_ENFORCE === "1",
        gatewayId: process.env.AI_GATEWAY_ID ?? "email-triage-badi-dev",
      },
      ...(costComparison ? { costComparison } : {}),
    },
    hookTimeout: 120_000,
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
