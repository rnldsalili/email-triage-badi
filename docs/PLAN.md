# Project plan

Status: proposed implementation plan. Research date: 2026-09-20.

## 1. Outcome

Build a small, single-user service that organizes the owner's existing Gmail inbox using the approved labels. The service runs on Cloudflare Workers, uses Hono and TypeScript, validates boundaries with Zod 4, and classifies through `typesafe/jev` on the Cloudflare AI binding.

Success means relevant email is easier to find, urgent messages stand out, and routine messages are categorized consistently. Gmail labels are the primary user experience.

## 2. Confirmed requirements

- Cloudflare Workers deployment.
- Hono and TypeScript.
- Bun for package management, local TypeScript scripts and project command execution; Cloudflare Workers remains the deployment runtime.
- Zod where runtime validation is needed.
- Drizzle ORM for D1 queries and Drizzle Kit for SQL migration generation; Wrangler applies migrations.
- Jev through Cloudflare's AI binding.
- Existing Gmail mailbox and six existing labels.
- The 15 recommended labels in [LABELS.md](LABELS.md).
- A complete plan and implementation roadmap before writing the application.

## 3. Recommended defaults

These are planning decisions, not additional user-confirmed requirements.

| Decision | Initial default | Reason |
| --- | --- | --- |
| Accounts | One allowlisted Gmail account | Fits a personal service |
| Production plan | Workers Paid | Five-minute cron has a 30-second CPU allowance; Free has only 10 ms |
| AI access | AI binding with explicit AI Gateway and Unified Billing, pending Phase 0 confirmation | General binding reference requires a gateway for third-party models |
| Scope | New inbox messages; initial scan of last 7 days in inbox | Useful starting coverage with bounded work |
| Discovery interval | Every 5 minutes | Simple operation without Google Pub/Sub |
| Processing | Starting maximum of 20 jobs per tick, sequential initially | A ceiling, not a throughput promise; calibrate with per-job measurements |
| Tick time budget | 120 seconds wall time, with a 15-second checkpoint reserve and 180-second renewable lease | Check remaining time before every job/stage; resume deferred work next tick |
| Daily inference guard | 500 attempted calls per account per UTC day, initially | Includes retries/reprocessing; volume guard, not a dollar cap |
| Backfill and cleanup caps | 5,000 messages per backfill; 100 rows per cleanup batch | Configurable bounded maintenance work |
| AI input | Subject, sender/recipient context, relevant headers, cleaned body | Enough context for the task |
| AI body cap | 12,000 characters; subject cap 500 | Conservative application limit, not a token guarantee |
| Storage | D1 metadata and structured results | Supports retries, history, and corrections |
| Database layer | Drizzle ORM with a TypeScript SQLite schema | Typed queries and a maintainable schema for related tables |
| Normalized body retention | In memory during processing | Gmail remains the content source |
| Detailed result retention | 90 days | Bounded personal history |
| Deduplication records | Retained while the account is connected | Prevent old completed work reappearing after cleanup |
| Initial mode | `dry_run` | Evaluate actual behavior before applying labels |
| Admin interface | Bearer-authenticated Hono API | Small operational surface for one owner |
| OAuth setup | Local bootstrap helper, refresh token in Worker secret | Avoid building a hosted account-management UI |
| Label changes | Message-level operations | Incoming replies may need different decisions |

Character limits must still be checked against the integration's token budget, including questions. Oversized or unsupported inputs receive an explicit processing outcome.

## 4. MVP features

### Gmail connection and discovery

- Obtain offline OAuth access to the configured mailbox.
- Validate mailbox identity before syncing or writing.
- Run a bounded initial inbox scan, then incremental history synchronization.
- Recover from expired history cursors using a resumable scan of the current inbox.
- Keep discovered work durable before advancing the history cursor.

### Label setup and migration

- Inventory existing labels and persist their Gmail IDs.
- Rename an existing label when the destination name is absent.
- Create missing labels and hierarchy containers where needed.
- Handle old/new name collisions without deleting either label automatically.
- Record migration operations for restart and reversal.

### Classification

- One primary topic from the 12 topics, plus an internal `other` outcome.
- Three independently evaluated actions: urgent, needs reply, to do.
- Validate provider responses and apply per-question uncertainty policies.
- Record the returned model version, rubric version, policy version, and token usage.
- Expose uncertain results for inspection rather than inventing a new Gmail label.

### Application and corrections

- Apply a deterministic label diff against current message labels.
- Preserve existing manual classifications through the ownership rules in [LABELS.md](LABELS.md).
- Record before/after label sets and mutation attempts.
- Allow explicit corrections and lock corrected messages against automatic replacement.
- Allow retrying failures and explicitly reprocessing selected messages.

### Operation

- Health and detailed status endpoints.
- Pause, dry-run, and apply modes.
- Bounded retries with persistent backoff and visible failures.
- Redacted structured logging and basic counters.

## 5. First-release boundaries

The first release organizes messages with labels. Future work includes automatic archiving, generated summaries, daily digests, attachment extraction, sent-message tracking, custom sender rules, Gmail push notifications, and a dashboard.

`Action/Needs Reply` means a message appears to request a reply. It is not yet a live count of unanswered conversations. Action labels are cleared manually or through a correction in this release. Reading a message does not complete an action.

## 6. Milestones

| Milestone | Deliverable | Completion condition |
| --- | --- | --- |
| M0: Integration proof | Worker invokes Jev; Gmail credential reads configured mailbox | Real synthetic Jev response validated; Gmail profile matches owner |
| M1: Foundation | Hono, configuration, D1/Drizzle, auth, test runner | Type checking, generated migrations, boundary tests pass |
| M2: Read-only pipeline | Sync, normalization, durable jobs, dry-run classifications | Paginated scan and history recovery tested; no Gmail writes in dry-run |
| M3: Labeling | Migration, ownership-aware diffs, restart recovery | Existing-label fixtures and interrupted-write tests pass |
| M4: Owner controls | History, corrections, retries, pause, status | Corrections persist and survive later automatic processing |
| M5: Release | Evaluated and monitored deployment | End-to-end criteria below satisfied |

Detailed tasks and dependencies are in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## 7. Release criteria

### Functional

- A newly received inbox message is discovered, classified, and labeled.
- All 15 approved labels have correct IDs and names; optional hierarchy container labels are not classification outputs.
- Normal reruns reuse completed work instead of repeating inference.
- Reconnection, history expiration, and interrupted mutations have tested recovery paths.
- Manual corrections cannot be overwritten by an automatic rerun.
- Paused and dry-run modes prevent automated Gmail mutation.

### Quality targets

Targets are proposed acceptance goals, not measured performance claims.

- Accepted-topic accuracy of at least 90%: correct non-abstained decisions divided by all non-abstained decisions on eligible, unambiguously annotated held-out examples.
- Decision coverage of at least 80%: non-abstained decisions divided by all eligible, unambiguously annotated held-out examples. Inference failures count as uncovered. Zero accepted decisions yields undefined accuracy and fails the coverage gate.
- A confident `other` counts as a topic decision, not an abstention. Report label-assignment coverage (accepted decisions for the 12 named topics) separately, plus per-topic accuracy/coverage. These are proposed starting targets to validate against the mailbox.
- Urgent-label precision of at least 95%, with recall and sample counts also reported.
- Needs-reply and to-do precision of at least 90% each.
- Report per-category errors; a good overall score must not hide failures on payslips or financial email.
- Aim for 95% of ordinary new messages to be processed within 10 minutes under expected personal volume, excluding provider outages and backfill load.

If a label has too few examples to support a credible estimate, mark its quality unverified and expand the evaluation set. Tune thresholds on a development split and report final metrics on an untouched split.

Ground-truth ambiguity is annotated per dimension. Exclude ambiguous dimensions from primary accuracy/precision/recall denominators and report their counts and abstention rates separately. An ambiguous topic does not exclude a clear action annotation on the same message. See DEVELOPMENT.md for exact reporting rules.

## 8. Follow-up roadmap

1. Sender overrides with explicit priority and versioned configuration.
2. Thread-aware outstanding-reply tracking using sent messages and aliases.
3. Template-based daily digest; generative summaries only if useful.
4. Optional auto-archive for evaluated low-priority categories.
5. Gmail push notifications through Google Pub/Sub when polling latency becomes limiting.
6. A small dashboard if the API and Gmail interface become inconvenient.

## 9. Values to supply during implementation

- Gmail address and any aliases relevant to recipient detection.
- Preferred time zone for interpreting contextual urgency.
- Employer domains or other context needed to distinguish Work from Personal.
- Cloudflare account, Jev access/billing availability, and desired operating budget.
- Whether the recommended 7-day initial scan and 5-minute schedule should change.

Implementation can use the documented defaults until these values are configured. Unknown employer context must not be filled with guessed domains.
