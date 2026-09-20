import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import labelsFixture from "../fixtures/gmail/labels.json";
import { createDb } from "../src/db/client";
import type { GmailLabel } from "../src/gmail/types";
import {
  buildMigrationPlan,
  getLabelMapping,
  getLabelMappings,
  persistInventory,
} from "../src/services/labels";
import { labelKeyForName } from "../src/taxonomy/labels";

const labels = labelsFixture.labels as GmailLabel[];

describe("label inventory and migration plan", () => {
  it("classifies every canonical label against existing Gmail labels", () => {
    const plan = buildMigrationPlan(labels);
    expect(plan.entries).toHaveLength(15);
    const byKey = Object.fromEntries(
      plan.entries.map((entry) => [entry.semanticKey, entry])
    );

    expect(byKey).toMatchObject({
      credit_cards: {
        action: "rename",
        aliasIds: ["Label_1"],
        canonicalId: null,
        legacyId: "Label_1",
      },
      github: { action: "rename", legacyId: "Label_2" },
      job_alerts: { action: "rename", legacyId: "Label_3" },
      payslips: { action: "rename", legacyId: "Label_4" },
      receipts: {
        action: "conflict",
        canonicalId: "Label_7",
        legacyId: "Label_6",
      },
      urgent: { action: "rename", legacyId: "Label_5" },
      work: { action: "create", canonicalId: null, legacyId: null },
    });

    expect(plan).toMatchObject({ legacyMappingsApplied: 6 });
    expect(plan.conflicts).toHaveLength(1);
  });

  it("plans parent container reuse and creation", () => {
    const plan = buildMigrationPlan(labels);
    const containers = Object.fromEntries(
      plan.parentContainers.map((container) => [container.name, container])
    );
    expect(containers.Finance).toMatchObject({ action: "reuse", id: "Label_8" });
    expect(containers.Development).toMatchObject({ action: "create", id: null });
    expect(containers.Career).toMatchObject({ action: "create" });
    expect(containers.Action).toMatchObject({ action: "create" });
  });

  it("maps legacy and canonical names to stable keys", () => {
    expect(labelKeyForName("Credit Card")).toBe("credit_cards");
    expect(labelKeyForName("finance/receipts & confirmations")).toBe("receipts");
    expect(labelKeyForName("Action/Urgent")).toBe("urgent");
    expect(labelKeyForName("SOS Need Urgent Attention")).toBe("urgent");
    expect(labelKeyForName("Travel")).toBeUndefined();
  });

  it("persists inventory mappings with alias IDs and states, idempotently", async () => {
    const db = createDb(env.DB);
    const accountId = "acct-label-inventory";
    const plan = buildMigrationPlan(labels);

    await persistInventory(db, accountId, plan, 1_000_000);

    const receipts = await getLabelMapping(db, accountId, "receipts");
    expect(receipts).toMatchObject({
      gmailLabelId: "Label_7",
      migrationState: "conflict",
    });
    expect(JSON.parse(receipts?.legacyAliasIdsJson ?? "[]")).toStrictEqual(["Label_6"]);

    const creditCards = await getLabelMapping(db, accountId, "credit_cards");
    expect(creditCards).toMatchObject({
      gmailLabelId: "Label_1",
      migrationState: "pending",
    });

    const work = await getLabelMapping(db, accountId, "work");
    expect(work).toMatchObject({ gmailLabelId: null, migrationState: "missing" });

    await persistInventory(db, accountId, plan, 2_000_000);
    const all = await getLabelMappings(db, accountId);
    expect(all).toHaveLength(15);
  });
});
