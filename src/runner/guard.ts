import type { Db } from "../db/client";
import { getControl } from "../db/repositories/control";
import { renewLease } from "../db/repositories/leases";
import type { LeaseFence } from "../db/repositories/leases";
import type { TimeBudget } from "./time-budget";

export class DeferredWorkError extends Error {
  readonly reason: "pending_mode" | "wall_time" | "lease_lost";

  constructor(reason: "pending_mode" | "wall_time" | "lease_lost") {
    super(reason);
    this.name = "DeferredWorkError";
    this.reason = reason;
  }
}

export interface GuardDeps {
  db: Db;
  now: () => number;
  budget: TimeBudget;
  fence?: LeaseFence;
}

export const admit = async (
  deps: GuardDeps,
  estimateMs = 0,
  write = false
): Promise<void> => {
  const { mode } = await getControl(deps.db);
  if (mode === "paused" || (write && mode !== "apply")) {
    throw new DeferredWorkError("pending_mode");
  }
  if (!deps.budget.canSpend(estimateMs, deps.now())) {
    throw new DeferredWorkError("wall_time");
  }
  if (
    deps.fence &&
    !(await renewLease(
      deps.db,
      deps.fence.resourceKey,
      deps.fence.ownerToken,
      deps.now(),
      deps.fence.leaseMs
    ))
  ) {
    throw new DeferredWorkError("lease_lost");
  }
};
