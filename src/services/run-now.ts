import { runScheduledTick } from "../runner/runner";

/**
 * Wall budget for an owner-triggered tick. The request is awaited rather than
 * detached, because `waitUntil` work is cancelled 30 seconds after the response
 * is sent and a cancelled tick could leave the mailbox lease held.
 */
export const MANUAL_TICK_BUDGET_MS = 60_000;

/**
 * Shorter than the scheduled lease so an aborted manual request (for example a
 * closed browser tab) cannot block the cron schedule for the full run lease.
 */
export const MANUAL_TICK_LEASE_MS = 90_000;

export interface ManualTickResult {
  durationMs: number;
  mode: string | null;
  status: string;
}

export const runManualTick = async (
  env: Env,
  requestId?: string
): Promise<ManualTickResult> => {
  const startedAt = Date.now();
  try {
    const outcome = await runScheduledTick(env, {
      leaseMs: MANUAL_TICK_LEASE_MS,
      wallBudgetMs: MANUAL_TICK_BUDGET_MS,
    });
    console.log(
      JSON.stringify({
        durationMs: outcome.durationMs,
        event: "manual_tick",
        requestId: requestId ?? null,
        status: outcome.status,
      })
    );
    return {
      durationMs: outcome.durationMs,
      mode: outcome.mode ?? null,
      status: outcome.status,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "unknown",
        event: "manual_tick_error",
        message:
          error instanceof Error ? error.message.slice(0, 200) : "manual_tick_failed",
        requestId: requestId ?? null,
      })
    );
    return { durationMs: Date.now() - startedAt, mode: null, status: "error" };
  }
};
