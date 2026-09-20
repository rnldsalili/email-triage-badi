import { ConfigError, parseConfig } from "./config/env";
import { BUILD_VERSION } from "./config/versions";
import { runScheduledTick } from "./runner/runner";

export const handleScheduled = async (
  controller: ScheduledController,
  env: Env
): Promise<void> => {
  const startedAt = Date.now();
  try {
    parseConfig({ ...env });
  } catch (error) {
    console.error(
      JSON.stringify({
        cron: controller.cron,
        event: "scheduled_invalid_config",
        message: error instanceof ConfigError ? error.issues.join("; ") : String(error),
      })
    );
    return;
  }

  try {
    const outcome = await runScheduledTick(env);
    console.log(
      JSON.stringify({
        build: BUILD_VERSION,
        cron: controller.cron,
        event: "scheduled_tick",
        wallMs: Date.now() - startedAt,
        ...outcome,
      })
    );
  } catch {
    console.error(
      JSON.stringify({
        cron: controller.cron,
        durationMs: Date.now() - startedAt,
        event: "scheduled_error",
        message: "scheduled_failure",
      })
    );
  }
};
