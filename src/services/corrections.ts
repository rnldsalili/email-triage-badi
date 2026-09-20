import { eq } from "drizzle-orm";

import type { DecisionSet } from "../classifier/policy";
import type { Db } from "../db/client";
import { getLatestClassification } from "../db/repositories/classifications";
import { listCorrections } from "../db/repositories/corrections";
import type { Correction } from "../db/schema";
import { classifications, messages } from "../db/schema";
import { ACTION_KEYS } from "../taxonomy/labels";
import type { ActionKey, TopicKey } from "../taxonomy/labels";

export interface CorrectionReplacement {
  topic?: TopicKey | "other" | null;
  actions?: Partial<Record<ActionKey, boolean>>;
}

export const mergeCorrections = (
  classificationDecisions: DecisionSet,
  corrections: Correction[]
): DecisionSet => {
  const decisions: DecisionSet = structuredClone(classificationDecisions);
  const ordered = [...corrections].toSorted(
    (left, right) => left.revision - right.revision
  );

  for (const correction of ordered) {
    let replacement: CorrectionReplacement;
    try {
      replacement = JSON.parse(correction.replacementValuesJson) as CorrectionReplacement;
    } catch {
      continue;
    }

    if (replacement.topic !== undefined) {
      decisions.topic =
        replacement.topic === null
          ? {
              ...decisions.topic,
              confidence: 1,
              key: "other",
              probability: 1,
              status: "accepted",
              topKey: "other",
            }
          : {
              ...decisions.topic,
              confidence: 1,
              key: replacement.topic,
              probability: 1,
              status: "accepted",
              topKey: replacement.topic,
            };
    }

    for (const key of ACTION_KEYS) {
      const value = replacement.actions?.[key];
      if (value === undefined) {
        continue;
      }
      const decision = {
        probability: value ? 1 : 0,
        status: value ? ("positive" as const) : ("negative" as const),
      };
      if (key === "urgent") {
        decisions.urgent = decision;
      }
      if (key === "needs_reply") {
        decisions.needsReply = decision;
      }
      if (key === "to_do") {
        decisions.toDo = decision;
      }
    }
  }

  return decisions;
};

export const setDimensionLocks = async (
  db: Db,
  messageId: string,
  dimensions: string[]
): Promise<void> => {
  const rows = await db
    .select({ dimensionLocksJson: messages.dimensionLocksJson })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  const locks = JSON.parse(rows[0]?.dimensionLocksJson ?? "{}") as Record<
    string,
    { locked: boolean; userControlled: boolean }
  >;
  for (const dimension of dimensions) {
    locks[dimension] = { locked: true, userControlled: false };
  }
  await db
    .update(messages)
    .set({ dimensionLocksJson: JSON.stringify(locks) })
    .where(eq(messages.id, messageId));
};

export const persistEffectiveDecision = async (
  db: Db,
  accountId: string,
  messageId: string,
  now: number
): Promise<void> => {
  const classification = await getLatestClassification(db, messageId);
  if (!classification) {
    return;
  }
  let base: DecisionSet;
  try {
    base = JSON.parse(classification.decisionJson) as DecisionSet;
  } catch {
    return;
  }
  const corrections = await listCorrections(db, messageId);
  const decisions = mergeCorrections(base, corrections);
  const correctedDimensions = new Set(
    corrections.flatMap((correction) => {
      try {
        return JSON.parse(correction.changedDimensionsJson) as string[];
      } catch {
        return [];
      }
    })
  );
  const baseReasons = (() => {
    try {
      return JSON.parse(classification.reviewReasonsJson) as string[];
    } catch {
      return [];
    }
  })();
  const remainingReasons = baseReasons.filter(
    (reason) =>
      ![...correctedDimensions].some((dimension) => reason.startsWith(`${dimension}_`))
  );
  const derivedId = crypto.randomUUID();
  await db.insert(classifications).values({
    accountId,
    answerJson: classification.answerJson,
    applicationStatus: "corrected",
    createdAt: now,
    decisionJson: JSON.stringify(decisions),
    durationMs: classification.durationMs,
    id: derivedId,
    messageId,
    modelVersion: classification.modelVersion,
    normalizedInputHash: classification.normalizedInputHash,
    policyVersion: classification.policyVersion,
    reviewFlag: remainingReasons.length > 0,
    reviewReasonsJson: JSON.stringify(remainingReasons),
    rubricVersion: classification.rubricVersion,
    taxonomyVersion: classification.taxonomyVersion,
    usageJson: classification.usageJson,
  });
  await db
    .update(messages)
    .set({ latestClassificationId: derivedId })
    .where(eq(messages.id, messageId));
};
