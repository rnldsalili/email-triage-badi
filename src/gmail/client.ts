import type { z } from "zod";

import { readBoundedText } from "../utils/bounded-body";
import { GmailError, reasonFromStatus } from "./errors";
import type { GmailErrorDetail } from "./errors";
import type { AccessTokenSource } from "./tokens";
import {
  gmailAttachmentSchema,
  gmailHistoryListSchema,
  gmailLabelListSchema,
  gmailLabelSchema,
  gmailMessageListSchema,
  gmailMessageSchema,
  gmailModifyResponseSchema,
  gmailProfileSchema,
} from "./types";
import type {
  GmailAttachment,
  GmailHistoryList,
  GmailLabel,
  GmailMessage,
  GmailModifyResponse,
  GmailProfile,
} from "./types";

const DEFAULT_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

export const SYSTEM_LABEL_IDS: ReadonlySet<string> = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SPAM",
  "TRASH",
  "SENT",
  "DRAFT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

export interface GmailClientOptions {
  tokens: AccessTokenSource;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  beforeRequest?: (write: boolean) => Promise<void>;
  timeoutMs?: number;
}

export interface ListMessagesParams {
  query?: string;
  maxResults?: number;
  pageToken?: string;
  labelIds?: string[];
}

export interface ListHistoryParams {
  startHistoryId: string;
  pageToken?: string;
  maxResults?: number;
  historyTypes?: string[];
}

const extractErrorDetail = (body: unknown): GmailErrorDetail | undefined => {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { error } = body as { error?: unknown };
  if (typeof error === "string") {
    return { message: error };
  }
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as { message?: unknown; errors?: unknown };
  const detail: GmailErrorDetail = {};
  if (typeof record.message === "string") {
    detail.message = record.message;
  }
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const first = record.errors[0] as { reason?: unknown };
    if (typeof first?.reason === "string") {
      detail.reason = first.reason;
    }
  }
  return detail;
};

const buildQuery = (
  params: Record<string, string | number | string[] | undefined>
): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, item);
      }
    } else {
      search.append(key, String(value));
    }
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
};

export class GmailClient {
  private readonly tokens: AccessTokenSource;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly beforeRequest?: (write: boolean) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: GmailClientOptions) {
    this.tokens = options.tokens;
    this.fetchImpl = (options.fetchImpl ?? fetch).bind(globalThis);
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.beforeRequest = options.beforeRequest;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    return this.requestWithRefresh(path, schema, init, true);
  }

  private async requestWithRefresh<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit | undefined,
    allowRefresh: boolean
  ): Promise<T> {
    const write = init?.method === "POST" || init?.method === "PATCH";
    await this.beforeRequest?.(write);
    const token = await this.tokens.getAccessToken();
    await this.beforeRequest?.(write);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GmailError("network_error", "Gmail request failed or timed out");
    }

    if (response.status === 401 && allowRefresh) {
      await response.body?.cancel();
      this.tokens.invalidate();
      return this.requestWithRefresh(path, schema, init, false);
    }

    const text = await readBoundedText(response, 4 * 1024 * 1024);
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new GmailError("invalid_response", "Gmail returned non-JSON body");
        }
      }
    }

    if (!response.ok) {
      const detail = extractErrorDetail(body);
      throw new GmailError(
        reasonFromStatus(response.status, detail),
        detail?.message ?? `Gmail returned HTTP ${response.status}`,
        response.status
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const [firstIssue] = parsed.error.issues;
      const location = firstIssue?.path.join(".") ?? "unknown";
      throw new GmailError(
        "invalid_response",
        `Gmail response failed validation at ${location}`
      );
    }
    return parsed.data;
  }

  getProfile(): Promise<GmailProfile> {
    return this.request("/profile", gmailProfileSchema);
  }

  async listLabels(): Promise<GmailLabel[]> {
    const result = await this.request("/labels", gmailLabelListSchema);
    return result.labels;
  }

  listMessages(params: ListMessagesParams = {}) {
    const query = buildQuery({
      labelIds: params.labelIds,
      maxResults: params.maxResults,
      pageToken: params.pageToken,
      q: params.query,
    });
    return this.request(`/messages${query}`, gmailMessageListSchema);
  }

  getMessage(
    id: string,
    format: "full" | "metadata" | "minimal" = "full",
    metadataHeaders?: string[]
  ): Promise<GmailMessage> {
    const query = buildQuery({
      format,
      metadataHeaders,
    });
    return this.request(
      `/messages/${encodeURIComponent(id)}${query}`,
      gmailMessageSchema
    );
  }

  listHistory(params: ListHistoryParams) {
    const query = buildQuery({
      historyTypes: params.historyTypes,
      maxResults: params.maxResults,
      pageToken: params.pageToken,
      startHistoryId: params.startHistoryId,
    });
    return this.request<GmailHistoryList>(`/history${query}`, gmailHistoryListSchema);
  }

  getAttachment(messageId: string, attachmentId: string): Promise<GmailAttachment> {
    return this.request(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      gmailAttachmentSchema
    );
  }

  createLabel(name: string): Promise<GmailLabel> {
    return this.request("/labels", gmailLabelSchema, {
      body: JSON.stringify({
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
        name,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  renameLabel(labelId: string, name: string): Promise<GmailLabel> {
    return this.request(`/labels/${encodeURIComponent(labelId)}`, gmailLabelSchema, {
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
  }

  modifyMessage(
    messageId: string,
    changes: { addLabelIds?: string[]; removeLabelIds?: string[] },
    approvedUserLabelIds: ReadonlySet<string> = new Set()
  ): Promise<GmailModifyResponse> {
    const requested = [...(changes.addLabelIds ?? []), ...(changes.removeLabelIds ?? [])];
    const systemLabel = requested.find((id) => SYSTEM_LABEL_IDS.has(id));
    if (systemLabel) {
      throw new GmailError(
        "invalid_request",
        `Refusing to mutate system label ${systemLabel}`
      );
    }
    if (requested.some((id) => !approvedUserLabelIds.has(id))) {
      throw new GmailError("invalid_request", "Refusing to mutate an unapproved label");
    }
    return this.request(
      `/messages/${encodeURIComponent(messageId)}/modify`,
      gmailModifyResponseSchema,
      {
        body: JSON.stringify({
          addLabelIds: changes.addLabelIds ?? [],
          removeLabelIds: changes.removeLabelIds ?? [],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
  }
}
