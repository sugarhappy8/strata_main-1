# Build 9.2.0 — The STRATA iOS app

Build 9.2.0 is the website and server half of the STRATA iOS app. The app (repository `sugarhappy8/strata-fitness-ios`)
shows this site; when the site sees the app's `StrataApp/<n>` user agent it switches to an app mode. Browsers are
unchanged, and Paddle on the website is unchanged.

## What changed

### App mode (inside the iOS app only)
- One tab bar (Rankings, Dashboard, Train, Recovery, Profile) and a top bar with back navigation on every page; no
  website chrome or Install links; a welcome screen for signed-out people, and members open on Dashboard.
- Transitions and press feedback use only transform and opacity, and respect reduced motion.
- Native extras, each skipped by older app builds and browsers: haptics, the screen kept on during a workout, a
  "Rest is over" notification, Add to Calendar through iOS's New Event sheet, AirPrint, and downloads handed to the
  share sheet.

### Strata+ through Apple In-App Purchase
- `/pricing` in the app is an Apple paywall (price from StoreKit, renewal terms, Terms, Privacy, Apple's EULA,
  Restore Purchases, Manage subscription). Paddle is never loaded in the app.
- `POST /api/billing/apple/transactions` and `POST /api/billing/apple/notifications` verify Apple's signed data and keep
  one App Store subscription per STRATA account. See [Apple In-App Purchase](apple-in-app-purchase.md).
- Strata+ is one entitlement: Paddle, App Store, or an admin grant. Account, pricing, admin, export, Privacy, and Terms
  cover App Store billing.

### Accounts
- Deletion completes inside the app with the password and DELETE (`POST /api/account/delete/now`); browsers keep the
  emailed link. App Store subscribers are told Apple keeps billing until they cancel.
- Sessions in the app renew while in use, up to 60 days.
- Daily Snapshots and the Training Log use the member's own time zone for "today".

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 9.2.0.
2. **No new settings.** `APPLE_BUNDLE_ID` and `APPLE_IAP_PRODUCT_IDS` default to the app's IDs. The App Store tables
   are created when the server starts.
3. **App Store Connect.** Point both App Store Server Notification URLs (Version 2) at
   `https://stratafitness.online/api/billing/apple/notifications`.
4. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.2.0 npm run smoke:deploy`, then open the site in a
   browser (unchanged) and in a TestFlight build of the app.

## Validation

The Node suite with coverage floors, release markers, architecture policy, strict types, lint, runtime smokes, the
performance budgets, and the browser journeys pass, including the app-mode journeys. The iOS app builds and loads the
site in the iOS simulator in the iOS repository's CI.
