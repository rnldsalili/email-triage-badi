export type Mode = "paused" | "dry_run" | "apply";

export interface StatusResponse {
  aiBudget: {
    deferredJobs: number;
    limit: number;
    resetsAt: string;
    used: number;
  };
  jobs: { queued: number; due: number; failed: number; deferredByBudget: number };
  labels: { migration: string; mapped: number; conflicts: number };
  lastCompletionAt: string | null;
  lastError: { code: string; at: string } | null;
  mailbox: {
    authStatus: string;
    email: string;
    lastSyncAt: string | null;
    syncPhase: string;
  } | null;
  messages: { metadataErrors: number; missingMetadata: number };
  mode: Mode;
  operations: { queued: number; failed: number };
  updatedAt: string;
  versions: {
    build: string;
    model: string;
    policy: string;
    rubric: string;
    taxonomy: string;
  };
}

export interface UiConfig {
  limits: {
    detailRetentionDays: number;
    maxAiCallsPerDay: number;
    maxBackfillMessages: number;
    maxMetadataRefreshPerTick: number;
  };
  modes: Mode[];
  owner: { email: string; timeZone: string };
}

export interface MessageListItem {
  actions: { needs_reply: boolean | null; to_do: boolean | null; urgent: boolean | null };
  applicationStatus: string;
  classificationId: string | null;
  classifiedAt: string | null;
  from: string | null;
  messageId: string;
  metadataState: string;
  model: string | null;
  needsReview: boolean;
  policyVersion: string | null;
  processingStatus: string;
  receivedAt: string;
  reviewReasons: string[];
  rubricVersion: string | null;
  subject: string | null;
  taxonomyVersion: string | null;
  threadId: string;
  topic: string | null;
  topicDecisionStatus: string | null;
}

export interface MessageListResponse {
  items: MessageListItem[];
  nextCursor: string | null;
}

export interface MessageDetail extends MessageListItem {
  answers: unknown;
  corrections: {
    changedDimensions: string[];
    createdAt: string;
    id: string;
    note: string | null;
    replacementValues: unknown;
    revision: number;
  }[];
  gmailMetadata: {
    errorCode: string | null;
    fetchedAt: string | null;
    from: string | null;
    status: string;
    subject: string | null;
  };
  job: {
    attempts: number;
    deferredReason: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    id: string;
    kind: string;
    nextAttemptAt: string | null;
    stage: string;
    updatedAt: string;
  } | null;
  ownership: {
    appOwnedLabelIds: string[];
    dimensionStates: Record<string, { locked?: boolean }>;
    lastObservedLabelIds: string[];
  };
}

export interface OperationItem {
  completedAt: string | null;
  createdAt: string;
  id: string;
  kind: string;
  lastError: { code: string; message: string | null } | null;
  progress: Record<string, unknown> | null;
  request: Record<string, unknown> | null;
  startedAt: string | null;
  status: string;
}

export interface OperationListResponse {
  items: OperationItem[];
  nextCursor: string | null;
}

export interface LabelMapping {
  aliasIds: string[];
  currentName: string | null;
  gmailLabelId: string | null;
  migrationState: string;
  semanticKey: string;
}

export interface LabelsResponse {
  conflicts: string[];
  definitions: { key: string; kind: string; name: string }[];
  legacyMappings: { key: string; oldName: string }[];
  mappings: LabelMapping[];
  parentContainers: string[];
}
