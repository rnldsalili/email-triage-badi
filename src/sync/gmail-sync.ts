import type { AppConfig } from "../config/env";
import type { Db } from "../db/client";
import { createInitialJob } from "../db/repositories/jobs";
import type { LeaseFence } from "../db/repositories/leases";
import {
  commitHistoryCursor,
  getMailbox,
  updateMailboxScanState,
} from "../db/repositories/mailboxes";
import {
  getMessageByGmailId,
  upsertDiscoveredMessage,
} from "../db/repositories/messages";
import type { Mailbox } from "../db/schema";
import type { GmailClient } from "../gmail/client";
import { GmailError } from "../gmail/errors";
import type {
  GmailHistoryList,
  GmailMessage,
  GmailMessageList,
  GmailMessageRef,
} from "../gmail/types";
import { admit, DeferredWorkError } from "../runner/guard";
import { STAGE_ESTIMATES_MS } from "../runner/time-budget";
import type { TimeBudget } from "../runner/time-budget";

export interface SyncDeps {
  db: Db;
  client: GmailClient;
  config: AppConfig;
  accountId: string;
  now: () => number;
  budget: TimeBudget;
  fence?: LeaseFence;
}

const saveScan = async (
  deps: SyncDeps,
  id: string,
  update: Parameters<typeof updateMailboxScanState>[2]
) => {
  await admit(deps);
  await updateMailboxScanState(deps.db, id, update, deps.fence);
};

class ExpiredHistoryError extends Error {
  constructor() {
    super("Gmail history cursor expired");
    this.name = "ExpiredHistoryError";
  }
}

export interface SyncResult {
  phase: string;
  discovered: number;
  completed: boolean;
  deferred: boolean;
  recoveryStarted: boolean;
}

export type DiscoveryOutcome = "created" | "filtered" | "budget_exhausted";

const PAGE_SIZE = 100;
const INBOX_LABEL = "INBOX";

export const buildInboxQuery = (cutoffMs: number | null): string => {
  if (cutoffMs === null) {
    return `in:${INBOX_LABEL}`;
  }
  return `in:${INBOX_LABEL} after:${Math.floor(cutoffMs / 1000)}`;
};

const cutoffFromQuery = (query: string | null): number | null => {
  if (!query) {
    return null;
  }
  const match = /after:(?<historyId>\d+)/u.exec(query);
  if (!match?.groups?.historyId) {
    return null;
  }
  return Number(match.groups.historyId) * 1000;
};

const isInboxMessage = (message: GmailMessage): boolean =>
  (message.labelIds ?? []).includes(INBOX_LABEL);

const dedupeRefs = (refs: GmailMessageRef[]): GmailMessageRef[] => {
  const seen = new Set<string>();
  const unique: GmailMessageRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) {
      continue;
    }
    seen.add(ref.id);
    unique.push(ref);
  }
  return unique;
};

const ensureInitialJob = (deps: SyncDeps, messageId: string): Promise<boolean> =>
  createInitialJob(deps.db, {
    accountId: deps.accountId,
    id: crypto.randomUUID(),
    messageId,
    now: deps.now(),
  });

const collectHistoryRefs = (page: GmailHistoryList): GmailMessageRef[] => {
  const refs: GmailMessageRef[] = [];
  for (const event of page.history ?? []) {
    for (const added of event.messagesAdded ?? []) {
      refs.push(added.message);
    }
    for (const labelled of event.labelsAdded ?? []) {
      if (labelled.labelIds.includes(INBOX_LABEL)) {
        refs.push(labelled.message);
      }
    }
  }
  return refs;
};

const outsideReceivedWindow = (
  receivedAt: number | null,
  options: { minReceivedAt?: number | null; maxReceivedAt?: number | null }
): boolean => {
  if (receivedAt === null) {
    return false;
  }
  const { minReceivedAt, maxReceivedAt } = options;
  if (
    minReceivedAt !== null &&
    minReceivedAt !== undefined &&
    receivedAt < minReceivedAt
  ) {
    return true;
  }
  return (
    maxReceivedAt !== null && maxReceivedAt !== undefined && receivedAt >= maxReceivedAt
  );
};

export const discoverMessageRef = async (
  deps: SyncDeps,
  ref: GmailMessageRef,
  options: { minReceivedAt?: number | null; maxReceivedAt?: number | null } = {}
): Promise<DiscoveryOutcome> => {
  // Stored refs are re-checked from D1 only. Re-walking a page must not depend on
  // the Gmail fetch allowance or a page can never finish within a tick.
  const existing = await getMessageByGmailId(deps.db, deps.accountId, ref.id);
  if (existing) {
    if (outsideReceivedWindow(existing.receivedAt, options)) {
      return "filtered";
    }
    await admit(deps);
    return (await ensureInitialJob(deps, existing.id)) ? "created" : "filtered";
  }
  if (!deps.budget.canSpend(STAGE_ESTIMATES_MS.messageFetch, deps.now())) {
    return "budget_exhausted";
  }
  await admit(deps, STAGE_ESTIMATES_MS.messageFetch);
  let message: GmailMessage;
  try {
    message = await deps.client.getMessage(ref.id, "minimal");
  } catch (error) {
    if (error instanceof GmailError && error.reason === "not_found") {
      return "filtered";
    }
    throw error;
  }
  await admit(deps);
  if (!isInboxMessage(message)) {
    return "filtered";
  }

  const receivedAt = message.internalDate ? Number(message.internalDate) : null;
  if (outsideReceivedWindow(receivedAt, options)) {
    return "filtered";
  }

  const receivedValue =
    receivedAt !== null && Number.isFinite(receivedAt) ? receivedAt : deps.now();
  const { message: stored } = await upsertDiscoveredMessage(deps.db, {
    accountId: deps.accountId,
    gmailMessageId: ref.id,
    id: crypto.randomUUID(),
    now: deps.now(),
    receivedAt: receivedValue,
    threadId: message.threadId ?? ref.threadId,
  });
  return (await ensureInitialJob(deps, stored.id)) ? "created" : "filtered";
};

type HistoryPageResult = { page: GmailHistoryList } | { reset: true };

const fetchHistoryPage = async (
  deps: SyncDeps,
  mailboxId: string,
  startCursor: string,
  pageToken: string | undefined
): Promise<HistoryPageResult> => {
  try {
    const page = await deps.client.listHistory({
      historyTypes: ["messageAdded", "labelAdded"],
      maxResults: PAGE_SIZE,
      pageToken,
      startHistoryId: startCursor,
    });
    return { page };
  } catch (error) {
    if (error instanceof GmailError && error.reason === "not_found") {
      throw new ExpiredHistoryError();
    }
    if (pageToken && error instanceof GmailError && error.reason === "invalid_request") {
      await saveScan(deps, mailboxId, { historyPageToken: null, now: deps.now() });
      return { reset: true };
    }
    throw error;
  }
};

const discoverHistoryRefs = async (
  deps: SyncDeps,
  refs: GmailMessageRef[]
): Promise<number | null> => {
  let discovered = 0;
  for await (const ref of dedupeRefs(refs)) {
    const result = await discoverMessageRef(deps, ref);
    if (result === "budget_exhausted") {
      return null;
    }
    if (result === "created") {
      discovered += 1;
    }
  }
  return discovered;
};

const advanceHistory = async (
  deps: SyncDeps,
  mailbox: Mailbox,
  startCursor: string,
  pageToken: string | undefined,
  discovered: number
): Promise<{ discovered: number; completed: boolean; deferred: boolean }> => {
  if (!deps.budget.canSpend(STAGE_ESTIMATES_MS.discoveryPage, deps.now())) {
    return { completed: false, deferred: true, discovered };
  }
  await admit(deps, STAGE_ESTIMATES_MS.discoveryPage);
  const result = await fetchHistoryPage(deps, mailbox.id, startCursor, pageToken);
  if ("reset" in result) {
    return { completed: false, deferred: true, discovered };
  }
  const { page } = result;

  const pageDiscovered = await discoverHistoryRefs(deps, collectHistoryRefs(page));
  if (pageDiscovered === null) {
    return { completed: false, deferred: true, discovered };
  }
  const totalDiscovered = discovered + pageDiscovered;

  const nextToken = page.nextPageToken;
  await saveScan(deps, mailbox.id, {
    historyPageToken: nextToken ?? null,
    now: deps.now(),
  });

  if (nextToken) {
    return await advanceHistory(deps, mailbox, startCursor, nextToken, totalDiscovered);
  }
  await commitHistoryCursor(
    deps.db,
    mailbox.id,
    page.historyId ?? startCursor,
    deps.now(),
    deps.fence
  );
  return { completed: true, deferred: false, discovered: totalDiscovered };
};

export const traverseHistory = async (
  deps: SyncDeps,
  mailbox: Mailbox,
  startCursor: string
): Promise<{ discovered: number; completed: boolean; deferred: boolean }> =>
  await advanceHistory(
    deps,
    mailbox,
    startCursor,
    mailbox.historyPageToken ?? undefined,
    0
  );

export const startRecovery = async (deps: SyncDeps, mailbox: Mailbox): Promise<void> => {
  await admit(deps, STAGE_ESTIMATES_MS.discoveryPage);
  const profile = await deps.client.getProfile();
  await saveScan(deps, mailbox.id, {
    historyPageToken: null,
    now: deps.now(),
    phase: "recovery_scan",
    scanAnchorHistoryId: profile.historyId,
    scanPageToken: null,
    scanQuery: buildInboxQuery(null),
  });
};

export const runIncrementalSync = async (deps: SyncDeps): Promise<SyncResult> => {
  const mailbox = await getMailbox(deps.db);
  if (!mailbox?.committedHistoryId) {
    return {
      completed: false,
      deferred: false,
      discovered: 0,
      phase: "incremental",
      recoveryStarted: false,
    };
  }

  try {
    const outcome = await traverseHistory(deps, mailbox, mailbox.committedHistoryId);
    return {
      completed: outcome.completed,
      deferred: outcome.deferred,
      discovered: outcome.discovered,
      phase: "incremental",
      recoveryStarted: false,
    };
  } catch (error) {
    if (error instanceof DeferredWorkError && error.reason === "wall_time") {
      return {
        completed: false,
        deferred: true,
        discovered: 0,
        phase: "incremental",
        recoveryStarted: false,
      };
    }
    if (error instanceof ExpiredHistoryError) {
      await startRecovery(deps, mailbox);
      return {
        completed: false,
        deferred: false,
        discovered: 0,
        phase: "recovery_scan",
        recoveryStarted: true,
      };
    }
    throw error;
  }
};

const catchupOrRecover = async (deps: SyncDeps, mailbox: Mailbox, anchor: string) => {
  try {
    return await traverseHistory(deps, mailbox, anchor);
  } catch (error) {
    if (!(error instanceof ExpiredHistoryError)) {
      throw error;
    }
    await startRecovery(deps, mailbox);
    return { completed: false, deferred: true, discovered: 0 };
  }
};

const fetchScanPage = async (
  deps: SyncDeps,
  mailbox: Mailbox,
  pageToken: string | undefined
): Promise<{ page: GmailMessageList; reset: boolean }> => {
  try {
    const page = await deps.client.listMessages({
      maxResults: PAGE_SIZE,
      pageToken,
      query: mailbox.scanQuery ?? buildInboxQuery(null),
    });
    return { page, reset: false };
  } catch (error) {
    if (pageToken && error instanceof GmailError && error.reason === "invalid_request") {
      await saveScan(deps, mailbox.id, { now: deps.now(), scanPageToken: null });
      return { page: { messages: [] }, reset: true };
    }
    throw error;
  }
};

const advanceScan = async (
  deps: SyncDeps,
  mailbox: Mailbox,
  cutoff: number | null,
  pageToken: string | undefined,
  discovered: number
): Promise<{ discovered: number; completed: boolean; deferred: boolean }> => {
  if (!deps.budget.canSpend(STAGE_ESTIMATES_MS.discoveryPage, deps.now())) {
    return { completed: false, deferred: true, discovered };
  }
  await admit(deps, STAGE_ESTIMATES_MS.discoveryPage);
  const { page, reset } = await fetchScanPage(deps, mailbox, pageToken);
  if (reset) {
    return { completed: false, deferred: true, discovered };
  }

  let totalDiscovered = discovered;
  for await (const ref of page.messages ?? []) {
    const result = await discoverMessageRef(deps, ref, { minReceivedAt: cutoff });
    if (result === "budget_exhausted") {
      return { completed: false, deferred: true, discovered: totalDiscovered };
    }
    if (result === "created") {
      totalDiscovered += 1;
    }
  }

  const nextToken = page.nextPageToken;
  await saveScan(deps, mailbox.id, {
    now: deps.now(),
    scanPageToken: nextToken ?? null,
  });

  if (!nextToken) {
    return { completed: true, deferred: false, discovered: totalDiscovered };
  }
  return await advanceScan(deps, mailbox, cutoff, nextToken, totalDiscovered);
};

const runInboxScan = async (
  deps: SyncDeps,
  mailbox: Mailbox
): Promise<{ discovered: number; completed: boolean; deferred: boolean }> =>
  await advanceScan(
    deps,
    mailbox,
    cutoffFromQuery(mailbox.scanQuery),
    mailbox.scanPageToken ?? undefined,
    0
  );

export const runBootstrap = async (deps: SyncDeps): Promise<SyncResult> => {
  let mailbox = await getMailbox(deps.db);
  if (!mailbox) {
    return {
      completed: false,
      deferred: false,
      discovered: 0,
      phase: "idle",
      recoveryStarted: false,
    };
  }

  if (!mailbox.scanAnchorHistoryId) {
    await admit(deps, STAGE_ESTIMATES_MS.discoveryPage);
    const profile = await deps.client.getProfile();
    const cutoff = deps.now() - deps.config.defaults.initialLookbackDays * 86_400_000;
    await saveScan(deps, mailbox.id, {
      historyPageToken: null,
      now: deps.now(),
      phase: "bootstrap_scan",
      scanAnchorHistoryId: profile.historyId,
      scanPageToken: null,
      scanQuery: buildInboxQuery(cutoff),
    });
    mailbox = (await getMailbox(deps.db)) ?? mailbox;
  }

  let discovered = 0;
  if (mailbox.syncPhase !== "bootstrap_catchup") {
    const scanOutcome = await runInboxScan(deps, mailbox);
    discovered += scanOutcome.discovered;
    if (!scanOutcome.completed) {
      return {
        completed: false,
        deferred: scanOutcome.deferred,
        discovered,
        phase: "bootstrap_scan",
        recoveryStarted: false,
      };
    }
    await saveScan(deps, mailbox.id, {
      now: deps.now(),
      phase: "bootstrap_catchup",
      scanPageToken: null,
    });
  }

  const refreshed = (await getMailbox(deps.db)) ?? mailbox;
  const anchor = refreshed.scanAnchorHistoryId;
  if (!anchor) {
    return {
      completed: false,
      deferred: false,
      discovered,
      phase: "bootstrap_catchup",
      recoveryStarted: false,
    };
  }

  const catchup = await catchupOrRecover(deps, refreshed, anchor);
  return {
    completed: catchup.completed,
    deferred: catchup.deferred,
    discovered: discovered + catchup.discovered,
    phase: "bootstrap_catchup",
    recoveryStarted: false,
  };
};

export const runRecovery = async (deps: SyncDeps): Promise<SyncResult> => {
  let mailbox = await getMailbox(deps.db);
  if (!mailbox) {
    return {
      completed: false,
      deferred: false,
      discovered: 0,
      phase: "idle",
      recoveryStarted: false,
    };
  }

  let discovered = 0;
  if (mailbox.syncPhase !== "recovery_catchup") {
    const scanOutcome = await runInboxScan(deps, mailbox);
    discovered += scanOutcome.discovered;
    if (!scanOutcome.completed) {
      return {
        completed: false,
        deferred: scanOutcome.deferred,
        discovered,
        phase: "recovery_scan",
        recoveryStarted: false,
      };
    }
    await saveScan(deps, mailbox.id, {
      now: deps.now(),
      phase: "recovery_catchup",
      scanPageToken: null,
    });
  }

  mailbox = (await getMailbox(deps.db)) ?? mailbox;
  const anchor = mailbox.scanAnchorHistoryId;
  if (!anchor) {
    return {
      completed: false,
      deferred: false,
      discovered,
      phase: "recovery_catchup",
      recoveryStarted: false,
    };
  }

  const catchup = await catchupOrRecover(deps, mailbox, anchor);
  return {
    completed: catchup.completed,
    deferred: catchup.deferred,
    discovered: discovered + catchup.discovered,
    phase: "recovery_catchup",
    recoveryStarted: false,
  };
};
