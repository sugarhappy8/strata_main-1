# Build 9.8.0 — Investor pack

Build 9.8.0 is the third of the three releases before V1 in the 9.5 fix list. An investor decides on usage numbers
first and code second; the code was ready to be looked at, but the numbers and the story were not. This build adds a
metrics view to Admin, a demo account, and a short pack of documents, and corrects the policies where they no longer
matched the product. It also moves Strata+ from $2.99 a month to **$4.99 USD a month or $29.99 USD a year**.

## What changed

### Strata+ is $4.99 a month or $29.99 a year
- The pricing page offers two plans, monthly ($4.99 USD) and yearly ($29.99 USD, half the monthly price over a year).
  Monthly is chosen until the member picks yearly; the choice shows with the subscribe button and is fixed while
  checkout is open. A server without a yearly price shows monthly only.
- `POST /api/billing/checkout` takes `{ "plan": "monthly" | "yearly" }` (monthly when absent) and answers
  `400 PLAN_UNAVAILABLE` for any other plan. The server picks the price from its own configuration, never from the
  browser.
- `src/paddle-catalog.js` holds both plans. Checkout, recovery, webhooks, and entitlement accept only
  `PADDLE_PRICE_ID` at 499 minor units billed monthly and `PADDLE_YEARLY_PRICE_ID` at 2999 billed yearly, on
  `PADDLE_PRODUCT_ID`; a price on the wrong cycle, or a subscription whose item cycle differs from its own, grants
  nothing.
- Switching plans before paying switches off the unpaid checkout on the other plan. (Corrected in 9.8.1: an unpaid
  checkout open in another tab is switched off too; one that has been paid stops the new checkout instead.)
- Account and Pricing name the member's plan ("Your yearly subscription…"). The subscription summary has `plan`.
- Admin → Metrics counts a yearly subscription as $29.99 ÷ 12 of MRR (and after fees, Paddle's $0.50 is charged once a
  year), and adds Yearly subscriptions to Revenue now and the CSV.
- Terms §4, the refund policy (14 days after a monthly or yearly charge), the privacy policy, the account-deletion
  page, the homepage, and the investor pack state the new prices. The iOS app's terms paragraph says $4.99 a month; the
  App Store sells monthly only for now.
- The live Paddle account has both new prices on the Strata+ product (created for this build). It had no
  subscriptions, so no subscriber needed moving.

### Admin → Metrics
- A Metrics tab between Overview and People. Four cards (weekly active members in the last complete week, paying
  members, MRR, free-to-paid conversion) and five tables:
  - **Revenue now:** customer accounts, ever paid, paying members by Paddle and App Store, lifetime access, MRR at the
    list price and after Paddle's 5% + $0.50 or Apple's 15%, and yearly subscriptions.
  - **Weekly:** active members and sign-ups (email or Google) for the last 12 Monday weeks, the current one "so far".
  - **Cohorts:** for each sign-up week, activation within seven days and activity in week 4 and week 8.
  - **Monthly:** subscriptions paying at the start, new, ended, churn, and MRR at the end, for six months.
  - **Strata AI:** active Strata+ members, requests, tokens, and cost per member for three months.
- **Download CSV** saves the same figures as `strata-metrics-YYYY-MM-DD.csv`, one table per figure. It comes with the
  figures, so the download needs no second request, and it is dropped when the private view locks. Cells that could
  run as a spreadsheet formula are written as text.
- `GET /api/admin/metrics` (owner only, `no-store`) returns `{ metrics, csv }`. `src/metrics.js` computes every figure
  from plain rows and reads nothing itself; `src/admin-metrics.js` serves it; `src/metrics-store.js` reads the rows in
  one call on SQLite and Turso alike.
- An **active member** saved or logged something that week: started a workout, saved a week, logged nutrition, sent a
  check-in, or sent Strata AI a message. Signing in alone, and a Daily Brief STRATA wrote on its own, do not count.
- Customer accounts only: the owner, `APPLE_SANDBOX_ACCOUNTS`, and `STRATA_INTERNAL_ACCOUNTS` are left out, and the
  page says how many were. "How each figure is counted" on the tab and `docs/investor/metrics.md` give every
  definition, and what the numbers cannot say (where sign-ups came from is not recorded).

### Activation
- Migration `013-account-milestones` adds `account_milestones`: when an account first saved a **full week**, as many
  days with exercises as the training days it chose (four by default). A `plan.updated` reaction records it, keeping
  the earliest time, so a retried or late reaction never moves it.
- Weekly plans are stored only as the current week, so earlier full weeks cannot be reconstructed: activation counts
  accounts created after the migration ran, and the page says from when.
- The date is in the member's export (`dataLayer.firstFullWeekAt`) and is deleted with the account.

### Demo account
- `npm run demo:account -- --email <address> [--name <name>] [--yes]` creates a verified account with a four-day
  upper/lower week, four weeks of logged workouts with rising loads (one session missed), check-ins on every other
  session, and 28 sample Polar nights with one poor night. It writes through the store and the same event reactions
  the server runs, so the Training Log, Daily Snapshots, and plan history fill in.
- It only creates a new account and refuses the owner's email, an email that already has an account, or one not in
  `STRATA_INTERNAL_ACCOUNTS`. Writing to Turso needs `--yes`. The password comes from `STRATA_DEMO_PASSWORD` or is
  generated and shown once. It never grants Strata+; the owner does that in Admin → People.
- The sample Polar connection's next sync is a year away, so the sync loop never calls Polar for it. Without
  `DEVICE_TOKEN_KEY` there are no nights.
- The stored password hash comes from `hashPassword` in `src/auth.js`, now shared with the script.

### The investor pack
`docs/investor/`: a one-page overview; the metrics sheet with definitions and the pricing maths (what $4.99 monthly
and $29.99 yearly keep after fees, against the old $2.99); a technical one-pager; a
runbook for rolling back, rotating every key, and restoring the database; the roadmap to V1 with what Build 9 cut and
why and the open decisions; the demo, recording, TestFlight, and live-site guide; and answers to prepare for
investors' questions.

### Policies checked against the product
- **Privacy, Providers:** the Strata AI paragraph said the model runs on a STRATA-operated computer reached through a
  tunnel provider and that requests are never written to the database. Strata AI runs on Groq (as the Strata AI
  section says), and since 9.4 a request waits in the database until it is answered and an answer is kept up to 10
  minutes. The paragraph's list of what the summary contains now matches the Strata AI section.
- **Privacy, Connected devices:** said Polar data is never sent to Strata AI. The Strata AI section and the code
  include the last few nights of sleep, recovery, and heart-rate readings in the summary for a member who has allowed
  Strata AI. The section now says so.
- **Privacy:** describes the Metrics view and the full-week date.
- **Refunds:** a new section says App Store purchases are refunded by Apple at reportaproblem.apple.com, as the
  terms already did.
- **Terms:** §4 states the two plans; otherwise unchanged.
- **README:** its Strata AI storage line is corrected like the privacy policy.

## Upgrade notes

1. **Before deploying — the price.** 9.8.0 sells only the new prices; on the old $2.99 price its checkout stays closed.
   In Render set `PADDLE_PRICE_ID` to the $4.99 monthly price and `PADDLE_YEARLY_PRICE_ID` to the $29.99 yearly price
   (both on the existing Strata+ product), and in App Store Connect set the Strata+ Monthly price to $4.99. Run
   `npm run preflight:production` with the production settings. Keep the old $2.99 price active in Paddle until 9.8.0 has run
   cleanly, so a rollback can use it (`docs/investor/runbook.md`), then archive it.
2. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 9.8.0.
3. **Database.** Migration `013-account-milestones` adds one table and a delete trigger. It is additive; 9.7.0 runs on
   the migrated database unchanged. Back up Turso before deploying, as for any migration.
4. **Configuration (optional).** `STRATA_INTERNAL_ACCOUNTS` (comma-separated emails left out of Metrics; the demo
   script requires its address here) and `STRATA_AI_USD_PER_MILLION_TOKENS` (prices Strata AI tokens). Both are in
   `render.yaml` as `sync: false`.
5. **Members.** New members see the two plans. Polar members who also use Strata AI may want to know the policy now describes what
   the AI summary already contained.
6. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.8.0 npm run smoke:deploy`, then open Admin →
   Metrics, create the demo account (`docs/investor/demo.md`), and grant it Strata+. Open `/pricing` signed in and
   check both plans show; start a yearly checkout and confirm Paddle shows $29.99 a year, then close it.

## Validation

The format check, release markers, both architecture policies, strict types, lint, the Node suite with coverage
floors, runtime smokes, the performance budgets, and the browser journeys pass. New checks cover a yearly checkout
end to end (Paddle bills $29.99 a year, the subscription entitles, Account names the plan), switching plans before
paying, a yearly price that is invalid or equals the monthly one keeping checkout off, a wrong cycle or amount on
either plan, the plan chooser, MRR from mixed monthly and yearly subscriptions, and every figure against
a hand-worked month (activation windows, retention windows, churn, MRR after fees, AI cost), the CSV and its formula
guard, the same rows from SQLite and Turso, migration 013 and its delete trigger, the earliest-full-week rule and the
default target, internal accounts left out of every figure, the owner-only route end to end from a saved plan, the
Metrics tab's loading, download, stale-response, and purge behaviour, and the demo account's data and its refusals.
