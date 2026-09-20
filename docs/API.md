# HTTP API

The routes below are implemented. Base path: `/api/v1`.

## 1. Authentication and validation

- `GET /healthz` is public and returns only service liveness and build version.
- Every `/api/v1/*` route requires `Authorization: Bearer <ADMIN_API_TOKEN>`.
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

Use 400 for invalid input, 401 for missing/invalid authentication, 404 for absent resources, 409 for incompatible state/idempotency conflicts, 413 for size limits, 429 for rate limiting, and 503 for unavailable dependencies.

## 2. Endpoints

| Method/path | Purpose | Response |
| --- | --- | --- |
| `GET /healthz` | Public liveness only | 200 |
| `GET /api/v1/status` | Mode, mailbox connection, sync status, backlog and errors | 200 |
| `PATCH /api/v1/settings` | Set `mode`: paused, dry_run, apply | 200 with persisted settings |
| `GET /api/v1/labels` | Canonical keys, Gmail IDs, inventory and migration conflicts | 200 |
| `POST /api/v1/labels/migration-plan` | Refresh inventory and build a read-only setup plan | 202 with operation ID |
| `POST /api/v1/labels/migrate` | Enqueue the identified migration plan | 202; apply mode required |
| `POST /api/v1/sync` | Enqueue an incremental discovery request | 202 |
| `POST /api/v1/backfills` | Enqueue a bounded inbox date-range scan | 202 |
| `GET /api/v1/operations/:id` | Read operation/job progress and errors | 200 |
| `GET /api/v1/messages` | Cursor-paginated stored results | 200 |
| `GET /api/v1/messages/:id` | Result, action probabilities, ownership and correction history | 200 |
| `POST /api/v1/messages/:id/reprocess` | Enqueue new inference under current rubric | 202 |
| `POST /api/v1/messages/:id/apply` | Enqueue application of a selected saved result | 202; apply mode required |
| `POST /api/v1/messages/:id/corrections` | Persist replacement decisions and enqueue reconciliation | 202 |
| `POST /api/v1/messages/:id/retry` | Retry a failed processing job from its durable stage | 202 |

Use Gmail message IDs in message paths. Account scope always comes from server configuration, not an arbitrary client-supplied mailbox.

Long work is stored before returning 202. The next scheduled tick processes it. Operation statuses are `queued`, `running`, `completed`, or `failed`; detailed job stages and deferral reasons are exposed separately where relevant. The MVP has no cancellation state or endpoint; pausing stops admission of new work without discarding queued operations.

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

`POST /sync` and the read-only `POST /labels/migration-plan` accept an optional key. Without a key, coalesce duplicate queued requests for the same mailbox/kind using an atomic database constraint. If a sync is already running, retain at most one follow-up request so new changes are not lost; respond with the existing queued follow-up ID when present. Explicit keys still receive the usual replay/conflict semantics. Do not use indefinite payload-hash deduplication for intentional repeated backfills or reprocessing.

Settings updates are intrinsically idempotent. The API persists work; one runner serializes Gmail changes. A correction that arrives during inference increments the revision, and the worker must observe that revision before preparing a mutation.

## 5. Read responses

`GET /messages` is D1-only and returns `{ items, nextCursor }`. Each item contains `messageId`, `threadId`, `receivedAt`, `classificationId`, `classifiedAt`, `processingStatus`, `applicationStatus`, `topic`, `topicDecisionStatus`, `actions`, `needsReview`, `reviewReasons`, `model`, `taxonomyVersion`, `rubricVersion` and `policyVersion`. Pending messages may have null result fields. It does not fetch or include subjects/senders. Return the latest result per message rather than duplicate list rows for old generations.

`GET /messages/:id` adds stored probabilities, topic confidence, ownership, locks and retained correction history. By default it also uses D1 only. With `includeGmailMetadata=true`, fetch Gmail `format=metadata` with Subject/From headers and return `gmailMetadata: { status, subject, from, fetchedAt, errorCode }`. Status is `available`, `not_requested`, `unavailable` (message missing), or `error` (auth/transient failure); missing values are null and errors are redacted. The stored detail still returns 200 if enrichment fails. Do not persist the fetched headers or request a body for this enrichment.

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

`status` includes last discovery/completion times, queued/due/failed counts, current sync phase, last redacted error, active mode, model identifier, configuration versions, migration readiness, and `aiBudget: { used, limit, resetsAt, deferredJobs }`. Budget deferral is not a terminal failure. An HTTP 200 status response may still describe a disconnected mailbox; liveness is not proof of working OAuth.
