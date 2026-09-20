import { and, eq } from "drizzle-orm";

import type { DecisionSet } from "../classifier/policy";
import type { AppConfig } from "../config/env";
import { POLICY_VERSION, TAXONOMY_VERSION } from "../config/versions";
import type { Db } from "../db/client";
import {
  getClassificationById,
  getLatestClassification,
} from "../db/repositories/classifications";
import { getControl } from "../db/repositories/control";
import {
  listCorrections,
  getLatestCorrectionRevision,
} from "../db/repositories/corrections";
import { getMessageById } from "../db/repositories/messages";
import { labelMutations, messages } from "../db/schema";
import type { Job, Message } from "../db/schema";
import type { GmailClient } from "../gmail/client";
import { GmailError } from "../gmail/errors";
import { admit } from "../runner/guard";
import type { GuardDeps } from "../runner/guard";
import { STAGE_ESTIMATES_MS } from "../runner/time-budget";
import type { TimeBudget } from "../runner/time-budget";
import { ACTION_KEYS } from "../taxonomy/labels";
import type { LabelKey } from "../taxonomy/labels";
import { mergeCorrections } from "./corrections";
import { computeLabelDiff, detectManualChanges } from "./label-diff";
import type {
  Dimension,
  DimensionState,
  LabelDiff,
  LabelMappingInfo,
} from "./label-diff";
import { buildMigrationPlan, getLabelMappings, persistInventory } from "./labels";

export interface ApplyDeps extends GuardDeps {
  db: Db;
  client: GmailClient;
  config: AppConfig;
  accountId: string;
  now: () => number;
  budget: TimeBudget;
}

export type ApplyOutcome =
  | { status: "applied"; added: string[]; removed: string[] }
  | { status: "no_change" }
  | { status: "skipped"; reason: string }
  | { status: "deferred"; reason: string };

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const approvedLabelIds = (mappings: LabelMappingInfo[]): Set<string> => {
  const approved = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.canonicalId) {
      approved.add(mapping.canonicalId);
    }
    for (const alias of mapping.aliasIds) {
      approved.add(alias);
    }
  }
  return approved;
};

const desiredLabelIds = (diff: LabelDiff, currentLabelIds: string[]): string[] => {
  const desired = currentLabelIds.filter((id) => !diff.remove.includes(id));
  for (const id of diff.add) {
    if (!desired.includes(id)) {
      desired.push(id);
    }
  }
  return desired;
};

const requiredLabelKeys = (decisions: DecisionSet): LabelKey[] => {
  const keys: LabelKey[] = [];
  if (
    decisions.topic.status === "accepted" &&
    decisions.topic.key !== "other" &&
    decisions.topic.key
  ) {
    keys.push(decisions.topic.key);
  }
  const actionDecisions: Record<string, { status: string }> = {
    needs_reply: decisions.needsReply,
    to_do: decisions.toDo,
    urgent: decisions.urgent,
  };
  for (const key of ACTION_KEYS) {
    if (actionDecisions[key]?.status === "positive") {
      keys.push(key);
    }
  }
  return keys;
};

const refreshLabelMappings = async (deps: ApplyDeps): Promise<void> => {
  const labels = await deps.client.listLabels();
  const plan = buildMigrationPlan(labels);
  await persistInventory(deps.db, deps.accountId, plan, deps.now());
};

const preflight = async (deps: ApplyDeps, job: Job): Promise<ApplyOutcome | null> => {
  const control = await getControl(deps.db);
  if (control.mode !== "apply") {
    return { reason: "pending_mode", status: "deferred" };
  }
  if (!job.messageId) {
    return { reason: "missing_message", status: "skipped" };
  }
  if (!deps.budget.canSpend(STAGE_ESTIMATES_MS.mutation, deps.now())) {
    return { reason: "wall_time", status: "deferred" };
  }
  return null;
};

const isCurrentJobMessage = (job: Job, message: Message): ApplyOutcome | null => {
  if (message.lastGeneration > job.generation) {
    return { reason: "superseded_generation", status: "skipped" };
  }
  return null;
};

const classify = (
  job: Job,
  message: Message,
  classification: { id: string; policyVersion: string; taxonomyVersion: string }
): ApplyOutcome | null => {
  const superseded =
    classification.id !== message.latestClassificationId ||
    classification.taxonomyVersion !== TAXONOMY_VERSION ||
    classification.policyVersion !== POLICY_VERSION;
  if (job.kind === "apply" && superseded) {
    return { reason: "superseded_classification", status: "skipped" };
  }
  return null;
};

const stillCurrent = async (
  deps: ApplyDeps,
  job: Job,
  revision: number
): Promise<boolean> => {
  await admit(deps, STAGE_ESTIMATES_MS.mutation, true);
  if (!job.messageId) {
    return false;
  }
  const message = await getMessageById(deps.db, job.messageId);
  return (
    message?.lastGeneration === job.generation &&
    (await getLatestCorrectionRevision(deps.db, job.messageId)) === revision
  );
};

const handleMutationError = async (
  deps: ApplyDeps,
  intentId: string,
  error: unknown
): Promise<void> => {
  const retryable =
    error instanceof GmailError
      ? error.retryable || error.reason === "invalid_request"
      : true;
  if (error instanceof GmailError && error.reason === "invalid_request") {
    try {
      await refreshLabelMappings(deps);
    } catch {
      // inventory refresh is best effort; the retry path will try again
    }
    await deps.db
      .update(labelMutations)
      .set({ status: "superseded", updatedAt: deps.now() })
      .where(eq(labelMutations.id, intentId));
  }
  if (!retryable) {
    await deps.db
      .update(labelMutations)
      .set({ status: "failed", updatedAt: deps.now() })
      .where(eq(labelMutations.id, intentId));
  }
};

const reconcileIntentState = async (
  deps: ApplyDeps,
  message: Message,
  currentLabelIds: string[],
  add: string[],
  remove: string[],
  satisfied: boolean
): Promise<void> => {
  if (!satisfied) {
    return;
  }
  const appOwned = new Set(parseJson<string[]>(message.appOwnedLabelIdsJson, []));
  for (const id of add) {
    appOwned.add(id);
  }
  for (const id of remove) {
    appOwned.delete(id);
  }
  await deps.db
    .update(messages)
    .set({
      appOwnedLabelIdsJson: JSON.stringify([...appOwned]),
      lastObservedLabelIdsJson: JSON.stringify(currentLabelIds),
    })
    .where(eq(messages.id, message.id));
};

const finishApplied = async (
  deps: ApplyDeps,
  message: Message,
  intentId: string,
  resultingLabelIds: string[],
  added: string[],
  removed: string[]
): Promise<void> => {
  const previousOwned = parseJson<string[]>(message.appOwnedLabelIdsJson, []);
  const appOwned = new Set(previousOwned);
  for (const id of added) {
    appOwned.add(id);
  }
  for (const id of removed) {
    appOwned.delete(id);
  }

  const updatedAt = deps.now();
  await deps.db.batch([
    deps.db
      .update(labelMutations)
      .set({
        desiredLabelIdsJson: JSON.stringify(resultingLabelIds),
        status: "applied",
        updatedAt,
      })
      .where(eq(labelMutations.id, intentId)),
    deps.db
      .update(messages)
      .set({
        appOwnedLabelIdsJson: JSON.stringify([...appOwned]),
        applicationStatus: "applied",
        lastObservedLabelIdsJson: JSON.stringify(resultingLabelIds),
        processingStatus: "completed",
      })
      .where(eq(messages.id, message.id)),
  ]);
};

const mutateLabels = async (
  deps: ApplyDeps,
  job: Job,
  message: Message,
  intentId: string,
  changes: { add: string[]; remove: string[] },
  currentLabelIds: string[],
  approved: Set<string>,
  correctionRevision: number
): Promise<ApplyOutcome> => {
  if (!(await stillCurrent(deps, job, correctionRevision))) {
    return { reason: "superseded_generation", status: "skipped" };
  }
  try {
    const response = await deps.client.modifyMessage(
      message.gmailMessageId,
      { addLabelIds: changes.add, removeLabelIds: changes.remove },
      approved
    );
    await finishApplied(
      deps,
      message,
      intentId,
      response.labelIds ?? currentLabelIds,
      changes.add,
      changes.remove
    );
  } catch (error) {
    await handleMutationError(deps, intentId, error);
    throw error;
  }
  return { added: changes.add, removed: changes.remove, status: "applied" };
};

const supersedeIntent = async (deps: ApplyDeps, intentId: string): Promise<void> => {
  await deps.db
    .update(labelMutations)
    .set({ status: "superseded", updatedAt: deps.now() })
    .where(eq(labelMutations.id, intentId));
};

const replayPendingIntents = async (
  deps: ApplyDeps,
  job: Job,
  message: Message,
  currentLabelIds: string[],
  approved: Set<string>,
  correctionRevision: number
): Promise<ApplyOutcome | null> => {
  const intents = await deps.db
    .select()
    .from(labelMutations)
    .where(eq(labelMutations.messageId, message.id));
  for await (const intent of intents) {
    if (intent.status !== "pending") {
      continue;
    }
    const add = parseJson<string[]>(intent.addLabelIdsJson, []);
    const remove = parseJson<string[]>(intent.removeLabelIdsJson, []);
    if ([...add, ...remove].some((id) => !approved.has(id))) {
      await supersedeIntent(deps, intent.id);
      continue;
    }
    const satisfied =
      add.every((id) => currentLabelIds.includes(id)) &&
      remove.every((id) => !currentLabelIds.includes(id));
    if (intent.generation !== job.generation) {
      await reconcileIntentState(deps, message, currentLabelIds, add, remove, satisfied);
      await supersedeIntent(deps, intent.id);
      continue;
    }
    if (satisfied) {
      await finishApplied(deps, message, intent.id, currentLabelIds, add, remove);
      return { added: add, removed: remove, status: "applied" };
    }
    return await mutateLabels(
      deps,
      job,
      message,
      intent.id,
      { add, remove },
      currentLabelIds,
      approved,
      correctionRevision
    );
  }
  return null;
};

const markManualChanges = async (
  deps: ApplyDeps,
  message: Message,
  currentLabelIds: string[],
  mappings: LabelMappingInfo[],
  dimensionStates: Partial<Record<Dimension, DimensionState>>,
  unlockedDimensions: Set<Dimension>
): Promise<void> => {
  const manualChanges = detectManualChanges({
    appOwnedLabelIds: parseJson<string[]>(message.appOwnedLabelIdsJson, []),
    currentLabelIds,
    lastObservedLabelIds: parseJson<string[]>(message.lastObservedLabelIdsJson, []),
    mappings,
  }).filter((dimension) => !unlockedDimensions.has(dimension));
  if (manualChanges.length === 0) {
    return;
  }
  for (const dimension of manualChanges) {
    dimensionStates[dimension] = {
      locked: dimensionStates[dimension]?.locked ?? false,
      userControlled: true,
    };
  }
  await deps.db
    .update(messages)
    .set({ dimensionLocksJson: JSON.stringify(dimensionStates) })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.lastGeneration, message.lastGeneration)
      )
    );
};

const INELIGIBLE_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "SENT"]);

const isEligibleMessage = (job: Job, currentLabelIds: string[]): boolean => {
  if (currentLabelIds.some((id) => INELIGIBLE_LABELS.has(id))) {
    return false;
  }
  const requiresInbox = job.kind === "initial" || job.kind === "reprocess";
  return !requiresInbox || currentLabelIds.includes("INBOX");
};

const unlockDimensions = (
  dimensionStates: Partial<Record<Dimension, DimensionState>>,
  unlockedDimensions: Set<Dimension>
): void => {
  for (const dimension of unlockedDimensions) {
    const state = dimensionStates[dimension];
    if (state) {
      dimensionStates[dimension] = { ...state, userControlled: false };
    }
  }
};

const loadMappings = async (deps: ApplyDeps): Promise<LabelMappingInfo[]> => {
  const rows = await getLabelMappings(deps.db, deps.accountId);
  return rows.map((mapping) => ({
    aliasIds: parseJson<string[]>(mapping.legacyAliasIdsJson, []),
    canonicalId: mapping.gmailLabelId,
    semanticKey: mapping.semanticKey as LabelKey,
  }));
};

const ensureMappings = async (
  deps: ApplyDeps,
  decisions: DecisionSet,
  mappings: LabelMappingInfo[]
): Promise<LabelMappingInfo[]> => {
  const missing = requiredLabelKeys(decisions).some(
    (key) => !mappings.find((mapping) => mapping.semanticKey === key)?.canonicalId
  );
  if (!missing) {
    return mappings;
  }
  await admit(deps, STAGE_ESTIMATES_MS.discoveryPage, true);
  await refreshLabelMappings(deps);
  return await loadMappings(deps);
};

const mappingsIncomplete = (
  decisions: DecisionSet,
  mappings: LabelMappingInfo[]
): boolean =>
  requiredLabelKeys(decisions).some(
    (key) => !mappings.find((mapping) => mapping.semanticKey === key)?.canonicalId
  );

const decisionsForApplication = (
  classification: { decisionJson: string } | undefined
): DecisionSet | null => {
  if (classification) {
    return parseJson<DecisionSet | null>(classification.decisionJson, null);
  }
  return {
    needsReply: { probability: 0.5, status: "uncertain" },
    needsReview: true,
    reviewReasons: ["classification_expired"],
    toDo: { probability: 0.5, status: "uncertain" },
    topic: {
      confidence: 0,
      key: null,
      probability: 0,
      status: "uncertain",
      topKey: "other",
    },
    urgent: { probability: 0.5, status: "uncertain" },
  };
};

const loadDecision = (
  classification: Awaited<ReturnType<typeof getLatestClassification>>,
  job: Job,
  message: Message
): { decisions: DecisionSet } | { outcome: ApplyOutcome } => {
  if (!classification && job.kind !== "correction") {
    return { outcome: { reason: "no_classification", status: "skipped" } };
  }
  const stale = classification ? classify(job, message, classification) : null;
  if (stale) {
    return { outcome: stale };
  }
  const decisions = decisionsForApplication(classification);
  if (!decisions) {
    return { outcome: { reason: "invalid_decision_json", status: "skipped" } };
  }
  return { decisions };
};

export const applyClassifiedJob = async (
  deps: ApplyDeps,
  job: Job
): Promise<ApplyOutcome> => {
  const blocking = await preflight(deps, job);
  if (blocking) {
    return blocking;
  }
  if (!job.messageId) {
    return { reason: "missing_message", status: "skipped" };
  }

  const message = await getMessageById(deps.db, job.messageId);
  if (!message) {
    return { reason: "message_record_missing", status: "skipped" };
  }
  const staleMessage = isCurrentJobMessage(job, message);
  if (staleMessage) {
    return staleMessage;
  }

  const payload = parseJson<{ classificationId?: string; correctionId?: string }>(
    job.payloadJson ?? "{}",
    {}
  );
  const classification = payload.classificationId
    ? await getClassificationById(deps.db, payload.classificationId)
    : await getLatestClassification(deps.db, message.id);
  const loaded = loadDecision(classification, job, message);
  if ("outcome" in loaded) {
    return loaded.outcome;
  }
  const corrections = await listCorrections(deps.db, message.id);
  const correctionRevision = corrections.at(-1)?.revision ?? 0;
  const decisions = mergeCorrections(loaded.decisions, corrections);
  const correctionDimensions = corrections.flatMap((correction) =>
    parseJson<Dimension[]>(correction.changedDimensionsJson, [])
  );

  const mappings = await ensureMappings(deps, decisions, await loadMappings(deps));
  if (mappingsIncomplete(decisions, mappings)) {
    return { reason: "label_mapping_pending", status: "deferred" };
  }
  const approved = approvedLabelIds(mappings);

  await admit(deps, STAGE_ESTIMATES_MS.messageFetch, true);
  const current = await deps.client.getMessage(message.gmailMessageId, "minimal");
  const currentLabelIds = current.labelIds ?? [];
  if (!isEligibleMessage(job, currentLabelIds)) {
    return { reason: "ineligible_message", status: "skipped" };
  }

  const dimensionStates = parseJson<Partial<Record<Dimension, DimensionState>>>(
    message.dimensionLocksJson,
    {}
  );
  const unlockedDimensions = new Set<Dimension>(
    job.kind === "correction" ? correctionDimensions : []
  );
  unlockDimensions(dimensionStates, unlockedDimensions);

  const replayed = await replayPendingIntents(
    deps,
    job,
    message,
    currentLabelIds,
    approved,
    correctionRevision
  );
  if (replayed) {
    return replayed;
  }

  await markManualChanges(
    deps,
    message,
    currentLabelIds,
    mappings,
    dimensionStates,
    unlockedDimensions
  );

  const diff = computeLabelDiff({
    approvedUserLabelIds: approved,
    decisions,
    mappings,
    state: {
      appOwnedLabelIds: parseJson<string[]>(message.appOwnedLabelIdsJson, []),
      currentLabelIds,
      dimensionStates,
    },
    unlockedDimensions: [...unlockedDimensions],
  });

  if (diff.add.length === 0 && diff.remove.length === 0) {
    await deps.db
      .update(messages)
      .set({ lastObservedLabelIdsJson: JSON.stringify(currentLabelIds) })
      .where(eq(messages.id, message.id));
    return { status: "no_change" };
  }

  const intentId = crypto.randomUUID();
  if (!(await stillCurrent(deps, job, correctionRevision))) {
    return { reason: "superseded_generation", status: "skipped" };
  }
  await deps.db.insert(labelMutations).values({
    addLabelIdsJson: JSON.stringify(diff.add),
    beforeLabelIdsJson: JSON.stringify(currentLabelIds),
    createdAt: deps.now(),
    desiredLabelIdsJson: JSON.stringify(desiredLabelIds(diff, currentLabelIds)),
    generation: job.generation,
    id: intentId,
    jobId: job.id,
    messageId: message.id,
    removeLabelIdsJson: JSON.stringify(diff.remove),
    status: "pending",
    updatedAt: deps.now(),
  });

  return await mutateLabels(
    deps,
    job,
    message,
    intentId,
    diff,
    currentLabelIds,
    approved,
    correctionRevision
  );
};
