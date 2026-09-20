import type { GmailClient } from "../../src/gmail/client";
import { GmailError } from "../../src/gmail/errors";
import type {
  GmailHistoryList,
  GmailLabel,
  GmailMessage,
  GmailMessageList,
  GmailProfile,
} from "../../src/gmail/types";

export const DEFAULT_PROFILE: GmailProfile = {
  emailAddress: "owner@example.test",
  historyId: "1000",
  messagesTotal: 3,
  threadsTotal: 3,
};

export const minimalMessage = (
  id: string,
  options: { threadId?: string; receivedAt?: number; labels?: string[] } = {}
): GmailMessage => ({
  id,
  internalDate: String(options.receivedAt ?? 1_700_000_000_000),
  labelIds: options.labels ?? ["INBOX"],
  threadId: options.threadId ?? `thread-${id}`,
});

export const fullMessage = (
  id: string,
  body: string,
  options: { threadId?: string; receivedAt?: number; labels?: string[] } = {}
): GmailMessage => {
  const message = minimalMessage(id, options);
  return {
    ...message,
    payload: {
      body: { data: btoa(body) },
      headers: [
        { name: "Subject", value: `Subject for ${id}` },
        { name: "From", value: "Sender <sender@example.test>" },
        { name: "To", value: "owner@example.test" },
      ],
      mimeType: "text/plain",
    },
  };
};

export type MaybePromise<T> = T | Promise<T>;

export interface FakeGmailHandlers {
  getProfile?: () => MaybePromise<GmailProfile>;
  getMessage?: (id: string, format?: string) => MaybePromise<GmailMessage>;
  listMessages?: (params: {
    query?: string;
    pageToken?: string;
    maxResults?: number;
  }) => MaybePromise<GmailMessageList>;
  listHistory?: (params: {
    startHistoryId: string;
    pageToken?: string;
  }) => MaybePromise<GmailHistoryList>;
  listLabels?: () => MaybePromise<GmailLabel[]>;
  createLabel?: (name: string) => MaybePromise<GmailLabel>;
  renameLabel?: (labelId: string, name: string) => MaybePromise<GmailLabel>;
  modifyMessage?: (
    messageId: string,
    changes: { addLabelIds?: string[]; removeLabelIds?: string[] }
  ) => MaybePromise<{ id: string; threadId: string; labelIds: string[] }>;
}

export interface FakeGmail {
  client: GmailClient;
  calls: { method: string; args: unknown[] }[];
}

export const fakeGmail = (handlers: FakeGmailHandlers): FakeGmail => {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, args: unknown[]) => calls.push({ args, method });

  const client = {
    createLabel: (name: string) => {
      record("createLabel", [name]);
      if (handlers.createLabel) {
        return handlers.createLabel(name);
      }
      return { id: `Label_new_${name}`, name };
    },
    getMessage: (id: string, format?: string) => {
      record("getMessage", [id, format]);
      if (handlers.getMessage) {
        return handlers.getMessage(id, format);
      }
      throw new GmailError("not_found", `no fake message ${id}`);
    },
    getProfile: () => {
      record("getProfile", []);
      if (handlers.getProfile) {
        return handlers.getProfile();
      }
      return DEFAULT_PROFILE;
    },
    listHistory: (params: { startHistoryId: string; pageToken?: string }) => {
      record("listHistory", [params]);
      if (handlers.listHistory) {
        return handlers.listHistory(params);
      }
      return { history: [] };
    },
    listLabels: () => {
      record("listLabels", []);
      if (handlers.listLabels) {
        return handlers.listLabels();
      }
      return [];
    },
    listMessages: (params: {
      query?: string;
      pageToken?: string;
      maxResults?: number;
    }) => {
      record("listMessages", [params]);
      if (handlers.listMessages) {
        return handlers.listMessages(params);
      }
      return { messages: [] };
    },
    modifyMessage: (
      messageId: string,
      changes: { addLabelIds?: string[]; removeLabelIds?: string[] }
    ) => {
      record("modifyMessage", [messageId, changes]);
      if (handlers.modifyMessage) {
        return handlers.modifyMessage(messageId, changes);
      }
      throw new GmailError("invalid_request", "no fake modify handler");
    },
    renameLabel: (labelId: string, name: string) => {
      record("renameLabel", [labelId, name]);
      if (handlers.renameLabel) {
        return handlers.renameLabel(labelId, name);
      }
      return { id: labelId, name };
    },
  } as unknown as GmailClient;

  return { calls, client };
};
