# Build 10.1.0 — Android

Build 10.1.0 brings STRATA to Android. The STRATA Android app (repository `sugarhappy8/strata-fitness-android`) opens
this site like the iPhone app does and sells the same Strata+ through Google Play Billing. This release is the
website's side: it checks Google Play purchases, keeps one Strata+ across every way to pay, and adapts
app mode, Account, the policies, and the admin desk to Android.

The steps only the owner can take (the Play developer account, the subscription in the Play Console, the Google Cloud
service account, and Pub/Sub) are under [Upgrade notes](#upgrade-notes).

## What changed

### Strata+ through Google Play
- **The Android app sells the website's two plans.** One subscription, `online.stratafitness.app.plus`, with the base
  plans `monthly` ($4.99 USD a month) and `yearly` ($29.99 USD a year). The paywall offers the base plans Google Play
  returns, monthly first, with the yearly saving worked out from the local prices, and Google Play's own purchase
  sheet takes the payment.
- **STRATA checks every purchase with Google.** The app sends the purchase token to
  `POST /api/billing/google/purchases`. The server reads the subscription from the Google Play Developer API, checks
  that it is Strata+ for this app and that Google names the signed-in STRATA account (the app sets it as the purchase's
  obfuscated account id), stores Google's answer, and acknowledges the purchase, which Google requires within three
  days. A purchase that belongs to another account is refused, and one subscription can never unlock two accounts.
- **Renewals, cancellations, and refunds follow Google.** Google Play's real-time developer notifications arrive
  through Pub/Sub at `POST /api/billing/google/notifications`, protected by a secret token in the push URL. Each one
  only says which purchase changed, so the server asks Google again. Every 10 minutes it also re-reads subscriptions
  near their expiry, not yet acknowledged, or not checked for a day, so a missed notification or a failed
  acknowledgement is caught up.
- **Access follows Google's state.** Active, in the grace period, or cancelled but paid up: Strata+. On hold, paused,
  pending, or expired: no Strata+, and the paywall and Account say why. An active, auto-renewing subscription keeps
  access for two hours past the expiry STRATA last saw, so a renewal STRATA has not read yet never shows as a lapse.
- **One Strata+.** Paddle, Apple, Google Play, and owner grants are one entitlement. A member with Strata+ from Google
  Play is never offered Paddle's checkout (`ALREADY_ENTITLED_GOOGLE_PLAY`), and the app's paywall shows members where
  their Strata+ is billed (the App Store, Paddle, or Google Play) instead of a second purchase.
- **Test purchases** (Google Play's license testers) are stored like any purchase but unlock Strata+ in production
  only for the STRATA accounts in `GOOGLE_PLAY_TEST_ACCOUNTS`, as Sandbox purchases do for Apple.

### The website in the Android app
- The app shell tells the Android app from the iPhone app by the web view's user agent (both add `StrataApp/1`) and
  marks the page `data-app="android"`. App mode, its tab bar, and its styles apply to both apps.
- Android's web view does not save files a page makes itself, so in the Android app the data export and the plan,
  workout, and calendar files go to the share sheet (Drive, Files, email). Two workout export links that were clicked
  without being on the page now are, so they reach the share sheet too.

### Account, deletion, and the desk
- Account shows a Google Play subscription's plan, state, and renewal or end date, with **Manage subscription**, which
  opens Google Play's subscription page.
- The export lists Google Play subscriptions with their order id, plan, state, and dates, but never the purchase token.
- Deleting an account removes its Google Play records. The deletion confirmation, its email, and the delete-account
  page say that Google keeps billing until the member cancels in Google Play › Payments & subscriptions › Subscriptions.
- The admin Overview shows Google Play billing's status; a member's detail shows their Google Play subscription;
  Metrics counts Google Play subscriptions at the plan's price less Google's 15% service fee and leaves out
  `GOOGLE_PLAY_TEST_ACCOUNTS`.

### Policies
- Privacy describes what STRATA receives from and stores about Google Play purchases, and that the export leaves out
  the purchase token. Terms describe the Android subscription, renewals, cancelling, and that Google Play decides its
  refunds. Refunds has a section for Strata+ bought in the Android app. All three are dated 3 October 2026.

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 10.1.0.
2. **Database.** No migration: the server creates the `google_play_subscriptions` table at start, as it does for the
   other billing tables.
3. **Configuration.** Nothing is required to deploy: without a service account, the Google Play routes answer
   `503 GOOGLE_PLAY_NOT_CONFIGURED`, notifications are refused, and everything else works as before. To sell on
   Android, set in Render:
   - `GOOGLE_PLAY_SERVICE_ACCOUNT` (secret): the service account's JSON key;
   - `GOOGLE_PLAY_NOTIFICATION_TOKEN` (secret): 32 to 256 letters, digits, `-` or `_`;
   - `GOOGLE_PLAY_TEST_ACCOUNTS`: the Play review demo account's email and any testers'.

   `GOOGLE_PLAY_PACKAGE_NAME` and `GOOGLE_PLAY_PRODUCT_IDS` default to `online.stratafitness.app` and
   `online.stratafitness.app.plus` and are set in `render.yaml`.
4. **Google Play Console, Google Cloud, and Pub/Sub.** Create the subscription and its two base plans, the service
   account and its Play Console permissions, and the notification topic and push subscription:
   [google-play-billing.md](google-play-billing.md) has every step, and `docs/google-play.md` in
   `sugarhappy8/strata-fitness-android` takes the app from a developer account to a live listing.
5. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=10.1.0 npm run smoke:deploy`. Then:
   - the admin Overview shows Google Play billing (set up or not, as configured);
   - with notifications set up, **Send test notification** in the Play Console logs `google_play.notification` with
     outcome `test`;
   - in the Android app (installed from an internal testing link), a license tester's purchase unlocks Strata+ and
     Account says it is billed by Google Play.

## Validation

All of these pass:
- the format check, the release markers, and both architecture policies;
- strict types and lint;
- the Node suite with its coverage floors;
- the runtime smokes and the performance budgets;
- the browser journeys.

New and changed checks cover:
- the Google Play API client: service-account sign-in, reading a subscription, acknowledging, and Google's errors;
- verifying purchases: the product, the account Google names, a replaced purchase's owner, a purchase owned by another
  account, test purchases, every subscription state, the renewal margin, notifications with and without the token,
  and the background refresh, on local SQLite and the Turso adapter;
- the real server: a Google Play subscription unlocks Strata+ and refuses a second payment, an expired one does not,
  the routes' guards, the export without the token, and the deletion notice;
- the Android paywall: base plans, the purchase carrying the STRATA account, pending, cancelled, and refused
  purchases, Restore Purchases, test purchases, and members billed elsewhere;
- app mode on Android: the user-agent check, the purchase sync, purchase updates, and downloads to the share sheet;
- Account, pricing, offline access, the planner, and the admin desk with Google Play subscriptions.

The Android app has its own checks in its repository: JVM unit tests (links, the calendar event, Play prices and
periods, shared files, and the Capacitor fields it relies on), Android lint, and config tests for both apps.
