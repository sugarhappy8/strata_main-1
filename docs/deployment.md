# Deployment and provider operations

This guide keeps operational detail out of the project overview. Read [architecture.md](architecture.md) before changing a trust boundary, and read [../SECURITY.md](../SECURITY.md) before reporting a vulnerability.

## Deployment model

STRATA must run as a Node web service. A static host can display files but cannot provide authentication, account APIs, protected pages, webhooks, or persistent plans.

The checked-in `render.yaml` defines the supported Render service shape:

- Node 24 selected by `.node-version`;
- `npm ci --omit=dev --no-audit --no-fund` for production dependencies;
- `npm start` as the process command;
- `/healthz` as the compatibility alias for the storage-aware readiness check; and
- secret values entered in the host rather than committed to the repository.

Local development uses SQLite. Production refuses to start without Turso, because Render's local filesystem is ephemeral and must not become the durable account store.

## 100-person pilot

The blueprint selects `1c-2g` (1 CPU, 2 GB RAM), an always-on paid web-service baseline. This is a starting configuration to validate against the real workload, not a certified capacity guarantee. No service has been purchased or changed by editing this file. See [Render compute plans](https://render.com/docs/compute-plans) and [Blueprint reference](https://render.com/docs/blueprint-spec).

Use one application instance initially: request/identity throttles are process-local. Before adding replicas, move those counters to a shared store or enforce equivalent limits at a trusted ingress. Persistent email-send and challenge-attempt controls remain in the database. Keep `TRUST_PROXY=true` only behind the configured trusted proxy; direct Node deployments should leave it false.

The auth network allowance is 400 signup/login attempts per IP per 15 minutes, with ten attempts per hashed email across addresses. Verification permits 600 requests per IP and twelve per challenge; resend permits 300 per IP and six per challenge. Existing five-attempt code and durable email-send limits still apply. API rate-limit responses include retry guidance.

Run `npm run load:100` and `npm run load:100:shared` on Linux to reproduce the isolated checks. These scripts accept no live target and intentionally disable email/payment providers. Configure the production Turso/Resend/Paddle values, verify delivery and signed webhook handling, confirm database backups/restoration, and measure real hosted latency before inviting the pilot. See [release readiness](release-readiness.md) for this build's validation status.

Public asset representations are cached for a process lifetime with a 16 MiB cap; restart after editing assets. Request headers have a 15-second deadline, complete request bodies 30 seconds, idle sockets 60 seconds, and keep-alive idle sockets 5 seconds. Graceful shutdown drains for up to ten seconds, then exits visibly with failure if connections remain. [Node HTTP documentation](https://nodejs.org/docs/latest-v24.x/api/http.html) describes these controls.

## Local setup

```bash
npm install
npx playwright install chromium firefox webkit
npm run check
npm start
```

The default address is `http://127.0.0.1:4173`. Keep the Turso variables blank to create a local database below `data/`. Use `.env.example` as the variable inventory; it contains placeholders, not credentials.

## Turso and Render

1. Create a Turso database in a suitable region.
2. Create a database authentication token and store it in Render as `TURSO_AUTH_TOKEN`.
3. Store the database URL as `TURSO_DATABASE_URL`.
4. Deploy from the repository's Render Blueprint, or reproduce the Web Service settings in `render.yaml` exactly.
5. Do not configure `STRATA_DATA_DIR` or a Render disk in production.
6. Run the production configuration preflight, deploy, then verify `/api/status`, `/livez`, and `/readyz`.

Fixed runtime settings include `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY=true`, and the public HTTPS `APP_BASE_URL`. Only enable `TRUST_PROXY` behind the configured trusted reverse proxy; a directly exposed Node process must not trust arbitrary forwarding headers.

The server applies additive schema setup through an ordered migration ledger on startup and checks foreign-key behavior. The monthly-subscription migration adds a subscription link to existing purchase records and a lean subscription-state table without rewriting completed, unrevoked lifetime purchases. Do not delete or replace a production database as an upgrade step. Back up Turso before promotion, inspect the migration result, then create or use a test account, save a plan, redeploy, and confirm that the same account and plan remain available.

Operational endpoints:

- `/api/status` reports build and provider-readiness booleans without returning secrets.
- `/livez` is process-only and returns only `{ "ok": true }` when the Node process can answer.
- `/readyz` runs a store probe and returns only `{ "ok": true }` with `200` when storage is reachable.
- `/healthz` remains a compatibility alias for `/readyz`, including for the checked-in Render health check.

A `404` or HTML response from those endpoints normally means the project was deployed as a static site or the wrong service. Successful liveness with `503` readiness points to storage connectivity or credentials; do not route normal traffic to that instance.

Every response includes a validated incoming or server-generated `X-Request-ID`. Normal request logs are one-line structured JSON with timestamp, method, path without query data, status, duration, and completion state. Values under sensitive field names are redacted, request bodies and raw query strings are not logged, and test logging is quiet. Keep provider and platform logs under access control anyway; redaction is a defense, not permission to log secrets.

## Resend account email

Resend delivers signup verification, password reset, account-deletion confirmation, support acknowledgments and notifications, and administrator replies. It never stores account passwords and is not part of Admin authorization.

1. Verify the dedicated sending subdomain in Resend and finish its DNS authentication.
2. Create a restricted sending API key.
3. Generate an independent high-entropy `EMAIL_VERIFICATION_SECRET` of at least 32 characters. Do not reuse the Resend key, a session secret, or a Paddle credential.
4. Configure `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `SUPPORT_EMAIL`, `EMAIL_VERIFICATION_SECRET`, and the HTTPS `APP_BASE_URL` in Render.
5. Set `EMAIL_VERIFICATION_ENABLED=true` only after every value is valid and mail delivery has been tested.

The application fails closed when email enforcement is requested but incomplete. Do not use `ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS` outside `NODE_ENV=test`; the server intentionally rejects that escape hatch in production.

Test the complete flow with a non-owner address: sign up, receive and submit the verification code, sign out/in, request a password-reset link, and confirm that using it revokes existing sessions. Also verify deletion mail only goes to the registered address and that a used or expired action link cannot be replayed.

## Primary administrator and support

`ADMIN_EMAIL` identifies the one account eligible to claim the empty primary-owner binding after email verification. The binding is stored by immutable user ID, so changing the environment variable alone does not transfer ownership. Keep that account recoverable and never expose the configured address through readiness APIs.

`SUPPORT_EMAIL` is the notification destination for new Contact and help-desk requests. `EMAIL_REPLY_TO` controls the reply-to address on mail sent through the same Resend configuration; no Gmail API or separate administrator password is needed.

After owner setup, sign in as the bound owner and verify that Admin opens with that normal live session and no second password, emailed code, or timed privilege window. Verify that non-owners and revoked, expired, or stale-version owner sessions are denied. Then verify primary-owner self-protection, one-click review dialogs, support responses, server-generated action-specific audit reasons, and the redacted audit trail. Resend availability no longer controls Admin access.

Permanent deletion retains one explicit destructive review dialog but no typed command or operator-entered reason. The server supplies the audit reason, pauses the non-owner account, revokes its sessions, reconciles supported unfinished checkouts, and performs the guarded deletion. Resolve or cancel any live Paddle subscription first; a billing blocker leaves the account paused for an explicit retry or restore. The final database operation requires the same still-live bound-owner session and current auth version, and rechecks owner protection, suspension, checkout claims, and billing state while recording the audit atomically.

## Member account controls

`GET /api/account/sessions` lists only the signed-in member's active sessions and exposes opaque public identifiers plus creation, expiry, and current-session state. `POST /api/account/sessions/revoke` and `POST /api/account/sessions/revoke-others` are CSRF-protected, account-scoped mutations; the current session cannot be removed through the selective route. `POST /api/account/export` is also authenticated, CSRF-protected, account-scoped, rate-limited, and returned with private `no-store` attachment headers. Workout history uses stable keyset pages so the response is not buffered or silently capped; because the download does not hold a long database transaction, concurrent account changes can be reflected progressively. Exercise these controls after deployment, confirm another browser is actually signed out, and inspect an export for expected account data and the documented secret/provider/admin exclusions without placing the download in deployment logs or support tickets.

## Strata AI

Strata AI is off until `AI_BASE_URL` and `AI_MODEL` are set. It works with any OpenAI-compatible chat server; the pilot runs a local model in Atomic Chat on the owner's PC.

1. In Atomic Chat, load the model and keep the local server bound to `127.0.0.1` with LAN access off.
2. Turn on remote access with an API key. Copy the public `https://…/v1` address and the key.
3. In Render, set `AI_BASE_URL` to that address, `AI_API_KEY` to the key, and `AI_MODEL` to the exact model ID that `GET /v1/models` lists. Never commit these values or paste the key into chat, tickets, or logs.
4. Deploy, sign in with a Strata+ account, open `/ai`, and confirm the status reads "Strata AI is ready".

Choosing a model:

- Use an official instruction-tuned model that ships with its chat template. On a 12 GB GPU, Qwen2.5-14B-Instruct at Q4_K_M (about 9 GB) fits with a 16,384-token context and writes a week in roughly 10–20 seconds. Qwen2.5-7B-Instruct at Q5_K_M or Q6_K answers about twice as fast with slightly simpler plans.
- Avoid community merges and "upscaled" models (for example an 8B model stretched to 14B). They can loop on one phrase and never produce the JSON STRATA needs, which shows as "Strata AI's answer could not be read" and an `ai.unreadable_answer` warning in the logs.
- Avoid reasoning ("thinking") models unless the server honors `enable_thinking: false`; otherwise the thinking uses up the answer budget.
- Each request needs about 4,000 tokens of context (a prompt of up to about 2,800 tokens plus an answer of up to 900). The server's context is shared by its parallel slots, so 16,384 tokens supports 3–4 slots.
- After changing models, set `AI_MODEL` to the exact ID the server lists and redeploy.

Operational notes:

- A Cloudflare quick tunnel gets a new address each time it restarts. Update `AI_BASE_URL` in Render when that happens, or use a named tunnel for a stable address. If the endpoint sits behind Cloudflare Access, set `AI_ACCESS_CLIENT_ID` and `AI_ACCESS_CLIENT_SECRET` to a service token.
- In production a plain `http://` address other than this machine is ignored, so the key never travels unencrypted. The server logs `ai.insecure_base_url_ignored` when that happens.
- Requests wait in an in-memory queue: `AI_MAX_CONCURRENT` (default 3) run at once and `AI_MAX_QUEUE` (default 20) can wait. Match `AI_MAX_CONCURRENT` to the model server's parallel slots. Each member gets `AI_DAILY_LIMIT` requests per UTC day (default 30). `AI_TIMEOUT_MS` (default 120000) bounds each model call.
- The queue, results, and daily counts live in one process's memory and reset on restart. Answers are kept for 10 minutes so the page can collect them.
- The model receives the member's saved plan, personal setup, and summaries of recent workouts and nutrition logs. It never receives the member's name, email, or account ID. Logs record request kind, outcome code, and duration only; they never include messages or answers.
- When the PC is off or the tunnel is down, `/ai` shows that Strata AI may be offline, and every other STRATA feature keeps working.

## Polar connected devices

Strata+ members can connect their own Polar account (for example a Polar Loop) from Account. The feature is off until `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET`, and `DEVICE_TOKEN_KEY` are set; until then the Strata+ Recovery destination says it is coming soon and Account shows no Connected devices card. Once configured, members connect from Account, Recovery fills in, and Train can offer a lighter session after a poor night.

1. Sign in at [admin.polaraccesslink.com](https://admin.polaraccesslink.com) with the Polar account that will own the app and create an AccessLink client. Set its redirect URL to `https://<your domain>/api/devices/polar/callback` (STRATA builds the same address from `APP_BASE_URL`; set `POLAR_REDIRECT_URI` only if it must differ).
2. In Render, set `POLAR_CLIENT_ID` and `POLAR_CLIENT_SECRET` from that client, and `DEVICE_TOKEN_KEY` to 32 random bytes written as base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep a copy of the key somewhere safe: without it, stored Polar tokens cannot be read and members must reconnect.
3. Deploy, then create the webhook from a machine that has the same `POLAR_*` and `APP_BASE_URL` values: `npm run polar:webhook -- create`. Polar shows the signing secret only once; set it as `POLAR_WEBHOOK_SECRET` and redeploy. `npm run polar:webhook -- status` lists the webhook and `-- delete` removes it. If Polar rejects an event name, pass the ones it accepts, for example `-- create --events EXERCISE,SLEEP`.
4. Run `npm run preflight:production` and confirm the `devices.polar` check passes. Then connect a real Polar account with a Strata+ test member and confirm the first import, the Recovery page, and a disconnect.

How it runs:

- Connecting starts on Polar's sign-in page. Session cookies are `SameSite=Strict`, so Polar's return only parks its one-time code in a short-lived cookie limited to `/api/devices/polar/complete`; the Account page finishes the link with the same signed-in session that started it. A connection request expires after 10 minutes and is bound to that session.
- Tokens are sealed with AES-256-GCM before they are stored and are never sent to the browser or included in exports. To rotate the key, move the current value to `DEVICE_TOKEN_KEY_PREVIOUS`, set a new `DEVICE_TOKEN_KEY`, and redeploy; tokens sealed with either key keep working.
- The sync loop imports Polar's 28-day window on connect, then checks each connection at least once a day and sooner after a signed webhook. It stays under the rate limits Polar reports in every response, pauses while a member's Strata+ is inactive, and asks the member to reconnect if Polar rejects their token. `DEVICE_SYNC_INTERVAL_MS` (default 60000) sets how often it looks for due connections.
- Disconnecting deletes the member's imported data and deregisters them at Polar. Account deletion does the same through a database trigger; if Polar cannot be reached, only the sealed token (without a user link) is kept for up to 30 days while the loop retries.
- STRATA keeps imported nights, days, and workouts for about 13 months and half-hour heart-rate detail for 28 days. Logs record only event names such as `device.synced` and `device.sync_failed` with an outcome code, never tokens or health values.
- Without `POLAR_WEBHOOK_SECRET`, webhooks are rejected and members still sync daily.

## Paddle monthly subscription

Paddle is the merchant of record for the $2.99 USD per month Strata+ subscription. The public amount, USD currency, monthly frequency, and catalog identifiers must stay aligned with the live catalog. Since Build 7.5.1, the application does not embed either current catalog ID: `PADDLE_PRODUCT_ID` and `PADDLE_PRICE_ID` are operator-supplied `sync: false` values in `render.yaml`, and checkout remains unavailable until both identify the same valid monthly catalog item. The browser consumes the product selected and validated by the same-origin server instead of pinning an older product in public code. New checkout creation also fails closed unless Paddle's returned current catalog item reports a unit price of exactly 299 minor units in USD.

Required configuration:

- `PADDLE_PRODUCT_ID` and an explicit `PADDLE_PRICE_ID` for a quantity-one, automatically collected, $2.99 USD monthly price;
- optionally, `PADDLE_LEGACY_RECURRING_PRICE_IDS`, a comma-separated list of earlier monthly price IDs on that same product for existing subscribers only;
- `PADDLE_CLIENT_TOKEN`, a live browser-safe client token;
- `PADDLE_API_KEY`, a private live server key with transaction creation/read and customer-portal access;
- `PADDLE_WEBHOOK_SECRET`, the notification destination's signing secret; and
- `PADDLE_CHECKOUT_ENABLED`, the launch/rollback switch.

The application rejects the retired one-time live price ID for every new checkout, even if it is supplied explicitly. Since Build 7.5.1, it recognizes that exact retired price/product pair only while reconciling an already-recorded, abandoned Build 7.4 checkout. It updates a validated `draft` transaction's complete item list to the configured monthly price and reuses that transaction; a stale state Paddle permits the application to cancel must be confirmed canceled before a fresh checkout begins. A delayed completion of the exact retired checkout is accepted only with its original account and checkout metadata, API origin, automatic collection, one item of quantity one, null subscription, null billing cycle, and a valid customer ID; it is then recorded as lifetime access. Unknown one-time prices, mismatched products/accounts, unsafe status changes, and invalid provider responses still fail closed. The application also fails closed for an absent or malformed recurring price, environment-mismatched credentials, incomplete secrets, or production sandbox configuration. Do not enable checkout to work around these guards. Create the actual monthly catalog item in Paddle, enter its exact ID in the deployment environment, and then run the preflight.

When moving the live catalog from $0.99 to $2.99, keep `PADDLE_PRODUCT_ID` on the existing product, set `PADDLE_PRICE_ID` to the new $2.99 monthly price, and put the previous $0.99 monthly price ID in `PADDLE_LEGACY_RECURRING_PRICE_IDS`. Do not include the current price, the retired one-time price, duplicate IDs, malformed IDs, or more than 20 IDs; invalid allowlist configuration fails checkout setup closed. Leave the old Paddle price available for subscriptions already using it but prevent new purchases of it in Paddle. STRATA accepts an allowlisted price only for reconciliation and entitlement when Paddle also confirms the configured product, monthly cycle, quantity one, automatic collection, and account/subscription linkage. New transactions and migrated unfinished checkouts always use the current `PADDLE_PRICE_ID`; every path that can expose an unfinished current checkout must additionally confirm the 299-minor-unit USD price. After every price change, test one grandfathered subscriber, one new checkout, a wrong-amount response, a wrong-product event, an annual-cycle event, cancellation, and renewal before removing an old ID. Remove an ID only after no active or recoverable subscription still uses it.

Create or reuse a live notification destination at:

```text
https://stratafitness.online/api/paddle/webhook
```

Subscribe to `transaction.completed`, `subscription.created`, `subscription.updated`, the transaction lifecycle events used by checkout reconciliation, and adjustment creation/update events. Reusing the destination preserves its signing secret; deleting and recreating it requires an intentional secret rotation in Render.

STRATA verifies `Paddle-Signature` over the exact raw request body before parsing JSON. A completed transaction is accepted only when it was created by STRATA and its transaction, subscription, customer, product, price, account custom data, quantity, automatic collection, monthly cycle, and completion state match server-side records. Interrupted checkout creation may also reconcile through an authenticated Paddle API read, which applies the same transaction validator and cannot fabricate subscription state. Paid access additionally requires the linked Paddle subscription to match, be `active`, `trialing`, or `past_due`, and have a verified future current-period end; a missing or expired bound fails closed, while `paused` and `canceled` deny access. A scheduled cancellation or pause keeps access only until its effective timestamp, never beyond the current-period end, even if the provider status update is delayed. Browser redirects and client tokens never grant entitlement. Event IDs, event occurrence times, transaction state, subscription state, and adjustments make duplicates, replays, and out-of-order deliveries safe.

Qualifying completed, unrevoked purchases made under the earlier one-time offering remain grandfathered lifetime access and do not require a fabricated subscription. The new app trial is separate: each eligible account can start it once for seven days without a card. It ends automatically and never creates or converts into a Paddle subscription.

`GET /api/billing/subscription` returns an authenticated, private `no-store` summary for the Account page. Members manage an existing monthly subscription through `POST /api/billing/portal`, which additionally requires CSRF and is account-scoped. The server requests a temporary Paddle customer-portal session, validates that every returned URL belongs to `customer-portal.paddle.com` and the stored customer/subscription pair, returns it with `no-store`, and never persists it. Cancellation and refund are separate actions. Account deletion does not cancel a Paddle subscription, refund a charge, or erase Paddle's merchant-of-record records; complete the intended billing action before deletion.

Keep `PADDLE_CHECKOUT_ENABLED=false` for a new or unverified setup. Enable it only after the domain/default payment link is approved and a live end-to-end monthly transaction plus subscription event reaches the matching account. Verify another browser session sees the entitlement, open the Paddle portal, schedule a cancellation, confirm access remains through the effective period, and verify the eventual canceled state removes access. Then process the intended test refund or adjustment and confirm access is revoked when required.

If checkout creation, webhook delivery, or entitlement granting fails, disable the switch and redeploy. That stops new purchases without deleting existing transactions or account entitlements.

`PADDLE_ENFORCE_IP_ALLOWLIST` is an optional defense in depth, not a replacement for signatures. Enable it only on a host that reliably preserves Paddle's originating address and only after testing through the real proxy. The current Render configuration leaves it false because an incorrect proxy address can reject genuine signed notifications.

Keep private promotion codes in Paddle and share them privately. Never place a code in HTML, browser JavaScript, repository documentation, screenshots, analytics, or support examples.

## Release verification

Before deployment:

```bash
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run check
npm audit --omit=dev
npm run preflight:production
```

`npm run check` verifies release metadata and architecture policy, statically checks typed domain boundaries, runs the correctness-focused linter, enforces coverage floors over the Node suite, executes browser-free runtime QA, checks endpoint/storage performance budgets, and runs the isolated high-risk browser journeys. Linux CI runs the E2E compatibility matrix in Chromium, Firefox, and WebKit with focused axe checks, keyboard navigation, and 200% text sizing. Local Darwin runs default to Chromium and WebKit because Playwright Firefox cannot use its headless framebuffer in the Codex app sandbox; run `STRATA_E2E_ENGINE=firefox npm run test:e2e` when that diagnostic is available. Use `npm run qa:ui` with the environment documented in `../qa/README.md` for the broader authenticated Chromium layout pass.

`npm run preflight:production` reads the candidate environment and fails on non-production runtime settings, an unsafe public URL, missing durable Turso values, insecure cookies, ambiguous proxy configuration, an enabled test bypass, an invalid administrator address, incomplete Resend configuration, incomplete or mismatched Paddle configuration, or reused secrets. It validates shape and coherence only; it does not call Turso, Resend, or Paddle and cannot prove that a credential is accepted.

After deployment:

1. Check `/api/status`, `/livez`, `/readyz`, and the compatibility `/healthz` alias.
2. Confirm account, protected-page, service-worker, and manifest responses have the expected cache policy.
3. Complete a signup/login and plan-save round trip.
4. Exercise provider flows after changing Resend or Paddle configuration.
5. Run `STRATA_SMOKE_BASE_URL=https://your-host.example STRATA_EXPECTED_BUILD=7.8.7 npm run smoke:deploy` to check status/build/provider flags, durable Turso reporting, storage readiness, the public home and manifest, security headers, and signed-out private-route handling.
6. Confirm GitHub Actions is green before tagging or announcing a release.

The deployment smoke is read-only and does not create an account, send email, buy a subscription, process a webhook, or mutate production data. Complete authorized provider-backed smoke separately and record its result; never describe local provider fakes or configuration-shape checks as live credential evidence.

## Production limits

Free Render services can sleep and take time to wake. The installed PWA may show its public offline explanation or a generic continuation shell for an already-authorized device workout during a cold start, but authentication, new private reads, entitlement, Plan changes, and sync still require the live server. Free services and Turso/Resend/Paddle plans also have usage limits; select appropriate tiers and monitoring before relying on the service for real users.

The current administrator model has one verified, permanently bound owner and no delegated roles or Admin-specific MFA. Its authority follows the normal live account session, so keep that account and every signed-in device secure. Support has no attachments or real-time chat. Treat these as operating limits rather than silently broadening privileges or storing new sensitive content.
