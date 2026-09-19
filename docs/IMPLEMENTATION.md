# Implementation plan

All tasks are initially open. Complete each phase's acceptance criteria before its dependent phase. These are implementation work packages, not claims that code exists.

## Phase 0 — Verify live integrations

Dependencies: Cloudflare account, Google Cloud project, owner Gmail identity.

- [ ] Confirm `typesafe/jev` is enabled for the target Cloudflare account and record dashboard pricing/billing requirements.
- [ ] Test the Jev page's plain binding call and an explicit gateway call; record account/gateway configuration and whether a gateway is required. Provisionally configure `AI_GATEWAY_ID` and Unified Billing until verified.
- [ ] Verify the actual billing unit (per-token, per-request, or other), rate and usage accounting; do not infer pricing from response token counts.
- [ ] Verify gateway caching/content logging are disabled for email requests and document remaining provider-side retention terms separately.
- [ ] Create a minimal development Worker with an AI binding and make one synthetic Choice/Noul request.
- [ ] Compare the runtime response to Cloudflare's published schema; record returned model and token usage.
- [ ] Generate Worker binding types with current Wrangler; check whether Jev is represented. If types lag, isolate a precise local adapter rather than spreading `any` casts through the app.
- [ ] Verify model request limits, actual latency, and timeout/cancellation behavior.
- [ ] Enable Gmail API; create OAuth credentials and a localhost callback configuration.
- [ ] Implement a local bootstrap helper with state validation and offline access using a maintained Google OAuth library.
- [ ] Validate granted scope, obtain a refresh token, and read the owner profile.

Deliverables: synthetic integration fixture, sanitized findings in RESEARCH.md, documented account setup.

Acceptance: successful binding inference and successful Gmail profile read for the configured owner. Any pricing or version-pinning uncertainty is documented rather than guessed.

## Phase 1 — Application foundation

Dependencies: Phase 0 integration shape.

- [ ] Scaffold the Hono Cloudflare Workers TypeScript project using Bun; commit `bun.lock` and pin the Bun version in project metadata and CI.
- [ ] Standardize project commands on `bun run`; use Bun for local TypeScript helpers and Vitest for tests. Verify Wrangler, Drizzle Kit, Vitest and OAuth-library compatibility; retain Node.js for tooling that requires it.
- [ ] Enable TypeScript strict mode; generate runtime/binding types from Wrangler.
- [ ] Add Hono, Zod 4, `@hono/zod-validator`; add development tooling and Workers-compatible Vitest integration.
- [ ] Add `drizzle-orm` as a runtime dependency and `drizzle-kit` as a development dependency; pin compatible versions.
- [ ] Implement `fetch` and `scheduled` entry points with shared service wiring.
- [ ] Implement environment validation, admin Bearer authentication and stable error responses.
- [ ] Add public health, authenticated status and persistent mode settings.
- [ ] Define the architecture's tables, constraints and indexes with Drizzle SQLite schema builders in `src/db/schema.ts`.
- [ ] Define the partial unique `(account_id, message_id) WHERE kind = 'initial'` index and message-job `(account_id, message_id, kind, generation)` uniqueness; prove later reprocess/correction generations remain insertable.
- [ ] Add atomic daily inference reservation counters and a queued-operation coalescing constraint for optional-key sync/inventory requests.
- [ ] Implement `src/db/client.ts` using `drizzle-orm/d1` and the `env.DB` binding.
- [ ] Configure `drizzle.config.ts` and Wrangler to share `migrations/`; verify generated SQL layout works with Wrangler.
- [ ] Generate and review SQL migrations with Drizzle Kit; apply with Wrangler to local D1.
- [ ] Implement typed Drizzle repositories, D1-supported transactional batches and atomic leases; isolate parameterized SQL where necessary.
- [ ] Add migration generation/local application scripts and an explicit remote-application script with environment selection.
- [ ] Add `.gitignore` for credentials, `.dev.vars`, private fixtures, generated local state, and evaluation outputs containing email data.
- [ ] Establish formatting, type checking, tests and dry-run build scripts.
- [ ] Verify a reproducible install with `bun install --frozen-lockfile` and ensure deployed modules do not import Bun-only APIs or local script dependencies.

Acceptance: clean install, type check, generated migrations applied to local D1, Drizzle repository/batch tests, auth/error tests and Worker build pass. Runtime starts in dry-run unless explicitly configured otherwise.

## Phase 2 — Gmail client and label inventory

Dependencies: Phase 1.

- [ ] Implement refresh-token exchange and one-refresh-on-401 behavior.
- [ ] Implement Gmail client methods, response validation and typed error reasons.
- [ ] Implement profile owner verification and persisted `auth_required` condition.
- [ ] Define the canonical 12 topic keys, 3 action keys and legacy mappings in source.
- [ ] Implement read-only label inventory and migration-plan generation.
- [ ] Implement full-payload fetching, selected text-part fetching and minimal-label fetching.
- [ ] Test pagination, malformed responses, token failures and quota errors with fixtures.

Acceptance: inventory maps real Gmail IDs to canonical keys; no label writes are required for this phase. Wrong-account credentials block the pipeline.

## Phase 3 — Normalization and classifier

Dependencies: Phases 0–2.

- [ ] Recursively decode Gmail MIME payloads, including base64url, charset, multipart alternatives and text-part attachment IDs.
- [ ] Select a Workers-compatible HTML-to-text approach and verify it under the Workers test runtime.
- [ ] Add body/subject/payload bounds, conservative quote trimming, attachment metadata and truncation markers.
- [ ] Implement Jev adapter and the topic plus three action questions.
- [ ] Define Zod provider schemas and inferred domain types.
- [ ] Implement independent per-dimension thresholds and uncertain outcomes.
- [ ] Persist versions, answer probabilities, decisions, input hash, usage and durations.
- [ ] Build a local evaluation runner against synthetic/redacted fixtures.

Acceptance: one message produces one validated call containing all four questions. Receipt/bill, newsletter/promotion, job-alert/recruiter and security/GitHub boundaries have representative examples. Unsupported content produces a visible outcome.

## Phase 4 — Sync and durable dry-run processing

Dependencies: Phase 3 and D1 repositories.

- [ ] Implement a mailbox run lease with ownership token, expiry and conditional renewal.
- [ ] Implement bounded initial scan with a pre-scan history anchor.
- [ ] Implement paginated incremental history and inbox-addition discovery.
- [ ] Persist discovered messages/jobs before advancing page progress or the final cursor.
- [ ] Implement invalid-page replay and expired-history recovery scans.
- [ ] Implement bounded sequential job processing, per-stage retries and terminal failures.
- [ ] Check remaining wall time before each job and expensive stage, reserve checkpoint time, and verify durable deferral when work will not fit. Treat 20 jobs as a starting maximum; measure per-job latency and CPU separately on Workers Paid.
- [ ] Enforce `MAX_AI_CALLS_PER_DAY` across inference attempts, retries and reprocessing; defer exhausted jobs until the next UTC day without consuming error retries, while continuing non-inference work.
- [ ] Persist classification before application; complete dry-run jobs without Gmail mutations.
- [ ] Implement explicit backfill jobs with fixed ranges, limits and resumable pagination.
- [ ] Add tests for overlapping cron runs, crash recovery and arrivals during bootstrap.

Acceptance: a replayed page or repeated tick does not create duplicate initial jobs. A failed classifier does not block discovery of later messages. Cursor advancement never loses undurable jobs. Dry-run makes zero Gmail mutation calls.

## Phase 5 — Migration and label application

Dependencies: Phase 4; classifier evaluated enough for a small apply-mode trial.

- [ ] Implement migration execution with rename-in-place, reuse, create and conflict outcomes.
- [ ] Journal each label setup step; reconcile current Gmail state on restart.
- [ ] Implement pure label-diff logic with per-dimension ownership and uncertainty preservation.
- [ ] Resolve legacy/canonical equivalence sets so an existing alias satisfies the desired label without duplicate addition; test removal/replacement by explicit correction.
- [ ] Enforce approved USER-label ID allowlists in both diff and mutation adapter; reject every SYSTEM-label mutation.
- [ ] Persist mutation intents, then apply message-level Gmail changes.
- [ ] Reconcile a pending intent after a crash rather than repeating inference.
- [ ] Detect changed manual labels before reprocessing; mark affected dimensions user-controlled.
- [ ] Preserve correction revisions if new owner input arrives while inference is in flight.
- [ ] Recheck application mode and message eligibility before mutation.
- [ ] Implement bounded refresh of missing/stale label mappings.

Acceptance: all six legacy mappings work, name collisions are reported, unrelated labels are preserved, and Gmail-write-success/D1-write-failure recovery is tested. New replies are treated as separate messages.

## Phase 6 — Operational API and corrections

Dependencies: Phase 5.

- [ ] Implement the routes and schemas in API.md.
- [ ] Implement cursor pagination and review/failure filters.
- [ ] Implement operation idempotency records and conflicting-payload detection.
- [ ] Coalesce optional-key sync/read-only inventory requests; retain required keys for deliberate write/reprocess/backfill operations.
- [ ] Define D1-only list fields and optional detail metadata enrichment; preserve stored responses when Gmail enrichment fails.
- [ ] Implement correction persistence, dimension locks and queued reconciliation.
- [ ] Implement saved-result application, explicit reprocessing and failed-job retry.
- [ ] Add redacted structured logs and status counters.
- [ ] Implement retention cleanup while preserving deduplication records, active jobs, pending intents and correction locks.

Acceptance: the owner can inspect uncertain messages, correct them, and retry failures. Reprocessing cannot overwrite a locked dimension. Status distinguishes liveness, OAuth failure, stale sync, and backlog.

## Phase 7 — Evaluation and release

Dependencies: Phases 0–6.

- [ ] Curate and split a representative labeled email set as described in DEVELOPMENT.md.
- [ ] Evaluate thresholds, category confusion, urgent precision/recall, action precision/recall, abstention, latency and token usage.
- [ ] Enforce >=90% accepted-topic accuracy and >=80% decision coverage on unambiguous held-out dimensions; report confident `other`, label-assignment coverage and ambiguous annotations separately.
- [ ] Run a dry-run period over a representative inbox sample; suggested starting duration is 3–7 days, extended if volume is low.
- [ ] Record real inference cost using Cloudflare's price for Jev.
- [ ] Exercise OAuth reconnect, provider throttling, expired history and deployment restart scenarios.
- [ ] Deploy the production Worker/D1 with secrets and scheduled trigger.
- [ ] Generate and execute label migration in apply mode, then verify Gmail label IDs and hierarchy.
- [ ] Apply a small explicitly selected set of evaluated results; inspect the resulting labels.
- [ ] Enable routine apply mode and monitor backlog, errors and corrections.
- [ ] Update README with actual setup commands and release status once implemented.

Acceptance: all release criteria in PLAN.md have measured evidence or a clearly recorded exception and rationale. Restore/pause procedures have been exercised.

## Recommended implementation slices

Each slice should remain reviewable and testable:

1. Project scaffold, config and health/auth.
2. Drizzle schema/client, generated D1 migrations and leases.
3. Gmail credentials/client and inventory.
4. Normalization and Jev classification.
5. Discovery and dry-run jobs.
6. Migration and mutation recovery.
7. Corrections and operational API.
8. Evaluation, deployment and runbook verification.

## Definition of done for every slice

- Types and validation match runtime boundaries.
- Changed behavior has meaningful tests, especially persistence and external-write failure paths.
- Formatting, type checking, applicable tests and build pass.
- No credentials or personal email bodies appear in tracked fixtures/logs.
- New configuration and operational behavior are reflected in these docs.
- Outstanding integration assumptions are recorded instead of concealed by mocks.
