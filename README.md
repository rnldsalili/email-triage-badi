# Email Triage Badi

A personal Gmail triage service for Cloudflare Workers. It classifies incoming email with Jev through Cloudflare's AI binding and applies a topic label plus relevant action labels in Gmail.

**Project status:** core pipeline, operational API and owner dashboard implemented. The repository includes hardening for mode changes, lease fencing, migration recovery, atomic owner operations, bounded inputs, retention, evaluation reports and CI. A five-minute cron is configured; the deployed mode is persistent state, not the `DEFAULT_MODE` in this file—check authenticated `/api/v1/status` before any operational action. Repository changes do not deploy automatically. Representative owner-labeled evaluation and operational drills remain separate release checks.

Live verification performed 2026-09-20:

- Real Jev inference through the AI binding and the dedicated `email-triage-badi-dev` AI Gateway (Unified Billing, logging disabled).
- Gmail OAuth bootstrap with PKCE, live profile read and refresh-token exchange.
- Read-only label inventory against the real mailbox (21 labels, six legacy mappings detected).
- 15-example synthetic evaluation with zero failures (topic 14/14 accepted on unambiguous examples; median latency 819 ms; total estimated cost $0.0008).
- Production Worker deployed with remote D1 migrations applied; `/healthz` and authenticated `/api/v1/status` verified.

## Product goal

Make the existing Gmail inbox easier to scan by answering four questions for each message:

1. What is this email about?
2. Does it need urgent attention?
3. Does it need a reply?
4. Does it require another action?

Gmail remains the interface for reading email. A private owner dashboard served by the same Worker shows classifications, corrections and operations, and covers the routine work: review messages, correct labels, retry or reprocess failures, apply saved results, scan older mail, manage label setup, switch modes and trigger a bounded run. The same capabilities remain available through the authenticated API for automation and recovery.

## Stack

| Component | Choice |
| --- | --- |
| Runtime | Cloudflare Workers |
| Dashboard | React + Vite, served as Worker static assets |
| HTTP framework | Hono |
| Language | TypeScript with strict checking |
| Validation | Zod 4 with a small Hono JSON-body validation helper |
| Classification | `env.AI.run(AI_MODEL, { state, questions }, { gateway, skipCache, collectLog: false })` |
| Gmail integration | Gmail REST API with OAuth 2.0 offline access |
| Scheduling | Cloudflare Cron Triggers, initially every five minutes |
| Persistence | Cloudflare D1 with Drizzle ORM (`drizzle-orm/d1`) |
| Database migrations | Drizzle Kit generates SQL; Wrangler applies migrations |
| Tests | Vitest with Cloudflare's Workers test integration |
| Tooling | Bun package manager/script runner, Wrangler, TypeScript, Ultracite with Oxlint/Oxfmt |

Jev is listed by Cloudflare as a **third-party** model available through the native AI binding. Provision an AI Gateway with Unified Billing as the provisional access path; Phase 0 must resolve the discrepancy between the plain-call model example and the gateway requirement in the binding reference. Verify account access, billing units and rates in the Cloudflare dashboard.

## Documentation map

| Document | Purpose |
| --- | --- |
| [Deployment guide](docs/DEPLOY.md) | Step-by-step setup and deploy instructions |
| [Project plan](docs/PLAN.md) | Scope, decisions, defaults, milestones, and release criteria |
| [Labels and classification](docs/LABELS.md) | Approved labels, migration, Jev questions, and uncertainty policy |
| [Architecture](docs/ARCHITECTURE.md) | Gmail sync, processing, persistence, retries, and module boundaries |
| [API design](docs/API.md) | Implemented Hono endpoints and request/response contracts |
| [Implementation plan](docs/IMPLEMENTATION.md) | Ordered work packages with dependencies and acceptance criteria |
| [Development and evaluation](docs/DEVELOPMENT.md) | Tooling, test scenarios, fixtures, and classification evaluation |
| [Deployment and operations](docs/OPERATIONS.md) | Credentials, configuration, rollout, monitoring, and recovery |
| [Research and decisions](docs/RESEARCH.md) | Verified references, rationale, and unresolved integration checks |

## First-release behavior

- Connect one Gmail account.
- Discover new inbox messages using Gmail history.
- Classify with one topic Choice and three independent action Noul questions in one Jev call; an optional, disabled-by-default exact GitHub completed-event rule can produce a zero-inference result instead.
- Apply up to one automatic topic label and zero or more action labels.
- Store bounded Subject/From metadata so messages are recognizable in the dashboard without a Gmail call per row.
- Keep processing state, model results, and corrections in D1.
- Start in dry-run mode, then enable label application after evaluation.
- Recover from retries and interrupted processing without repeatedly classifying completed messages.
- Serve an owner-only dashboard over the same authenticated API.

The approved taxonomy contains **12 topic labels and 3 action labels**. See [Labels](docs/LABELS.md) for exact names and boundaries.

## Local setup and verification

Install the Bun version in `.bun-version` and Node.js 22, then run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build
```

Routine tests run local D1 and fake providers with remote bindings disabled, plus a jsdom suite for the dashboard. The dashboard is a React app in `web/`; `bun run web:build` bundles it into `web/dist`, which the Worker serves as static assets. `bun run build` builds the dashboard into `web/dist` and then validates the Worker bundle and assets with a Wrangler dry-run. For local development, copy `.dev.vars.example` to `.dev.vars`, configure the owner in `wrangler.jsonc`, supply credentials, and run `bun run db:migrate:local` followed by `bun run dev` (Worker + dashboard) or `bun run web:dev` for the dashboard against the running Worker. See [OPERATIONS.md](docs/OPERATIONS.md) for OAuth and deployment setup.

Live evaluation is explicit and billed separately from the production daily cap:

```sh
EVAL_MAX_CALLS=30 bun run evaluate
```

The shorter topic rubric is selected for production with `AI_RUBRIC=compact-v1`; the separate `GITHUB_PASSIVE_FAST_PATH` remains `off`. For a private, unlabeled, bounded cost comparison, use `bun run sample:cost` followed by `bun run compare:cost` with `COST_DATASET`, `EVAL_MAX_CALLS`, and `COST_MAX_USD`; see [DEVELOPMENT.md](docs/DEVELOPMENT.md). Unlabeled agreement does not prove correctness. Owner-labeled held-out evaluation of the compact rubric is still outstanding.

Default assumptions are explicit in [Project plan](docs/PLAN.md). They can be adjusted without changing the overall architecture.
