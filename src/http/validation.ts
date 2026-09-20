import type { Context } from "hono";
import type { ZodType } from "zod";

import type { AppEnv } from "../app-env";
import { readBoundedText, InputLimitError } from "../utils/bounded-body";
import { ApiError } from "./errors";

export const MAX_JSON_BODY_BYTES = 64 * 1024;

const summarizeIssues = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .slice(0, 5)
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message
    )
    .join("; ");

export const readJsonBody = async <T>(
  c: Context<AppEnv>,
  schema: ZodType<T>
): Promise<T> => {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new ApiError("VALIDATION_ERROR", "Content-Type must be application/json");
  }

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new ApiError("PAYLOAD_TOO_LARGE", "Request body exceeds 64 KiB");
  }

  let text: string;
  try {
    text = await readBoundedText(c.req.raw, MAX_JSON_BODY_BYTES);
  } catch (error) {
    if (error instanceof InputLimitError) {
      throw new ApiError("PAYLOAD_TOO_LARGE", "Request body exceeds 64 KiB");
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Request body is not valid JSON");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError("VALIDATION_ERROR", summarizeIssues(result.error.issues));
  }
  return result.data;
};
