# Paddle provider acceptance

This checklist separates code-level evidence from real provider evidence. The automated suite uses an in-process fake Paddle service and a disposable local database. It proves STRATA's validation, ordering, idempotency, and entitlement rules; it does **not** prove that Paddle credentials, catalog objects, notification destinations, customer-portal settings, or a hosted database are correctly configured.

## Automated evidence

Run the focused provider suite before every payment release:

```sh
node --test \
  test/payments.test.js \
  test/database-payments.test.js \
  test/payment-sandbox.test.js \
  test/server-payments.test.js \
  test/server-account-recovery.test.js
```

| Risk | Local evidence |
| --- | --- |
| Checkout creation | The server fixes the product, the chosen plan's price, quantity, collection mode, account ID, and durable checkout ID; concurrent and interrupted requests cannot create an untracked duplicate. |
| Initial entitlement | A completed transaction alone stays locked. Access begins only after the signed, account-bound subscription snapshot is stored. |
| Invalid or replayed webhook | Invalid signatures, wrong source when allowlisting is enabled, wrong account/customer/catalog, stale timestamps, reused adjustment IDs, and duplicate event IDs fail closed or are idempotent. |
| Renewal | A newer, validated `subscription.updated` event advances the current-period boundary; replaying that event records it once. |
| Cancellation and pause | Scheduled cancellation retains access only until its effective boundary. Paused and terminally canceled states remove access; an ordered active state can resume it. |
| Refund and adjustment | Pending and partial refunds do not revoke access. Approved full refunds and chargebacks do, and older adjustment state cannot overwrite newer state. |
| Legacy lifetime access | A strictly validated pre-subscription purchase remains grandfathered without a fabricated subscription; a revoked legacy purchase remains revoked. |
| Portal | Returned management URLs must be HTTPS links on Paddle's customer-portal host and match the stored customer/subscription pair. They are not persisted. |

The fake-provider suite never sends a request to Paddle, Turso, Resend, or a production deployment. Passing it is necessary, not sufficient, for launch.

## Safe sandbox acceptance

Use a dedicated non-production deployment, isolated database, disposable test accounts, and Paddle sandbox credentials. Never point this exercise at the production database or live catalog. STRATA intentionally rejects sandbox credentials when `NODE_ENV=production`.

Before starting:

- Create a sandbox product with two quantity-one, automatically collected prices: **$4.99 USD monthly** and **$29.99 USD yearly**. Confirm the create-transaction response returns `unit_price.amount` as `499` (or `2999` for yearly) and `unit_price.currency_code` as `USD`; STRATA rejects a newly prepared checkout when either value differs or is absent.
- Configure the sandbox client token, API key, notification secret, product ID, and price ID on the isolated deployment. Keep `PADDLE_CHECKOUT_ENABLED=false` until the values and webhook URL are reviewed.
- Register the deployment's exact `/api/paddle/webhook` HTTPS URL for transaction, subscription, and adjustment events.
- Leave IP allowlisting off until the staging proxy is proven to preserve Paddle's source address. Signatures remain mandatory either way.
- Confirm `/api/status` reports the expected build, persistent storage, configured payments, and the intended checkout switch. Confirm `/api/billing/config` exposes only the sandbox environment, client token, catalog IDs, and public price—not the API key or webhook secret.

Then enable checkout and record the result of each step:

1. Create a fresh verified account and open checkout from Pricing. Confirm Paddle receives one transaction for the expected product, price, quantity, currency, cadence, and account metadata.
2. Before paying, confirm Strata+ remains locked. Complete the sandbox checkout and wait for both the transaction and subscription notifications to return HTTP 2xx.
3. Confirm the same account receives Strata+ in the original browser and a second signed-in browser. A checkout redirect or `transaction.completed` delivery alone must never be treated as entitlement.
4. Redeliver the same notification from Paddle. Confirm the application remains in the same state and no duplicate purchase, subscription, or event record appears.
5. Open subscription management from Account. Confirm overview, payment-method, and cancellation actions open temporary `https://customer-portal.paddle.com/…` URLs for the correct subscription.
6. Schedule cancellation or pause. Confirm access remains only through the provider's effective boundary, then is denied when the terminal state is delivered. If the sandbox supports resume for that state, resume once and confirm only a newer ordered update restores access.
7. Observe a sandbox renewal update when available and confirm the current-period end moves forward. If the provider account cannot produce a real renewal during the release window, mark this step **not externally verified**; the fake-provider renewal test is not a substitute.
8. On a separate disposable subscription, create a partial refund and confirm access remains. Then approve a full refund (or approved chargeback fixture) and confirm access is removed in both browsers. Do not test a real-money refund for sandbox acceptance.
9. Send or redeliver an older subscription/adjustment notification after the newer state. Confirm the newer state is not regressed.
10. Cancel remaining sandbox subscriptions and resolve unfinished transactions before deleting the disposable accounts.

## Evidence record

For each acceptance run, record the build, deployment URL, UTC time, operator, sandbox product/price IDs, test account alias, transaction/subscription/event IDs, observed HTTP status, expected state, actual state, and pass/fail result. Redact client tokens, API keys, notification secrets, cookies, CSRF tokens, portal URLs, and personal data.

Release acceptance requires all applicable steps to pass, genuine Paddle notifications to receive HTTP 2xx, and no unexplained pending checkout or entitlement state. A skipped provider step must remain explicitly marked as unverified in release readiness; local fake results must never be described as a real Paddle, Turso, or Resend verification.

See [deployment](deployment.md#paddle-subscriptions) for production configuration and rollback guidance.
