# Research and architectural decisions

Research date: 2026-09-20. Live documentation was consulted for the design. Service pricing, availability and schemas can change; verify them during the implementation spike.

## 1. Verified findings

### Jev through Cloudflare

- Cloudflare's unified AI catalog documents `env.AI.run("typesafe/jev", { state, questions })`.
- Cloudflare's AI Gateway binding reference separately states third-party models require an AI Gateway and Unified Billing, and shows an explicit third `gateway` argument. This is an unresolved documentation discrepancy, not evidence that the gateway is optional. Provision a gateway and `AI_GATEWAY_ID` provisionally, then test both forms in Phase 0.
- The catalog marks Jev **third-party** and lists a 32,000-token context window.
- It returns typed Choice, Noul and Score answers; Choice/Score include distributions and confidence, while Noul returns a yes/no probability.
- The example response reports `jev-1.13.0`; this is evidence of a returned version, not evidence of a caller-selectable version pin.
- The published input schema allows `state` and `questions` and rejects extra top-level properties. Do not pass a direct-TypeSafe `model` property inside the binding input without documented support.
- Pricing is linked to the Cloudflare dashboard. TypeSafe's direct API price is not a verified Cloudflare price.
- Confirm whether Cloudflare bills Jev per token, per request or another unit. Token counters in a response alone do not establish the billing unit. Verify gateway content logging/cache settings alongside the integration.

Sources:

- [Cloudflare Jev model](https://developers.cloudflare.com/ai/models/typesafe/jev/)
- [Cloudflare Jev input schema](https://developers.cloudflare.com/ai/models/typesafe/jev/schema-input.json)
- [Cloudflare Jev output schema](https://developers.cloudflare.com/ai/models/typesafe/jev/schema-output.json)
- [Cloudflare unified model catalog](https://developers.cloudflare.com/ai/models/)
- [AI Gateway Workers bindings and third-party requirements](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)

Correction to the initial research: looking only at the older Workers AI catalog missed this unified-catalog integration. The plan uses the native binding, not a separate TypeSafe HTTP client or API key.

### Jev task fit and limitations

Jev is designed for bounded structured decisions rather than free-form generation. TypeSafe documents literal interpretation, numerical/date limitations, irrelevant-context sensitivity and susceptibility to adversarial state content. Typed output does not guarantee a correct email classification.

The plan therefore uses one topic Choice and three Noul questions, explicit category boundaries, limited relevant context, Zod response validation, and application-owned label decisions. Confidence thresholds require evaluation on the actual mailbox.

Sources:

- [TypeSafe API primitives](https://docs.typesafe.ai/api.md)
- [Confidence semantics](https://docs.typesafe.ai/confidence.md)
- [Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
- [TypeSafe models](https://docs.typesafe.ai/models.md)

Direct TypeSafe limits and endpoint parameters must not be assumed to describe Cloudflare's integration exactly.

### Gmail synchronization and labels

- Gmail supports full/bounded initial synchronization and incremental synchronization through history.
- History can expire; Gmail documents HTTP 404 as requiring a new full synchronization for the application's scope.
- Label operations ultimately affect messages. A thread's label list is the union across its messages.
- New messages in a thread do not inherit labels applied to existing messages.
- The pipeline needs access to bodies and message-label mutation, so it uses `gmail.modify`.
- OAuth offline access provides refresh tokens for unattended work; refresh credentials can expire or be revoked.

Sources:

- [Synchronize clients](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Manage labels](https://developers.google.com/workspace/gmail/api/guides/labels)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [History list reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list)
- [Message modification reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify)
- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

### Worker application structure

- Hono can expose its fetch handler alongside a Worker scheduled handler.
- Cron Triggers run on UTC schedules.
- Workers Paid cron intervals below one hour have a 30-second CPU limit; Workers Free has 10 ms. Cron wall duration is capped at 15 minutes. Network waits do not consume CPU time, so wall-time admission and CPU telemetry must be treated separately.
- D1 provides prepared statements and transactional batches suitable for persisting jobs and progress.
- Drizzle documents a native `drizzle-orm/d1` adapter for Workers. The plan adopts typed Drizzle queries and a SQLite TypeScript schema, with Drizzle Kit generating SQL and Wrangler applying migrations. Supported D1 batches and atomic statements remain the concurrency mechanisms.
- Zod 4 supports runtime parsing and JSON Schema conversion, though Jev's question API does not require a generated JSON Schema prompt.

Sources:

- [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Hono validation](https://hono.dev/docs/guides/validation)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers CPU and wall-time limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Drizzle Cloudflare D1 integration](https://orm.drizzle.team/docs/connect-cloudflare-d1)
- [Zod JSON Schema](https://zod.dev/json-schema)

## 2. Decision log

| Decision | Rationale | Revisit when |
| --- | --- | --- |
| Gmail API rather than Email Routing | The goal is organizing the existing Gmail inbox | A custom-domain ingress use case is added |
| Native Jev binding with provisional explicit AI Gateway | Reconciles general third-party requirements with a model example that omits gateway options; Phase 0 verifies behavior and billing | Live access-path verification resolves the discrepancy |
| Cron polling | Simple setup for one mailbox; avoids Pub/Sub/watch renewal | Lower latency becomes important |
| D1-backed jobs | Durable progress/retries with one database and low volume | Backlog requires independent consumers |
| Message-level labels | Correct for Gmail's actual semantics and new replies | Thread-aware product behavior is specified |
| One topic plus independent actions | Matches approved taxonomy and avoids conflating topic with urgency | Real examples demonstrate a need for multiple topics |
| Internal `other` and uncertain outcomes | Honest coverage without adding an unapproved Gmail label | Owner chooses a review label |
| Local OAuth bootstrap | Small personal-service setup without hosted account management | Multiple users/accounts are needed |
| No model-generated explanations in v1 | Jev is a decision model; probabilities and criteria provide diagnostics | Summaries become a product requirement |
| Drizzle ORM + Drizzle Kit + Wrangler | User-selected typed database layer; TypeScript schema and reviewed generated SQL, with Wrangler owning migration application | D1 adapter/tooling compatibility changes |
| Bun package manager and local script runner | User-selected tooling; one committed Bun lockfile and TypeScript helpers | A tool requires a different execution runtime; keep Workers as the deployment runtime |
| Preserve manual ownership | Avoid fighting the owner's existing organization | More sophisticated edit tracking is implemented |

## 3. Integration checks still required

The Drizzle decision supersedes the original native-SQL-only recommendation. Explicit parameterized SQL remains available inside repositories for atomic operations.

1. Plain versus explicit-gateway Jev binding behavior, actual account access, Unified Billing requirements, pricing unit/rate, and content logging/cache controls.
2. Current binding types, quotas and request cancellation behavior.
3. Whether Cloudflare exposes explicit Jev version pinning; log returned versions meanwhile.
4. Actual model latency and classification accuracy on the owner's messages and languages.
5. HTML parser and charset support under the Workers runtime.
6. Gmail nested-label display and rename/collision behavior in a live test mailbox.
7. OAuth publishing configuration suitable for this personal unattended app.
8. Compatible pinned Drizzle ORM/Kit versions, Wrangler-compatible generated migration layout, and batch/atomic-claim behavior under the Workers test runtime.
9. Pinned Bun version compatibility with local OAuth/evaluation helpers and project tooling; identify tools that still require Node.js. Vitest remains the test runner.

These checks are Phase 0/early implementation work. The documentation does not claim live inference, Gmail mutation, or deployment has been tested.
