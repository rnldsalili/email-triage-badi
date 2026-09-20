import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import type { Credentials } from "google-auth-library";

import { DEV_VARS_PATH, loadDevVars, saveDevVars } from "./lib/dev-vars";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const DEFAULT_REDIRECT_URI = "http://localhost:8788/oauth2callback";
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

const HELP = `Usage: bun run oauth:bootstrap [--check]

Interactive mode (default):
  Starts a localhost callback server, opens the Google consent screen,
  exchanges the authorization code for tokens, verifies the Gmail profile,
  and stores GOOGLE_REFRESH_TOKEN in ${DEV_VARS_PATH} (gitignored).

Check mode (--check):
  Uses the existing refresh token to fetch a fresh access token and read
  the Gmail profile. Does not open a browser and does not write secrets.

Environment (process env or ${DEV_VARS_PATH}):
  GOOGLE_CLIENT_ID        required OAuth client identifier
  GOOGLE_CLIENT_SECRET    required OAuth client secret
  GMAIL_ACCOUNT_EMAIL     optional expected mailbox; mismatch fails the run
  OAUTH_REDIRECT_URI      optional; default ${DEFAULT_REDIRECT_URI}
                          must be registered exactly on the OAuth client

Google Cloud setup:
  1. Create a project and enable the Gmail API.
  2. Configure the OAuth consent screen for a personal External app.
  3. Create an OAuth client of type Web application.
  4. Add ${DEFAULT_REDIRECT_URI} as an authorized redirect URI.
  5. Store the client credentials in ${DEV_VARS_PATH} or the environment.
`;

const resolveConfig = () => {
  const devVars = loadDevVars();
  const read = (key: string): string | undefined => process.env[key] ?? devVars[key];
  return {
    clientId: read("GOOGLE_CLIENT_ID"),
    clientSecret: read("GOOGLE_CLIENT_SECRET"),
    expectedEmail: read("GMAIL_ACCOUNT_EMAIL"),
    redirectUri: read("OAUTH_REDIRECT_URI") ?? DEFAULT_REDIRECT_URI,
    refreshToken: read("GOOGLE_REFRESH_TOKEN"),
  };
};

const base64url = (input: Buffer): string =>
  input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};

interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

const fetchGmailProfile = async (accessToken: string): Promise<GmailProfile> => {
  const response = await fetch(GMAIL_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as Partial<GmailProfile> & {
    error?: { message?: string; status?: string };
  };
  if (!response.ok) {
    const reason = body.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Gmail profile read failed: ${reason}`);
  }
  if (!body.emailAddress) {
    throw new Error("Gmail profile response did not include emailAddress");
  }
  return body as GmailProfile;
};

const verifyIdentity = (profile: GmailProfile, expectedEmail?: string): void => {
  if (!expectedEmail) {
    console.log(
      "GMAIL_ACCOUNT_EMAIL is not configured; profile identity was not compared."
    );
    return;
  }
  if (profile.emailAddress.toLowerCase() !== expectedEmail.trim().toLowerCase()) {
    throw new Error(
      `Authorized mailbox ${profile.emailAddress} does not match configured owner`
    );
  }
};

const reportProfile = (profile: GmailProfile): void => {
  console.log("Gmail profile verified:");
  console.log(`  emailAddress: ${profile.emailAddress}`);
  console.log(`  messagesTotal: ${profile.messagesTotal}`);
  console.log(`  threadsTotal: ${profile.threadsTotal}`);
  console.log(`  historyId: ${profile.historyId}`);
};

const grantedScopes = (tokens: Credentials): string[] =>
  (tokens.scope ?? "").split(" ").filter(Boolean);

const runCheckMode = async (): Promise<void> => {
  const config = resolveConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
  }
  if (!config.refreshToken) {
    throw new Error(
      "GOOGLE_REFRESH_TOKEN is required for --check; run the bootstrap first"
    );
  }

  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
  client.setCredentials({ refresh_token: config.refreshToken });

  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error("Token refresh returned no access token");
  }

  const profile = await fetchGmailProfile(token);
  verifyIdentity(profile, config.expectedEmail);
  reportProfile(profile);
  console.log("Refresh-token exchange succeeded.");
};

const failCallback = (response: ServerResponse, message: string): never => {
  response.writeHead(400, { "content-type": "text/html" });
  response.end(`<h1>Authorization failed</h1><p>${message}</p>`);
  throw new Error(message);
};

interface CallbackOptions {
  authUrl: string;
  port: number;
  redirect: URL;
  redirectUri: string;
  state: string;
}

const waitForAuthorizationCode = async (
  server: Server,
  options: CallbackOptions
): Promise<string> => {
  const { authUrl, port, redirect, redirectUri, state } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLOW_TIMEOUT_MS);

  server.listen(port, redirect.hostname, () => {
    console.log("Open this URL in a browser and approve access:");
    console.log(authUrl);
    console.log(`Waiting for the callback on ${redirectUri} (5 minute limit)...`);
  });

  const handleRequest = async (): Promise<string> => {
    const [request, response] = (await once(server, "request", {
      signal: controller.signal,
    })) as [IncomingMessage, ServerResponse];
    const requestUrl = new URL(
      request.url ?? "/",
      `${redirect.protocol}//${redirect.host}`
    );

    if (requestUrl.pathname !== redirect.pathname) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return await handleRequest();
    }

    const error = requestUrl.searchParams.get("error");
    const returnedState = requestUrl.searchParams.get("state") ?? "";
    const returnedCode = requestUrl.searchParams.get("code");

    if (error) {
      return failCallback(response, `Google returned: ${error}`);
    }
    if (!returnedState || !safeEqual(returnedState, state)) {
      return failCallback(response, "State parameter validation failed");
    }
    if (!returnedCode) {
      return failCallback(response, "Callback did not include an authorization code");
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<h1>Authorization received</h1><p>You can close this tab and return to the terminal.</p>"
    );
    return returnedCode;
  };

  try {
    return await handleRequest();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("OAuth flow timed out before a callback arrived", {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    server.close();
  }
};

const runInteractiveMode = async (): Promise<void> => {
  const config = resolveConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required; see --help");
  }

  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });

  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    prompt: "consent",
    redirect_uri: config.redirectUri,
    scope: [GMAIL_SCOPE],
    state,
  });

  const redirect = new URL(config.redirectUri);
  const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));

  const server = createServer();
  const code = await waitForAuthorizationCode(server, {
    authUrl,
    port,
    redirect,
    redirectUri: config.redirectUri,
    state,
  });

  const { tokens } = await client.getToken({
    code,
    codeVerifier,
    redirect_uri: config.redirectUri,
  });

  const scopes = grantedScopes(tokens);
  if (!scopes.includes(GMAIL_SCOPE)) {
    throw new Error(
      `Granted scopes did not include ${GMAIL_SCOPE} (granted: ${scopes.join(", ") || "none"})`
    );
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke prior access and re-run with fresh consent."
    );
  }
  if (!tokens.access_token) {
    throw new Error("Token exchange returned no access token");
  }

  const profile = await fetchGmailProfile(tokens.access_token);
  verifyIdentity(profile, config.expectedEmail);

  saveDevVars({
    GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
    ...(config.expectedEmail ? { GMAIL_ACCOUNT_EMAIL: config.expectedEmail } : {}),
  });

  reportProfile(profile);
  console.log(`Refresh token stored in ${DEV_VARS_PATH} (mode 0600).`);
  console.log("Provision Worker secrets with wrangler secret put:");
  console.log("  GOOGLE_CLIENT_ID");
  console.log("  GOOGLE_CLIENT_SECRET");
  console.log("  GOOGLE_REFRESH_TOKEN");
};

const main = async (): Promise<void> => {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log(HELP);
    return;
  }
  if (args.has("--check")) {
    await runCheckMode();
    return;
  }
  await runInteractiveMode();
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`oauth-bootstrap failed: ${message}`);
  process.exit(1);
}
