# Build 8.9.0 — Subscription-only Strata+ and a simpler studio

Build 8.9.0 retires the free Strata+ trial, gathers Plan, Train, and Nutrition into the Strata+ Overview, moves Strata AI from the homepage into a Strata AI chat on every Strata+ view, tightens the pricing copy, and removes training progress from Account. It is also the first build to carry its own version number everywhere: the earlier 8.9.0 changes went out under the Build 8.8.8 asset versions, so installed apps kept the 8.8.8 stylesheet and showed the new Overview cards and Strata AI button unstyled.

## What changed

### No free trial

- Strata+ is offered only as the $2.99 USD monthly subscription. The pricing page, homepage, Account, Terms, and Privacy Policy no longer offer or describe a free trial.
- `POST /api/discovery/trial` now answers `410` with code `TRIAL_RETIRED`, so an installed app from an earlier build gets a clear message instead of a new trial. The store no longer has a way to create a trial row, and `/api/me` reports `trial.eligible:false` for every account.
- A trial started before this build keeps its recorded end (bounded by the old seven-day maximum) and can subscribe early from Pricing. Account labels it as a trial with the time remaining.

### Strata AI chat

- The homepage no longer has a Strata AI section or Strata AI copy.
- Every Strata+ view shows a round Strata AI launcher in the bottom-right corner. It glows and pulses on a slow 2.8-second beat (a steady glow when the device asks for reduced motion), and hovering it or focusing it with the keyboard shows “Strata AI chat”. On touch screens a tap opens the chat straight away.
- The launcher opens a small chat panel: ask a question, use a suggested request or “Review my plan”, and apply a proposed week, nutrition targets, or an exercise swap from inside the chat. Applying a week refreshes the Overview and Plan on the same page, and replacing a saved plan still asks first. On phones and short screens the chat fills the visible screen and follows the on-screen keyboard.
- Nothing is requested until the chat is first opened. The chat and the full Strata AI page share one conversation in the browser tab, so “Open full screen” (or `/ai`) continues it, including an answer still on its way. A reply that arrives while the chat is closed marks the launcher.
- The Overview’s “Ask Strata AI to plan” opens the same chat; it still links to `/ai` for a modified click or without JavaScript. The launcher sits above the mobile navigation and the exercise-comparison tray, and is hidden when printing.

### Overview holds Plan, Train, and Nutrition

- The Strata+ destination tabs are now Overview, Recovery, Progress, and Exercises.
- Overview keeps everything it showed before and adds three cards below it. Plan and Nutrition open their full views, each with “Back to Overview”; Train opens the Train page. The Plan card summarizes the saved week.
- Plan, Nutrition, and the tools inside them (session builder, monthly schedule, shared plans, personal setup) keep Overview highlighted. Existing links such as `/discover.html#nutritionWorkspace` still open the right view.
- Opening a view moves focus to its heading on the next frame, unless focus has already moved to something else by then. Before, a card focused right after returning to Overview could lose focus to the Overview heading, so Enter did nothing.

### Pricing without repetition

- Each fact now appears once: price, renewal, and cancellation in the hero; Strata+ benefits on the price card; payment, tax, and refund details in one checkout note; and the free core on the free card.
- The duplicate “How the trial and subscription work”, “Compare Free and Strata+”, and “Subscription assurances” sections are gone, along with their styles.

### Account without progress

- Account no longer shows the Weekly progress, Recent momentum, or Training signal cards. Progress lives in Strata+ Progress. Account keeps the next planned workout, access, billing, connected devices, data controls, and security.

## Upgrade notes

- Every asset URL and the service-worker cache name advance to 8.9.0, so installed apps fetch the new stylesheets on their next visit. `npm run release:check` now also fails when the newest `CHANGELOG.md` entry names a build that the version markers do not carry.
- No configuration or migration changes. Existing `discovery_trials` rows stay in place for running trials, account export, and owner analytics.
- Tests now unlock Strata+ with `test/support/strata-plus-access.js`, which writes a complimentary grant to the test database. `npm run qa:ui` needs `STRATA_QA_DATA_DIR` pointed at the running server’s data directory.

## Validation

Release validation covers the full Node test suite, architecture policy, strict type checking, lint, coverage thresholds, runtime QA, performance checks, and the browser journeys, including new checks for the Strata AI chat (launcher label, glow, panel, phone layout, focus, and applying a week from it), the shared conversation engine, the Overview cards and their navigation, the retired trial route, the pricing copy, and the Account page.
