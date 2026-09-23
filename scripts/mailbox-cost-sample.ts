import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { unstable_readConfig } from "wrangler";

import { parseConfig } from "../src/config/env";
import type { AppConfig } from "../src/config/env";
import { costComparisonDatasetSchema } from "../src/evaluation/cost-comparison";
import { GmailClient } from "../src/gmail/client";
import { GmailError } from "../src/gmail/errors";
import { createAccessTokenSource } from "../src/gmail/tokens";
import type { GmailMessage, GmailMessageRef } from "../src/gmail/types";
import { loadDevVars } from "./lib/dev-vars";

const PRIVATE_DIRECTORY = path.resolve("eval/private");
const OUTPUT = path.resolve(
  process.env.COST_DATASET ?? "eval/private/mailbox-cost-observation.json"
);
const SECRET_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "ADMIN_API_TOKEN",
] as const;
const STOP_REASONS: Record<string, true> = {
  auth_invalid: true,
  auth_required: true,
  permission_denied: true,
  quota_exceeded: true,
  rate_limited: true,
};

const selectEvenly = (refs: GmailMessageRef[], requested: number): GmailMessageRef[] => {
  const count = Math.min(requested, refs.length);
  if (count === 0) {
    return [];
  }
  return Array.from({ length: count }, (_, index) => {
    const ref = refs[Math.floor(((index + 0.5) * refs.length) / count)];
    if (!ref) {
      throw new Error("cost_sampler_invalid_selection");
    }
    return ref;
  });
};

const loadProductionConfig = (): AppConfig => {
  try {
    const production = unstable_readConfig(
      { config: "wrangler.jsonc", env: "production" },
      { hideWarnings: true }
    );
    const { vars } = production;
    if (
      !vars ||
      typeof vars.GMAIL_ACCOUNT_EMAIL !== "string" ||
      typeof vars.AI_GATEWAY_ID !== "string"
    ) {
      throw new Error("production_config_missing");
    }
    const processSecrets = Object.fromEntries(
      SECRET_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [
        key,
        process.env[key],
      ])
    );
    const config = parseConfig({ ...vars, ...loadDevVars(), ...processSecrets });
    if (
      config.owner.accountEmail.toLowerCase() !==
        vars.GMAIL_ACCOUNT_EMAIL.toLowerCase() ||
      config.ai.gatewayId !== vars.AI_GATEWAY_ID ||
      config.ai.model !== "typesafe/jev"
    ) {
      throw new Error("production_context_mismatch");
    }
    return config;
  } catch {
    throw new Error("cost_sampler_configuration_invalid");
  }
};

const createReadOnlyClient = (config: AppConfig): GmailClient => {
  const tokenSource = createAccessTokenSource({
    clientId: config.secrets.googleClientId,
    clientSecret: config.secrets.googleClientSecret,
    refreshToken: config.secrets.googleRefreshToken,
  });
  // GmailClient normally refreshes and retries a 401; this one-shot sampler stops instead.
  const tokens = {
    ...tokenSource,
    invalidate: () => {
      throw new GmailError("auth_invalid", "Gmail authentication failed", 401);
    },
  };
  const getOnly: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      if (request.method !== "GET") {
        throw new Error("gmail_read_only_guard");
      }
      return fetch(input, init);
    },
    { preconnect: fetch.preconnect }
  );
  return new GmailClient({
    beforeRequest: (write) => {
      if (write) {
        throw new Error("gmail_read_only_guard");
      }
      return Promise.resolve();
    },
    fetchImpl: getOnly,
    tokens,
  });
};

interface SampledRef {
  ref: GmailMessageRef;
  stratum: "github" | "other";
}

const collectMessages = async (
  client: GmailClient,
  selected: SampledRef[]
): Promise<{
  examples: { id: string; message: GmailMessage; stratum: SampledRef["stratum"] }[];
  skippedErrors: Record<string, number>;
  stoppedReason: "auth_failure" | "rate_limited" | null;
}> => {
  const seen = new Set<string>();
  const examples: {
    id: string;
    message: GmailMessage;
    stratum: SampledRef["stratum"];
  }[] = [];
  const skippedErrors: Record<string, number> = {};
  let datasetBytes = 16 * 1024;
  let stoppedReason: "auth_failure" | "rate_limited" | null = null;
  let previousRequestAt = Date.now();

  const visit = async (index: number): Promise<void> => {
    const item = selected[index];
    if (!item) {
      return;
    }
    const { ref, stratum } = item;
    if (seen.has(ref.id)) {
      return await visit(index + 1);
    }
    seen.add(ref.id);
    const remaining = 500 - (Date.now() - previousRequestAt);
    if (remaining > 0) {
      await Bun.sleep(remaining);
    }
    previousRequestAt = Date.now();
    try {
      const message = await client.getMessage(ref.id, "full");
      const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf-8") + 100;
      if (datasetBytes + messageBytes > 16 * 1024 * 1024) {
        skippedErrors.dataset_size_limit = (skippedErrors.dataset_size_limit ?? 0) + 1;
      } else {
        datasetBytes += messageBytes;
        examples.push({
          id: `example-${String(examples.length + 1).padStart(3, "0")}`,
          message,
          stratum,
        });
      }
    } catch (error) {
      const reason = error instanceof GmailError ? error.reason : "unknown_error";
      if (STOP_REASONS[reason]) {
        stoppedReason =
          reason === "rate_limited" || reason === "quota_exceeded"
            ? "rate_limited"
            : "auth_failure";
        return;
      }
      skippedErrors[reason] = (skippedErrors[reason] ?? 0) + 1;
    }
    await visit(index + 1);
  };
  await visit(0);
  return { examples, skippedErrors, stoppedReason };
};

const main = async (): Promise<void> => {
  const relativePath = path.relative(PRIVATE_DIRECTORY, OUTPUT);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    existsSync(OUTPUT)
  ) {
    throw new Error("cost_dataset_path_invalid_or_exists");
  }
  const config = loadProductionConfig();

  const client = createReadOnlyClient(config);
  const profile = await client.getProfile();
  if (
    profile.emailAddress.trim().toLowerCase() !==
    config.owner.accountEmail.trim().toLowerCase()
  ) {
    throw new Error("cost_sampler_mailbox_mismatch");
  }

  const started = Date.now();
  const after = Math.floor((started - 30 * 24 * 60 * 60 * 1000) / 1000);
  const before = Math.floor(started / 1000);
  const query = `after:${after} before:${before}`;
  const github = await client.listMessages({
    labelIds: ["INBOX"],
    maxResults: 300,
    query: `${query} from:notifications@github.com`,
  });
  const other = await client.listMessages({
    labelIds: ["INBOX"],
    maxResults: 300,
    query: `${query} -from:notifications@github.com`,
  });
  const selected = [
    ...selectEvenly(github.messages ?? [], 60).map((ref) => ({
      ref,
      stratum: "github" as const,
    })),
    ...selectEvenly(other.messages ?? [], 20).map((ref) => ({
      ref,
      stratum: "other" as const,
    })),
  ];
  const { examples, skippedErrors, stoppedReason } = await collectMessages(
    client,
    selected
  );
  if (examples.length === 0) {
    throw new Error("cost_sampler_no_readable_messages");
  }

  const dataset = costComparisonDatasetSchema.parse({
    examples,
    gatewayId: config.ai.gatewayId,
    owner: config.owner,
    sampledAt: new Date(started).toISOString(),
    sampling: {
      githubHasMore: Boolean(github.nextPageToken),
      otherHasMore: Boolean(other.nextPageToken),
      requestedGithub: 60,
      requestedOther: 20,
      skippedErrors,
      stoppedReason,
    },
    version: "mailbox-cost-observation-v1",
  });
  const content = JSON.stringify(dataset);
  if (Buffer.byteLength(content, "utf-8") > 16 * 1024 * 1024) {
    throw new Error("cost_dataset_too_large");
  }
  mkdirSync(PRIVATE_DIRECTORY, { mode: 0o700, recursive: true });
  mkdirSync(path.dirname(OUTPUT), { mode: 0o700, recursive: true });
  if (realpathSync(PRIVATE_DIRECTORY) !== PRIVATE_DIRECTORY) {
    throw new Error("cost_dataset_path_invalid_or_exists");
  }
  chmodSync(PRIVATE_DIRECTORY, 0o700);
  chmodSync(path.dirname(OUTPUT), 0o700);
  const actualRoot = realpathSync(PRIVATE_DIRECTORY);
  const actualParent = realpathSync(path.dirname(OUTPUT));
  if (actualParent !== actualRoot && !actualParent.startsWith(`${actualRoot}/`)) {
    throw new Error("cost_dataset_path_invalid_or_exists");
  }
  const descriptor = openSync(
    OUTPUT,
    constants.O_WRONLY + constants.O_CREAT + constants.O_EXCL + constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
  const counts = {
    github: examples.filter((example) => example.stratum === "github").length,
    other: examples.filter((example) => example.stratum === "other").length,
    skippedErrors,
    stoppedReason,
  };
  console.log(
    JSON.stringify({
      after: new Date(after * 1000).toISOString(),
      before: new Date(before * 1000).toISOString(),
      counts,
      destination: OUTPUT,
      event: "cost_dataset_collected",
      hasMore: {
        github: dataset.sampling.githubHasMore,
        other: dataset.sampling.otherHasMore,
      },
    })
  );
};

try {
  await main();
} catch (error) {
  // Neither Gmail error messages nor parser issues may contain mailbox material in terminal output.
  const code = error instanceof Error ? error.message : "";
  const safeCodes: Record<string, true> = {
    cost_dataset_path_invalid_or_exists: true,
    cost_dataset_too_large: true,
    cost_sampler_configuration_invalid: true,
    cost_sampler_mailbox_mismatch: true,
    cost_sampler_no_readable_messages: true,
  };
  console.error(
    `cost sampling failed: ${safeCodes[code] ? code : "private_collection_error"}`
  );
  process.exitCode = 1;
}
