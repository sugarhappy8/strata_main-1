# Build 9.8.1 — Final checks

Build 9.8.1 fixes what a final check of 9.8.0 found before the push for V1: a review of every 9.8.0 change, and the
live site loaded on a phone in the browser and as the iOS app. It changes no prices and adds no features.

## What changed

### Checkout
- **An interrupted yearly checkout can be recovered.** When Paddle created a yearly checkout but its answer was lost
  (a timeout or a malformed response), the retry checked the recovered checkout against the monthly price and refused
  it ("contact support"), every time. The recovered checkout is now checked against the price STRATA recorded when it
  began, and a checkout validator without a recorded price accepts any current plan instead of assuming monthly.
- **Choosing the other plan never reopens the first.** After an interrupted monthly checkout, choosing yearly
  reopened the monthly checkout while the page said yearly. An interrupted checkout is now reused only for the plan the
  member chose; one on the other plan is switched off, and the chosen plan's checkout opens. If that first checkout
  has been paid by then, switching it off fails and the new checkout does not open, so nobody pays for both plans.
- Messages for yearly subscribers no longer say "monthly": the access check, the account-deletion block, and the
  subscription lookup.

### Admin and metrics
- **Earlier active days stay counted.** Plan history kept only a member's latest 50 saves, and the planner saves on
  every edit, so a member's earlier active days could vanish and week-4 and week-8 retention could fall after the fact.
  Plan history now also keeps the latest save of each day for 120 days, longer than any window the metrics read. A
  nutrition entry counts on the day it is for as well as the day it was last changed (an edit overwrites the latter).
- **Retention waits for the week to end.** An account counted as eligible for week 4 or week 8 on that week's last day,
  while the day was still running.
- **Strata AI months are whole.** Usage is kept 90 days, so near a month's end the oldest of three months was missing
  its first days. A month is now shown only while every day of it is kept.
- **Yearly renewals.** Admin → Overview counted every yearly subscription as "Renewed period" from its first day. A
  subscription on the yearly price now counts once its period runs past its first year.
- The full-week reaction counts training days as the planner does and skips the profile read for a week with no
  training days or an account already recorded. `STRATA_INTERNAL_ACCOUNTS` is read the same way sign-in reads an email.
- `npm run demo:account` asks for `--yes` before it connects to Turso. Connecting runs the schema migrations, so the
  refusal used to come after a write.

### The live site
- **A clean console on Pricing.** Paddle.js loads its overlay stylesheet from Paddle's CDN, which the content policy
  blocked; `style-src` now allows `https://cdn.paddle.com`, the origin Paddle.js itself comes from. Paddle.js also
  starts Paddle Retain (ProfitWell) for every live checkout; STRATA does not use Retain and blocks that script, so the
  page now tells Paddle.js Retain is already loaded and no request is made.
- `/account` and `/workout` open the account and workout pages; they returned 404. The workout page still needs
  sign-in and Strata+.

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 9.8.1.
2. **Database.** No migration. Plan history keeps a few more rows per member (at most one per day for 120 days).
3. **Configuration.** None.
4. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.8.1 npm run smoke:deploy`, then open `/pricing`
   with the browser console open and check it stays clean.

## Validation

The format check, release markers, both architecture policies, strict types, lint, the Node suite with coverage
floors, runtime smokes, the performance budgets, and the browser journeys pass. New checks reproduce each bug first:
an interrupted yearly checkout recovered as yearly (503 before), an interrupted monthly checkout switched off when the
member chooses yearly (reopened before), plan history and nutrition logs keeping earlier active days on SQLite and
Turso, retention eligibility on the last day of the window, the Strata AI months at the end of a month, a yearly
subscription's renewal, the demo script's refusal before any connection, Paddle Retain never starting, and the
`/account` and `/workout` addresses.
