const encoder = new TextEncoder();

export const SESSION_COOKIE_NAME = "etb_session";
export const SESSION_TTL_MS = 30 * 86_400_000;
export const CSRF_HEADER = "x-etb-csrf";
export const CSRF_HEADER_VALUE = "dashboard";

const sessionKey = async (adminToken: string): Promise<CryptoKey> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`email-triage-session-v1:${adminToken}`)
  );
  return await crypto.subtle.importKey(
    "raw",
    digest,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );
};

const sign = async (adminToken: string, payload: string): Promise<string> => {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await sessionKey(adminToken),
    encoder.encode(payload)
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const createSessionToken = async (
  adminToken: string,
  now: number,
  ttlMs: number = SESSION_TTL_MS
): Promise<string> => {
  const expiresAt = now + ttlMs;
  const payload = `${expiresAt}.${crypto.randomUUID()}`;
  return `${payload}.${await sign(adminToken, payload)}`;
};

export const verifySessionToken = async (
  adminToken: string,
  token: string,
  now: number
): Promise<boolean> => {
  const separator = token.lastIndexOf(".");
  if (separator === -1) {
    return false;
  }
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^\d+\./u.test(payload) || !/^[\da-f]{64}$/u.test(signature)) {
    return false;
  }
  const expiresAt = Number(payload.slice(0, payload.indexOf(".")));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return false;
  }
  const expected = await sign(adminToken, payload);
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(signature)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedDigest, expectedDigest);
};

export const readCookie = (
  cookieHeader: string | undefined,
  name: string
): string | null => {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
};

export const sessionCookie = (
  token: string,
  maxAgeSeconds: number,
  secure: boolean
): string =>
  `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${
    secure ? "; Secure" : ""
  }`;

export const clearedSessionCookie = (secure: boolean): string =>
  `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${
    secure ? "; Secure" : ""
  }`;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Cookies are `Secure` everywhere except plain-HTTP loopback development, where
 * browsers treat localhost as a trustworthy origin. A downgraded production
 * request must never yield a usable session cookie.
 */
export const shouldUseSecureCookie = (url: string): boolean => {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") {
    return true;
  }
  return !LOOPBACK_HOSTS.has(parsed.hostname);
};
