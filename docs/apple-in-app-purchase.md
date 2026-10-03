# Apple In-App Purchase for Strata+

Inside the STRATA iOS app, Strata+ is sold through Apple In-App Purchase as an auto-renewable monthly subscription at $4.99 USD per month. The website's $29.99 yearly plan has no App Store product yet. The website keeps Paddle exactly as it is. Strata+ is one entitlement however it was paid for: Paddle, Apple, or an owner's complimentary grant.

## How it works

1. The app buys `online.stratafitness.app.plus.monthly` with StoreKit 2 and sets the purchase's `appAccountToken` to the signed-in member's STRATA user id (a UUID).
2. The app posts the signed transaction (a JWS) to `POST /api/billing/apple/transactions` with the session cookie and CSRF token, the same way other signed-in writes work. It does this after a purchase, after **Restore Purchases**, at launch for `Transaction.currentEntitlements`, and for every `Transaction.updates` item. It finishes a transaction only after the server accepts it.
3. The server verifies each JWS against Apple Root CA - G3 (`src/apple-jws.js`), then checks the bundle id, product id, environment, and that `appAccountToken` equals the signed-in account. It stores one row per `originalTransactionId` in `apple_subscriptions` and answers with the member's `discovery` (the same shape as `/api/me`) and the accepted transaction ids.
   Strata+ is not shared through Family Sharing. A transaction whose `inAppOwnershipType` is `FAMILY_SHARED` never grants access: it is left out of `accepted`, and a post that holds nothing else is refused with `422 APPLE_FAMILY_SHARED` ("Strata+ is not shared through Family Sharing. Subscribe with your own Apple Account to unlock it."). The member's own purchase in the same post still counts.
4. Apple sends App Store Server Notifications V2 to `POST /api/billing/apple/notifications`. The server verifies the signed payload and the transaction and renewal info inside it, skips a `notificationUUID` it has already processed, and applies the change to the subscription by `originalTransactionId` (linking a new one by `appAccountToken`). It answers `200 {}` for handled or ignored notifications (including any about a Family Sharing copy, which change nothing), `400` only for an invalid signature, and `503` only when racing updates to the same subscription kept winning, so Apple retries only what can succeed.

Access is active while the subscription is not revoked and either its expiry is in the future or Apple's billing grace period has not ended. Every Strata+ check goes through `billing.hasCurrentAccess`, which is Paddle or Apple or grant. `/api/me` reports `discovery.accessType` as `paid` (Paddle), then `apple`, then `grant`, and `discovery.apple` as `{active, productId, expiresAt, autoRenew, inGracePeriod, environment, revoked}` or `null`.

State never moves backwards. Each row keeps two clocks: `last_signed_at`, the `signedDate` of the newest App Store data applied, which orders the auto-renew and grace state, and `latest_signed_at`, the `signedDate` of the data last applied to the current billing period (`latest_transaction_id`), which orders that period's expiry and refund state. The current period moves only to a later period, or to data about the same period signed no earlier; data older on both clocks is ignored. So a refund of an earlier billing period does not end the current one and never hides later data about it: the current period's own refund still ends access even when Apple delivers it after an older period's refund that it signed later. A later billing period that Apple signed earlier but delivered late (for example a retried `DID_RENEW` arriving after the refund notification for an older period) still moves the period forward, and the newer auto-renew and grace state stay as they are. The database refuses a write that would move either clock back, so when two deliveries for one subscription race, the one that loses is recomputed from the newer row (up to three times, then `503 APPLE_STATE_BUSY`, and Apple delivers the notification again). A subscription stays with the account that bought it; another account can take it over only after it has expired or been revoked and the newer purchase was made for that account. Otherwise the server answers `409 APPLE_PURCHASE_OTHER_ACCOUNT`.

| Notification | Effect |
| --- | --- |
| `SUBSCRIBED`, `DID_RENEW`, `OFFER_REDEEMED`, `RENEWAL_EXTENDED` | New period and expiry |
| `DID_CHANGE_RENEWAL_STATUS`, `DID_CHANGE_RENEWAL_PREF` | Auto-renew status |
| `DID_FAIL_TO_RENEW` with `GRACE_PERIOD` | Access until the renewal info's `gracePeriodExpiresDate` |
| `DID_FAIL_TO_RENEW` (billing retry), `GRACE_PERIOD_EXPIRED`, `EXPIRED` | Access ends at the expiry |
| `REFUND`, `REVOKE` | Access ends now |
| `REFUND_REVERSED` | Access returns |
| `TEST` and anything else | Acknowledged, no change |

Errors use `{error, code}`: `400 APPLE_SIGNATURE_INVALID`, `400 APPLE_ROOT_UNTRUSTED`, `400 APPLE_TRANSACTION_INVALID` (wrong bundle, unknown product, missing `appAccountToken`), `403 APPLE_ACCOUNT_MISMATCH`, `409 APPLE_PURCHASE_OTHER_ACCOUNT`, `422 APPLE_FAMILY_SHARED`, `503 APPLE_STATE_BUSY` (another update to the same subscription kept winning; retry). Both endpoints accept bodies up to 256 KiB and are rate limited (30 transaction posts per account and 600 notifications per address per 15 minutes).

A purchase made outside the app without an `appAccountToken` (for example an offer code redeemed in the App Store) cannot be linked to a STRATA account and is rejected.

## Paying once

Strata+ is one entitlement, so a member is never asked to pay for it twice:

- `POST /api/billing/checkout` (Paddle, on the website) answers `409 {code: "ALREADY_ENTITLED_APP_STORE", error: "You already have Strata+ through the App Store."}` while the member's App Store access is active (including Apple's billing grace period), before Paddle is contacted. Other members with Strata+ keep `409 ALREADY_ENTITLED`. Once the App Store access has ended, Paddle checkout opens as usual.
- `POST /api/billing/portal` answers `409 {code: "APP_STORE_MANAGED", error: "Your Strata+ subscription is managed by the App Store. Manage it in Settings on your iPhone.", manageUrl: "https://apps.apple.com/account/subscriptions"}` when the member has no Paddle subscription but has an App Store subscription (current or past). A member with a Paddle subscription still gets Paddle's portal; a member with neither still gets `404 SUBSCRIPTION_NOT_FOUND`.
- The admin Overview (System readiness) shows App Store billing as Purchases verified when signed App Store data can be verified against a pinned root for the configured bundle and products. The public `/api/status` no longer reports it.

## Accounts, export, and deletion

- In the app, account deletion completes in the app, with no email (App Review cannot open one). Profile > Delete account opens a dialog: what is deleted, Apple's billing note with **Manage subscription** when Apple may still bill, the account password, and DELETE typed exactly. It posts `POST /api/account/delete/now` with `{password, confirmation: "DELETE"}`, the session's CSRF token, and a trusted Origin. The server checks DELETE first (`400 DELETE_CONFIRMATION_REQUIRED`), then the password with sign-in's constant-time scrypt comparison (`401 {code: "PASSWORD_INCORRECT", error: "That password is incorrect."}`), allows 5 attempts per 15 minutes per account and per network (`429 ACCOUNT_DELETE_RATE_LIMIT`), and then applies exactly the emailed link's protections, through the same code (`src/account-deletion.js`): the primary administrator (`409 ADMIN_ACCOUNT_PROTECTED`), a checkout being prepared (`409 CHECKOUT_PREPARING`), an unsettled payment (`409 PURCHASE_PENDING`), and a Paddle subscription that has not ended (`409 SUBSCRIPTION_ACTIVE`) refuse. The store deletes through the emailed link's path, by consuming a short-lived internal `account_delete` action. Success answers `200 {ok, message, appleBilling?}`, clears the session and signup cookies, and is audit-logged as `account_deleted` with purpose `account_delete_in_app`; the app shows the message for a moment and returns to its signed-out start screen. "Email me a deletion link instead" still sends the emailed link; browsers keep the emailed link only.
- An Apple subscription never blocks account deletion (App Review Guideline 5.1.1(v)). Deleting removes the `apple_subscriptions` rows. Because Apple keeps billing until the member cancels, the deletion request, the deletion email, `/api/account/delete/status`, `/api/account/delete/complete`, and `/api/account/delete/now` include `appleBilling: {message, manageUrl}` (`https://apps.apple.com/account/subscriptions`) while a subscription is live or Apple reports it set to renew (even after a refund, which does not turn renewal off by itself).
- The account export includes `access.appleSubscriptions`.
- The owner's Admin member list and detail include `discovery.apple`; the detail adds the same summary `/api/me` uses.
- Sessions slide: once a session is past half of its seven days, the next request extends it and re-sends the cookie with the same token, never beyond 60 days after sign-in.

## Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `APPLE_BUNDLE_ID` | `online.stratafitness.app` | Must match the app's bundle id. |
| `APPLE_IAP_PRODUCT_IDS` | `online.stratafitness.app.plus.monthly` | Comma list of accepted Strata+ products. |
| `APPLE_SANDBOX_ACCOUNTS` | (unset) | Comma list of STRATA account emails a Sandbox purchase unlocks Strata+ for in production. Put the App Review demo account here. |
| `APPLE_ROOT_FINGERPRINT` | (unset) | Test-only root override; ignored unless `NODE_ENV=test`. |

There is no shared secret or API key. Purchases from both the Production and Sandbox environments are verified and saved, because App Review and TestFlight purchase in Sandbox. In production (`NODE_ENV=production`) a Sandbox purchase unlocks Strata+ only for an account listed in `APPLE_SANDBOX_ACCOUNTS`; on any other account it is saved and shown with `environment: "Sandbox"` but grants nothing, so a free Sandbox purchase can never stand in for a paid one. Outside production every Sandbox purchase unlocks Strata+. Admin shows Apple's own state for the subscription, whichever environment it came from.

## App Store Connect steps

1. **Agreements, Tax, and Banking:** accept the Paid Apps agreement and complete the bank and tax forms. Purchases do not work until it is active.
2. **Subscriptions:** create a subscription group named `Strata+`. In it, create an auto-renewable subscription with product id `online.stratafitness.app.plus.monthly`, duration 1 month, price $4.99 USD (let Apple fill other storefronts), and a display name and description. Leave **Family Sharing** off: the server never grants Strata+ to a family member's shared copy. Add the review screenshot of the in-app purchase screen.
3. **App Store Server Notifications:** under App Information, set Version 2 notifications with the URL `https://stratafitness.online/api/billing/apple/notifications` for both the Production and the Sandbox server. Use **Request a Test Notification** (or the App Store Server API) and expect a `200`; the server logs `apple.notification` with outcome `test`.
4. **Submit the subscription with the app version** the first time; later changes can be submitted on their own.

## Sandbox testing

- Create Sandbox Apple Accounts under Users and Access > Sandbox, and sign in to one on the device under Settings > Developer (or App Store) > Sandbox Account.
- TestFlight builds and development builds buy in Sandbox; renewals are accelerated (a month renews about every five minutes, up to 12 times a day).
- Check (on a local or staging server, or with the test account listed in `APPLE_SANDBOX_ACCOUNTS`): purchase unlocks Strata+ on the same STRATA account, Restore Purchases works after reinstalling, a second STRATA account on the same Apple Account gets `APPLE_ACCOUNT_MISMATCH` or `APPLE_PURCHASE_OTHER_ACCOUNT`, cancelling in the sandbox subscription settings ends access at expiry, and a refund requested through the Sandbox account (or a `REFUND` test) removes access.
- Local tests sign with a throwaway chain from `test/support/apple-test-chain.js`; see `test/apple-billing.test.js` and `test/server-apple-billing.test.js`.

## What App Review sees

- The reviewer signs in with the demo STRATA account from the review notes and buys Strata+ with their Sandbox Apple Account. List that demo account's email in `APPLE_SANDBOX_ACCOUNTS` on Render before submitting, so the Sandbox purchase unlocks Strata+ on it.
- The purchase screen must show the price and period from StoreKit, that it renews monthly until cancelled, how to cancel, **Restore Purchases**, and links to the [Terms](https://stratafitness.online/terms) and [Privacy Policy](https://stratafitness.online/privacy), which cover purchases through Apple.
- The app must link to no outside payment for Strata+ (Paddle stays on the website only).
- Account deletion must be reachable and complete in the app: Profile > Delete account, the account password, and DELETE delete the account at once with no email. The server never blocks it by the subscription; the member is told Apple keeps billing until they cancel, with a Manage subscription button.
