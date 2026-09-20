# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner of a personal Gmail account, who is also the developer-operator of the service. They triage the inbox from a desktop and from a phone; the dashboard must work well in both contexts. No other audiences exist — access is owner-only.

## Product Purpose

Classify incoming Gmail with the Jev model through Cloudflare's AI binding and apply a topic label plus relevant action labels, so the existing inbox is easier to scan. Each message answers four questions: What is it about? Is it urgent? Does it need a reply? Does it require another action? Gmail remains the interface for reading email; the owner dashboard served by the same Worker covers the routine triage work (review, correct, retry/reprocess, apply saved results, scan older mail, manage labels, switch modes, trigger bounded runs). Success means: relevant email is easier to find, urgent messages stand out, routine messages are categorized consistently.

## Positioning

A private, single-tenant service running on the owner's own Cloudflare account against their own Gmail — no third-party SaaS reads their mail. What a neighboring product could not truthfully copy: ownership-aware label diffs that preserve manual classifications, a per-question uncertainty policy that surfaces uncertain results instead of inventing labels, and durable, recoverable processing (leases, journals, bounded retries) persisted in D1.

## Operating Context

- Gmail web and mobile app is the reading experience; labels are the primary UX.
- The owner dashboard is a React + Vite app served by the Worker as static assets, backed by the authenticated owner API (same capabilities, for automation and recovery).
- Cloudflare dashboard is where the owner manages the AI Gateway (Unified Billing, `email-triage-badi-dev`), Workers, and D1.
- Modes progress from `dry_run` to `apply` after evaluation; a five-minute cron drives discovery, with bounded runs, retries, and backfill.
- OAuth bootstrap is done locally via a script; the refresh token lives in a Worker secret.

## Capabilities and Constraints

- Approved taxonomy: 12 topic labels plus an internal `other` outcome, and 3 independent action labels (urgent, needs reply, to do). Exact names and boundaries live in `docs/LABELS.md`.
- One classification call per message: one topic choice plus three action answers, with recorded model/rubric/policy versions and token usage.
- Corrections lock a message against automatic replacement; label changes are message-level operations.
- Single allowlisted Gmail account; scope is new inbox messages plus an initial scan of the last 7 days.
- Bounded inputs: subject cap 500 characters, body cap 12,000 characters; daily guard of 500 attempted AI calls per account per UTC day.
- Detailed result retention is 90 days; deduplication records persist while the account is connected.
- Modes: pause, dry-run, apply. Failures are visible and retriable with persistent backoff.
- Dashboard usage is confirmed for desktop and phone (user-confirmed 2026-09-21); the UI must remain fully usable on a phone.
- Open decision: the specific meaning/derivation of the name "Badi" was not stated; only its binding status is recorded.

## Brand Commitments

- The name "Badi" is a binding product name (user-confirmed 2026-09-21): the product identity carries it. Its specific meaning is not yet recorded and must not be invented.
- No other voice, personality, or visual identity commitments were established.

## Evidence on Hand

- Live verification (2026-09-20, recorded in `README.md` and `docs/RESEARCH.md`): real Jev inference through the AI binding, Gmail OAuth bootstrap with PKCE, read-only label inventory (21 labels, six legacy mappings), a 15-example synthetic evaluation with zero failures, and a deployed production Worker with verified `/healthz` and authenticated `/api/v1/status`.
- A runnable codebase with 149+ Workers-runtime tests, dashboard jsdom tests, and fixture-based evaluation tooling (`fixtures/`, `bun run evaluate`).
- Complete internal documentation under `docs/` (plan, labels, architecture, API, operations, research).
- Absences: no design system record (no DESIGN.md), no committed visual golden captures or screenshot fixtures, no testimonials, press, or marketing assets. Future work must not fabricate any of these.

## Product Principles

1. **Gmail is the primary interface.** The service organizes; the dashboard orchestrates. Label behavior in Gmail is the product outcome, not the dashboard alone.
2. **Owner trust over automation.** Uncertain results are surfaced for inspection, never guessed into new labels; manual classifications are preserved and locked.
3. **Bounded and recoverable by construction.** Every operation is capped, journaled, and resumable; interrupted work never corrupts state or re-does completed classification.
4. **Dry-run before apply.** Label application is evidence-gated: evaluate actual behavior before touching the mailbox.
5. **Single-tenant simplicity.** One account, one owner, no multi-tenant abstractions — every surface reflects that scope honestly.

## Accessibility & Inclusion

Personal floor (user-confirmed 2026-09-21): sensible contrast, keyboard support, and reasonable screen-reader semantics; no formal WCAG conformance target is required.
