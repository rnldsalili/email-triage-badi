import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  CONFIGURATION_ERROR: 500,
  CONFLICT: 409,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  VALIDATION_ERROR: 400,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
}

export const errorEnvelope = (
  code: ErrorCode,
  message: string,
  requestId: string
): ErrorEnvelope => ({ error: { code, message, requestId } });
