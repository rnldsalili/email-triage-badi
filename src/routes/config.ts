import { Hono } from "hono";

import type { AppEnv } from "../app-env";
import { MODES } from "../config/env";

export const configRoutes = new Hono<AppEnv>().get("/", (c) => {
  const config = c.get("config");
  return c.json({
    limits: {
      detailRetentionDays: config.limits.detailRetentionDays,
      maxAiCallsPerDay: config.limits.maxAiCallsPerDay,
      maxBackfillMessages: config.limits.maxBackfillMessages,
      maxMetadataRefreshPerTick: config.limits.maxMetadataRefreshPerTick,
    },
    modes: MODES,
    owner: {
      email: config.owner.accountEmail,
      timeZone: config.owner.timeZone,
    },
  });
});
