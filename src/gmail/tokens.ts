import { z } from "zod";

import { readBoundedText } from "../utils/bounded-body";
import { GmailError } from "./errors";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const EXPIRY_SAFETY_MS = 60_000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export interface AccessTokenSource {
  getAccessToken: () => Promise<string>;
  invalidate: () => void;
}

export interface AccessTokenSourceOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const createAccessTokenSource = (
  options: AccessTokenSourceOptions
): AccessTokenSource => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async getAccessToken(): Promise<string> {
      if (cached && cached.expiresAt > now()) {
        return cached.token;
      }

      const body = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: "refresh_token",
        refresh_token: options.refreshToken,
      });

      let response: Response;
      try {
        response = await fetchImpl(TOKEN_ENDPOINT, {
          body: body.toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new GmailError(
          "network_error",
          "Token endpoint request failed or timed out"
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await readBoundedText(response, 64 * 1024));
      } catch {
        throw new GmailError("invalid_response", "Token endpoint returned non-JSON");
      }

      if (!response.ok) {
        const parsedError = tokenErrorSchema.safeParse(payload);
        const code = parsedError.success ? parsedError.data.error : "unknown_error";
        if (code === "invalid_grant") {
          throw new GmailError(
            "auth_required",
            "Google refresh token is invalid or revoked; re-run the OAuth bootstrap"
          );
        }
        throw new GmailError("auth_invalid", `Token refresh failed: ${code}`);
      }

      const parsed = tokenResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new GmailError("invalid_response", "Token response failed validation");
      }

      cached = {
        expiresAt: now() + Math.max(0, parsed.data.expires_in * 1000 - EXPIRY_SAFETY_MS),
        token: parsed.data.access_token,
      };
      return cached.token;
    },

    invalidate(): void {
      cached = null;
    },
  };
};
