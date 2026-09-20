import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { labelMappings } from "../db/schema";
import type { GmailLabel } from "../gmail/types";
import {
  LABEL_DEFINITIONS,
  LABEL_KEYS,
  LEGACY_LABEL_MAPPINGS,
  PARENT_CONTAINERS,
} from "../taxonomy/labels";
import type { LabelKey } from "../taxonomy/labels";

export type MigrationAction = "rename" | "reuse" | "create" | "conflict";

export interface MigrationPlanEntry {
  semanticKey: LabelKey;
  targetName: string;
  kind: "topic" | "action";
  action: MigrationAction;
  canonicalId: string | null;
  legacyId: string | null;
  legacyName: string | null;
  aliasIds: string[];
}

export interface ParentContainerPlan {
  name: string;
  action: "reuse" | "create";
  id: string | null;
}

export interface MigrationPlan {
  entries: MigrationPlanEntry[];
  parentContainers: ParentContainerPlan[];
  conflicts: MigrationPlanEntry[];
  legacyMappingsApplied: number;
}

const findUserLabel = (labels: GmailLabel[], name: string): GmailLabel | undefined => {
  const normalized = name.trim().toLowerCase();
  return labels.find(
    (label) =>
      label.name.trim().toLowerCase() === normalized &&
      (label.type === undefined || label.type === "user")
  );
};

export const buildMigrationPlan = (labels: GmailLabel[]): MigrationPlan => {
  const entries: MigrationPlanEntry[] = [];
  let legacyMappingsApplied = 0;

  for (const key of LABEL_KEYS) {
    const definition = LABEL_DEFINITIONS[key];
    const canonical = findUserLabel(labels, definition.name);
    const legacyName = LEGACY_LABEL_MAPPINGS.find(
      (mapping) => mapping.key === key
    )?.oldName;
    const legacy = legacyName ? findUserLabel(labels, legacyName) : undefined;

    let action: MigrationAction;
    if (canonical && legacy) {
      action = "conflict";
    } else if (canonical) {
      action = "reuse";
    } else if (legacy) {
      action = "rename";
    } else {
      action = "create";
    }

    if (action === "rename" || action === "conflict") {
      legacyMappingsApplied += 1;
    }

    entries.push({
      action,
      aliasIds: legacy ? [legacy.id] : [],
      canonicalId: canonical?.id ?? null,
      kind: definition.kind,
      legacyId: legacy?.id ?? null,
      legacyName: legacy?.name ?? null,
      semanticKey: key,
      targetName: definition.name,
    });
  }

  const parentContainers: ParentContainerPlan[] = PARENT_CONTAINERS.map((name) => {
    const existing = findUserLabel(labels, name);
    return {
      action: existing ? "reuse" : "create",
      id: existing?.id ?? null,
      name,
    };
  });

  return {
    conflicts: entries.filter((entry) => entry.action === "conflict"),
    entries,
    legacyMappingsApplied,
    parentContainers,
  };
};

export const migrationStateFor = (action: MigrationAction) => {
  switch (action) {
    case "reuse": {
      return "ready" as const;
    }
    case "rename": {
      return "pending" as const;
    }
    case "create": {
      return "missing" as const;
    }
    case "conflict": {
      return "conflict" as const;
    }
    default: {
      throw new Error(`Unhandled migration action: ${String(action)}`);
    }
  }
};

export const persistInventory = async (
  db: Db,
  accountId: string,
  plan: MigrationPlan,
  now: number
): Promise<void> => {
  for await (const entry of plan.entries) {
    const gmailLabelId = entry.canonicalId ?? entry.legacyId;
    await db
      .insert(labelMappings)
      .values({
        accountId,
        currentName: entry.targetName,
        gmailLabelId,
        id: crypto.randomUUID(),
        legacyAliasIdsJson: JSON.stringify(entry.aliasIds),
        migrationState: migrationStateFor(entry.action),
        semanticKey: entry.semanticKey,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          currentName: entry.targetName,
          gmailLabelId,
          legacyAliasIdsJson: JSON.stringify(entry.aliasIds),
          migrationState: migrationStateFor(entry.action),
          updatedAt: now,
        },
        target: [labelMappings.accountId, labelMappings.semanticKey],
      });
  }
};

export const getLabelMappings = (db: Db, accountId: string) =>
  db.select().from(labelMappings).where(eq(labelMappings.accountId, accountId));

export const getLabelMapping = async (db: Db, accountId: string, key: LabelKey) => {
  const rows = await db
    .select()
    .from(labelMappings)
    .where(
      and(eq(labelMappings.accountId, accountId), eq(labelMappings.semanticKey, key))
    )
    .limit(1);
  return rows[0];
};
