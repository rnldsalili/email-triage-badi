import { vi } from "vitest";

import type {
  LabelsResponse,
  MessageDetail,
  MessageListItem,
  StatusResponse,
  UiConfig,
} from "../src/types";

export const statusFixture = (
  overrides: Partial<StatusResponse> = {}
): StatusResponse => ({
  aiBudget: {
    deferredJobs: 0,
    limit: 500,
    resetsAt: "2026-09-22T00:00:00.000Z",
    used: 12,
  },
  jobs: { deferredByBudget: 0, due: 0, failed: 0, queued: 3 },
  labels: { conflicts: 0, mapped: 15, migration: "ready" },
  lastCompletionAt: "2026-09-21T08:00:00.000Z",
  lastError: null,
  mailbox: {
    authStatus: "ok",
    email: "owner@example.test",
    lastSyncAt: "2026-09-21T08:00:00.000Z",
    syncPhase: "incremental",
  },
  messages: { metadataErrors: 0, missingMetadata: 2 },
  mode: "dry_run",
  operations: { failed: 0, queued: 0 },
  updatedAt: "2026-09-21T08:05:00.000Z",
  versions: {
    build: "test-build",
    model: "typesafe/jev",
    policy: "policy-v1",
    rubric: "rubric-v1",
    taxonomy: "taxonomy-v1",
  },
  ...overrides,
});

export const configFixture: UiConfig = {
  limits: {
    detailRetentionDays: 90,
    maxAiCallsPerDay: 500,
    maxBackfillMessages: 5000,
    maxMetadataRefreshPerTick: 25,
  },
  modes: ["paused", "dry_run", "apply"],
  owner: { email: "owner@example.test", timeZone: "Asia/Manila" },
};

export const messageFixture = (
  overrides: Partial<MessageListItem> = {}
): MessageListItem => ({
  actions: { needs_reply: true, to_do: null, urgent: false },
  applicationStatus: "not_applied_dry_run",
  classificationId: "classification-1",
  classifiedAt: "2026-09-21T07:00:00.000Z",
  from: "Sender <sender@example.test>",
  messageId: "gm-1",
  metadataState: "available",
  model: "jev-1.13.0",
  needsReview: true,
  policyVersion: "policy-v1",
  processingStatus: "completed",
  receivedAt: "2026-09-21T06:59:00.000Z",
  reviewReasons: ["to_do_uncertain"],
  rubricVersion: "rubric-v1",
  subject: "Invoice for September",
  taxonomyVersion: "taxonomy-v1",
  threadId: "thread-1",
  topic: "bills",
  topicDecisionStatus: "accepted",
  ...overrides,
});

export const detailFixture = (overrides: Partial<MessageDetail> = {}): MessageDetail => ({
  ...messageFixture(),
  answers: {},
  corrections: [],
  gmailMetadata: {
    errorCode: null,
    fetchedAt: "2026-09-21T08:00:00.000Z",
    from: "Sender <sender@example.test>",
    status: "available",
    subject: "Invoice for September",
  },
  job: {
    attempts: 1,
    deferredReason: null,
    errorCode: null,
    errorMessage: null,
    id: "job-1",
    kind: "initial",
    nextAttemptAt: null,
    stage: "completed",
    updatedAt: "2026-09-21T07:00:00.000Z",
  },
  ownership: {
    appOwnedLabelIds: [],
    dimensionStates: {},
    lastObservedLabelIds: [],
  },
  ...overrides,
});

export const labelsFixture: LabelsResponse = {
  conflicts: [],
  definitions: [
    { key: "bills", kind: "topic", name: "Bills" },
    { key: "work", kind: "topic", name: "Work" },
    { key: "urgent", kind: "action", name: "Actions/Urgent" },
    { key: "needs_reply", kind: "action", name: "Actions/Needs reply" },
    { key: "to_do", kind: "action", name: "Actions/To do" },
  ],
  legacyMappings: [],
  mappings: [
    {
      aliasIds: [],
      currentName: "Bills",
      gmailLabelId: "Label_1",
      migrationState: "ready",
      semanticKey: "bills",
    },
  ],
  parentContainers: ["Topics", "Actions"],
};

export interface StubCall {
  body: unknown;
  method: string;
  path: string;
}

export type StubHandler = (init: RequestInit) => Response | Promise<Response>;

const resolveUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

export const stubFetch = (handlers: Record<string, StubHandler>) => {
  const calls: StubCall[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(resolveUrl(input), "http://localhost");
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
        method,
        path: `${url.pathname}${url.search}`,
      });
      const handler =
        handlers[`${method} ${url.pathname}`] ??
        handlers[`${method} ${url.pathname}${url.search}`];
      if (!handler) {
        throw new Error(`unexpected fetch ${method} ${url.pathname}${url.search}`);
      }
      return await handler(init);
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
};

export const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, {
    headers: { "content-type": "application/json" },
    status,
  });
