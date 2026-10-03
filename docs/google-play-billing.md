# Google Play Billing for Strata+

Inside the STRATA Android app, Strata+ is sold through Google Play Billing with the website's two plans: one subscription product, `online.stratafitness.app.plus`, with the base plans `monthly` ($4.99 USD a month) and `yearly` ($29.99 USD a year), both auto-renewing. The paywall offers the base plans Google Play returns, monthly first, with the yearly saving worked out from the storefront's own prices. The website sells the same two plans through Paddle and the iOS app through Apple ([apple-in-app-purchase.md](apple-in-app-purchase.md)). Strata+ is one entitlement however it was paid for: Paddle, Apple, Google Play, or an owner's complimentary grant.

## How it works

1. The app (repository `sugarhappy8/strata-fitness-android`) buys the base plan the member chose with Play Billing Library 8 and sets the purchase's `obfuscatedAccountId` to the signed-in member's STRATA user id. Google returns it as `externalAccountIdentifiers.obfuscatedExternalAccountId`. A base plan whose id contains `year` or `annual` is the yearly plan: Account names it, and Admin → Metrics counts it at its yearly price.
2. The app posts each purchase token and product id to `POST /api/billing/google/purchases` (`{purchases: [{purchaseToken, productId}]}`, 1 to 20 items) with the session cookie and CSRF token, the same way other signed-in writes work. It does this after a purchase, after **Restore Purchases**, once per launch for the purchases Google Play holds for the device's Google Account, and for every purchase update Play reports while the app runs. The app never acknowledges a purchase itself.
3. For every token the server reads the subscription from the Google Play Developer API (`purchases.subscriptionsv2.get`, `src/google-play-api.js`) as the service account in `GOOGLE_PLAY_SERVICE_ACCOUNT`. It checks the line item's product is one of `GOOGLE_PLAY_PRODUCT_IDS` and that the account Google names is the signed-in account (or, for a resubscription without one, that the purchase it replaces (`linkedPurchaseToken`) belongs to that account). It stores one row per purchase token in `google_play_subscriptions`, acknowledges the purchase (`purchases.subscriptions.acknowledge`; Google refunds a purchase not acknowledged within three days), and answers with the member's `discovery` (the same shape as `/api/me`) and the accepted tokens.
4. Google Play sends Real-time developer notifications through Cloud Pub/Sub to `POST /api/billing/google/notifications?token=<GOOGLE_PLAY_NOTIFICATION_TOKEN>`. A notification only says which token changed, so the server reads that token from Google again and stores the answer. It answers `403` without the right token, `200 {}` for everything it handled or ignored (test notifications, other packages, unlinked purchases, invalid tokens), and `503` only when Google could not be reached, so Pub/Sub retries only what can succeed.
5. Every 10 minutes the server re-reads up to 25 subscriptions that are within an hour of their expiry, not acknowledged yet, or not checked for a day, so a renewal, an acknowledgement that failed, or a missed notification is caught up.

Access is active while Google's state is `ACTIVE`, `IN_GRACE_PERIOD` (Google extends the expiry during the grace period), or `CANCELED` (cancelled but paid until the expiry), and the expiry is in the future. An `ACTIVE`, auto-renewing subscription keeps access for two more hours past the expiry STRATA last saw, so a renewal STRATA has not read yet never shows as a lapse. `ON_HOLD`, `PAUSED`, `PENDING`, `EXPIRED`, and `PENDING_PURCHASE_CANCELED` give no access. Every Strata+ check goes through `billing.hasCurrentAccess`, which is Paddle or Apple or Google Play or grant. `/api/me` reports `discovery.accessType` as `paid` (Paddle), then `apple`, then `google`, then `grant`, and `discovery.googlePlay` as `{active, productId, plan, expiresAt, autoRenew, state, inGracePeriod, onHold, paused, pending, testPurchase}` or `null`.

State never moves backwards: each row keeps `checked_at`, the time STRATA asked Google, and the database refuses an answer read earlier than the one stored. A subscription stays with the account that bought it; another account can take it over only after it no longer gives access and Google names that account. Otherwise the server answers `409 GOOGLE_PLAY_PURCHASE_OTHER_ACCOUNT`.

Errors use `{error, code}`: `400 GOOGLE_PLAY_PURCHASE_INVALID` (unknown or expired token, another app's or product's purchase, no STRATA account on the purchase), `403 GOOGLE_PLAY_ACCOUNT_MISMATCH`, `409 GOOGLE_PLAY_PURCHASE_OTHER_ACCOUNT`, `429 GOOGLE_PLAY_RATE_LIMIT`, `503 GOOGLE_PLAY_NOT_CONFIGURED` (no service account, or Google refused it), and `503 GOOGLE_PLAY_UNAVAILABLE`. Both endpoints accept bodies up to 256 KiB and are rate limited (30 purchase posts per account and 600 notifications per address per 15 minutes).

## Paying once

A member with Strata+ from Google Play is never sent to a second payment: Paddle checkout answers `409 ALREADY_ENTITLED_GOOGLE_PLAY`, and the Paddle portal answers `GOOGLE_PLAY_MANAGED` with Google Play's subscriptions page. Inside the Android app the paywall shows the member where their Strata+ is billed (the App Store, Paddle, or Google Play) instead of a second purchase.

## Accounts, export, and deletion

- Account shows the Google Play plan, state, and renewal or end date, and in the Android app a **Manage in Google Play** button that opens Play's subscription page.
- The JSON export lists Google Play subscriptions with their order id, product, base plan, state, dates, and auto-renewal, but never the purchase token, which stays on the server.
- Deleting the account removes its `google_play_subscriptions` rows. It does not cancel the subscription: the deletion confirmation, its email, and the delete-account page say that Google keeps billing until the member cancels in Google Play › Payments & subscriptions › Subscriptions.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_PLAY_PACKAGE_NAME` | `online.stratafitness.app` | The Android app's package name. |
| `GOOGLE_PLAY_PRODUCT_IDS` | `online.stratafitness.app.plus` | Comma list of subscription product ids the server accepts. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT` | — (secret) | The service account's JSON key, as JSON or base64. Without it the purchase route answers `503 GOOGLE_PLAY_NOT_CONFIGURED` and the admin Overview shows Google Play billing as not set up. |
| `GOOGLE_PLAY_NOTIFICATION_TOKEN` | — (secret) | 32 to 256 letters, digits, `-` or `_`, also put in the Pub/Sub push URL. Without it every notification is refused. |
| `GOOGLE_PLAY_TEST_ACCOUNTS` | — | Comma list of STRATA account emails for which a Google Play test purchase (license testers) unlocks Strata+ in production. Put the Play review demo account here. Outside production every test purchase unlocks. |

Admin → Metrics counts Google Play subscriptions at the plan's list price less Google's 15% service fee and leaves out the accounts in `GOOGLE_PLAY_TEST_ACCOUNTS`.

## Google Play Console steps

1. Create the app with package `online.stratafitness.app` and upload a signed build (`docs/google-play.md` in `sugarhappy8/strata-fitness-android`).
2. Monetize → Subscriptions: create `online.stratafitness.app.plus` with base plans `monthly` (1 month, auto-renewing, $4.99 USD) and `yearly` (1 year, auto-renewing, $29.99 USD). Turn on a grace period and account hold as you like; STRATA reads whatever Google reports.
3. Google Cloud: in the project linked to the Play Console, enable the Google Play Android Developer API and create a service account with a JSON key. In Play Console → Users and permissions, invite the service account's email with **View financial data** and **Manage orders and subscriptions**. Put the JSON key in `GOOGLE_PLAY_SERVICE_ACCOUNT` (Render secret).
4. Pub/Sub: create a topic, grant `google-play-developer-notifications@system.gserviceaccount.com` the Pub/Sub Publisher role on it, and create a push subscription to `https://stratafitness.online/api/billing/google/notifications?token=<GOOGLE_PLAY_NOTIFICATION_TOKEN>`. In Play Console → Monetization setup, set the topic and send a test notification (the server logs `google_play.notification` with outcome `test`).
5. Add license testers (Play Console → Settings → License testing) and the review demo account's email to `GOOGLE_PLAY_TEST_ACCOUNTS`.

## Testing

License testers buy with test cards that renew quickly (a monthly plan renews every five minutes). Those purchases arrive with `testPurchase` set, are stored, and unlock Strata+ in production only for accounts in `GOOGLE_PLAY_TEST_ACCOUNTS`. Account and the paywall say "This was a Google Play test purchase" for anyone else.
