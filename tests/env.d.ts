import type { D1Migration } from "@cloudflare/vitest-pool-workers";

import type { EvaluationSettings } from "../src/evaluation/dataset";

declare module "vitest" {
  export interface ProvidedContext {
    evaluation: EvaluationSettings;
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
