import { Hono } from "hono";
import type { Context } from "hono";

import type { AppEnv } from "./app-env";
import { ConfigError } from "./config/env";
import { ApiError, errorEnvelope } from "./http/errors";
import { adminAuth } from "./http/middleware/auth";
import { loadConfig } from "./http/middleware/config";
import { requestId } from "./http/middleware/request-id";
import { authRoutes } from "./routes/auth";
import { configRoutes } from "./routes/config";
import { healthRoutes } from "./routes/health";
import { labelRoutes } from "./routes/labels";
import { messageRoutes } from "./routes/messages";
import { backfillRoutes, operationRoutes, syncRoutes } from "./routes/operations";
import { runRoutes } from "./routes/run";
import { settingsRoutes } from "./routes/settings";
import { statusRoutes } from "./routes/status";

const handleError = (error: unknown, c: Context<AppEnv>): Response => {
  const id = c.get("requestId") ?? crypto.randomUUID();
  if (error instanceof ApiError) {
    return c.json(errorEnvelope(error.code, error.message, id), error.status);
  }
  if (error instanceof ConfigError) {
    return c.json(
      errorEnvelope(
        "CONFIGURATION_ERROR",
        `Invalid configuration: ${error.issues.join("; ")}`,
        id
      ),
      500
    );
  }
  console.error(
    JSON.stringify({
      errorMessage:
        error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
      errorName: error instanceof Error ? error.name : typeof error,
      event: "request_error",
      message: "unexpected_error",
      requestId: id,
    })
  );
  return c.json(errorEnvelope("INTERNAL_ERROR", "Unexpected server error", id), 500);
};

const handleNotFound = (c: Context<AppEnv>): Response => {
  const id = c.get("requestId") ?? crypto.randomUUID();
  return c.json(errorEnvelope("NOT_FOUND", "Route not found", id), 404);
};

export const createApp = (): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.use("*", requestId);
  app.onError(handleError);
  app.notFound(handleNotFound);

  app.route("/", healthRoutes);

  const api = new Hono<AppEnv>();
  api.use("*", loadConfig);
  api.route("/auth", authRoutes);
  api.use("*", adminAuth);
  api.route("/config", configRoutes);
  api.route("/status", statusRoutes);
  api.route("/settings", settingsRoutes);
  api.route("/labels", labelRoutes);
  api.route("/sync", syncRoutes);
  api.route("/backfills", backfillRoutes);
  api.route("/operations", operationRoutes);
  api.route("/messages", messageRoutes);
  api.route("/run", runRoutes);
  app.route("/api/v1", api);

  return app;
};
