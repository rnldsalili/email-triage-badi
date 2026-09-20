import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../app-env";
import { createDb } from "../db/client";
import { getControl } from "../db/repositories/control";
import { enqueueOperation, getOperation } from "../db/repositories/operations";
import { ApiError } from "../http/errors";
import {
  requireIdempotencyKey,
  withIdempotency,
  operationWrite,
} from "../http/idempotency";
import { readJsonBody } from "../http/validation";
import { getLabelMappings } from "../services/labels";
import {
  LABEL_DEFINITIONS,
  LABEL_KEYS,
  LEGACY_LABEL_MAPPINGS,
  PARENT_CONTAINERS,
} from "../taxonomy/labels";

const migrateSchema = z
  .object({ planOperationId: z.string().min(1).optional() })
  .strict();

export const labelRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const mappings = await getLabelMappings(db, accountId);
    return c.json({
      conflicts: mappings
        .filter((mapping) => mapping.migrationState === "conflict")
        .map((mapping) => mapping.semanticKey),
      definitions: LABEL_KEYS.map((key) => ({
        key,
        kind: LABEL_DEFINITIONS[key].kind,
        name: LABEL_DEFINITIONS[key].name,
      })),
      legacyMappings: LEGACY_LABEL_MAPPINGS,
      mappings: mappings.map((mapping) => ({
        aliasIds: JSON.parse(mapping.legacyAliasIdsJson) as string[],
        currentName: mapping.currentName,
        gmailLabelId: mapping.gmailLabelId,
        migrationState: mapping.migrationState,
        semanticKey: mapping.semanticKey,
      })),
      parentContainers: PARENT_CONTAINERS,
    });
  })
  .post("/migration-plan", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const now = Date.now();
    const key = c.req.header("idempotency-key")?.trim();

    if (key) {
      const response = await withIdempotency(
        db,
        accountId,
        { key, payload: {}, route: "labels/migration-plan" },
        now,
        () => {
          const operationId = crypto.randomUUID();
          return {
            body: { coalesced: false, operationId },
            status: 202,
            writes: [
              operationWrite(db, operationId, accountId, "migration_plan", {}, now),
            ],
          };
        }
      );
      return c.json(response.body, response.status as 200);
    }

    const outcome = await enqueueOperation(db, {
      accountId,
      coalesceKey: "migration_plan",
      id: crypto.randomUUID(),
      kind: "migration_plan",
      now,
      requestJson: "{}",
    });
    return c.json(
      { coalesced: !outcome.created, operationId: outcome.operation.id },
      202
    );
  })
  .post("/migrate", async (c) => {
    const db = createDb(c.env.DB);
    const accountId = c.get("config").owner.accountEmail;
    const control = await getControl(db);
    if (control.mode !== "apply") {
      throw new ApiError("CONFLICT", "Label migration requires apply mode");
    }
    const key = requireIdempotencyKey(c.req.header("idempotency-key"));
    const hasBody = (c.req.header("content-length") ?? "0") !== "0";
    const body = hasBody ? await readJsonBody(c, migrateSchema) : {};
    const planOperationId = body.planOperationId ?? null;
    if (planOperationId) {
      const plan = await getOperation(db, planOperationId);
      if (
        !plan ||
        plan.accountId !== accountId ||
        plan.kind !== "migration_plan" ||
        plan.status !== "completed"
      ) {
        throw new ApiError(
          "VALIDATION_ERROR",
          "planOperationId must reference a completed label migration plan"
        );
      }
    }
    const now = Date.now();
    const request = { planOperationId };
    const response = await withIdempotency(
      db,
      accountId,
      { key, payload: request, route: "labels/migrate" },
      now,
      () => {
        const operationId = crypto.randomUUID();
        return {
          body: { operationId, planOperationId },
          status: 202,
          writes: [operationWrite(db, operationId, accountId, "migrate", request, now)],
        };
      }
    );
    return c.json(response.body, response.status as 200);
  });
