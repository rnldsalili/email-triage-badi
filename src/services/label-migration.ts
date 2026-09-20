import { and, eq } from "drizzle-orm";

import type { AppConfig } from "../config/env";
import type { Db } from "../db/client";
import { labelMigrationOperations } from "../db/schema";
import type { LabelMigrationOperation } from "../db/schema";
import type { GmailClient } from "../gmail/client";
import type { GmailLabel } from "../gmail/types";
import { admit, DeferredWorkError } from "../runner/guard";
import type { GuardDeps } from "../runner/guard";
import { STAGE_ESTIMATES_MS } from "../runner/time-budget";
import { buildMigrationPlan, persistInventory } from "./labels";

export interface MigrationDeps extends GuardDeps {
  db: Db;
  client: GmailClient;
  config: AppConfig;
  accountId: string;
}

export interface MigrationOutcome {
  created: number;
  renamed: number;
  reused: number;
  conflicts: number;
  containersCreated: number;
  completed: boolean;
  deferred: boolean;
}

const reconcileStep = async (
  deps: MigrationDeps,
  step: LabelMigrationOperation,
  labels: GmailLabel[]
) => {
  const target = labels.find(
    (label) =>
      label.type !== "system" && label.name.toLowerCase() === step.newName?.toLowerCase()
  );
  if (step.action === "reuse" || step.action === "conflict") {
    return target;
  }
  if (target) {
    // A completed rename must still refer to its original ID; never swallow a collision.
    if (step.action === "rename" && target.id !== step.labelId) {
      await deps.db
        .update(labelMigrationOperations)
        .set({ action: "conflict" })
        .where(eq(labelMigrationOperations.id, step.id));
    }
    return target;
  }
  await admit(deps, STAGE_ESTIMATES_MS.mutation, true);
  const label =
    step.action === "rename" && step.labelId
      ? await deps.client.renameLabel(step.labelId, step.newName ?? "")
      : await deps.client.createLabel(step.newName ?? "");
  const index = labels.findIndex((existing) => existing.id === label.id);
  if (index === -1) {
    labels.push(label);
  } else {
    labels[index] = label;
  }
  return label;
};

export const executeLabelMigration = async (
  deps: MigrationDeps,
  operationId = crypto.randomUUID()
): Promise<MigrationOutcome> => {
  const outcome: MigrationOutcome = {
    completed: false,
    conflicts: 0,
    containersCreated: 0,
    created: 0,
    deferred: false,
    renamed: 0,
    reused: 0,
  };
  try {
    await admit(deps, STAGE_ESTIMATES_MS.mutation, true);
    const labels = await deps.client.listLabels();
    let steps = await deps.db
      .select()
      .from(labelMigrationOperations)
      .where(
        and(
          eq(labelMigrationOperations.operationId, operationId),
          eq(labelMigrationOperations.accountId, deps.accountId)
        )
      );
    if (steps.length === 0) {
      const plan = buildMigrationPlan(labels);
      const entries = [
        ...plan.parentContainers
          .filter((entry) => entry.action === "create")
          .map((entry) => ({
            action: entry.action,
            labelId: entry.id,
            newName: entry.name,
            oldName: null,
            semanticKey: null,
          })),
        ...plan.entries.map((entry) => ({
          action: entry.action,
          labelId: entry.action === "rename" ? entry.legacyId : entry.canonicalId,
          newName: entry.targetName,
          oldName: entry.legacyName,
          semanticKey: entry.semanticKey,
        })),
      ];
      // One atomic journal insertion before the first external write.
      const journalWrites = entries.map((entry) =>
        deps.db.insert(labelMigrationOperations).values({
          ...entry,
          accountId: deps.accountId,
          createdAt: deps.now(),
          id: crypto.randomUUID(),
          operationId,
          status: "pending" as const,
        })
      );
      const [first, ...remaining] = journalWrites;
      if (first) {
        await deps.db.batch([first, ...remaining]);
      }
      steps = await deps.db
        .select()
        .from(labelMigrationOperations)
        .where(eq(labelMigrationOperations.operationId, operationId));
    }
    // Parents precede children even when restarting from a partially completed journal.
    steps.sort((a, b) => Number(a.semanticKey !== null) - Number(b.semanticKey !== null));
    for await (const step of steps) {
      if (step.status !== "completed") {
        await admit(deps, STAGE_ESTIMATES_MS.mutation, true);
        const result = await reconcileStep(deps, step, labels);
        await deps.db
          .update(labelMigrationOperations)
          .set({
            completedAt: deps.now(),
            labelId: result?.id ?? step.labelId,
            status: "completed",
          })
          .where(eq(labelMigrationOperations.id, step.id));
      }
      if (step.action === "rename") {
        outcome.renamed += 1;
      }
      if (step.action === "reuse") {
        outcome.reused += 1;
      }
      if (step.action === "conflict") {
        outcome.conflicts += 1;
      }
      if (step.action === "create") {
        if (step.semanticKey) {
          outcome.created += 1;
        } else {
          outcome.containersCreated += 1;
        }
      }
    }
    await admit(deps, 0, true);
    await persistInventory(
      deps.db,
      deps.accountId,
      buildMigrationPlan(labels),
      deps.now()
    );
    outcome.completed = true;
  } catch (error) {
    if (!(error instanceof DeferredWorkError) || error.reason === "lease_lost") {
      throw error;
    }
    outcome.deferred = true;
  }
  return outcome;
};
