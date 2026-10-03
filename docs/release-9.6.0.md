# Build 9.6.0 — Fix list

Build 9.6.0 works through the first eight items of the 9.5 fix list. It adds no features. It closes two gaps in the App
Store purchase flow, makes the HTML escaper impossible to bypass by accident, removes checkout code for prices STRATA
no longer sells, and drops data and a route that only existed for retired features.

## What changed

### App Store purchases
- The paywall says "Welcome to Strata+" only when STRATA reports that the purchase unlocked it. A purchase STRATA saved
  but did not unlock gets a plain warning and the account is refreshed. An App Store test (Sandbox) purchase is told
  that test purchases do not unlock Strata+, at purchase and at Restore Purchases.
- An address in `APPLE_SANDBOX_ACCOUNTS` unlocks Strata+ with a Sandbox purchase only after that STRATA account has
  verified its email. The check is in both the SQL and `appleRowActive`, so someone who signs up with the review
  address but cannot open its mailbox gets nothing.

### One way to put markup on the page
- `html` in `public/scripts/html.js` returns trusted markup, a frozen object, instead of a string. Trusted markup put
  into another `html` template goes in unchanged, and a list of it is joined, so a template nested inside another is
  escaped exactly once. `StrataHtml.join(items, separator)` joins with a separator.
- `setHtml`, `insertHtml`, and `replaceHtml` take only trusted markup (or a list of it). A plain string, `""`, `null`,
  or a number is refused with a `TypeError`, so text built by hand can no longer reach `innerHTML`. Elements are
  cleared with `textContent`.
- Every hand-built template in 37 browser modules now uses `html`, and the hand-written `esc()` / `escapeHtml()` calls
  are gone. Some values were never escaped before and now are: exercise video and source links, IDs in `data-*`
  attributes, class names, and chart and recovery-stage SVG attributes. Ordinary output is unchanged.
- `raw()` is used twice, both for markup read back from the page: the Strata+ benefit list the App Store paywall
  reuses, and a rating button's own label restored after saving.
- ESLint now rejects, in `public/`: a plain template or string that holds a tag, an entity, or an attribute fragment;
  `StrataHtml.escape`; `.map(...).join(...)` over `html` results; and an `html` result inside a plain template or `+`.
  Each converted module has a test that renders a member's text containing `<`, `&`, and `"` through the real page
  code and checks it is escaped once.

### Old checkout code removed
- `src/legacy-checkout.js` is deleted. The checks the current $2.99 plan relies on (the exact 299-minor-unit USD price,
  the recorded catalog, cancellation validation) moved into `src/checkout-reconciliation.js`.
- The earlier-monthly-price allowlist is gone: `PADDLE_LEGACY_RECURRING_PRICE_IDS`, its preflight check, and catalog
  migration of subscriptions. STRATA entitles only `PADDLE_PRICE_ID` on `PADDLE_PRODUCT_ID`.
- The Build 7.4 one-time checkout paths are gone: migrating abandoned 7.4 drafts and recording a late 7.4 completion
  as lifetime access. A late 7.4 completion is now refused like any unknown catalog. Completed one-time purchases keep
  their lifetime access, which never depended on this code.
- Kept: switching off abandoned drafts at Paddle (account deletion and admin close/delete use it for current drafts),
  the account-deletion billing checks, refunds, and lifetime access.
- An abandoned checkout on any price other than the current one is now switched off when the member starts a new
  checkout, after it is checked against the price and product STRATA recorded for it. Before, it made checkout fail
  with `503 PURCHASE_RECONCILIATION_INVALID` until support stepped in.

### Retired data and routes
- `POST /api/discovery/trial`, which answered `410 TRIAL_RETIRED` since 8.9.0, is removed and answers `404`.
- Migration `011-drop-build9-archives` drops `archive_discovery_trials` and `archive_community_weekly_plans`, which 9.0.0
  kept so the cut could be rolled back.
- Migration `012-close-build7-checkouts` marks any unfinished checkout on the retired 7.4 one-time price canceled and
  revoked, and deletes its checkout claim, so it cannot block account deletion or a new checkout. With none it changes
  nothing.

### Strict route IDs
- An API path parameter must be 1–200 letters, digits, `_`, or `-`, which every STRATA ID, date, and slug already is.
  It is matched against the raw path and never decoded, so `%2F` can no longer become `/` inside an ID, and `..`, `%00`,
  or a space cannot reach a handler. Such a path answers `404 API route not found.`

## Not in this build
- **Testing Polar sync with a real Polar account (item 9).** It needs a real Polar account and is still to do.
- **Discover's imports as real ES modules (item 10).** The list defers it until after V1.

## Upgrade notes

1. **Back up the database first.** Migration `011` deletes the Build 9 archive tables, and after it the 9.0.0 rollback
   (renaming the archives back) is no longer possible. Migrations `011` and `012` run on start.
2. **Configuration.** `PADDLE_LEGACY_RECURRING_PRICE_IDS` is no longer read; delete it from the deployment. Before
   moving to another price in future, migrate every subscriber to it in Paddle first (see `docs/deployment.md`). The
   App Review account in `APPLE_SANDBOX_ACCOUNTS` must verify its email in STRATA before its Sandbox purchase unlocks
   Strata+.
3. **API.** `POST /api/discovery/trial` answers `404`. A path whose ID contains anything but letters, digits, `_`, or `-`
   answers `404`.
4. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 9.6.0.
5. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.6.0 npm run smoke:deploy`.

## Validation

The format check, release markers, both architecture policies, strict types, lint, the Node suite with coverage
floors, runtime smokes, the performance budgets, and the browser journeys pass. During the `html` change, a temporary
audit hook recorded every plain string that looked like markup when `html` escaped it, across the whole Node suite and
every browser journey. It found only the hostile text the tests feed in on purpose.
