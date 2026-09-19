# Development, testing and evaluation

## 1. Tooling to establish

Use **Bun** for package management, project scripts and local TypeScript helpers. Commit `bun.lock` once the application exists, pin the Bun version in project metadata and CI, and install with `bun install --frozen-lockfile` in CI. Use `bun add` for runtime dependencies and `bun add --dev` for development dependencies.

Cloudflare Workers remains the application runtime. Keep `Bun.*` APIs in local scripts only; deployed modules must use Workers-supported APIs. Continue using **Vitest** and Cloudflare's Workers test integration through `bun run test`, not Bun's built-in `bun test` runner.

Verify Wrangler, Drizzle Kit, Vitest and Google's OAuth library with the selected versions during setup. Bun can launch package scripts whose executables use Node.js internally; retain a supported Node.js LTS installation where those tools require it. Do not force Node-targeted tools onto Bun's runtime without checking compatibility. Runtime-specific tests execute inside Cloudflare's Workers test environment.

Planned scripts; these do not exist yet:

| Script | Contract |
| --- | --- |
| `bun run dev` | Local Wrangler development |
| `bun run types` | Generate Cloudflare binding/runtime types |
| `bun run typecheck` | TypeScript no-emit checking |
| `bun run lint` | Lint source and scripts |
| `bun run format:check` | Formatting verification |
| `bun run test` | Vitest deterministic tests with mocked external APIs |
| `bun run test:integration` | Vitest Worker runtime and local D1 integration tests |
| `bun run build` | Wrangler deploy dry-run / bundle validation |
| `bun run db:generate` | Generate SQL migrations and metadata from the Drizzle schema |
| `bun run db:migrate:local` | Apply committed migrations to local D1 with Wrangler |
| `bun run db:migrate:remote` | Apply committed migrations to an explicitly selected remote D1 environment with Wrangler |
| `bun run oauth:bootstrap` | Local interactive Google OAuth setup using a Bun TypeScript helper |
| `bun run evaluate` | Explicit live-model evaluation using a Bun TypeScript helper |
| `bun run deploy` | Deploy configured environment |

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

Assert list requests make no Gmail calls. Test detail enrichment disabled, available, missing-message, auth failure and transient failure; stored classifications remain accessible and subject/sender values are never written to D1.

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
