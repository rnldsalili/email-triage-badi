# Deployment and operations

This runbook describes the intended application. Provisioning and exact CLI commands are implementation deliverables; no resources have been created by this documentation task.

## 1. Required resources

- Cloudflare account with Workers Paid, D1 and access/billing configured for `typesafe/jev`.
- Provisionally, an AI Gateway in the same account with Unified Billing configured/funded. Phase 0 must test whether the plain Jev example works without explicit gateway configuration and document the supported access path.
- One production Worker and D1 database; separate development/test resources where live integration is needed.
- Cron trigger `*/5 * * * *` for production, managed in Wrangler configuration.
- Google Cloud project with Gmail API enabled.
- Google OAuth client with registered localhost bootstrap callback and the owner allowed to authorize it.
- The Gmail address used for mailbox identity verification.

### Verified Phase 0 setup notes (2026-09-20)

- Jev access requires **AI Gateway Unified Billing credits**. Without them, both the plain binding call and an explicit-gateway call fail with runtime error `2021: Insufficient AI Gateway credits`. Load credits in the dashboard under **AI > AI Gateway > Credits Available > Manage > Top-up credits**. A 5% fee applies to credit purchases; provider token pricing is passed through without markup.
- A dedicated gateway `email-triage-badi-dev` is provisioned with `collect_logs: false`, `cache_ttl: 0`, authentication on and **Workers AI billing `unified`**, and the `default` gateway was also hardened to `collect_logs: false`. The application must pass this gateway ID explicitly on every Jev call: calls without a gateway argument silently route through `default` instead.
- Observed billing from gateway-reported cost: exactly proportional to input tokens at about `4.2e-8` per token (~$0.042 per million input tokens); no separable output-token cost. Confirm the published rate in the dashboard before quoting costs.
- The binding wraps the model output: `{ state: "Completed", result: { model, answers, usage }, gatewayMetadata: { keySource: "Unified" } }`. Parse and validate `result` against the published Jev output schema; tolerate unknown envelope fields.
- Structured log entries retained metadata only (tokens, cost, status, timing); request and response content fields were empty in all observed cases, including while `default` had log collection enabled. Treat this as observed integration behavior, not a provider retention guarantee.
- Cloudflare documents Zero Data Retention only for OpenAI and Anthropic Unified Billing traffic. No ZDR option is documented for TypeSafe/Jev; treat provider-side retention as unverified and check TypeSafe's terms before sending real email content.
- Generated binding types do not include `typesafe/jev`; the call resolves to the unknown-model fallback returning `Record<string, unknown>`. Keep one localized Jev adapter plus Zod validation instead of `any` casts.
- The local OAuth bootstrap helper is `scripts/oauth-bootstrap.ts`, run as `bun run oauth:bootstrap` (interactive) or `bun run oauth:check` (verify an existing refresh token). It registers `http://localhost:8788/oauth2callback` by default, validates a random `state` and PKCE `S256` verifier, requests `gmail.modify` with offline access, verifies the Gmail profile, and writes the refresh token to `.dev.vars` with mode `0600`. Override the redirect with `OAUTH_REDIRECT_URI` and pin the mailbox with `GMAIL_ACCOUNT_EMAIL`.
- Phase 0 verified the helper end to end: live profile read for the configured owner mailbox and a successful fresh refresh-token exchange on `bun run oauth:check`.

The Phase 0 integration spike and its temporary Workers were removed after verification; the synthetic request/response fixtures live in `fixtures/jev/`. Account-scoped credentials for local commands live in the gitignored `.cloudflare.env` (see `.cloudflare.env.example`).

Workers AI model identifier is exactly `typesafe/jev`, without an `@cf/` prefix. Keep the native `AI` binding; an explicit gateway uses the third argument to `AI.run`, with `gateway.id` from `AI_GATEWAY_ID`. Confirm the billing unit (tokens, requests, or other), actual rate and account requirements rather than deriving cost from token usage alone.

## 2. Bindings and configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `AI` | AI binding | Jev access |
| `AI_GATEWAY_ID` | Variable | Explicit gateway name in the same account; provisionally required pending Phase 0 verification |
| `DB` | D1 binding | State, jobs and history |
| `GOOGLE_CLIENT_ID` | Secret | OAuth client identifier, provisioned with credential set |
| `GOOGLE_CLIENT_SECRET` | Secret | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Secret | Owner's offline Gmail access |
| `ADMIN_API_TOKEN` | Secret | High-entropy API credential |
| `GMAIL_ACCOUNT_EMAIL` | Variable | Exact configured mailbox identity |
| `OWNER_ALIASES_JSON` | Variable | Additional addresses relevant to recipient context, default `[]` |
| `OWNER_TIME_ZONE` | Variable | IANA time zone; initial fallback UTC |
| `EMPLOYER_DOMAINS_JSON` | Variable | Optional Work context, default `[]` |
| `AI_MODEL` | Variable | `typesafe/jev` |
| `DEFAULT_MODE` | Variable | `dry_run`; initializes persistent mode only on first setup |
| `INITIAL_LOOKBACK_DAYS` | Variable | `7` |
| `MAX_JOBS_PER_TICK` | Variable | Starting ceiling `20`; lower when measured stage costs require it |
| `TICK_WALL_BUDGET_MS` | Variable | `120000`; elapsed-time admission budget, not CPU allowance |
| `CHECKPOINT_RESERVE_MS` | Variable | `15000`; time reserved for durable checkpoints and lease handling |
| `RUN_LEASE_MS` | Variable | `180000`; renewable run lease |
| `MAX_BACKFILL_MESSAGES` | Variable | `5000`; maximum owner-requested inbox backfill size |
| `CLEANUP_BATCH_SIZE` | Variable | `100`; maximum rows per cleanup batch |
| `MAX_AI_CALLS_PER_DAY` | Variable | `500`; account-wide production attempt cap per UTC day, including retries/dry-run/reprocessing |
| `MAX_BODY_CHARACTERS` | Variable | `12000` |
| `DETAIL_RETENTION_DAYS` | Variable | `90` |

Validate variables once per invocation/service initialization using Zod. Thresholds, taxonomy and rubric live in versioned code/configuration rather than undocumented dashboard edits. The active mode lives in D1; a deployment must not reset it unexpectedly.

Validate positive bounded configuration values, checkpoint reserve below the wall budget, and a run lease longer than the wall budget. `MAX_AI_CALLS_PER_DAY=0` intentionally defers all inference. Use conditional D1 reservations before calls; no dispatch is allowed when the budget cannot be reserved. The guard limits call volume, not money, and does not cover independent local evaluation.

For email requests, set gateway `skipCache: true` and `collectLog: false`, and verify effective gateway logging/cache settings. Keep email bodies out of application logs and gateway content logs/caches. Document provider-side data handling separately rather than inferring zero retention from local application settings.

For a five-minute cron, Workers Paid currently allows 30 seconds CPU and 15 minutes wall time; Workers Free allows only 10 ms CPU. The application's 120-second wall budget leaves network waits separate from CPU use. Measure both via runtime telemetry and tune batch/input limits; raising an HTTP CPU setting is not a way to bypass the cron CPU limit.

Use Wrangler-generated binding types and invoke project tooling through the documented `bun run` scripts. Choose and pin the compatibility date during implementation. Enable compatibility flags only for deployed dependencies that need them. Bun is local tooling, not the deployment runtime; Bun-only APIs and the local OAuth helper's dependencies must stay outside the Worker bundle.

## 3. Google authorization setup

1. Enable Gmail API and configure the OAuth consent screen.
2. Register the bootstrap helper's exact localhost redirect URI.
3. Request `gmail.modify` and offline access, validate browser-bound state, and check granted scopes.
4. Use the returned access token to verify the Gmail profile matches the configured owner.
5. Store the refresh token through local secret provisioning, not in repository files or shared terminal logs.
6. Refresh tokens are not returned on every authorization. Preserve an existing valid token when a response omits it; use a deliberate re-consent flow when needed.
7. Test a fresh access-token exchange with the stored refresh token.

Google documents a seven-day refresh-token lifetime for External apps in Testing status when scopes go beyond basic identity scopes. Account for this in the development setup; do not mistake regular testing-token expiry for a sync defect. Use Google's appropriate publishing configuration for unattended personal operation and verify the applicable personal-use rules. A later public/multi-user release requires a separate OAuth review of restricted-scope requirements.

## 4. Deployment sequence

1. Finish the integration spike and local checks.
2. Provision D1. Review committed Drizzle Kit-generated SQL migrations, verify them locally, then apply those same files with Wrangler to the intended environment. Keep Wrangler's `migrations_dir` aligned with Drizzle Kit's output. Schema changes run before dependent application code is deployed, using backward-compatible changes where needed.
3. Configure AI/D1 bindings, variables, secrets and production cron in Wrangler.
4. Deploy with default dry-run mode.
5. Verify health, authenticated status, Gmail owner identity and a synthetic Jev call. Verify explicit gateway access, billing units and disabled content logging/cache behavior as part of this check.
6. Run read-only label inventory and review collision output.
7. Bootstrap the recent inbox and inspect dry-run results.
8. Evaluate using DEVELOPMENT.md; adjust versioned criteria and thresholds as needed.
9. Enter apply mode to execute the explicit label migration; inspect names, IDs and Gmail hierarchy.
10. Apply a selected small set of saved compatible classifications, then allow new-message processing.
11. Observe the first production day for latency, retries, false urgent labels and manual correction behavior.

Setting apply mode does not automatically replay all completed dry-run results. Use the saved-result API or a controlled reprocessing operation for selected existing messages.

## 5. Daily operation and monitoring

Log JSON events with request/run/job IDs, stage, durations, counts, error class, model version and token totals. Never log bodies, OAuth tokens, authorization codes or raw headers. Keep message identifiers in the database; operational logs can use internal job IDs.

Monitor:

- Last successful discovery and processing times.
- Oldest pending job and due/failed counts.
- Initial scan/recovery progress and capped backfills.
- Model failures, invalid responses and uncertain-decision rates.
- Gmail quota/rate errors and OAuth connection state.
- Label mutation failures and migration conflicts.
- Input tokens and actual Cloudflare inference cost.
- Reserved daily AI attempts, remaining allowance, reset time and budget-deferred jobs.
- Per-job wall latency, invocation CPU time and work deferred by the tick budget.
- Correction frequency by label and model/rubric version.

Suggested operational triggers: inspect sync after 15 minutes without a successful tick, inspect a growing backlog older than 30 minutes, and investigate any repeated auth or label-write failure. These are proposed alert thresholds, not service guarantees.

## 6. Recovery procedures

### Pause processing

Set persistent mode to `paused`. Read status to confirm the active run has stopped starting new units. For a complete shutdown, remove cron with an explicit empty schedule list and deploy; configuration omission may leave an existing cron in place. Requests already in flight can finish, so inspect the mutation journal before resuming.

### Jev unavailable or account billing exhausted

Jobs back off and then become visible failures; email remains in Gmail. Check Cloudflare model availability and billing, then retry from the last durable stage. The MVP has no automatic second-model fallback that would change classification semantics silently.

### OAuth revoked/expired

Run the bootstrap helper again, verify the account, replace the refresh-token secret, then run a connection check and resume. Preserve the cursor; if it has expired, normal recovery performs the inbox rescan.

### Daily AI allowance exhausted

Inspect `aiBudget` in status. Inference jobs wait for the next UTC-day allowance; discovery and saved-result/correction application continue. Inspect whether backfill, retries or explicit reprocessing consumed the allowance before deliberately changing the configured cap. Budget exhaustion does not consume the provider-error retry allowance and is not a terminal failure.

### Sync cursor invalid

History 404 enters the documented current-inbox recovery scan automatically. Check progress rather than resetting D1. If mail outside the inbox must also be recovered, design/run an explicitly scoped extension of backfill rather than claiming the inbox scan covers it.

### Incorrect classification

Submit a correction for the affected dimension. Add an appropriately redacted example to the evaluation set. Change the rubric only after testing other categories for regressions.

### Label renamed or deleted outside the service

Refresh inventory and reconcile known IDs/names. Surface unresolved mapping conflicts. Recreate missing approved labels only through the setup operation, then retry affected mutations.

### Deployment rollback

Pause, deploy the previous application version, and keep D1 migrations backward-compatible where practical. A code rollback does not revert Gmail labels. Use mutation records to propose a targeted reversal; only reverse app-owned changes that still match expected state. Do not bulk undo manual edits.

### Data maintenance

The TypeScript Drizzle schema is the database definition source. Drizzle Kit generates migrations; Wrangler is the only migration applier/tracker. Keep migration generation in development/CI tooling, not Worker startup. Review data migrations and table rebuilds before remote application. Avoid mixing direct schema push or a second migration runner into production.

Clean expired detail rows in bounded batches. Retain minimum deduplication records, correction locks, active jobs and pending mutation intents. Back up/export D1 before destructive schema changes using supported current D1 tooling; verify restoration in a separate database before relying on it.

## 7. Cost model

Total cost consists of Worker executions/compute, D1 reads/writes/storage, and Jev inference at Cloudflare's account-specific published rate. Five-minute polling produces approximately 288 scheduled invocations per day before manual operations.

Estimate monthly inference from measured input/output usage, call counts and the verified dashboard billing units. Do not substitute TypeSafe's direct API rate or assume returned token counters imply token billing. Bound backfills and report processed counts/tokens so one large historical scan is visible in the estimate. Include any applicable gateway charges. The daily call guard reduces accidental volume but cannot guarantee a dollar ceiling when request sizes or pricing vary.

## 8. Post-launch review

After the first week, review latency, categories with frequent corrections, false urgent labels, body truncation frequency and actual cost. Adjust batch size or schedule based on measured backlog. Revisit Queues or push notifications only if the current design misses the owner's latency/volume needs.

## 9. Hardened runtime behavior

- Mode is re-read at provider-stage admission and before Gmail mutation. Queued migrations remain waiting in dry-run; paused mode stops new work. An already-dispatched request may finish.
- The runner renews its mailbox lease between admitted stages. Cursor/page checkpoints include the owner token and expiry in their SQL conditions. Discovery receives a bounded portion of the tick so processing can progress during large scans.
- Gmail/OAuth requests use 10-second abort signals. Gmail responses are streamed into a 4 MiB limit, OAuth/API JSON into 64 KiB limits. MIME traversal is bounded to 200 parts and depth 30. The complete serialized Jev request has a conservative 30,000 UTF-8-byte cap (including questions), reserving space within the documented 32k-token context; rejected inputs expose `model_input_too_large` rather than retrying inference.
- Label migration journals are committed before the first Gmail write. Restarting reconciles the original step IDs and old/new names. Message mutations enforce approved IDs at the Gmail adapter boundary; stale intents are superseded and recomputed, never treated as satisfied by silently dropping their IDs.
- Owner operations and idempotency responses commit atomically in D1. Replay keys live at least 90 days and remain while their operations exist. Legacy incomplete reservations return a conflict for inspection instead of blindly rerunning partially persisted work.
- Detailed classifications, including the latest result, expire after the retention period unless needed by active jobs or pending intents. Message/job identity, ownership and correction locks remain. A correction can still reconcile its specified dimensions after classification details expire.
- `status` reports complete 15-label readiness, last completion time and the last persisted redacted run error. Workers observability is enabled in Wrangler; use runtime telemetry for CPU duration rather than inferring CPU from wall time.

The new repository code is not automatically deployed by CI. Complete local checks, deploy deliberately, then continue the dry-run observation and measured release gates before routine apply mode.
