import type {
  LabelsResponse,
  MessageDetail,
  MessageListResponse,
  Mode,
  OperationItem,
  OperationListResponse,
  StatusResponse,
  UiConfig,
} from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const unauthorizedListeners = new Set<() => void>();

/**
 * Notified when any request is rejected as unauthenticated, so the app can drop
 * back to the login screen when a session expires or the admin token rotates.
 */
export const onUnauthorized = (listener: () => void): (() => void) => {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
};

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unexpected error";

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

const request = async <T>(path: string, init: RequestOptions = {}): Promise<T> => {
  const { body: rawBody, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("x-etb-csrf", "dashboard");
  let body: BodyInit | undefined;
  if (rawBody !== undefined) {
    if (typeof rawBody === "string") {
      body = rawBody;
    } else {
      headers.set("content-type", "application/json");
      body = JSON.stringify(rawBody);
    }
  }
  const response = await fetch(path, {
    ...rest,
    body,
    credentials: "same-origin",
    headers,
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    if (response.status === 401) {
      for (const listener of unauthorizedListeners) {
        listener();
      }
    }
    const envelope = parsed as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? "INTERNAL_ERROR",
      envelope?.error?.message ?? `Request failed with status ${response.status}`
    );
  }
  return parsed as T;
};

const idempotencyHeaders = (key?: string): Record<string, string> =>
  key ? { "idempotency-key": key } : {};

export const getSession = () =>
  request<{ authenticated: boolean }>("/api/v1/auth/session");

export const login = (token: string) =>
  request<{ authenticated: boolean }>("/api/v1/auth/session", {
    body: { token },
    method: "POST",
  });

export const logout = () =>
  request<{ authenticated: boolean }>("/api/v1/auth/session", { method: "DELETE" });

export const getStatus = () => request<StatusResponse>("/api/v1/status");

export const getUiConfig = () => request<UiConfig>("/api/v1/config");

export const setMode = (mode: Mode) =>
  request<{ mode: Mode }>("/api/v1/settings", { body: { mode }, method: "PATCH" });

export const requestSync = () =>
  request<{ operationId: string }>("/api/v1/sync", { method: "POST" });

export const runNow = () =>
  request<{
    durationMs: number;
    mode: string | null;
    status: string;
    triggered: boolean;
  }>("/api/v1/run", { method: "POST" });

export const refreshMetadata = () =>
  request<{ errors: number; operationId: string; pending: number }>(
    "/api/v1/messages/metadata-refresh",
    { body: { retryErrors: true }, method: "POST" }
  );

export const requestBackfill = (
  input: {
    maxMessages: number;
    receivedAfter: string;
    receivedBefore: string;
  },
  idempotencyKey?: string
) =>
  request<{ operationId: string }>("/api/v1/backfills", {
    body: input,
    headers: idempotencyHeaders(idempotencyKey),
    method: "POST",
  });

export interface MessageQuery {
  cursor?: string | null;
  limit?: number;
  needsReview?: boolean;
  processingStatus?: string;
  topic?: string;
}

export const listMessages = (query: MessageQuery) => {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 25));
  if (query.cursor) {
    params.set("cursor", query.cursor);
  }
  if (query.needsReview !== undefined) {
    params.set("needsReview", String(query.needsReview));
  }
  if (query.processingStatus) {
    params.set("processingStatus", query.processingStatus);
  }
  if (query.topic) {
    params.set("topic", query.topic);
  }
  return request<MessageListResponse>(`/api/v1/messages?${params.toString()}`);
};

export const getMessage = (messageId: string, includeMetadata = true) =>
  request<MessageDetail>(
    `/api/v1/messages/${encodeURIComponent(messageId)}${
      includeMetadata ? "?includeGmailMetadata=true" : ""
    }`
  );

export const refreshMessageMetadata = (messageId: string) =>
  request<{
    errorCode: string | null;
    fetchedAt: string;
    from: string | null;
    status: string;
    subject: string | null;
  }>(`/api/v1/messages/${encodeURIComponent(messageId)}/metadata`, { method: "POST" });

export const submitCorrection = (
  messageId: string,
  payload: {
    actions?: Record<string, boolean>;
    note?: string;
    topic?: string | null;
  },
  idempotencyKey?: string
) =>
  request<{ applicationStatus: string; revision: number }>(
    `/api/v1/messages/${encodeURIComponent(messageId)}/corrections`,
    {
      body: payload,
      headers: idempotencyHeaders(idempotencyKey),
      method: "POST",
    }
  );

export const retryMessage = (messageId: string, idempotencyKey?: string) =>
  request<{ jobId: string; stage: string }>(
    `/api/v1/messages/${encodeURIComponent(messageId)}/retry`,
    { headers: idempotencyHeaders(idempotencyKey), method: "POST" }
  );

export const reprocessMessage = (
  messageId: string,
  reason: string,
  idempotencyKey?: string
) =>
  request<{ operationId: string }>(
    `/api/v1/messages/${encodeURIComponent(messageId)}/reprocess`,
    {
      body: { reason },
      headers: idempotencyHeaders(idempotencyKey),
      method: "POST",
    }
  );

export const applyMessage = (
  messageId: string,
  classificationId: string,
  idempotencyKey?: string
) =>
  request<{ operationId: string }>(
    `/api/v1/messages/${encodeURIComponent(messageId)}/apply`,
    {
      body: { classificationId },
      headers: idempotencyHeaders(idempotencyKey),
      method: "POST",
    }
  );

export const listOperations = (query: {
  cursor?: string | null;
  kind?: string;
  limit?: number;
}) => {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 25));
  if (query.cursor) {
    params.set("cursor", query.cursor);
  }
  if (query.kind) {
    params.set("kind", query.kind);
  }
  return request<OperationListResponse>(`/api/v1/operations?${params.toString()}`);
};

export const getOperation = (operationId: string) =>
  request<OperationItem>(`/api/v1/operations/${encodeURIComponent(operationId)}`);

export const getLabels = () => request<LabelsResponse>("/api/v1/labels");

export const planLabelMigration = () =>
  request<{ coalesced: boolean; operationId: string }>("/api/v1/labels/migration-plan", {
    method: "POST",
  });

export const migrateLabels = (planOperationId: string | null, idempotencyKey?: string) =>
  request<{ operationId: string; planOperationId: string | null }>(
    "/api/v1/labels/migrate",
    {
      body: planOperationId ? { planOperationId } : {},
      headers: idempotencyHeaders(idempotencyKey),
      method: "POST",
    }
  );
