import { z } from "zod";

export const MODES = ["paused", "dry_run", "apply"] as const;
export type Mode = (typeof MODES)[number];

const jsonStringArray = (defaultJson: string) =>
  z
    .string()
    .default(defaultJson)
    .transform((value, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "must be valid JSON" });
        return z.NEVER;
      }
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        ctx.addIssue({
          code: "custom",
          message: "must be a JSON array of strings",
        });
        return z.NEVER;
      }
      return parsed as string[];
    });

const timeZone = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be a valid IANA time zone" }
  );

const rawEnvSchema = z
  .object({
    ADMIN_API_TOKEN: z.string().min(1),
    AI_GATEWAY_ID: z.string().min(1),
    AI_MODEL: z.string().min(1).default("typesafe/jev"),
    AI_RUBRIC: z.enum(["standard", "compact-v1"]).default("standard"),
    CHECKPOINT_RESERVE_MS: z.coerce.number().int().min(0).default(15_000),
    CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    DEFAULT_MODE: z.enum(MODES).default("dry_run"),
    DETAIL_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    EMPLOYER_DOMAINS_JSON: jsonStringArray("[]"),
    GITHUB_PASSIVE_FAST_PATH: z.enum(["off", "on"]).default("off"),
    GMAIL_ACCOUNT_EMAIL: z.email(),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_REFRESH_TOKEN: z.string().min(1),
    INITIAL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(7),
    MAX_AI_CALLS_PER_DAY: z.coerce.number().int().min(0).default(500),
    MAX_BACKFILL_MESSAGES: z.coerce.number().int().min(1).max(100_000).default(5000),
    MAX_BODY_CHARACTERS: z.coerce.number().int().min(1).max(1_000_000).default(12_000),
    MAX_JOBS_PER_TICK: z.coerce.number().int().min(1).max(1000).default(20),
    MAX_METADATA_REFRESH_PER_TICK: z.coerce.number().int().min(1).max(500).default(25),
    OWNER_ALIASES_JSON: jsonStringArray("[]"),
    OWNER_TIME_ZONE: timeZone.default("UTC"),
    RUN_LEASE_MS: z.coerce.number().int().min(1000).default(180_000),
    TICK_WALL_BUDGET_MS: z.coerce.number().int().min(1000).default(120_000),
  })
  .superRefine((value, ctx) => {
    if (value.CHECKPOINT_RESERVE_MS >= value.TICK_WALL_BUDGET_MS) {
      ctx.addIssue({
        code: "custom",
        message: "must be smaller than TICK_WALL_BUDGET_MS",
        path: ["CHECKPOINT_RESERVE_MS"],
      });
    }
    if (value.RUN_LEASE_MS <= value.TICK_WALL_BUDGET_MS) {
      ctx.addIssue({
        code: "custom",
        message: "must be greater than TICK_WALL_BUDGET_MS",
        path: ["RUN_LEASE_MS"],
      });
    }
  });

export interface AppConfig {
  ai: {
    gatewayId: string;
    githubPassiveFastPath: "off" | "on";
    model: string;
    rubric: "standard" | "compact-v1";
  };
  owner: {
    accountEmail: string;
    aliases: string[];
    timeZone: string;
    employerDomains: string[];
  };
  defaults: {
    mode: Mode;
    initialLookbackDays: number;
  };
  limits: {
    maxJobsPerTick: number;
    tickWallBudgetMs: number;
    checkpointReserveMs: number;
    runLeaseMs: number;
    maxBackfillMessages: number;
    cleanupBatchSize: number;
    maxAiCallsPerDay: number;
    maxBodyCharacters: number;
    detailRetentionDays: number;
    maxMetadataRefreshPerTick: number;
  };
  secrets: {
    adminApiToken: string;
    googleClientId: string;
    googleClientSecret: string;
    googleRefreshToken: string;
  };
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export const parseConfig = (rawEnv: Record<string, unknown>): AppConfig => {
  const withDefaults: Record<string, unknown> = { ...rawEnv };

  const result = rawEnvSchema.safeParse(withDefaults);
  if (!result.success) {
    const issues = result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message
    );
    throw new ConfigError(issues);
  }
  const env = result.data;

  return {
    ai: {
      gatewayId: env.AI_GATEWAY_ID,
      githubPassiveFastPath: env.GITHUB_PASSIVE_FAST_PATH,
      model: env.AI_MODEL,
      rubric: env.AI_RUBRIC,
    },
    defaults: {
      initialLookbackDays: env.INITIAL_LOOKBACK_DAYS,
      mode: env.DEFAULT_MODE,
    },
    limits: {
      checkpointReserveMs: env.CHECKPOINT_RESERVE_MS,
      cleanupBatchSize: env.CLEANUP_BATCH_SIZE,
      detailRetentionDays: env.DETAIL_RETENTION_DAYS,
      maxAiCallsPerDay: env.MAX_AI_CALLS_PER_DAY,
      maxBackfillMessages: env.MAX_BACKFILL_MESSAGES,
      maxBodyCharacters: env.MAX_BODY_CHARACTERS,
      maxJobsPerTick: env.MAX_JOBS_PER_TICK,
      maxMetadataRefreshPerTick: env.MAX_METADATA_REFRESH_PER_TICK,
      runLeaseMs: env.RUN_LEASE_MS,
      tickWallBudgetMs: env.TICK_WALL_BUDGET_MS,
    },
    owner: {
      accountEmail: env.GMAIL_ACCOUNT_EMAIL,
      aliases: env.OWNER_ALIASES_JSON,
      employerDomains: env.EMPLOYER_DOMAINS_JSON,
      timeZone: env.OWNER_TIME_ZONE,
    },
    secrets: {
      adminApiToken: env.ADMIN_API_TOKEN,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      googleRefreshToken: env.GOOGLE_REFRESH_TOKEN,
    },
  };
};
