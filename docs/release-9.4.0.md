# Build 9.4.0 — Hardening

Build 9.4.0 adds no features. It closes eight gaps found in a review: purchases, request checks, product counts, the
Strata AI quota, the public status, lost event reactions, the session cookie, and state kept in one server's memory.

## What changed

### Apple test purchases no longer unlock Strata+ in production
- Sandbox purchases (TestFlight and App Review) are still verified and saved. In production (`NODE_ENV=production`)
  they unlock Strata+ only for accounts listed in the new `APPLE_SANDBOX_ACCOUNTS` (comma-separated emails). Outside
  production every Sandbox purchase still unlocks it. Production purchases are unchanged.
- The `plus.*` route check and `/api/me` apply the same rule. Admin shows Apple's own state for the subscription.

### Workout saves check the origin
- `POST`, `PUT`, and `DELETE` on `/api/workouts` require a trusted STRATA origin, as training writes already did. A
  write with no `Origin` header used to pass the general cross-origin check; it now gets `403 WORKOUT_ORIGIN_REQUIRED`.

### Product activity counts are harder to fake
- A signed-in count must carry the session's CSRF token. The browser reads its token from `/api/me` and sends the
  session only when signed in; signed out it still sends no cookie.
- Anonymous counts are limited per network address and have their own total (1,000 per 15 minutes), so they cannot use
  up the signed-in total (5,000).
- Each action counts once per account or network per UTC day. The server keeps a one-way daily key, made with a secret
  that exists only in its memory, until the day ends.
- Counts are stored as signed-in and anonymous. The admin readout's totals are the signed-in counts, the ones to decide
  from; anonymous counts sit beside them. Privacy, policies, and admin text describe the change.

### The Strata AI quota cannot be overshot
- The member allowance and the shared daily budget are each claimed with one conditional database write
  (`INSERT … ON CONFLICT DO UPDATE … WHERE used < limit RETURNING`); no row back means spent.
- A member's new request is marked in flight before the first await, so simultaneous requests cannot all pass the
  "already running" check and each claim the quota.

### `/api/status` shows only that the app is up
- `GET /api/status` returns `{ "ok": true, "version": "9.4.0" }`. Storage, email, payments, the Paddle IP allowlist,
  App Store billing, Google sign-in, and admin setup moved to the admin Overview's System readiness panel, which gains
  App Store billing and Sign in with Google rows.
- `npm run smoke:deploy` checks the version and fails if the status reveals any setup. Check configuration before a
  deploy with `npm run preflight:production` and afterwards on the Overview.

### Failed event reactions are retried
- When a listener fails (for example a Daily Snapshot rebuild after a workout), the listener and its payload are saved to
  a new `event_outbox` table and retried every 30 seconds with doubling backoff, up to 12 attempts.
- Reading a member's Daily Snapshots first retries that member's queued reactions, so a failed rebuild is healed on the
  next read instead of leaving a stale row. The Training Log recomputes its links on every read.

### The session cookie no longer wraps `res.writeHead`
- The session lookup adds the renewed cookie with `appendSetCookie(res, cookie)` before any handler writes. `json` and
  `redirect` merge a route's own `Set-Cookie` with it: a cookie of the same name wins, others are kept.

### State moved out of server memory
- Rate limits are kept in `rate_buckets` (one conditional write per request; keys are stored hashed). Every limiter call
  is awaited, and a test fails on one that is not.
- Strata AI requests are queued in `ai_jobs`: one unfinished request per member across servers, the member's message is
  dropped once answered, and a request a restart interrupted runs again.
- The Polar sync loop runs only while its server holds the `polar-sync` row in the new `locks` table.
- STRATA runs as one server: `render.yaml` sets `numInstances: 1`, and a second server on the same database logs
  `service.multiple_instances`. See [One server](deployment.md#one-server).

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 9.4.0.
2. **App Review.** Before submitting the iOS app, set `APPLE_SANDBOX_ACCOUNTS` on Render to the App Review demo
   account's email, or the reviewer's Sandbox purchase will not unlock Strata+.
3. **Database.** The new tables (`event_outbox`, `rate_buckets`, `locks`, `ai_jobs`, `product_signal_actors`) are
   created when the server starts. Migration `010-product-signal-audiences` adds the signed-in and anonymous count
   columns; earlier counts stay in the total and are not attributed to either.
4. **Monitoring.** Anything that read flags from `/api/status` must use the admin Overview instead; `/api/status` now
   has only `ok` and `version`.
5. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.4.0 npm run smoke:deploy`, then open the admin
   Overview and check System readiness.

## Validation

The Node suite with coverage floors, release markers, architecture policy, strict types, lint, runtime smokes, the
performance budgets, the 100-account load checks (separate and shared addresses), and the browser journeys pass. New
tests cover a Sandbox purchase in production, a workout write with no origin, signal forgery and once-a-day counting,
simultaneous AI requests against a slow store, the outbox's retries, leases, and read-time healing, the renewed cookie
beside a route's own cookies, rate slots and locks on SQLite and Turso, the AI queue surviving a restart, and the
multiple-server warning.
