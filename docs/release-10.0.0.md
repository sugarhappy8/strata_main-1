# Build 10.0.0 — V1

Build 10.0.0 is V1: the website and the iOS app are one system. Strata+ is the same two plans however it is bought,
the app's tabs are the website's navigation, and both use the same brand mark, buttons, and headline type. A mistyped
address now opens a STRATA page with the navigation instead of a bare error.

It is the code side of V1. The steps only the owner can take (the Strata+ Yearly product in App Store Connect, App
Review, and a real Polar account) are listed under [Upgrade notes](#upgrade-notes) and in the
[roadmap](investor/roadmap.md).

## What changed

### One Strata+, on the web and in the app
- **The App Store sells the website's two plans.** Strata+ Monthly at $4.99 USD a month
  (`online.stratafitness.app.plus.monthly`) and Strata+ Yearly at $29.99 USD a year
  (`online.stratafitness.app.plus.yearly`). Before, the app sold only the monthly plan.
- **The paywall offers a choice.** The app's paywall asks "Choose a plan" and lists Monthly, then Yearly, at the
  prices and periods the App Store gives for the member's storefront. Yearly shows its saving against twelve monthly
  payments ("save 50%" in the US). The saving is worked out from the storefront's own prices, and it is left out if the
  two prices are in different currencies or the saving is under 5%. The auto-renewal terms and Subscribe follow the
  chosen plan. If the App Store returns only one plan (before Strata+ Yearly exists in App Store Connect), the paywall
  shows that plan's price, as before.
- **STRATA knows which plan an App Store subscription is.** `APPLE_IAP_PRODUCT_IDS` accepts both products by default,
  and a product ending in `.yearly` is the yearly plan. Account says "Yearly · App Store · renews …" or "Monthly · …",
  and its messages name the plan. Admin → Metrics counts an App Store yearly subscription at $29.99 ÷ 12 a month, the
  same as a Paddle one; before, every App Store subscription counted as monthly. The account summary carries the plan
  as `plan`.
- **The app never sells a second subscription.** The website's pricing page refuses a new checkout when the owner has
  turned off new payment sessions for the account, or when the member's Strata+ subscription is paused. The paywall
  now does the same and says why. Before, it still opened the App Store purchase sheet in both cases.
- The terms say how the App Store plans renew: each month or each year, matching the plan chosen. The terms, the
  privacy policy, and STRATA's emails name the App Store's current path for managing a subscription: Settings ›
  Apple Account › Subscriptions.

### One navigation
- **The app's tabs follow who is signed in, as the website's navigation does.**
  - A visitor sees Rankings, Plan, Strata+, and Sign in.
  - A member sees Rankings, Plan, Train, Recovery, and Profile.
  - A Strata+ member sees Rankings, Dashboard, Train, Recovery, and Profile.

  Before, everyone saw the Strata+ member's five tabs, so a visitor's Dashboard, Train, and Recovery tabs opened pages
  that needed an account or Strata+. The weekly plan is the Plan tab, except for Strata+ members, who reach it from
  Dashboard. Strata+ is a visitor's own tab. For a member, it belongs to the tab that led to it: Recovery, Train, or
  Strata AI.
- Every tab has an icon. A new test fails if any tab, for any of the three audiences, draws without one.
- In the app, the forgot-password and reset-password screens are titled as the website titles them: "Forgot
  password" and "Reset password". Before, they were "Reset password" and "New password".

### One look
- **The app uses the website's brand.** The app's welcome screen and the offline workout page draw the same wordmark
  and mark as every website page: three ascending bars, as in the app icon, in the accent colour.
- **Buttons are pills everywhere.** The app's buttons and its delete-account dialog use the website's pill shape.
  Headlines use the website's display weight and tracking.
- The app's plan choice matches the pricing page's: one selectable card per plan, with the chosen card outlined in the
  accent colour.
- The Install page no longer says there is no App Store download, now that there is an iOS app. It says the browser
  adds STRATA to the Home Screen with nothing to download.

### A page for wrong addresses
- A browser that follows an address STRATA does not have now gets a "Page not found" page with a 404 status. It has the
  navigation, a way back to STRATA, and Contact support, and in the app it shows the tab bar. Scripts, tools, and
  `/api/` routes still get JSON. The page is `noindex` and never cached.

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 10.0.0.
2. **Database.** No migration.
3. **Configuration.** In Render, set `APPLE_IAP_PRODUCT_IDS` to
   `online.stratafitness.app.plus.monthly,online.stratafitness.app.plus.yearly`, as `render.yaml` now does. A value
   that lists only the monthly product rejects yearly purchases. Set it rather than deleting it: 10.0.0's default
   lists both products, but 9.8.x's lists only monthly, so after a rollback a yearly subscriber would lose Strata+.
   Nothing else changes.
4. **App Store Connect.** In the `Strata+` subscription group, create the auto-renewable subscription
   `online.stratafitness.app.plus.yearly` on the same level as the monthly plan: duration 1 year, price $29.99 USD. Add
   its display name, description, and review screenshot, and submit it with the next app version.
   [apple-in-app-purchase.md](apple-in-app-purchase.md) has every step. Until it is approved, the paywall shows only
   the monthly plan. The iOS repository's StoreKit configuration has both plans for local testing.
5. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=10.0.0 npm run smoke:deploy`. Then:
   - In a browser, open a page that does not exist (for example `/nothing-here`): it shows "Page not found".
   - In the app, open Strata+ signed out: the tabs read Rankings, Plan, Strata+, and Sign in, and the paywall offers
     both plans once Strata+ Yearly is live.

## Validation

All of these pass:
- the format check, the release markers, and both architecture policies;
- strict types and lint;
- the Node suite with its coverage floors;
- the runtime smokes and the performance budgets;
- the browser journeys.

New and changed checks cover:
- the two-plan paywall: order, savings, a single-plan storefront, the chosen product bought, and refusals for an
  account with new purchases turned off or a paused subscription;
- the yearly App Store plan in the account summary, Account, and Metrics;
- the tabs for each audience, each with an icon;
- the 404 page for browsers and JSON for everything else.

The iOS browser journey buys Strata+ Yearly through a StoreKit stand-in. The new screens were checked on an iPhone-sized
browser, as the website and as the app.
