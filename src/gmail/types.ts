import { z } from "zod";

export const gmailProfileSchema = z.object({
  emailAddress: z.string().min(1),
  historyId: z.string().min(1),
  messagesTotal: z.number().int().nonnegative().optional(),
  threadsTotal: z.number().int().nonnegative().optional(),
});

export type GmailProfile = z.infer<typeof gmailProfileSchema>;

export const gmailLabelSchema = z.object({
  id: z.string().min(1),
  labelListVisibility: z.string().optional(),
  messageListVisibility: z.string().optional(),
  name: z.string().min(1),
  type: z.enum(["system", "user"]).optional(),
});

export type GmailLabel = z.infer<typeof gmailLabelSchema>;

export const gmailLabelListSchema = z.object({
  labels: z.array(gmailLabelSchema).default([]),
});

export const gmailMessageRefSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
});

export const gmailMessageListSchema = z.object({
  messages: z.array(gmailMessageRefSchema).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

export type GmailMessageRef = z.infer<typeof gmailMessageRefSchema>;
export type GmailMessageList = z.infer<typeof gmailMessageListSchema>;

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export const gmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z.object({
    body: z
      .object({
        attachmentId: z.string().optional(),
        data: z.string().optional(),
        size: z.number().optional(),
      })
      .optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    mimeType: z.string().optional(),
    partId: z.string().optional(),
    parts: z.array(gmailMessagePartSchema).optional(),
  })
);

export const gmailMessageSchema = z.object({
  historyId: z.string().optional(),
  id: z.string().min(1),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  payload: gmailMessagePartSchema.optional(),
  sizeEstimate: z.number().optional(),
  snippet: z.string().optional(),
  threadId: z.string().min(1),
});

export type GmailMessage = z.infer<typeof gmailMessageSchema>;

export const gmailHistoryEventSchema = z.object({
  id: z.string().min(1),
  labelsAdded: z
    .array(
      z.object({
        labelIds: z.array(z.string()),
        message: gmailMessageRefSchema,
      })
    )
    .optional(),
  messages: z.array(gmailMessageRefSchema).optional(),
  messagesAdded: z.array(z.object({ message: gmailMessageRefSchema })).optional(),
});

export const gmailHistoryListSchema = z.object({
  history: z.array(gmailHistoryEventSchema).optional(),
  historyId: z.string().optional(),
  nextPageToken: z.string().optional(),
});

export type GmailHistoryList = z.infer<typeof gmailHistoryListSchema>;

export const gmailAttachmentSchema = z.object({
  data: z.string().optional(),
  size: z.number().optional(),
});

export type GmailAttachment = z.infer<typeof gmailAttachmentSchema>;

export const gmailModifyResponseSchema = z.object({
  id: z.string().min(1),
  labelIds: z.array(z.string()).default([]),
  threadId: z.string().min(1),
});

export type GmailModifyResponse = z.infer<typeof gmailModifyResponseSchema>;
