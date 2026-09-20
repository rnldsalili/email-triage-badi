import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import labelsFixture from "../fixtures/gmail/labels.json";
import { createDb } from "../src/db/client";
import {
  appControl,
  classifications,
  jobs,
  labelMappings,
  labelMigrationOperations,
  labelMutations,
  messages,
} from "../src/db/schema";
import type { GmailLabel } from "../src/gmail/types";
import { processDueJobs } from "../src/runner/process-jobs";
import { TimeBudget } from "../src/runner/time-budget";
import { executeLabelMigration } from "../src/services/label-migration";
import { getLabelMappings } from "../src/services/labels";
import { LABEL_DEFINITIONS, LABEL_KEYS } from "../src/taxonomy/labels";
import { testConfig } from "./helpers/config";
import { resetDatabase, seedMailbox } from "./helpers/db";
import { fakeGmail } from "./helpers/gmail-fake";

const NOW = 1_700_000_000_000;
const ACCOUNT = "owner@example.test";

const migrationDeps = (
  db: ReturnType<typeof createDb>,
  client: ReturnType<typeof fakeGmail>["client"]
) => ({
  accountId: ACCOUNT,
  budget: new TimeBudget(NOW, 120_000, 15_000),
  client,
  config: testConfig(),
  db,
  now: () => NOW,
});

const seedMappings = async (db: ReturnType<typeof createDb>) => {
  for await (const key of LABEL_KEYS) {
    await db.insert(labelMappings).values({
      accountId: ACCOUNT,
      currentName: LABEL_DEFINITIONS[key].name,
      gmailLabelId: `Label_${key}`,
      id: crypto.randomUUID(),
      legacyAliasIdsJson: "[]",
      migrationState: "ready",
      semanticKey: key,
      updatedAt: NOW,
    });
  }
};

interface ApplyOptions {
  currentLabelIds?: string[];
  appOwned?: string[];
  lastObserved?: string[];
  dimensionStates?: Record<string, { locked: boolean; userControlled: boolean }>;
  decisions?: Record<string, unknown>;
}

const seedClassifiedJob = async (
  db: ReturnType<typeof createDb>,
  options: ApplyOptions = {}
) => {
  await resetDatabase(db);
  await seedMailbox(db, { committedHistoryId: "1000" });
  await seedMappings(db);
  await db.update(appControl).set({ mode: "apply" });

  const messageId = crypto.randomUUID();
  await db.insert(messages).values({
    accountId: ACCOUNT,
    appOwnedLabelIdsJson: JSON.stringify(options.appOwned ?? []),
    dimensionLocksJson: JSON.stringify(options.dimensionStates ?? {}),
    firstSeenAt: NOW - 1000,
    gmailMessageId: "gm-apply-1",
    id: messageId,
    lastGeneration: 1,
    lastObservedLabelIdsJson: JSON.stringify(options.lastObserved ?? []),
    latestClassificationId: "classification-1",
    receivedAt: NOW - 1000,
    threadId: "t-apply-1",
  });

  await db.insert(classifications).values({
    accountId: ACCOUNT,
    answerJson: "{}",
    applicationStatus: "proposed",
    createdAt: NOW,
    decisionJson: JSON.stringify(
      options.decisions ?? {
        needsReply: { probability: 0.05, status: "negative" },
        needsReview: false,
        reviewReasons: [],
        toDo: { probability: 0.9, status: "positive" },
        topic: {
          confidence: 0.95,
          key: "bills",
          probability: 0.95,
          status: "accepted",
          topKey: "bills",
        },
        urgent: { probability: 0.05, status: "negative" },
      }
    ),
    durationMs: 10,
    id: "classification-1",
    messageId,
    modelVersion: "jev-1.13.0",
    normalizedInputHash: "hash",
    policyVersion: "policy-v1",
    reviewFlag: false,
    reviewReasonsJson: "[]",
    rubricVersion: "rubric-v1",
    taxonomyVersion: "taxonomy-v1",
    usageJson: "{}",
  });

  const jobId = crypto.randomUUID();
  await db.insert(jobs).values({
    accountId: ACCOUNT,
    createdAt: NOW,
    generation: 1,
    id: jobId,
    kind: "initial",
    messageId,
    stage: "classified",
    updatedAt: NOW,
  });

  return { jobId, messageId };
};

const applyDeps = (
  db: ReturnType<typeof createDb>,
  client: ReturnType<typeof fakeGmail>["client"]
) => ({
  accountId: ACCOUNT,
  ai: { run: () => ({}) } as unknown as Ai,
  budget: new TimeBudget(NOW, 120_000, 15_000),
  client,
  config: testConfig(),
  db,
  mode: "apply" as const,
  now: () => NOW,
});

describe("label migration", () => {
  it("renames legacy labels, creates missing ones and journals every step", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.update(appControl).set({ mode: "apply" });
    const labels: GmailLabel[] = (
      structuredClone(labelsFixture.labels) as GmailLabel[]
    ).filter((label) => label.type === "user" && label.id !== "Label_7");
    const gmail = fakeGmail({
      createLabel: (name) => {
        const created = { id: `Label_new_${labels.length + 1}`, name };
        labels.push(created);
        return created;
      },
      listLabels: () => labels,
      renameLabel: (labelId, name) => {
        const target = labels.find((label) => label.id === labelId);
        if (target) {
          target.name = name;
        }
        return { id: labelId, name };
      },
    });

    const outcome = await executeLabelMigration(migrationDeps(db, gmail.client));

    expect(outcome).toMatchObject({
      completed: true,
      conflicts: 0,
      containersCreated: 3,
      created: 9,
      renamed: 6,
    });

    const mappings = await getLabelMappings(db, ACCOUNT);
    expect({
      count: mappings.length,
      creditCards: mappings.find((mapping) => mapping.semanticKey === "credit_cards"),
    }).toMatchObject({
      count: 15,
      creditCards: { gmailLabelId: "Label_1", migrationState: "ready" },
    });
    const journalRows = await db.select().from(labelMigrationOperations);
    expect(journalRows).toHaveLength(18);

    const second = await executeLabelMigration(migrationDeps(db, gmail.client));
    expect(second).toMatchObject({ created: 0, renamed: 0, reused: 15 });
    expect({
      createCalls: gmail.calls.filter((call) => call.method === "createLabel").length,
      renameCalls: gmail.calls.filter((call) => call.method === "renameLabel").length,
    }).toStrictEqual({ createCalls: 12, renameCalls: 6 });
  });

  it("reports collisions without deleting either label", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    await db.update(appControl).set({ mode: "apply" });
    const labels = structuredClone(labelsFixture.labels) as GmailLabel[];
    const gmail = fakeGmail({
      createLabel: (name) => ({ id: `Label_new_${name}`, name }),
      listLabels: () => labels,
      renameLabel: (labelId, name) => ({ id: labelId, name }),
    });

    const outcome = await executeLabelMigration(migrationDeps(db, gmail.client));

    expect(outcome.conflicts).toBe(1);
    const mappings = await getLabelMappings(db, ACCOUNT);
    const receipts = mappings.find((mapping) => mapping.semanticKey === "receipts");
    expect(receipts?.migrationState).toBe("conflict");
    expect(JSON.parse(receipts?.legacyAliasIdsJson ?? "[]")).toStrictEqual(["Label_6"]);
    expect(
      gmail.calls.filter(
        (call) => call.method === "renameLabel" && call.args[0] === "Label_6"
      )
    ).toHaveLength(0);
  });
});

describe("label application", () => {
  it("applies the deterministic diff and records ownership", async () => {
    const db = createDb(env.DB);
    const { messageId } = await seedClassifiedJob(db);
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-apply-1",
        labelIds: ["INBOX"],
        threadId: "t-apply-1",
      }),
      modifyMessage: (messageId2, changes) => ({
        id: messageId2,
        labelIds: ["INBOX", ...(changes.addLabelIds ?? [])].filter(
          (id) => !(changes.removeLabelIds ?? []).includes(id)
        ),
        threadId: "t-apply-1",
      }),
    });

    const outcome = await processDueJobs(applyDeps(db, gmail.client));

    expect(outcome.processed).toBe(1);
    const modifyCalls = gmail.calls.filter((call) => call.method === "modifyMessage");
    expect(modifyCalls).toHaveLength(1);
    expect(modifyCalls[0]?.args[1]).toMatchObject({
      addLabelIds: ["Label_bills", "Label_to_do"],
      removeLabelIds: [],
    });

    const stored = await db.select().from(messages).where(eq(messages.id, messageId));
    const [completedJob] = await db.select().from(jobs);
    const intents = await db.select().from(labelMutations);
    expect({
      appOwned: JSON.parse(stored[0]?.appOwnedLabelIdsJson ?? "[]").toSorted(),
      applicationStatus: stored[0]?.applicationStatus,
      intentStatus: intents[0]?.status,
      jobStage: completedJob?.stage,
    }).toMatchObject({
      appOwned: ["Label_bills", "Label_to_do"],
      applicationStatus: "applied",
      intentStatus: "applied",
      jobStage: "completed",
    });
  });

  it("stops managing a dimension whose label the owner changed", async () => {
    const db = createDb(env.DB);
    const { messageId } = await seedClassifiedJob(db, {
      appOwned: ["Label_bills"],
      currentLabelIds: ["INBOX"],
      decisions: {
        needsReply: { probability: 0.05, status: "negative" },
        needsReview: false,
        reviewReasons: [],
        toDo: { probability: 0.05, status: "negative" },
        topic: {
          confidence: 0.95,
          key: "bills",
          probability: 0.95,
          status: "accepted",
          topKey: "bills",
        },
        urgent: { probability: 0.05, status: "negative" },
      },
      lastObserved: ["INBOX", "Label_bills"],
    });
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-apply-1",
        labelIds: ["INBOX"],
        threadId: "t-apply-1",
      }),
      modifyMessage: (id, changes) => ({
        id,
        labelIds: ["INBOX", ...(changes.addLabelIds ?? [])],
        threadId: "t-apply-1",
      }),
    });

    const outcome = await processDueJobs(applyDeps(db, gmail.client));

    expect(outcome.processed).toBe(1);
    expect(gmail.calls.filter((call) => call.method === "modifyMessage")).toHaveLength(0);
    const stored = await db.select().from(messages).where(eq(messages.id, messageId));
    const locks = JSON.parse(stored[0]?.dimensionLocksJson ?? "{}");
    expect(locks.topic).toMatchObject({ userControlled: true });
  });

  it("respects a correction lock on a dimension", async () => {
    const db = createDb(env.DB);
    const { messageId } = await seedClassifiedJob(db, {
      dimensionStates: { topic: { locked: true, userControlled: false } },
    });
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-apply-1",
        labelIds: ["INBOX"],
        threadId: "t-apply-1",
      }),
      modifyMessage: (id, changes) => ({
        id,
        labelIds: ["INBOX", ...(changes.addLabelIds ?? [])],
        threadId: "t-apply-1",
      }),
    });

    await processDueJobs(applyDeps(db, gmail.client));

    const modifyCall = gmail.calls.find((call) => call.method === "modifyMessage");
    expect(modifyCall?.args[1]).toMatchObject({
      addLabelIds: ["Label_to_do"],
      removeLabelIds: [],
    });
    void messageId;
  });

  it("reconciles a satisfied pending intent after a crash without re-applying", async () => {
    const db = createDb(env.DB);
    const { messageId, jobId } = await seedClassifiedJob(db);
    await db.insert(labelMutations).values({
      addLabelIdsJson: JSON.stringify(["Label_bills", "Label_to_do"]),
      beforeLabelIdsJson: JSON.stringify(["INBOX"]),
      createdAt: NOW,
      desiredLabelIdsJson: JSON.stringify(["INBOX", "Label_bills", "Label_to_do"]),
      generation: 1,
      id: "intent-1",
      jobId,
      messageId,
      removeLabelIdsJson: JSON.stringify([]),
      status: "pending",
      updatedAt: NOW,
    });
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-apply-1",
        labelIds: ["INBOX", "Label_bills", "Label_to_do"],
        threadId: "t-apply-1",
      }),
      modifyMessage: () => {
        throw new Error("must not be called when the intent is already satisfied");
      },
    });

    const outcome = await processDueJobs(applyDeps(db, gmail.client));

    expect(outcome.processed).toBe(1);
    expect(gmail.calls.filter((call) => call.method === "modifyMessage")).toHaveLength(0);
    const intents = await db.select().from(labelMutations);
    expect(intents[0]?.status).toBe("applied");
  });

  it("does not mutate Gmail when mode is dry-run", async () => {
    const db = createDb(env.DB);
    await seedClassifiedJob(db);
    await db.update(appControl).set({ mode: "dry_run" });
    const gmail = fakeGmail({
      getMessage: () => ({
        id: "gm-apply-1",
        labelIds: ["INBOX"],
        threadId: "t-apply-1",
      }),
    });

    const outcome = await processDueJobs({
      ...applyDeps(db, gmail.client),
      mode: "dry_run",
    });

    expect(outcome.deferred).toBe(0);
    expect(gmail.calls.filter((call) => call.method === "modifyMessage")).toHaveLength(0);
    const [classifiedJob] = await db.select().from(jobs);
    expect(classifiedJob?.stage).toBe("classified");
  });
});
