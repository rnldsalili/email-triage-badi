export type GmailErrorReason =
  | "auth_invalid"
  | "auth_required"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "invalid_request"
  | "server_error"
  | "network_error"
  | "invalid_response";

const RETRYABLE_REASONS: ReadonlySet<GmailErrorReason> = new Set([
  "quota_exceeded",
  "rate_limited",
  "server_error",
  "network_error",
]);

export class GmailError extends Error {
  readonly reason: GmailErrorReason;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(reason: GmailErrorReason, message: string, status: number | null = null) {
    super(message);
    this.name = "GmailError";
    this.reason = reason;
    this.status = status;
    this.retryable = RETRYABLE_REASONS.has(reason);
  }
}

export interface GmailErrorDetail {
  message?: string;
  reason?: string;
}

export const reasonFromStatus = (
  status: number,
  detail?: GmailErrorDetail
): GmailErrorReason => {
  if (status === 401) {
    return "auth_invalid";
  }
  if (status === 403) {
    switch (detail?.reason) {
      case "rateLimitExceeded":
      case "userRateLimitExceeded": {
        return "rate_limited";
      }
      case "quotaExceeded": {
        return "quota_exceeded";
      }
      default: {
        return "permission_denied";
      }
    }
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "server_error";
  }
  return "invalid_request";
};
