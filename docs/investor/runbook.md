# STRATA runbook

What to do when a release goes wrong, a key leaks, or data is damaged, written so someone other than the founder can
do it. It answers "what happens if you're unavailable?"

## Where everything is

| Service | What it holds | Where |
|---|---|---|
| GitHub | The code: `sugarhappy8/strata_main-1` (site and server), `sugarhappy8/strata-fitness-ios` (iOS app) | github.com |
| Render | The running server and every secret setting | dashboard.render.com, service `strata-workout-index` |
| Turso | The production database | turso.tech (and the `turso` CLI) |
| Paddle | Web subscriptions, refunds, the webhook | vendors.paddle.com |
| App Store Connect | The iOS app, its subscription, TestFlight | appstoreconnect.apple.com |
| Resend | Account email | resend.com |
| Groq | Strata AI | console.groq.com |
| Polar AccessLink | The wearable integration | admin.polaraccesslink.com |
| Google Cloud | Sign in with Google | console.cloud.google.com |

The owner account is `stratafitness.official@gmail.com` (Admin and support). Every setting is listed in
`.env.example`; the deployment guide (`docs/deployment.md`) explains each one.

**Make this work without the founder** (owner to do, once): add one trusted person as a member of the GitHub
repositories, the Render workspace, the Turso organisation, and the Paddle account, and keep the recovery codes for each
account somewhere they can reach. With that, the steps below need nothing else.

## Health and switches

- `GET /healthz`, `/livez`, and `/readyz` answer when the server and database are up. `/api/status` returns only
  `{ ok, version }`.
- After any deploy: `STRATA_SMOKE_BASE_URL=https://stratafitness.online STRATA_EXPECTED_BUILD=<build> npm run smoke:deploy`.
- `PADDLE_CHECKOUT_ENABLED=false` stops new web checkouts; existing subscriptions and webhooks keep working.
- `STRATA_AI_TIER=off` hides Strata AI everywhere without touching anything else. `STRATA_AI_DAILY_BRIEF=false` stops
  the morning briefs only.
- A changed setting in Render applies after the service redeploys; choose to deploy when you save it.

## Roll back a release

1. **Prefer a code-only rollback.** In Render, open the service's **Events** (deploys), choose the last good deploy,
   and **Rollback**. Or revert the release commit on `main` and let it deploy.
2. Every migration is additive, so older code runs on a newer database. 9.8.0's migration only adds a table that 9.7.0
   ignores; rolling 9.8.0 back to 9.7.0 needs no database change.
3. If billing is involved, set `PADDLE_CHECKOUT_ENABLED=false` first.
4. **9.8.0 changed the price.** 9.7.0 accepts only the $2.99 monthly price, so a rollback to it also needs
   `PADDLE_PRICE_ID` set back to that price, or its checkout stays closed. 9.7.0 does not recognise the $4.99 and
   $29.99 prices: once anyone has subscribed on them, a rollback suspends their Strata+ until 9.8.0 is back. Prefer
   fixing forward.
5. **10.0.0 added the yearly App Store plan.** 9.8.x accepts a yearly App Store subscription only while
   `APPLE_IAP_PRODUCT_IDS` lists it (its default lists only monthly), and names it monthly in Account and Metrics.
   With the setting in place, no member loses Strata+.
6. Check: sign in with a test account, open its plan, open Admin, and run the smoke check above with the old build.
7. Installed apps pick up the rolled-back files on their next visit, because each build has its own cache name.

Never combine a code rollback with a database restore; they are separate decisions.

## Rotate a key

Rotate any key that may have been seen by someone else. Change it at the provider first, then in Render.

| Setting | How | What members notice |
|---|---|---|
| `TURSO_AUTH_TOKEN` | `turso db tokens invalidate <db>` (every token stops working), then `turso db tokens create <db>`, set it in Render | A short outage between the two steps; do it at a quiet time |
| `PADDLE_API_KEY` | Create a new API key in Paddle → Developer tools, set it in Render, then revoke the old key | Nothing |
| `PADDLE_WEBHOOK_SECRET` | Rotate the notification destination's secret in Paddle with an overlap window, then set the new one in Render before the window ends. STRATA accepts any valid signature Paddle sends during the overlap. | Nothing |
| `PADDLE_CLIENT_TOKEN` | Create a new client-side token in Paddle, set it in Render, then revoke the old one | Nothing |
| `DEVICE_TOKEN_KEY` | Move the current value to `DEVICE_TOKEN_KEY_PREVIOUS`, set a new 32-byte base64 key (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), deploy. Once every connection has synced (a day), remove `DEVICE_TOKEN_KEY_PREVIOUS`. | Nothing. Losing both keys means members reconnect Polar. |
| `EMAIL_VERIFICATION_SECRET` | Set a new random value | Codes sent in the last 30 minutes stop working; people ask for a new one |
| `RESEND_API_KEY` | Create a new key in Resend, set it, delete the old one | Nothing |
| `GROQ_API_KEY` | Create a new key in Groq, set it, delete the old one | Nothing |
| `POLAR_CLIENT_SECRET` | Regenerate it in AccessLink admin, set it | Nothing |
| `GOOGLE_SIGN_IN_CLIENT_SECRET` | Add a new secret to the OAuth client, set it, then delete the old one | Nothing |

There is no session secret: sessions are random tokens stored as hashes. To sign everyone out, an owner can revoke
sessions per account in Admin → People; a password reset signs that member out everywhere.

## Back up and restore the database

**Back up** before every release that adds a migration, and before any manual data change:

```bash
turso db shell <database> .dump > strata-$(date +%Y-%m-%d).sql
```

Keep the file private: it holds every account. Turso also keeps point-in-time history for the length its plan allows.

**Restore only for a confirmed data problem**, because a restore discards every write after its point in time:

1. Set `PADDLE_CHECKOUT_ENABLED=false`, and suspend the Render service if bad writes are still happening.
2. Export what changed since the restore point if it must be kept (the Paddle and App Store dashboards hold the payment
   record; webhooks re-sync subscription state).
3. Create a new database from the point in time, or from the dump:
   `turso db create strata-restore --from-db <database> --timestamp <RFC 3339 time>`, or
   `turso db create strata-restore --from-dump strata-YYYY-MM-DD.sql`. Check `turso db create --help` for the current
   flags.
4. Check counts in the new database (`SELECT COUNT(*) FROM users`, `plans`, `workouts`, `paddle_subscriptions`).
5. Point Render at it: `TURSO_DATABASE_URL` from `turso db show strata-restore --url`, and a token from
   `turso db tokens create strata-restore`. Resume the service and deploy.
6. Sign in with a test account, open Admin → Overview, and run the smoke check.

Keep the old database until the restored one has run for a week.
