# Development, testing and evaluation

## 1. Tooling to establish

Use **Bun** for package management, project scripts and local TypeScript helpers. Commit `bun.lock` once the application exists, pin the Bun version in project metadata and CI, and install with `bun install --frozen-lockfile` in CI. Use `bun add` for runtime dependencies and `bun add --dev` for development dependencies.

Cloudflare Workers remains the application runtime. Keep `Bun.*` APIs in local scripts only; deployed modules must use Workers-supported APIs. Continue using **Vitest** and Cloudflare's Workers test integration through `bun run test`, not Bun's built-in `bun test` runner.

Verify Wrangler, Drizzle Kit, Vitest and Google's OAuth library with the selected versions during setup. Bun can launch package scripts whose executables use Node.js internally; retain a supported Node.js LTS installation where those tools require it. Do not force Node-targeted tools onto Bun's runtime without checking compatibility. Runtime-specific tests execute inside Cloudflare's Workers test environment.

Implemented scripts; D1 integration tests are included in `test`:

| Script | Contract |
| --- | --- |
| `bun run dev` | Local Wrangler development |
| `bun run web:dev` | Vite dev server for the dashboard with `/api` proxied to Wrangler |
| `bun run web:build` | Build the dashboard into `web/dist` for the Worker's static assets |
| `bun run types` | Generate Cloudflare binding/runtime types |
| `bun run typecheck` | TypeScript no-emit checking (worker/tests, scripts and dashboard projects) |
| `bun run lint` | Oxlint over `src`, `tests`, `scripts`, `web` |
| `bun run format` / `format:check` | Oxfmt formatting write/verify |
| `bun run check` / `fix` | Ultracite check/fix over the whole repository (Oxlint + Oxfmt) |
| `bun run test` | Workers-runtime API tests, then jsdom dashboard tests |
| `bun run test:api` / `test:web` | Run only the API suite or only the dashboard suite |
| `bun run test:watch` | Vitest watch mode |
| `bun run test:live` | Explicit live tests (real AI binding, remote inference; excluded from routine runs) |
| `bun run evaluate` | Live evaluation over the synthetic dataset with an explicit call cap |
| `bun run build` | Build the dashboard, then Wrangler deploy dry-run / bundle validation (assets included) |
| `bun run build:worker` | Wrangler deploy dry-run without rebuilding the dashboard |
| `bun run db:generate` | Generate SQL migrations and metadata from the Drizzle schema |
| `bun run db:migrate:local` | Apply committed migrations to local D1 with Wrangler |
| `bun run db:migrate:remote` | Apply committed migrations to the configured remote D1 |
| `bun run oauth:bootstrap` | Local interactive Google OAuth setup using a Bun TypeScript helper |
| `bun run oauth:check` | Verify the stored refresh token and Gmail profile |
| `bun run labels:inventory` | Read-only Gmail label inventory and migration plan (no writes) |
| `bun run deploy` | Build the dashboard, then deploy the configured Worker |

Notes from Phase 1 setup:

- Vitest is pinned to 4.1.x because `@cloudflare/vitest-pool-workers` 0.22 requires Vitest `^4.1.0`; the pool's new `cloudflareTest()` plugin replaces the older `defineWorkersConfig()` helper.
- The Workers compatibility date is `2026-08-22`, the newest date supported by the locally bundled workerd used by the test pool. Raise it when the local runtime supports a newer date.
- Tests run against local D1 with the committed Drizzle-generated migrations applied via `applyD1Migrations` in `tests/setup.ts`. Storage is isolated per test file, not per test, so tests use unique account and message identifiers.
- Test bindings (including the admin token) are injected through `vitest.config.ts`; local development secrets live in the gitignored `.dev.vars`.
- `wrangler types` reads `.dev.vars`, so the committed `worker-configuration.d.ts` includes local secret names. Regenerate it after changing bindings or `.dev.vars`.
- Linting and formatting use Ultracite's Oxlint/Oxfmt presets (`oxlint.config.ts`, `oxfmt.config.ts`); the Oxfmt line width stays at 90 to match the existing code. `bun run check` runs both tools repo-wide, while `lint`/`format` scope to `src`, `tests`, `scripts` and `web`. Sequential I/O loops use `for await...of` or explicit recursion rather than `for`/`while` so `no-await-in-loop` stays satisfied without parallelising rate-limited Gmail and D1 work. Tests keep at most five direct assertions per `it`, grouping related expectations into a single structural matcher. Dashboard files use kebab-case names; the Worker's `src` modules keep their existing naming.
- The dashboard is a separate Vite project under `web/` with its own `web/tsconfig.json`. Its tests run in jsdom through `vitest.web.config.ts` and stub `fetch` with the helpers in `web/test/harness.ts`; the Workers pool config excludes `web/**` so the two environments do not mix.
- The Workers test pool needs the assets directory from `wrangler.jsonc` to exist. `vitest.config.ts` writes a placeholder `web/dist/index.html` when the dashboard has not been built; run `bun run web:build` to test against the real bundle.

Local D1 and fake Gmail/AI adapters should be the default for development. A live AI binding request may use remote inference and incur charges even when initiated from local development; make the evaluation path explicit.

## 2. Testing strategy

### Unit tests

- Zod config, Gmail envelope, Jev answer and API schemas.
- MIME decoding: Unicode, base64url padding, multipart nesting, alternative deduplication, empty bodies and large content.
- HTML extraction: links, entities, meaningful line breaks, script/style exclusion.
- Classification decisions: exact threshold boundaries, topic `other`, invalid probability sums and missing question answers.
- Label diff: one proposed topic, independent actions, unknown labels, user ownership, locked corrections and uncertain dimensions.
- Label equivalence: legacy-only satisfies canonical intent, both representations avoid duplicate addition, correction removal covers aliases, and system-label IDs are rejected at the adapter boundary.
- Retry classification by HTTP status and provider error reason.

Use table-driven examples for policy boundaries; do not assert that a live model must always produce an identical floating-point probability.

### Worker/D1 integration tests

Run against Cloudflare's test integration and local D1 with the real Drizzle-generated SQL migrations. Exercise repositories through the Drizzle D1 adapter, including batch rollback and atomic claims; do not substitute a different SQLite driver for these integration tests. Test migration application to an empty database and upgrades from the previous schema with representative data.

Required scenarios:

1. Two concurrent runners: only one acquires the mailbox lease.
2. A run loses its lease: stale ownership cannot advance progress.
3. History has multiple pages and repeated message IDs: one initial job is created.
4. Failure after job insertion but before cursor commit: replay recovers without duplication.
5. Failure before job insertion: cursor stays unchanged.
6. A message arrives during bootstrap: catch-up from the saved anchor discovers it.
7. History returns 404: current inbox scan recovers older unknown messages.
8. A message later gains INBOX: discovery evaluates it if unseen or previously skipped solely for lacking INBOX; a completed classification remains deduplicated.
9. App label mutations appear in history: no classification loop.
10. Inference succeeds but label mutation fails: retry uses saved classification.
11. Gmail mutation succeeds but DB completion fails: journal reconciliation completes correctly.
12. A manual correction arrives during inference: the latest correction wins.
13. Owner removes an app action label: reprocess preserves that intent.
14. A message is archived/deleted before application: expected skipped outcome.
15. Dry-run/paused mode: no Gmail mutation request is emitted.
16. Retention cleanup preserves deduplication and active recovery state.
17. Partial initial-job uniqueness rejects duplicate initial jobs while allowing reprocess/correction generations; generation retries do not insert another job.
18. Time admission stops claiming jobs/stages with insufficient wall time; saved progress survives the next tick. Record CPU and wall-time telemetry separately.
19. Concurrent daily-budget reservations never exceed the cap; retries count, uncertain attempts are not refunded, and UTC rollover permits deferred inference. Saved-result application continues at the cap.
20. Optional-key sync requests coalesce with at most one queued follow-up; explicit operation keys retain replay/conflict behavior.

### API tests

Use Hono's request testing support. Cover authenticated routes, invalid JSON/content types, bounded pagination, idempotency replay/conflict, correction semantics and 202 operation tracking. Ensure error responses contain no raw OAuth/provider payloads.

Assert list requests make no Gmail calls. Test detail enrichment disabled, available, missing-message, auth failure and transient failure; stored classifications remain accessible. Stored Subject/From values are bounded header metadata, populated during classification or by an explicit metadata-refresh operation, and reused on later detail requests without another Gmail call.

Cover the dashboard session flow: token exchange sets an HTTP-only cookie, bad tokens and forged/expired cookies are rejected, cookie-authenticated mutations require the same-origin header, sign-out requires it too, cookies are `Secure` outside loopback, and rotating the admin token invalidates existing sessions. Cover asset routing: dashboard paths return the SPA shell while `/api/v1/*` stays on the Worker.

### Dashboard tests

Run the React app in jsdom with a stubbed `fetch` and assert the workflows the owner performs: listing recognizable messages, keeping uncertain action values distinct from "No", submitting only the changed correction dimensions (including explicit topic removal), gating apply/retry on mode and job state, keeping a note-only correction disabled, resetting the form between messages, cursor paging, returning to the login form on a 401, surviving a malformed hash, sending the dashboard header, reusing an idempotency key when the same payload is retried, queuing a bounded backfill, and confirming a label migration with its plan operation ID.

### Live smoke tests

Use a dedicated test mailbox or a small clearly identified owner-selected sample:

- Verify the actual `typesafe/jev` request/response shape.
- Read the account profile and label inventory.
- Create/rename test labels, verify IDs, then clean up only those known test resources.
- Classify a sample and inspect the exact message-level label diff.
- Test a new message in an existing thread; verify it receives its own classification.
- Revoke/reconnect OAuth and verify status/recovery.

Live smoke tests are explicit and excluded from routine CI.

## 3. Classification evaluation dataset

Start with approximately 150–300 owner-labeled examples, expanding where categories or action positives are sparse. Aim for at least 10–20 examples per topic and enough positive urgent/reply/task cases to measure precision meaningfully. These are practical starting sizes, not statistical guarantees.

Include:

- All 12 topic classes and `other`.
- Promotional messages that use urgent language.
- Credit card bill versus card-payment receipt.
- Subscription invoice versus successful renewal receipt.
- Job digest versus individual recruiter message.
- GitHub activity versus GitHub login alert.
- Payslip notifications with little body text.
- Reply-only versus non-reply task versus both.
- HTML-only, forwarded, quoted, multilingual and subject-only messages.
- Messages with misleading instructions embedded in content.
- Long messages whose decisive content appears near the end.

Store synthetic/redacted fixtures in the repository. Keep private evaluation examples outside version control. Split by thread and, where practical, repeated sender/template so near-duplicates do not leak between development and held-out sets.

Ground truth format specifies each dimension independently: `{ value, ambiguous }` for topic and each action. A reviewer marks `ambiguous: true` before model evaluation where a single ground-truth value cannot be justified; `value` may then be null. Do not infer annotation ambiguity from model confidence. Do not treat existing Gmail labels as unquestioned ground truth: some are broad or stale.

## 4. Evaluation report

Every run records:

- Timestamp, dataset version/hash, returned model versions, rubric/taxonomy/policy versions.
- Topic confusion matrix, per-class precision/recall and macro F1 with abstention/failure counts explicit. Report end-to-end correct-decision rate over all eligible unambiguous examples separately from accepted-topic accuracy; uncovered examples are not correct end-to-end decisions.
- Accepted-topic accuracy = correct accepted topic decisions / all accepted topic decisions on eligible, unambiguous topic examples; target >=90%.
- Decision coverage = accepted topic decisions / all eligible, unambiguous topic examples; target >=80%. Provider failures are uncovered. Zero accepted decisions gives undefined accuracy and fails coverage.
- A confident `other` is an accepted decision. Report its frequency/accuracy separately. Label-assignment coverage counts only accepted named-topic assignments over the same eligible denominator; uncertainty is abstention, not `other`.
- Each action's precision, recall, false-positive count, false-negative count and uncertain count.
- Confidence/probability bins versus observed correctness to assess calibration on this mailbox.
- Median/p95 inference latency, failure rate and token usage.
- Estimated cost using the verified Cloudflare rate, not the direct TypeSafe API rate.
- Representative mistakes and the proposed rubric change.

Exclude ambiguous annotations only for the affected dimension from primary accuracy/precision/recall and coverage calculations. Report total, eligible, ambiguous and excluded counts per dimension, plus model abstention rates on ambiguous examples. A clear action on a topic-ambiguous email still contributes to that action's metrics. Report uncertain and failed predictions on unambiguous action-positive examples as missed positives for end-to-end recall, while precision uses applied positives. If there are no predicted positives, precision is undefined, not 100%.

Local live evaluation must require an explicit maximum call count, counting retries, and report its own usage. It runs outside the production daily-budget counter unless explicitly routed through a budget-enforced production service; never claim it is automatically covered by that guard.

Tune on the development split. Re-run the untouched evaluation split before changing model/rubric/thresholds in production. A correction supplies a future evaluation example; it does not train or fine-tune Jev.

## 5. CI plan

After code exists, CI should install the pinned Bun version and the Node.js version required by its tools, run `bun install --frozen-lockfile`, then use the `bun run` scripts for generated-type consistency, formatting, linting, type checking, deterministic tests, local D1 integration tests and bundle validation. Include a schema/migration consistency check using the pinned Drizzle Kit version: regeneration should not reveal an uncommitted schema change. Deployment uses a scoped Cloudflare credential in CI secrets only after a deployment workflow is intentionally configured.

Model evaluation remains a separate explicit task because it costs money and has nondeterministic outputs. Keep runtime correctness tests deterministic through saved provider fixtures.

## 6. Completeness-review hardening

`.github/workflows/ci.yml` installs the pinned Bun version and Node.js 22, verifies generated binding types, formatting, lint, type checking, Workers/D1 tests, schema/migration consistency and the dry-run bundle. It has no deployment step. Routine tests disable remote bindings and inject test credentials; no Cloudflare or Gmail account is required.

`tests/hardening.test.ts` exercises mode changes between reads and writes, mode-eligible job admission, conservative stage budgets, cursor lease fencing, page-token replay, expired catch-up recovery, vanished messages, write-ahead migration recovery, concurrent/failed idempotent writes, saved-stage retry, in-flight corrections, retention and streaming input limits.

### Private evaluation and release gates

Use the fixture ground-truth format, with top-level `version`, `split` (`synthetic`, `development`, or `held_out`) and `examples`. Optional per-example `threadId` and `templateGroup` identify related examples. Keep private data under gitignored `eval/private/` or outside the repository.

```sh
# Pipeline smoke check only; synthetic data does not certify release quality.
EVAL_MAX_CALLS=30 bun run evaluate

# Tune on the development split.
EVAL_DATASET=eval/private/development.json EVAL_MAX_CALLS=300 bun run evaluate

# Enforce quality and sample-count gates on an untouched held-out split.
EVAL_DATASET=eval/private/held-out.json \
EVAL_DEVELOPMENT_DATASET=eval/private/development.json \
EVAL_MAX_CALLS=300 EVAL_ENFORCE=1 bun run evaluate
```

`EVAL_MAX_CALLS` must be supplied explicitly. Calls are sequential with no implicit retries. Attempts are counted even when the provider fails; unknown token usage is reported separately, so estimated cost is only the cost of known usage. `AI_GATEWAY_ID` optionally selects the evaluation gateway. The runner rejects overlapping IDs, thread/template groups and exact subject/body duplicates between development and held-out splits when enforcing gates.

Reports include dataset hash, timestamp, returned model versions and application versions; confusion matrix; per-topic precision, recall, F1, accepted accuracy and coverage; macro F1; end-to-end correct-decision rate; per-dimension annotation/abstention counts; calibration bins; action metrics; latency, usage and ID-only mistake lists. Review mistakes to decide rubric changes; the runner does not invent annotations or tune on the held-out split.

Enforcement requires the plan's topic/action thresholds and marks sparse categories unverified. Initial sample floors are 10 eligible examples for every topic including `other`, and 20 actual and predicted positives for each action. These are practical minimums, not statistical confidence guarantees. Null precision and zero coverage cannot pass. Enabling these gates does not mean the mailbox has passed them.
