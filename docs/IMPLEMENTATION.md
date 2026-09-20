# Implementation plan

Checkboxes track implemented work; phase notes preserve the evidence recorded at each milestone. Phase 7 remains open until measured mailbox quality and live rollout criteria are satisfied. Repository hardening updates are not a claim that production has been redeployed.

## Phase 0 — Verify live integrations

Dependencies: Cloudflare account, Google Cloud project, owner Gmail identity.

- [x] Confirm `typesafe/jev` is enabled for the target Cloudflare account and record dashboard pricing/billing requirements.
- [x] Test the Jev page's plain binding call and an explicit gateway call; record account/gateway configuration and whether a gateway is required. Provisionally configure `AI_GATEWAY_ID` and Unified Billing until verified.
- [x] Verify the actual billing unit (per-token, per-request, or other), rate and usage accounting; do not infer pricing from response token counts.
- [x] Verify gateway caching/content logging are disabled for email requests and document remaining provider-side retention terms separately.
- [x] Create a minimal development Worker with an AI binding and make one synthetic Choice/Noul request.
- [x] Compare the runtime response to Cloudflare's published schema; record returned model and token usage.
- [x] Generate Worker binding types with current Wrangler; check whether Jev is represented. If types lag, isolate a precise local adapter rather than spreading `any` casts through the app.
- [x] Verify model request limits, actual latency, and timeout/cancellation behavior.
- [x] Enable Gmail API; create OAuth credentials and a localhost callback configuration.
- [x] Implement a local bootstrap helper with state validation and offline access using a maintained Google OAuth library.
- [x] Validate granted scope, obtain a refresh token, and read the owner profile.

Deliverables: synthetic integration fixture, sanitized findings in RESEARCH.md, documented account setup.

Acceptance: successful binding inference and successful Gmail profile read for the configured owner. Any pricing or version-pinning uncertainty is documented rather than guessed.

Completed 2026-09-20. Evidence in RESEARCH.md section 0; fixtures in `fixtures/jev/`; spike removed from both accounts after verification.

## Phase 1 — Application foundation

Dependencies: Phase 0 integration shape.

- [x] Scaffold the Hono Cloudflare Workers TypeScript project using Bun; commit `bun.lock` and pin the Bun version in project metadata and CI.
- [x] Standardize project commands on `bun run`; use Bun for local TypeScript helpers and Vitest for tests. Verify Wrangler, Drizzle Kit, Vitest and OAuth-library compatibility; retain Node.js for tooling that requires it.
- [x] Enable TypeScript strict mode; generate runtime/binding types from Wrangler.
- [x] Add Hono and Zod 4 with a local JSON-body validation helper; add development tooling and Workers-compatible Vitest integration.
- [x] Add `drizzle-orm` as a runtime dependency and `drizzle-kit` as a development dependency; pin compatible versions.
- [x] Implement `fetch` and `scheduled` entry points with shared service wiring.
- [x] Implement environment validation, admin Bearer authentication and stable error responses.
- [x] Add public health, authenticated status and persistent mode settings.
- [x] Define the architecture's tables, constraints and indexes with Drizzle SQLite schema builders in `src/db/schema.ts`.
- [x] Define the partial unique `(account_id, message_id) WHERE kind = 'initial'` index and message-job `(account_id, message_id, kind, generation)` uniqueness; prove later reprocess/correction generations remain insertable.
- [x] Add atomic daily inference reservation counters and a queued-operation coalescing constraint for optional-key sync/inventory requests.
- [x] Implement `src/db/client.ts` using `drizzle-orm/d1` and the `env.DB` binding.
- [x] Configure `drizzle.config.ts` and Wrangler to share `migrations/`; verify generated SQL layout works with Wrangler.
- [x] Generate and review SQL migrations with Drizzle Kit; apply with Wrangler to local D1.
- [x] Implement typed Drizzle repositories, D1-supported transactional batches and atomic leases; isolate parameterized SQL where necessary.
- [x] Add migration generation/local application scripts and an explicit remote-application script with environment selection.
- [x] Add `.gitignore` for credentials, `.dev.vars`, private fixtures, generated local state, and evaluation outputs containing email data.
- [x] Establish formatting, type checking, tests and dry-run build scripts.
- [x] Verify a reproducible install with `bun install --frozen-lockfile` and ensure deployed modules do not import Bun-only APIs or local script dependencies.

Acceptance: clean install, type check, generated migrations applied to local D1, Drizzle repository/batch tests, auth/error tests and Worker build pass. Runtime starts in dry-run unless explicitly configured otherwise.

Completed 2026-09-20. 30 Workers-runtime tests pass (config validation, auth/error envelopes, settings persistence, leases, budget caps, job identity/claims, operation coalescing, D1 batch rollback); local D1 migration applied via Wrangler; bundle dry-run succeeds. Notes and script list in DEVELOPMENT.md.

## Phase 2 — Gmail client and label inventory

Dependencies: Phase 1.

- [x] Implement refresh-token exchange and one-refresh-on-401 behavior.
- [x] Implement Gmail client methods, response validation and typed error reasons.
- [x] Implement profile owner verification and persisted `auth_required` condition.
- [x] Define the canonical 12 topic keys, 3 action keys and legacy mappings in source.
- [x] Implement read-only label inventory and migration-plan generation.
- [x] Implement full-payload fetching, selected text-part fetching and minimal-label fetching.
- [x] Test pagination, malformed responses, token failures and quota errors with fixtures.

Acceptance: inventory maps real Gmail IDs to canonical keys; no label writes are required for this phase. Wrong-account credentials block the pipeline.

Completed 2026-09-20. 48 Workers-runtime tests pass (including token refresh/caching, one-refresh-on-401, typed Gmail errors, pagination, plan generation and mailbox identity blocking). Live read-only inventory verified the configured owner mailbox: 21 labels, all 6 legacy mappings detected for rename, 9 canonical labels and 4 parent containers planned for creation. Synthetic fixtures in `fixtures/gmail/`; operational command `bun run labels:inventory`.

## Phase 3 — Normalization and classifier

Dependencies: Phases 0–2.

- [x] Recursively decode Gmail MIME payloads, including base64url, charset, multipart alternatives and text-part attachment IDs.
- [x] Select a Workers-compatible HTML-to-text approach and verify it under the Workers test runtime.
- [x] Add body/subject/payload bounds, conservative quote trimming, attachment metadata and truncation markers.
- [x] Implement Jev adapter and the topic plus three action questions.
- [x] Define Zod provider schemas and inferred domain types.
- [x] Implement independent per-dimension thresholds and uncertain outcomes.
- [x] Persist versions, answer probabilities, decisions, input hash, usage and durations.
- [x] Build a local evaluation runner against synthetic/redacted fixtures.

Acceptance: one message produces one validated call containing all four questions. Receipt/bill, newsletter/promotion, job-alert/recruiter and security/GitHub boundaries have representative examples. Unsupported content produces a visible outcome.

Completed 2026-09-20. 82 Workers-runtime tests pass. Live verification through the real AI binding classified a synthetic invoice as `bills` (one call, 1.37 s, 1,270 input tokens) and the 15-example synthetic dataset with zero failures: topic accuracy 14/14 accepted and correct on unambiguous examples, urgent 0 predicted positives (1 uncertain on the positive), needs-reply precision 0.75/recall 1.0, to-do precision 1.0/recall 0.6, median latency 819 ms, p95 1,126 ms, total estimated cost $0.0008. These are pipeline-validation numbers on synthetic data, not mailbox quality claims. HTML extraction uses `htmlparser2`; MIME decoding, quote trimming and bounds are in `src/email/`; runner is `bun run evaluate` (explicit live config, 30-call cap).

## Phase 4 — Sync and durable dry-run processing

Dependencies: Phase 3 and D1 repositories.

- [x] Implement a mailbox run lease with ownership token, expiry and conditional renewal.
- [x] Implement bounded initial scan with a pre-scan history anchor.
- [x] Implement paginated incremental history and inbox-addition discovery.
- [x] Persist discovered messages/jobs before advancing page progress or the final cursor.
- [x] Implement invalid-page replay and expired-history recovery scans.
- [x] Implement bounded sequential job processing, per-stage retries and terminal failures.
- [x] Check remaining wall time before each job and expensive stage, reserve checkpoint time, and verify durable deferral when work will not fit. Treat 20 jobs as a starting maximum; measure per-job latency and CPU separately on Workers Paid.
- [x] Enforce `MAX_AI_CALLS_PER_DAY` across inference attempts, retries and reprocessing; defer exhausted jobs until the next UTC day without consuming error retries, while continuing non-inference work.
- [x] Persist classification before application; complete dry-run jobs without Gmail mutations.
- [x] Implement explicit backfill jobs with fixed ranges, limits and resumable pagination.
- [x] Add tests for overlapping cron runs, crash recovery and arrivals during bootstrap.

Acceptance: a replayed page or repeated tick does not create duplicate initial jobs. A failed classifier does not block discovery of later messages. Cursor advancement never loses undurable jobs. Dry-run makes zero Gmail mutation calls.

Completed 2026-09-20. 99 Workers-runtime tests pass, including bootstrap with catch-up arrivals, duplicate history IDs, budget deferral with cursor preservation and resume, expired-cursor recovery scans, label-only event suppression, INBOX re-entry, dry-run completion with no mutation calls, daily-cap deferral without retry consumption, wall-time admission, retry scheduling, invalid-AI one-retry failure, backfill cap/range/resume, atomic concurrent lease acquisition, paused mode and lease-holding runners. Production cron `*/5 * * * *` is configured in Wrangler; dry-run remains the seeded mode.

## Phase 5 — Migration and label application

Dependencies: Phase 4; classifier evaluated enough for a small apply-mode trial.

- [x] Implement migration execution with rename-in-place, reuse, create and conflict outcomes.
- [x] Journal each label setup step; reconcile current Gmail state on restart.
- [x] Implement pure label-diff logic with per-dimension ownership and uncertainty preservation.
- [x] Resolve legacy/canonical equivalence sets so an existing alias satisfies the desired label without duplicate addition; test removal/replacement by explicit correction.
- [x] Enforce approved USER-label ID allowlists in both diff and mutation adapter; reject every SYSTEM-label mutation.
- [x] Persist mutation intents, then apply message-level Gmail changes.
- [x] Reconcile a pending intent after a crash rather than repeating inference.
- [x] Detect changed manual labels before reprocessing; mark affected dimensions user-controlled.
- [x] Preserve correction revisions if new owner input arrives while inference is in flight.
- [x] Recheck application mode and message eligibility before mutation.
- [x] Implement bounded refresh of missing/stale label mappings.

Acceptance: all six legacy mappings work, name collisions are reported, unrelated labels are preserved, and Gmail-write-success/D1-write-failure recovery is tested. New replies are treated as separate messages.

Hardening evidence: `tests/hardening.test.ts` covers a rename succeeding before journal completion, mode changes before mutation, obsolete label intents, stale lease fencing, invalid history pages, expired bootstrap anchors, atomic operation rollback/replay/concurrency, retrying application without inference, and corrections arriving during inference. Migration steps are persisted together in a D1 batch before Gmail writes. Live label migration and the apply trial remain Phase 7 gates.

Local verification after completeness-review fixes: 176 tests across 17 files pass, along with formatting, lint, TypeScript checks and the Wrangler dry-run build. Frozen-lockfile installation succeeds, binding types were regenerated, and Drizzle reports no schema changes. Routine tests use no remote bindings. These are repository validation results, not production rollout or mailbox-quality evidence.

## Phase 6 — Operational API and corrections

Dependencies: Phase 5.

- [x] Implement the routes and schemas in API.md.
- [x] Implement cursor pagination and review/failure filters.
- [x] Implement operation idempotency records and conflicting-payload detection.
- [x] Coalesce optional-key sync/read-only inventory requests; retain required keys for deliberate write/reprocess/backfill operations.
- [x] Define D1-only list fields and optional detail metadata enrichment; preserve stored responses when Gmail enrichment fails.
- [x] Implement correction persistence, dimension locks and queued reconciliation.
- [x] Implement saved-result application, explicit reprocessing and failed-job retry.
- [x] Add redacted structured logs and status counters.
- [x] Implement retention cleanup while preserving deduplication records, active jobs, pending intents and correction locks.

Acceptance: the owner can inspect uncertain messages, correct them, and retry failures. Reprocessing cannot overwrite a locked dimension. Status distinguishes liveness, OAuth failure, stale sync, and backlog.

Completed 2026-09-20. 135 Workers-runtime tests pass, covering idempotent replay/conflict, coalescing, label inventory and apply-mode gating, cursor pagination and filters, detail enrichment availability/failure/not-requested, correction revisions with locks, reprocess generations, saved-result apply gating, retry reset, maintenance execution/deferral, operation status completion and bounded retention cleanup that preserves deduplication rows, locks and pending intents.

## Phase 7 — Evaluation and release

Dependencies: Phases 0–6.

- [ ] Curate and split a representative labeled email set as described in DEVELOPMENT.md.
- [ ] Evaluate thresholds, category confusion, urgent precision/recall, action precision/recall, abstention, latency and token usage.
- [ ] Enforce >=90% accepted-topic accuracy and >=80% decision coverage on unambiguous held-out dimensions; report confident `other`, label-assignment coverage and ambiguous annotations separately.
- [ ] Run a dry-run period over a representative inbox sample; suggested starting duration is 3–7 days, extended if volume is low.
- [x] Record real inference cost using Cloudflare's price for Jev.
- [ ] Exercise OAuth reconnect, provider throttling, expired history and deployment restart scenarios.
- [x] Deploy the production Worker/D1 with secrets and scheduled trigger.
- [ ] Generate and execute label migration in apply mode, then verify Gmail label IDs and hierarchy.
- [ ] Apply a small explicitly selected set of evaluated results; inspect the resulting labels.
- [ ] Enable routine apply mode and monitor backlog, errors and corrections.
- [x] Update README with actual setup commands and release status once implemented.

Acceptance: all release criteria in PLAN.md have measured evidence or a clearly recorded exception and rationale. Restore/pause procedures have been exercised.

In progress 2026-09-20. Completed: production Worker and remote D1 deployed with secrets and the `*/5 * * * *` cron in dry-run mode; health, authenticated status and the first live sync ticks verified; the synthetic evaluation runner measured 15 calls at ~$0.000053 per call and reported its own usage. A dry-run observation period is running against the live inbox (1,000+ inbox messages discovered and queued; the 500/day inference guard will pace classification). Owner-gated steps remain: the labeled held-out evaluation set, threshold enforcement, apply-mode label migration and the controlled apply trial. Two independent review rounds were completed and their actionable findings fixed with regression coverage (149 tests).

Exception recorded: expired-history recovery, retries and deployment restarts are exercised in the Workers-runtime test suite rather than by deliberate production outages; live OAuth-revocation and provider-throttling drills remain for the owner during the dry-run period.

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
