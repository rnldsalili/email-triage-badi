import type { D1Migration } from "@cloudflare/vitest-pool-workers";

import type { CostComparisonSettings } from "../src/evaluation/cost-comparison";
import type { EvaluationSettings } from "../src/evaluation/dataset";

declare module "vitest" {
  export interface ProvidedContext {
    evaluation: EvaluationSettings;
    costComparison?: CostComparisonSettings;
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
