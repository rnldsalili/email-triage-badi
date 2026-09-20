import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { validateHeldOutSplit } from "./src/evaluation/dataset";

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
    provide: { evaluation: {
      dataset,
      maxCalls: Number(process.env.EVAL_MAX_CALLS ?? "0"),
      enforce: process.env.EVAL_ENFORCE === "1",
      gatewayId: process.env.AI_GATEWAY_ID ?? "email-triage-badi-dev",
    } },
    hookTimeout: 120_000,
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
