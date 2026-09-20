import { and, desc, eq } from "drizzle-orm";

import type { ClassificationOutcome } from "../../classifier/jev";
import type { Db } from "../client";
import { classifications, messages, jobs } from "../schema";
import type { Classification, Job } from "../schema";
import { leasePredicate } from "./leases";
import type { LeaseFence } from "./leases";

export interface PersistClassificationInput {
  id: string;
  accountId: string;
  messageId: string;
  outcome: ClassificationOutcome;
  applicationStatus: string;
  now: number;
  job?: Job;
  fence?: LeaseFence;
}

export const createClassification = async (
  db: Db,
  input: PersistClassificationInput
): Promise<Classification> => {
  const { outcome } = input;
  const insert = db
    .insert(classifications)
    .values({
      accountId: input.accountId,
      answerJson: JSON.stringify(outcome.answers),
      applicationStatus: input.applicationStatus,
      createdAt: input.now,
      decisionJson: JSON.stringify(outcome.decisions),
      durationMs: outcome.durationMs,
      id: input.id,
      messageId: input.messageId,
      modelVersion: outcome.modelVersion,
      normalizedInputHash: outcome.normalizedInputHash,
      policyVersion: outcome.policyVersion,
      reviewFlag: outcome.decisions.needsReview,
      reviewReasonsJson: JSON.stringify(outcome.decisions.reviewReasons),
      rubricVersion: outcome.rubricVersion,
      taxonomyVersion: outcome.taxonomyVersion,
      usageJson: JSON.stringify(outcome.usage),
    })
    .returning();
  const results = input.job
    ? await db.batch([
        insert,
        db
          .update(jobs)
          .set({
            payloadJson: JSON.stringify({ classificationId: input.id }),
            stage: "classified",
            updatedAt: input.now,
          })
          .where(
            and(
              eq(jobs.id, input.job.id),
              eq(jobs.leaseToken, input.job.leaseToken ?? ""),
              leasePredicate(input.fence, input.now)
            )
          ),
        db
          .update(messages)
          .set({ latestClassificationId: input.id })
          .where(
            and(
              eq(messages.id, input.messageId),
              eq(messages.lastGeneration, input.job.generation),
              leasePredicate(input.fence, input.now)
            )
          ),
      ])
    : [await insert];
  const [rows] = results;
  const [row] = rows;
  if (!row) {
    throw new Error("classification insert returned no row");
  }
  return row;
};

export const getLatestClassification = async (
  db: Db,
  messageId: string
): Promise<Classification | undefined> => {
  const rows = await db
    .select()
    .from(classifications)
    .where(eq(classifications.messageId, messageId))
    .orderBy(desc(classifications.createdAt))
    .limit(1);
  return rows[0];
};

export const getClassificationById = async (
  db: Db,
  id: string
): Promise<Classification | undefined> => {
  const rows = await db
    .select()
    .from(classifications)
    .where(eq(classifications.id, id))
    .limit(1);
  return rows[0];
};

export const attachLatestClassification = async (
  db: Db,
  messageId: string,
  classificationId: string
): Promise<void> => {
  await db
    .update(messages)
    .set({ latestClassificationId: classificationId })
    .where(eq(messages.id, messageId));
};
