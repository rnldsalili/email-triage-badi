import { Hono } from "hono";

import type { AppEnv } from "../app-env";
import { createDb } from "../db/client";
import { getControl } from "../db/repositories/control";
import { enqueueOperation } from "../db/repositories/operations";
import { ApiError } from "../http/errors";
import {
  requireIdempotencyKey,
  withIdempotency,
  operationWrite,
} from "../http/idempotency";
import { getLabelMappings } from "../services/labels";
import {
  LABEL_DEFINITIONS,
  LABEL_KEYS,
  LEGACY_LABEL_MAPPINGS,
  PARENT_CONTAINERS,
} from "../taxonomy/labels";

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
    const now = Date.now();
    const response = await withIdempotency(
      db,
      accountId,
      { key, payload: {}, route: "labels/migrate" },
      now,
      () => {
        const operationId = crypto.randomUUID();
        return {
          body: { operationId },
          status: 202,
          writes: [operationWrite(db, operationId, accountId, "migrate", {}, now)],
        };
      }
    );
    return c.json(response.body, response.status as 200);
  });
