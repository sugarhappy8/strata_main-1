# Build 8.9.0 — Subscription-only Strata+ and a simpler studio

Build 8.9.0 retires the free Strata+ trial, gathers Plan, Train, and Nutrition into the Strata+ Overview, moves Strata AI from the homepage into a bubble that stays on every Strata+ view, tightens the pricing copy, and removes training progress from Account.

## What changed

### No free trial

- Strata+ is offered only as the $2.99 USD monthly subscription. The pricing page, homepage, Account, Terms, and Privacy Policy no longer offer or describe a free trial.
- `POST /api/discovery/trial` now answers `410` with code `TRIAL_RETIRED`, so an installed app from an earlier build gets a clear message instead of a new trial. The store no longer has a way to create a trial row, and `/api/me` reports `trial.eligible:false` for every account.
- A trial started before this build keeps its recorded end (bounded by the old seven-day maximum) and can subscribe early from Pricing. Account labels it as a trial with the time remaining.

### Strata AI bubble

- The homepage no longer has a Strata AI section or Strata AI copy.
- Every Strata+ view shows a small speech bubble marked “AI” in the bottom-right corner. Hovering it, or focusing it with the keyboard, explains that it is Strata AI and that pressing it opens Strata AI to plan your week. It sits above the mobile navigation and the exercise-comparison tray, and is hidden when printing.
- The Overview’s existing “Ask Strata AI to plan” action is unchanged.

### Overview holds Plan, Train, and Nutrition

- The Strata+ destination tabs are now Overview, Recovery, Progress, and Exercises.
- Overview keeps everything it showed before and adds three cards below it. Plan and Nutrition open their full views, each with “Back to Overview”; Train opens the Train page. The Plan card summarizes the saved week.
- Plan, Nutrition, and the tools inside them (session builder, monthly schedule, shared plans, personal setup) keep Overview highlighted. Existing links such as `/discover.html#nutritionWorkspace` still open the right view.

### Pricing without repetition

- Each fact now appears once: price, renewal, and cancellation in the hero; Strata+ benefits on the price card; payment, tax, and refund details in one checkout note; and the free core on the free card.
- The duplicate “How the trial and subscription work”, “Compare Free and Strata+”, and “Subscription assurances” sections are gone, along with their styles.

### Account without progress

- Account no longer shows the Weekly progress, Recent momentum, or Training signal cards. Progress lives in Strata+ Progress. Account keeps the next planned workout, access, billing, connected devices, data controls, and security.

## Upgrade notes

- No configuration or migration changes. Existing `discovery_trials` rows stay in place for running trials, account export, and owner analytics.
- Tests now unlock Strata+ with `test/support/strata-plus-access.js`, which writes a complimentary grant to the test database. `npm run qa:ui` needs `STRATA_QA_DATA_DIR` pointed at the running server’s data directory.

## Validation

Release validation covers the full Node test suite, architecture policy, strict type checking, lint, coverage thresholds, runtime QA, performance checks, and the browser journeys, including new checks for the AI bubble, the Overview cards and their navigation, the retired trial route, the pricing copy, and the Account page.
