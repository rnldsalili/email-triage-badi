# HTTP API

The routes below are implemented. Base path: `/api/v1`.

## 1. Authentication and validation

- `GET /healthz` is public and returns only service liveness and build version.
- Every `/api/v1/*` route requires `Authorization: Bearer <ADMIN_API_TOKEN>`, except the session routes below.
- The dashboard authenticates with an HTTP-only session cookie instead of a bearer token. `POST /api/v1/auth/session` exchanges the admin token for a signed cookie whose key derives from `ADMIN_API_TOKEN`; `GET` reports `{ "authenticated": boolean }` and `DELETE` clears the cookie. Sessions are stateless with a 30-day lifetime: signing out clears the browser cookie, and rotating `ADMIN_API_TOKEN` invalidates every outstanding session.
- Cookie-authenticated non-GET requests must additionally prove same-origin intent: they require the `x-etb-csrf` header with value `dashboard`, and any supplied `Origin` must match the request host. Any `Sec-Fetch-Site` value other than `same-origin` or `none` (including `same-site`) is rejected with `FORBIDDEN` (403). Bearer requests skip this check. Sign-out is not session-authenticated but still requires the same header, so a cross-site page cannot force a logout.
- The session cookie is always `Secure` except for plain-HTTP loopback development. A downgraded production request never yields a usable session cookie.
- Use HTTPS, compare credentials safely, and never log authorization headers.
- No browser cookie authentication or permissive cross-origin access is needed for v1.
- Apply Zod validation to route parameters, queries and JSON bodies. Require the matching JSON content type. Bound request body size and pagination limits.
- Return stable error codes with a request ID; redact provider tokens and email bodies.

Error envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid correction payload",
    "requestId": "request-id"
  }
}
```

Use 400 for invalid input, 401 for missing/invalid authentication, 403 for rejected cross-site cookie requests, 404 for absent resources, 409 for incompatible state/idempotency conflicts, 413 for size limits, 429 for rate limiting, and 503 for unavailable dependencies.

## 2. Endpoints

| Method/path | Purpose | Response |
| --- | --- | --- |
| `GET /healthz` | Public liveness only | 200 |
| `GET /api/v1/auth/session` | Report whether the request carries a valid session | 200 |
| `POST /api/v1/auth/session` | Exchange the admin token for a session cookie | 200 with `Set-Cookie` |
| `DELETE /api/v1/auth/session` | Clear the session cookie | 200 |
| `GET /api/v1/config` | Dashboard configuration: modes, owner identity and bounded limits | 200 |
| `GET /api/v1/status` | Mode, mailbox connection, sync status, backlog and errors | 200 |
| `PATCH /api/v1/settings` | Set `mode`: paused, dry_run, apply | 200 with persisted settings |
| `POST /api/v1/run` | Start one bounded tick now instead of waiting for cron | 202 |
| `GET /api/v1/labels` | Canonical keys, Gmail IDs, inventory and migration conflicts | 200 |
| `POST /api/v1/labels/migration-plan` | Refresh inventory and build a read-only setup plan | 202 with operation ID |
| `POST /api/v1/labels/migrate` | Enqueue the identified migration plan | 202; apply mode required |
| `POST /api/v1/sync` | Enqueue an incremental discovery request | 202 |
| `POST /api/v1/backfills` | Enqueue a bounded inbox date-range scan | 202 |
| `GET /api/v1/operations` | Cursor-paginated operation history | 200 |
| `GET /api/v1/operations/:id` | Read operation/job progress and errors | 200 |
| `GET /api/v1/messages` | Cursor-paginated stored results | 200 |
| `GET /api/v1/messages/:id` | Result, action probabilities, ownership, job state and correction history | 200 |
| `POST /api/v1/messages/metadata-refresh` | Enqueue bounded Subject/From backfill for stored messages | 202 |
| `POST /api/v1/messages/:id/metadata` | Refresh and return one message's Subject/From from Gmail | 200 |
| `POST /api/v1/messages/:id/reprocess` | Enqueue new inference under current rubric | 202 |
| `POST /api/v1/messages/:id/apply` | Enqueue application of a selected saved result | 202; apply mode required |
| `POST /api/v1/messages/:id/corrections` | Persist replacement decisions and enqueue reconciliation | 202 |
| `POST /api/v1/messages/:id/retry` | Retry a failed processing job from its durable stage | 202 |

Use Gmail message IDs in message paths. Account scope always comes from server configuration, not an arbitrary client-supplied mailbox.

`GET /api/v1/status` reports `lastError` only when the most recently completed sync failed. A successful sync clears the active warning; older failures remain in sync history. An in-progress sync does not change the warning until it finishes.

Long work is stored before returning 202. The next scheduled tick processes it, and `POST /api/v1/run` may start that work immediately. Operation statuses are `queued`, `running`, `completed`, or `failed`; detailed job stages and deferral reasons are exposed separately where relevant. The MVP has no cancellation state or endpoint; pausing stops admission of new work without discarding queued operations.

### Manual tick

`POST /api/v1/run` performs one bounded tick and answers 202 with `{ "triggered": true, "status", "mode", "durationMs" }`. `status` is one of `completed`, `paused`, `lease_held`, `auth_required`, `identity_mismatch`, `lease_lost` or `error`; only `completed` means work ran. The tick is awaited rather than detached: `waitUntil` work is cancelled 30 seconds after the response, and a cancelled tick could leave the mailbox lease held. It uses a 60-second wall budget (the scheduled tick keeps 120 seconds) and never exceeds the configured daily AI allowance. The mailbox lease serializes it against the cron schedule, so a concurrent tick reports `status: "lease_held"` and does no duplicate work. Use it when the owner does not want to wait up to five minutes for the next scheduled run; the durable work itself is unchanged.

The endpoint is not idempotency-keyed: repeating it is safe because the lease prevents overlapping work, but each accepted call may spend a bounded amount of AI budget. It is intended for owner use, not unattended polling.

### Metadata refresh

```json
{ "retryErrors": true }
```

The body is optional. `retryErrors: true` moves stored messages whose metadata fetch failed terminally (state `error`) back into the pending set before queueing; at most 100 rows are re-armed per call. The response reports `{ operationId, coalesced, pending, errors }` after that reset. Without the flag only never-fetched (`missing`) messages are processed. The route coalesces instead of taking an idempotency key, so a repeated call returns the existing queued operation.

`POST /api/v1/messages/:id/metadata` refreshes one message synchronously and returns the same `{ status, subject, from, fetchedAt, errorCode }` shape as detail enrichment. It returns 503 when Gmail is temporarily unavailable, because nothing was persisted.

### Session

```json
{ "token": "admin-api-token" }
```

The token is compared against `ADMIN_API_TOKEN`; on success the response sets `etb_session` with `HttpOnly`, `SameSite=Strict`, `Path=/` and a 30-day `Max-Age`. `Secure` is set for every request except plain-HTTP loopback development, so a downgraded production request never yields a usable cookie. Session values are signed with an HMAC key derived from the admin token, so no session state is stored server-side.

## 3. Request contracts

### Settings

```json
{ "mode": "dry_run" }
```

Mode updates take effect before the next unit of work. A pause prevents starting new provider calls and writes; a request already sent may complete. Recheck mode immediately before any Gmail mutation. Paused mode still permits status reads and persistence of owner-requested jobs/corrections, which wait until processing resumes.

### Backfill

```json
{
  "receivedAfter": "2026-09-01T00:00:00Z",
  "receivedBefore": "2026-09-20T00:00:00Z",
  "maxMessages": 500
}
```

Require an increasing date range and a positive maximum bounded by `MAX_BACKFILL_MESSAGES` (initially 5,000). Only inbox messages are included. Construct Gmail queries on the server from validated dates, then verify exact bounds using `internalDate`. Report whether the job stopped at its limit so capped work is not represented as a complete scan.

### Label migration

```json
{ "planOperationId": "completed-migration-plan-operation-id" }
```

`planOperationId` is optional. When supplied it must reference a `completed` `migration_plan` operation for the same account; the API stores it with the `migrate` operation so the executed setup is auditable against the plan the owner reviewed. Invalid or unfinished references return 400. The migration itself re-reads the current Gmail label inventory before writing, so the reference is provenance, not a stale snapshot.

### Reprocess

```json
{ "reason": "Evaluate rubric-v2" }
```

Reprocessing retains correction locks. It generates a new proposal and applies only unlocked dimensions when in apply mode.

### Apply saved result

```json
{ "classificationId": "classification-id" }
```

Reject a superseded result or one from an incompatible taxonomy/policy version. Re-read Gmail state, correction revisions and eligibility before applying. Reuse persisted answers rather than issuing new inference.

### Correction

```json
{
  "topic": "applications",
  "actions": {
    "urgent": false,
    "needs_reply": true
  },
  "note": "Direct recruiter conversation, not a bulk job alert"
}
```

- Accept only stable topic/action keys.
- Omitted dimensions remain unchanged.
- `topic: null` explicitly requests removal of approved topic labels from that message.
- An explicit action false requests removal of that action label; true requests addition.
- Persist an incremented correction revision and lock each supplied dimension.
- In dry-run/paused mode save the correction but do not mutate Gmail. Return `applicationStatus: "pending_mode"` and enqueue reconciliation for apply mode.
- API corrections override the ownership restriction for the specified approved dimensions because the owner explicitly selected the replacement. They do not affect unrelated labels.
- Limit notes to 1,000 characters. Free-text notes are owner metadata, not model training instructions.

Unlocking corrections can be added later as an explicit operation; routine reprocessing never unlocks them.

## 4. Idempotency and concurrency

Require `Idempotency-Key` for backfills, corrections, reprocessing, saved-result application, retry and migration execution. The local admin client generates a key once per intentional operation and reuses it on transport retries. Store account, route, key, request hash and response operation ID. Same key/same payload returns the original operation; same key/different payload returns 409. Retain mappings at least as long as the related operation details.

`POST /sync` and `POST /labels/migration-plan` accept an optional key. `POST /messages/metadata-refresh` always coalesces. Without a key, coalesce duplicate queued requests for the same mailbox/kind using an atomic database constraint. If a sync is already running, retain at most one follow-up request so new changes are not lost; respond with the existing queued follow-up ID when present. Explicit keys still receive the usual replay/conflict semantics. Do not use indefinite payload-hash deduplication for intentional repeated backfills or reprocessing.

Settings updates are intrinsically idempotent. The API persists work; one runner serializes Gmail changes. A correction that arrives during inference increments the revision, and the worker must observe that revision before preparing a mutation.

## 5. Read responses

`GET /messages` is D1-only and returns `{ items, nextCursor }`. Each item contains `messageId`, `threadId`, `receivedAt`, `subject`, `from`, `metadataState`, `classificationId`, `classifiedAt`, `processingStatus`, `applicationStatus`, `topic`, `topicDecisionStatus`, `actions`, `needsReview`, `reviewReasons`, `model`, `taxonomyVersion`, `rubricVersion` and `policyVersion`. Pending messages may have null result fields and null stored headers. `metadataState` is `missing` (not fetched yet or retried later), `available`, `unavailable` (message no longer exists in Gmail) or `error` (fetch failed terminally; re-arm with `POST /messages/metadata-refresh` and `retryErrors`). It does not fetch Gmail while listing. Return the latest result per message rather than duplicate list rows for old generations.

`GET /operations` returns `{ items, nextCursor }` newest first, with optional `status` and `kind` filters, default 25 and maximum 100 records. Each item contains `id`, `kind`, `status`, `createdAt`, `startedAt`, `completedAt`, `progress`, `request` and `lastError`. Cursors are opaque and ordered by `(created_at, id)`.

`GET /messages/:id` adds stored probabilities, topic confidence, ownership, locks, retained correction history and the latest job state:

```json
{
  "job": {
    "id": "job-id",
    "kind": "initial",
    "stage": "retry_wait",
    "attempts": 2,
    "nextAttemptAt": "2026-09-21T08:10:00.000Z",
    "deferredReason": "ai_budget",
    "errorCode": null,
    "updatedAt": "2026-09-21T08:00:00.000Z"
  }
}
```

`job` is null when no job exists. Deferral reasons are non-terminal: `ai_budget` waits for the next UTC day, while `pending_mode`, `wall_time` and `lease_lost` wait for the next tick or for apply mode.

Reading a message never calls Gmail and never writes. With `includeGmailMetadata=true` the response returns the stored header metadata as `gmailMetadata: { status, subject, from, fetchedAt, errorCode }`; without it, `status` is `not_requested`. `status` mirrors the stored `metadataState`: `available`, `unavailable` (message missing), `error` (terminal failure), or `missing` (never fetched, or an environmental failure left it pending). Missing values are null and error codes are redacted provider reasons.

`POST /messages/:id/metadata` is the only path that fetches from Gmail. It calls `format=metadata` for Subject/From, persists the result, and returns the same shape. It answers 503 when Gmail is temporarily unavailable, because nothing was persisted. Headers are truncated before storage; bodies are never requested.

Stored metadata is only replaced by strictly newer observations, so a slow concurrent fetch cannot overwrite a newer result. The dashboard calls the POST once when a detail view finds no stored headers, so opening a message is the only time a Gmail call is made for it.

Abbreviated message result example (fields omitted here remain part of the list contract):

```json
{
  "messageId": "gmail-message-id",
  "threadId": "gmail-thread-id",
  "processingStatus": "completed",
  "applicationStatus": "not_applied_dry_run",
  "topic": "applications",
  "actions": {
    "urgent": false,
    "needs_reply": true,
    "to_do": null
  },
  "needsReview": true,
  "reviewReasons": ["to_do_uncertain"],
  "model": "jev-1.13.0",
  "rubricVersion": "rubric-v1",
  "policyVersion": "policy-v1"
}
```

Action `null` means uncertain, not false. Expose raw probabilities and topic confidence in the detail response. Suggested list filters: `needsReview`, `processingStatus`, `topic`, `limit`, `cursor`. Use an opaque cursor based on stable message `(first_seen_at, id)` ordering; default 25 and maximum 100 records. New classification generations update the result attached to that message without changing its pagination identity.

`status` includes last discovery/completion times, queued/due/failed counts, current sync phase, last redacted error, active mode, model identifier, configuration versions, migration readiness, `messages.missingMetadata`, and `aiBudget: { used, limit, resetsAt, deferredJobs }`. Budget deferral is not a terminal failure. An HTTP 200 status response may still describe a disconnected mailbox; liveness is not proof of working OAuth.
