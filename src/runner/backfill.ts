import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/client";
import { operations } from "../db/schema";
import type { Operation } from "../db/schema";
import { GmailError } from "../gmail/errors";
import type { GmailMessageRef } from "../gmail/types";
import { discoverMessageRef } from "../sync/gmail-sync";
import type { SyncDeps } from "../sync/gmail-sync";
import { admit, DeferredWorkError } from "./guard";
import { STAGE_ESTIMATES_MS } from "./time-budget";

export const backfillRequestSchema = z
  .object({
    maxMessages: z.number().int().positive(),
    receivedAfter: z.iso.datetime(),
    receivedBefore: z.iso.datetime(),
  })
  .refine((value) => Date.parse(value.receivedBefore) > Date.parse(value.receivedAfter), {
    message: "receivedBefore must be after receivedAfter",
  });

export interface BackfillProgress {
  pageToken?: string | null;
  discovered?: number;
  capped?: boolean;
}

export interface BackfillOutcome {
  processed: number;
  completed: number;
  deferred: number;
  failed: number;
}

const PAGE_SIZE = 100;

interface BackfillPage {
  messages: GmailMessageRef[];
  nextPageToken?: string;
}

const fetchBackfillPage = async (
  deps: SyncDeps,
  query: string,
  pageToken: string | undefined
): Promise<BackfillPage | { reset: true }> => {
  try {
    const page = await deps.client.listMessages({
      maxResults: PAGE_SIZE,
      pageToken,
      query,
    });
    return { messages: page.messages ?? [], nextPageToken: page.nextPageToken };
  } catch (error) {
    if (pageToken && error instanceof GmailError && error.reason === "invalid_request") {
      return { reset: true };
    }
    throw error;
  }
};

const discoverBackfillRefs = async (
  deps: SyncDeps,
  messages: GmailMessageRef[],
  range: { after: number; before: number; maxMessages: number },
  startingDiscovered: number
): Promise<{ discovered: number } | "budget_exhausted"> => {
  let discovered = startingDiscovered;
  for await (const ref of messages) {
    if (discovered >= range.maxMessages) {
      break;
    }
    if (!deps.budget.canSpend(STAGE_ESTIMATES_MS.messageFetch, deps.now())) {
      return "budget_exhausted";
    }
    const result = await discoverMessageRef(deps, ref, {
      maxReceivedAt: range.before,
      minReceivedAt: range.after,
    });
    if (result === "budget_exhausted") {
      return "budget_exhausted";
    }
    if (result === "created") {
      discovered += 1;
    }
  }
  return { discovered };
};

const updateOperation = async (
  db: Db,
  id: string,
  update: Partial<{
    status: Operation["status"];
    startedAt: number | null;
    completedAt: number | null;
    progressJson: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    updatedAt: number;
  }>
): Promise<void> => {
  await db.update(operations).set(update).where(eq(operations.id, id));
};

const failOperation = async (
  deps: SyncDeps,
  operation: Operation,
  code: string,
  now: number
): Promise<void> => {
  await updateOperation(deps.db, operation.id, {
    completedAt: now,
    lastErrorCode: code,
    lastErrorMessage: "Backfill stopped; see server logs for details",
    status: "failed",
    updatedAt: now,
  });
};

const handleBackfillFailure = async (
  deps: SyncDeps,
  operation: Operation,
  error: unknown,
  outcome: BackfillOutcome
): Promise<BackfillOutcome> => {
  if (error instanceof DeferredWorkError) {
    if (error.reason === "lease_lost") {
      throw error;
    }
    return { ...outcome, deferred: outcome.deferred + 1 };
  }
  const code = error instanceof GmailError ? error.reason : "backfill_failed";
  await failOperation(deps, operation, code, deps.now());
  return { ...outcome, failed: outcome.failed + 1 };
};

const getNextBackfill = async (db: Db): Promise<Operation | undefined> => {
  const rows = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.kind, "backfill"),
        inArray(operations.status, ["queued", "running"])
      )
    )
    .orderBy(asc(operations.createdAt))
    .limit(1);
  return rows[0];
};

const checkpointProgress = async (
  deps: SyncDeps,
  operation: Operation,
  progress: BackfillProgress
): Promise<void> => {
  await admit(deps);
  await updateOperation(deps.db, operation.id, {
    progressJson: JSON.stringify(progress),
    updatedAt: deps.now(),
  });
};

const completeOperation = async (
  deps: SyncDeps,
  operation: Operation,
  progress: BackfillProgress
): Promise<void> => {
  await updateOperation(deps.db, operation.id, {
    completedAt: deps.now(),
    progressJson: JSON.stringify(progress),
    status: "completed",
    updatedAt: deps.now(),
  });
};

export const processQueuedBackfills = async (
  deps: SyncDeps
): Promise<BackfillOutcome> => {
  const outcome: BackfillOutcome = { completed: 0, deferred: 0, failed: 0, processed: 0 };
  const operation = await getNextBackfill(deps.db);
  if (!operation) {
    return outcome;
  }

  const request = backfillRequestSchema.safeParse(
    JSON.parse(operation.requestJson || "{}")
  );
  if (!request.success) {
    await failOperation(deps, operation, "invalid_backfill_request", deps.now());
    return { ...outcome, failed: 1 };
  }

  const progress: BackfillProgress = JSON.parse(operation.progressJson ?? "{}");
  const after = Date.parse(request.data.receivedAfter);
  const before = Date.parse(request.data.receivedBefore);
  const maxMessages = Math.min(
    request.data.maxMessages,
    deps.config.limits.maxBackfillMessages
  );

  await updateOperation(deps.db, operation.id, {
    startedAt: operation.startedAt ?? deps.now(),
    status: "running",
    updatedAt: deps.now(),
  });

  const query = `in:inbox after:${Math.floor(after / 1000)} before:${Math.ceil(before / 1000)}`;
  const range = { after, before, maxMessages };

  const advance = async (
    token: string | undefined,
    discoveredSoFar: number
  ): Promise<BackfillOutcome> => {
    if (!deps.budget.canSpend(STAGE_ESTIMATES_MS.backfillPage, deps.now())) {
      await checkpointProgress(deps, operation, {
        discovered: discoveredSoFar,
        pageToken: token,
      });
      return { ...outcome, deferred: 1 };
    }

    await admit(deps, STAGE_ESTIMATES_MS.backfillPage);
    const page = await fetchBackfillPage(deps, query, token);
    if ("reset" in page) {
      await checkpointProgress(deps, operation, {
        discovered: discoveredSoFar,
        pageToken: null,
      });
      return { ...outcome, deferred: 1 };
    }

    const pageResult = await discoverBackfillRefs(
      deps,
      page.messages,
      range,
      discoveredSoFar
    );
    if (pageResult === "budget_exhausted") {
      await checkpointProgress(deps, operation, {
        discovered: discoveredSoFar,
        pageToken: token,
      });
      return { ...outcome, deferred: 1 };
    }
    const { discovered } = pageResult;

    const nextToken = page.nextPageToken;
    const atCap = discovered >= maxMessages;
    if (atCap || !nextToken) {
      await completeOperation(deps, operation, {
        capped: atCap,
        discovered,
        pageToken: null,
      });
      return {
        ...outcome,
        completed: 1,
        processed: discovered,
      };
    }

    await checkpointProgress(deps, operation, { discovered, pageToken: nextToken });
    return await advance(nextToken, discovered);
  };

  try {
    return await advance(progress.pageToken ?? undefined, progress.discovered ?? 0);
  } catch (error) {
    return await handleBackfillFailure(deps, operation, error, outcome);
  }
};
