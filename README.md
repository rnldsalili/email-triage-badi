# Email Triage Badi

A personal Gmail triage service planned for Cloudflare Workers. It classifies incoming email with Jev through Cloudflare's AI binding and applies a topic label plus relevant action labels in Gmail.

**Project status:** planning only. These documents specify the intended implementation; application code, commands, and infrastructure described below have not been created or deployed.

## Product goal

Make the existing Gmail inbox easier to scan by answering four questions for each message:

1. What is this email about?
2. Does it need urgent attention?
3. Does it need a reply?
4. Does it require another action?

Gmail remains the interface for reading email. The service provides a small authenticated API for setup, status, classification history, corrections, and retry operations.

## Planned stack

| Component | Choice |
| --- | --- |
| Runtime | Cloudflare Workers |
| HTTP framework | Hono |
| Language | TypeScript with strict checking |
| Validation | Zod 4 and `@hono/zod-validator` |
| Classification | `env.AI.run("typesafe/jev", { state, questions })` |
| Gmail integration | Gmail REST API with OAuth 2.0 offline access |
| Scheduling | Cloudflare Cron Triggers, initially every five minutes |
| Persistence | Cloudflare D1 with Drizzle ORM (`drizzle-orm/d1`) |
| Database migrations | Drizzle Kit generates SQL; Wrangler applies migrations |
| Tests | Vitest with Cloudflare's Workers test integration |
| Tooling | Bun package manager/script runner, Wrangler, TypeScript, formatter/linter |

Jev is listed by Cloudflare as a **third-party** model available through the native AI binding. Provision an AI Gateway with Unified Billing as the provisional access path; Phase 0 must resolve the discrepancy between the plain-call model example and the gateway requirement in the binding reference. Verify account access, billing units and rates in the Cloudflare dashboard.

## Documentation map

| Document | Purpose |
| --- | --- |
| [Project plan](docs/PLAN.md) | Scope, decisions, defaults, milestones, and release criteria |
| [Labels and classification](docs/LABELS.md) | Approved labels, migration, Jev questions, and uncertainty policy |
| [Architecture](docs/ARCHITECTURE.md) | Gmail sync, processing, persistence, retries, and module boundaries |
| [API design](docs/API.md) | Planned Hono endpoints and request/response contracts |
| [Implementation plan](docs/IMPLEMENTATION.md) | Ordered work packages with dependencies and acceptance criteria |
| [Development and evaluation](docs/DEVELOPMENT.md) | Tooling, test scenarios, fixtures, and classification evaluation |
| [Deployment and operations](docs/OPERATIONS.md) | Credentials, configuration, rollout, monitoring, and recovery |
| [Research and decisions](docs/RESEARCH.md) | Verified references, rationale, and unresolved integration checks |

## First-release behavior

- Connect one Gmail account.
- Discover new inbox messages using Gmail history.
- Classify a message with one topic Choice and three independent action Noul questions in one Jev call.
- Apply up to one automatic topic label and zero or more action labels.
- Keep processing state, model results, and corrections in D1.
- Start in dry-run mode, then enable label application after evaluation.
- Recover from retries and interrupted processing without repeatedly classifying completed messages.

The approved taxonomy contains **12 topic labels and 3 action labels**. See [Labels](docs/LABELS.md) for exact names and boundaries.

## Starting implementation

Follow [Implementation plan](docs/IMPLEMENTATION.md) in order. Begin with the Cloudflare Jev integration spike and Gmail credentials, then build normalization and classification before automated labeling.

Default assumptions are explicit in [Project plan](docs/PLAN.md). They can be adjusted without changing the overall architecture.
