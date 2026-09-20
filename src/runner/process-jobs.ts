import { eq } from "drizzle-orm";

import { classifyMessage } from "../classifier/jev";
import { JevResponseError } from "../classifier/schemas";
import type { AppConfig, Mode } from "../config/env";
import type { Db } from "../db/client";
import { reserveInferenceCall } from "../db/repositories/budget";
import { createClassification } from "../db/repositories/classifications";
import { getControl } from "../db/repositories/control";
import { updateJobProgress } from "../db/repositories/job-progress";
import { claimDueJobs } from "../db/repositories/jobs";
import type { LeaseFence } from "../db/repositories/leases";
import {
  getMessageById,
  setMessageApplicationStatus,
  setMessageProcessingStatus,
} from "../db/repositories/messages";
import type { Job } from "../db/schema";
import { mailboxes } from "../db/schema";
import { normalizeMessage } from "../email/normalize";
import type { GmailClient } from "../gmail/client";
import { GmailError } from "../gmail/errors";
import { applyClassifiedJob } from "../services/label-apply";
import {
  metadataFromMessage,
  persistMessageMetadata,
} from "../services/message-metadata";
import { InputLimitError } from "../utils/bounded-body";
import { nextUtcMidnight, utcDateString } from "../utils/time";
import { admit, DeferredWorkError } from "./guard";
import { STAGE_ESTIMATES_MS } from "./time-budget";
import type { TimeBudget } from "./time-budget";

export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000];
export const MAX_ATTEMPTS = 5;
const JOB_LEASE_MS = 180_000;

export interface ProcessDeps {
  db: Db;
  client: GmailClient;
  ai: Ai;
  config: AppConfig;
  accountId: string;
  mode: Mode;
  now: () => number;
  budget: TimeBudget;
  random?: () => number;
  fence?: LeaseFence;
}

export interface ProcessOutcome {
  processed: number;
  deferred: number;
  retried: number;
  failed: number;
  skipped: number;
  authRequired?: boolean;
  stoppedAfterTimeout?: boolean;
}

export const retryDelayMs = (
  attempts: number,
  random: () => number = Math.random
): number => {
  const base =
    RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 60_000;
  const jitter = base * 0.2;
  return Math.round(base - jitter + random() * 2 * jitter);
};

const isRetryable = (error: unknown): boolean => {
  if (error instanceof InputLimitError) {
    return false;
  }
  if (error instanceof GmailError) {
    return error.retryable || error.reason === "invalid_request";
  }
  if (error instanceof JevResponseError) {
    return true;
  }
  return true;
};

const errorCode = (error: unknown): string => {
  if (error instanceof InputLimitError) {
    return error.code;
  }
  if (error instanceof GmailError) {
    return error.reason;
  }
  if (error instanceof JevResponseError) {
    return "invalid_ai_response";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "ai_timeout";
  }
  return "unexpected_error";
};

const now = (deps: ProcessDeps): number => deps.now();

const applyOutcome = async (
  deps: ProcessDeps,
  job: Job,
  outcome: ProcessOutcome,
  ownerToken: string
): Promise<void> => {
  const result = await applyClassifiedJob(deps, job);
  if (result.status === "applied" || result.status === "no_change") {
    job.stage = "completed";
    await updateJobProgress(
      deps.db,
      job.id,
      { clearLease: true, deferredReason: null, now: deps.now(), stage: "completed" },
      ownerToken
    );
    outcome.processed += 1;
    if (job.messageId && result.status === "no_change") {
      await setMessageProcessingStatus(
        deps.db,
        job.messageId,
        "completed",
        job.generation
      );
      await setMessageApplicationStatus(
        deps.db,
        job.messageId,
        "no_change",
        job.generation
      );
    }
    return;
  }
  if (result.status === "skipped") {
    job.stage = "skipped";
    await updateJobProgress(
      deps.db,
      job.id,
      { clearLease: true, errorCode: result.reason, now: deps.now(), stage: "skipped" },
      ownerToken
    );
    outcome.skipped += 1;
    return;
  }
  job.stage = "classified";
  await updateJobProgress(
    deps.db,
    job.id,
    {
      attempts: Math.max(0, job.attempts - 1),
      clearLease: true,
      deferredReason: result.reason,
      nextAttemptAt: deps.now() + 300_000,
      now: deps.now(),
      stage: "classified",
    },
    ownerToken
  );
  outcome.deferred += 1;
};

const classifyJob = async (
  deps: ProcessDeps,
  job: Job,
  outcome: ProcessOutcome,
  ownerToken: string
): Promise<void> => {
  if (!job.messageId) {
    await updateJobProgress(
      deps.db,
      job.id,
      {
        clearLease: true,
        errorCode: "missing_message",
        now: deps.now(),
        stage: "skipped",
      },
      ownerToken
    );
    outcome.skipped += 1;
    return;
  }

  const message = await getMessageById(deps.db, job.messageId);
  if (!message) {
    await updateJobProgress(
      deps.db,
      job.id,
      {
        clearLease: true,
        errorCode: "message_record_missing",
        now: deps.now(),
        stage: "skipped",
      },
      ownerToken
    );
    outcome.skipped += 1;
    return;
  }

  await admit(deps, STAGE_ESTIMATES_MS.messageFetch);
  const full = await deps.client.getMessage(message.gmailMessageId, "full");
  if (!(full.labelIds ?? []).includes("INBOX")) {
    await updateJobProgress(
      deps.db,
      job.id,
      { clearLease: true, errorCode: "not_in_inbox", now: deps.now(), stage: "skipped" },
      ownerToken
    );
    await setMessageProcessingStatus(deps.db, message.id, "skipped", job.generation);
    outcome.skipped += 1;
    return;
  }

  job.stage = "classifying";
  const claimed = await updateJobProgress(
    deps.db,
    job.id,
    { now: deps.now(), stage: "classifying" },
    ownerToken
  );
  if (!claimed) {
    return;
  }

  await persistMessageMetadata(
    deps.db,
    message.id,
    metadataFromMessage(full, deps.now())
  );

  await admit(deps, STAGE_ESTIMATES_MS.classification);
  const normalized = await normalizeMessage(full, {
    fetchAttachmentData: async (attachmentId) => {
      await admit(deps, STAGE_ESTIMATES_MS.messageFetch);
      const attachment = await deps.client.getAttachment(
        message.gmailMessageId,
        attachmentId
      );
      return attachment.data;
    },
    maxBodyCharacters: deps.config.limits.maxBodyCharacters,
  });
  await admit(deps, STAGE_ESTIMATES_MS.classification);
  const reservation = await reserveInferenceCall(
    deps.db,
    deps.accountId,
    utcDateString(deps.now()),
    deps.config.limits.maxAiCallsPerDay,
    deps.now()
  );
  if (!reservation.reserved) {
    await updateJobProgress(
      deps.db,
      job.id,
      {
        attempts: Math.max(0, job.attempts - 1),
        clearLease: true,
        deferredReason: "ai_budget",
        nextAttemptAt: nextUtcMidnight(deps.now()),
        now: deps.now(),
        stage: "retry_wait",
      },
      ownerToken
    );
    outcome.deferred += 1;
    return;
  }

  await admit(deps, STAGE_ESTIMATES_MS.classification);
  const classification = await classifyMessage(
    deps.ai,
    normalized,
    deps.config,
    deps.now(),
    { gatewayId: deps.config.ai.gatewayId }
  );

  const stored = await createClassification(deps.db, {
    accountId: deps.accountId,
    applicationStatus: deps.mode === "dry_run" ? "not_applied_dry_run" : "proposed",
    fence: deps.fence,
    id: crypto.randomUUID(),
    job,
    messageId: message.id,
    now: deps.now(),
    outcome: classification,
  });

  job.stage = "classified";
  job.payloadJson = JSON.stringify({ classificationId: stored.id });
  await updateJobProgress(
    deps.db,
    job.id,
    {
      deferredReason: null,
      errorCode: null,
      errorMessage: null,
      now: deps.now(),
      stage: "classified",
    },
    ownerToken
  );

  if (deps.mode === "dry_run") {
    await updateJobProgress(
      deps.db,
      job.id,
      { clearLease: true, now: deps.now(), stage: "completed" },
      ownerToken
    );
    await setMessageProcessingStatus(deps.db, message.id, "completed", job.generation);
    await setMessageApplicationStatus(
      deps.db,
      message.id,
      "not_applied_dry_run",
      job.generation
    );
    outcome.processed += 1;
    return;
  }

  await setMessageProcessingStatus(deps.db, message.id, "classified", job.generation);
  await applyOutcome(deps, job, outcome, ownerToken);
};

const isApplicationJob = (job: Job) =>
  job.stage === "classified" ||
  job.stage === "applying" ||
  job.kind === "apply" ||
  job.kind === "correction";

const processJob = async (
  deps: ProcessDeps,
  job: Job,
  outcome: ProcessOutcome,
  ownerToken: string
): Promise<void> => {
  const current: Job = { ...job };
  try {
    if (isApplicationJob(current)) {
      await applyOutcome(deps, current, outcome, ownerToken);
      return;
    }
    if (current.kind === "initial" || current.kind === "reprocess") {
      await classifyJob(deps, current, outcome, ownerToken);
      return;
    }
    await updateJobProgress(
      deps.db,
      current.id,
      {
        clearLease: true,
        errorCode: "unsupported_kind",
        now: deps.now(),
        stage: "skipped",
      },
      ownerToken
    );
    outcome.skipped += 1;
  } catch (error) {
    if (error instanceof DeferredWorkError) {
      await updateJobProgress(
        deps.db,
        job.id,
        {
          attempts: Math.max(0, job.attempts - 1),
          clearLease: true,
          deferredReason: error.reason,
          nextAttemptAt: deps.now() + 300_000,
          now: deps.now(),
          stage: current.stage === "classifying" ? "retry_wait" : current.stage,
        },
        ownerToken
      );
      outcome.deferred += 1;
      if (error.reason === "lease_lost") {
        throw error;
      }
      return;
    }
    const { attempts } = job;
    const code = errorCode(error);
    const retryable = isRetryable(error);
    const retryOnce =
      error instanceof JevResponseError ||
      (error instanceof GmailError && error.reason === "invalid_request");
    if (code === "ai_timeout") {
      outcome.stoppedAfterTimeout = true;
    }
    const canRetry = retryable && (retryOnce ? attempts < 2 : attempts < MAX_ATTEMPTS);
    const classified = current.stage === "classified" || current.stage === "applying";
    const retryStage = classified ? "classified" : "retry_wait";

    if (
      error instanceof GmailError &&
      (error.reason === "auth_required" || error.reason === "auth_invalid")
    ) {
      await updateJobProgress(
        deps.db,
        job.id,
        {
          attempts: Math.max(0, attempts - 1),
          clearLease: true,
          errorCode: code,
          errorMessage: code,
          now: now(deps),
          stage: retryStage,
        },
        ownerToken
      );
      const mailboxRows = await deps.db.select().from(mailboxes).limit(1);
      const [mailbox] = mailboxRows;
      if (mailbox) {
        await deps.db
          .update(mailboxes)
          .set({ authStatus: "auth_required", updatedAt: deps.now() })
          .where(eq(mailboxes.id, mailbox.id));
      }
      outcome.authRequired = true;
      return;
    }

    if (canRetry) {
      await updateJobProgress(
        deps.db,
        job.id,
        {
          attempts,
          clearLease: true,
          errorCode: code,
          errorMessage: code,
          nextAttemptAt: now(deps) + retryDelayMs(attempts, deps.random),
          now: now(deps),
          stage: retryStage,
        },
        ownerToken
      );
      outcome.retried += 1;
      return;
    }

    await updateJobProgress(
      deps.db,
      job.id,
      {
        attempts,
        clearLease: true,
        errorCode: code,
        errorMessage: code,
        now: now(deps),
        stage: "failed",
      },
      ownerToken
    );
    outcome.failed += 1;
  }
};

export const processDueJobs = async (deps: ProcessDeps): Promise<ProcessOutcome> => {
  const outcome: ProcessOutcome = {
    deferred: 0,
    failed: 0,
    processed: 0,
    retried: 0,
    skipped: 0,
  };
  const ownerToken = crypto.randomUUID();

  const runTick = async (remaining: number): Promise<void> => {
    if (remaining <= 0) {
      return;
    }
    const { mode } = await getControl(deps.db);
    if (
      mode === "paused" ||
      !deps.budget.canSpend(STAGE_ESTIMATES_MS.mutation, deps.now())
    ) {
      return;
    }
    await admit(deps);
    const jobs = await claimDueJobs(deps.db, {
      accountId: deps.accountId,
      leaseMs: JOB_LEASE_MS,
      limit: 1,
      mode,
      now: deps.now(),
      ownerToken,
    });

    const [job] = jobs;
    if (!job) {
      return;
    }
    await processJob({ ...deps, mode }, job, outcome, ownerToken);
    if (outcome.authRequired || outcome.stoppedAfterTimeout) {
      return;
    }
    await runTick(remaining - 1);
  };

  await runTick(deps.config.limits.maxJobsPerTick);

  return outcome;
};
