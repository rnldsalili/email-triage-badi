# Deployment guide

A step-by-step guide to deploying this Worker. Follow sections 1–8 in order the first time. For later code changes, jump to [section 9](#9-routine-redeploy).

Two kinds of setup are involved:

- **Google Cloud** — lets the service read and label your Gmail. Done once, in the browser.
- **Cloudflare** — hosts the Worker, database and cron. Commands run in your terminal.

---

## 0. What you need

| Item | Notes |
| --- | --- |
| Bun `1.4.3` | See `.bun-version`; install from bun.sh |
| Node.js 22 | Some tools (Wrangler, Drizzle) run on Node |
| Cloudflare account | **Workers Paid** plan (the 5-minute cron needs it) |
| `tellbadi.com` DNS zone | On the same Cloudflare account; the custom domain `email-triage.tellbadi.com` needs it |
| D1 database | Created in step 2 |
| AI Gateway | One gateway with **Unified Billing credits** loaded |
| Google Cloud project | Gmail API enabled, OAuth client created (step 1) |
| The Gmail address to manage | This becomes `GMAIL_ACCOUNT_EMAIL` |

Start every terminal session in the project folder:

```sh
cd /path/to/email-triage-badi
```

---

## 1. Google Cloud setup (once)

Your Google account signs in as the mailbox owner. The service gets a long-lived
"refresh token" so it can work without you logging in.

1. Open the [Google Cloud Console](https://console.cloud.google.com) and create (or pick) a project.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (new console: **Google Auth Platform**):
   - User type: **External**.
   - Fill in app name and your email as the contact.
4. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Name it anything, e.g. `email-triage-badi`.
   - Under **Authorized redirect URIs**, add exactly: `http://localhost:8788/oauth2callback`
5. Copy the **Client ID** and **Client secret** — you will need them in step 3.
6. **Audience → Publishing status → Publish app** (moves it from *Testing* to *In production*).
   - This is required. Apps in *Testing* get refresh tokens that die every 7 days.
   - You will see "Google hasn't verified this app" during sign-in. That is expected.
   - **Do not submit the app for verification.** It is unnecessary and takes weeks.
     See [Personal use rules](#personal-use-rules) below.

Docs: [Google authorization setup](OPERATIONS.md#3-google-authorization-setup).

---

## 2. Cloudflare setup (once)

1. Log in:

   ```sh
   bunx wrangler login
   ```

   The project pins its Cloudflare account in `wrangler.jsonc` (`account_id`), so
   commands target the right account even if your shell has another account selected.

2. **AI Gateway**: In the Cloudflare dashboard, go to **AI → AI Gateway**, create a
   gateway (the repo defaults to `email-triage-badi-dev`), and load credits under
   **Credits Available → Manage**. Without credits, every inference call fails with
   error `2021: Insufficient AI Gateway credits`.
   - Set **Logging: off** and **Cache: off** for privacy.
   - To use a different gateway name, change `AI_GATEWAY_ID` in `wrangler.jsonc`.

3. **D1 database** — skip if reusing the existing one. To create a new database:

   ```sh
   bunx wrangler d1 create email-triage-badi
   ```

   Copy the printed `database_id` into `d1_databases[0].database_id` in `wrangler.jsonc`.

---

## 3. Local configuration (once per machine)

1. Install dependencies:

   ```sh
   bun install --frozen-lockfile
   ```

2. Create your local secrets file and fill it in:

   ```sh
   cp .dev.vars.example .dev.vars
   ```

   | Key | Value |
   | --- | --- |
   | `GOOGLE_CLIENT_ID` | From step 1.4 |
   | `GOOGLE_CLIENT_SECRET` | From step 1.4 |
   | `GMAIL_ACCOUNT_EMAIL` | Your Gmail address, e.g. `you@gmail.com` |
   | `GOOGLE_REFRESH_TOKEN` | Leave empty for now — the next step fills it |
   | `ADMIN_API_TOKEN` | Generate one: `openssl rand -hex 32` |

   `.dev.vars` is gitignored and stays on your machine only.

3. Optional — Cloudflare account credentials for local commands:

   ```sh
   cp .cloudflare.env.example .cloudflare.env
   # paste your Account ID and an API token, then in each terminal:
   source .cloudflare.env
   ```

4. **Authorize Gmail.** This opens your browser, asks you to sign in, and stores the
   refresh token in `.dev.vars`:

   ```sh
   bun run oauth:bootstrap
   ```

   - The script first validates the client ID/secret against Google and prints which
     client it is using.
   - It opens the consent URL in your default browser automatically
     (use `bun run oauth:bootstrap --no-open` to print the URL instead).
   - Sign in, click **Advanced → Go to … (unsafe)** on the unverified-app screen,
     then approve the Gmail permission.
   - Success looks like:

     ```text
     Gmail profile verified:
       emailAddress: you@gmail.com
     Refresh token stored in .dev.vars (mode 0600).
     ```

5. Confirm the stored token still works (no browser, read-only):

   ```sh
   bun run oauth:check
   ```

---

## 4. Configure and publish secrets

1. Edit the `vars` block in `wrangler.jsonc` at minimum:

   | Variable | Meaning |
   | --- | --- |
   | `GMAIL_ACCOUNT_EMAIL` | Exact Gmail address the service may touch |
   | `OWNER_TIME_ZONE` | IANA zone, e.g. `Asia/Manila` |
   | `OWNER_ALIASES_JSON` | Other addresses that count as you, e.g. `["me@work.com"]` |
   | `EMPLOYER_DOMAINS_JSON` | Work domains used for context, e.g. `["acme.com"]` |
   | `DEFAULT_MODE` | Leave `dry_run` for the first deploy |
   | `AI_GATEWAY_ID` | Gateway name from step 2.2 |

   All other limits have safe defaults; see [Operations](OPERATIONS.md#2-bindings-and-configuration).

2. Push the four secrets to the running Worker (paste each value when prompted):

   ```sh
   bunx wrangler secret put ADMIN_API_TOKEN
   bunx wrangler secret put GOOGLE_CLIENT_ID
   bunx wrangler secret put GOOGLE_CLIENT_SECRET
   bunx wrangler secret put GOOGLE_REFRESH_TOKEN
   ```

   - `ADMIN_API_TOKEN`: the same value you put in `.dev.vars`.
   - `GOOGLE_*`: the same values from `.dev.vars` (they never expire).
   - Secrets take effect immediately; no redeploy needed.

---

## 5. Database migrations

Migrations are generated by Drizzle and applied by Wrangler.

- Local (for `bun run dev` and tests):

  ```sh
  bun run db:migrate:local
  ```

- Remote (production):

  ```sh
  bun run db:migrate:remote
  ```

Important:

- The migration history is a consolidated baseline. **Apply it only to a fresh,
  empty database.** Re-running it against an already-migrated database will fail
  or conflict with Wrangler's tracking.
- If you change `src/db/schema.ts`, generate new SQL first and commit it:

  ```sh
  bun run db:generate
  ```

---

## 6. Pre-flight checks

Run these before every deploy:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run build` is a Wrangler dry-run — it bundles the Worker without deploying.
All commands should exit with code 0.

---

## 7. Deploy

```sh
bun run deploy
```

This runs `wrangler deploy --env production`, so it targets the `production`
environment block in `wrangler.jsonc`. (Plain `bunx wrangler deploy` would use the
top-level configuration instead.)

It deploys the Worker, its `vars`, the D1 binding, the `*/5 * * * *` cron and the
custom domain `email-triage.tellbadi.com`. Because `tellbadi.com` is on this account,
the DNS record and TLS certificate are created automatically. The Worker starts in
`dry_run` mode by default, so it will classify email but not change any Gmail labels
until you explicitly switch modes.

The `workers.dev` URL (`https://email-triage-badi.<your-subdomain>.workers.dev`)
keeps working as well.

---

## 8. Verify

1. Liveness (public, no token needed):

   ```sh
   curl https://email-triage.tellbadi.com/healthz
   ```

   Expect: `{"status":"ok","version":"..."}`

2. Status (authenticated):

   ```sh
   curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
     https://email-triage.tellbadi.com/api/v1/status
   ```

   Check:
   - `authStatus` is `"ok"` (not `"auth_required"`)
   - `mode` is `"dry_run"`
   - sync counts start moving after the first cron tick

3. Watch logs live (optional but useful during the first day):

   ```sh
   bunx wrangler tail
   ```

4. List existing Gmail labels read-only and review the migration plan:

   ```sh
   bun run labels:inventory
   ```

When you are satisfied with dry-run results, switch modes:

```sh
curl -X PATCH -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"mode":"apply"}' \
  https://email-triage.tellbadi.com/api/v1/settings
```

Use `"apply"` to start labeling, `"dry_run"` to classify without writing labels,
or `"paused"` to stop all work. Mode is stored in the database and survives redeploys.

Full endpoint list: [API](API.md).

---

## 9. Routine redeploy

For a code-only change:

```sh
bun run format:check && bun run typecheck && bun run test
bun run deploy
```

Secrets and `vars` are not touched by a deploy. Apply schema changes
(`bun run db:generate` + `bun run db:migrate:remote`) before deploying code that
depends on them.

---

## 10. Common operations

| Task | Command |
| --- | --- |
| Live logs | `bunx wrangler tail` |
| List past deploys | `bunx wrangler deployments list` |
| Roll back code | `bunx wrangler rollback` |
| Pause all work | `PATCH /api/v1/settings` with `{"mode":"paused"}` |
| Re-authorize Gmail | `bun run oauth:bootstrap` then `bunx wrangler secret put GOOGLE_REFRESH_TOKEN` |
| Verify current token | `bun run oauth:check` |
| Update any secret | `bunx wrangler secret put <NAME>` |
| Check queue/budget | `GET /api/v1/status` → `aiBudget` |

---

## Personal use rules

- You are the only user. "In production" in Google Cloud is a **publishing status**,
  not a store listing — it only removes the 7-day refresh-token limit.
- The "Google hasn't verified this app" screen is normal and safe for your own app.
  Click **Advanced → Go to … (unsafe)** and continue.
- Do **not** submit for verification. For `gmail.modify` it takes about six weeks,
  needs a paid security assessment, must be renewed yearly, and adds nothing for a
  single-user app.
- The unverified screen has no effect on token lifetime or functionality.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `The OAuth client was not found` (401, `invalid_client`) | Client ID was deleted or belongs to another project; or the URL was copied from wrapped terminal text and got truncated | The bootstrap script now validates credentials before opening anything and prints a clear error. Verify **Credentials** contains the client ID in `wrangler.jsonc`/`.dev.vars`, and let the script open the browser (no copy/paste). |
| "Google hasn't verified this app" | App is published but not verified | Expected. Click **Advanced → Go to … (unsafe)**. Do not submit for verification. |
| Re-authorization needed every ~7 days | Consent screen is still in **Testing** | Publish the app (step 1.6), then re-run `bun run oauth:bootstrap` and update the `GOOGLE_REFRESH_TOKEN` secret. Old tokens keep their 7-day clock, so re-mint after publishing. |
| `authStatus: "auth_required"` in `/api/v1/status` | Refresh token revoked, expired, or password changed | Re-run `bun run oauth:bootstrap`, push the new `GOOGLE_REFRESH_TOKEN`, check `/api/v1/status` again. |
| `EADDRINUSE` / port 8788 busy | Another `oauth:bootstrap` is still running | `lsof -ti tcp:8788 \| xargs kill` then retry. |
| Runtime error `2021: Insufficient AI Gateway credits` | Gateway has no credits | Top up under **AI → AI Gateway → Credits**. |
| `401 UNAUTHORIZED` on `/api/v1/*` | Missing or wrong bearer token | Use `Authorization: Bearer <ADMIN_API_TOKEN>` with the value you pushed in step 4.2. |
| Config errors at runtime (`Invalid configuration: ...`) | Missing `vars` or secret | Compare `wrangler.jsonc` and the secret list in step 4 against `src/config/env.ts`. |

Recovery procedures for deeper incidents (revoked OAuth, expired history cursor,
rollback, data maintenance) live in [OPERATIONS.md](OPERATIONS.md#6-recovery-procedures).

---

## Where things live

| File | Contains | Committed? |
| --- | --- | --- |
| `wrangler.jsonc` | Worker name, bindings, crons, non-secret vars | Yes |
| `.dev.vars` | Local secrets (Google + admin token) | No (gitignored) |
| `.cloudflare.env` | Local Cloudflare API credentials | No (gitignored) |
| `scripts/oauth-bootstrap.ts` | Interactive Google authorization helper | Yes |
| `migrations/` | Generated SQL migrations | Yes |
