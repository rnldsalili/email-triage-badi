import type { AppConfig } from "./config/env";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    config: AppConfig;
    requestId: string;
  };
}
