# Build 8.6 — Organized Strata+ destinations

Build 8.5 gave each Strata+ tool one home. Build 8.6 cleans up what those homes show: every destination now states each fact once, reads in the order people use it, and keeps every control legible. Calculations, stored data, and APIs are unchanged.

## What changed, by destination

| Destination | Before | Build 8.6 |
| --- | --- | --- |
| Progress | "Repeat improvements" and "Logged personal bests" listed the same records twice; a "Looking for calories?" card led the page with an unreadable button; volume read "kg·reps" without a comparison | One **Exercise records** list: latest result, change since the last comparable session, and best (with a "New best" badge). An eight-week **Workouts per week** chart, week-over-week volume change, a 2 × 2 summary on phones, and one always-visible link to Nutrition |
| Nutrition | Target cards and details sat outside the panel gutter; diary fields sat at three different heights; the seven-day view switched to a light panel and wrapped every calorie total; meal ideas repeated the remaining calories and a fixed serving sentence on every meal | Targets → today's intake (with a logged-vs-target meter) → **This week at a glance** (logged progress per day) → meal ideas → **Behind the numbers** (energy breakdown, calibration, goal comparison, weight scenarios, and sources). Fields align, meal ingredients fold behind an "Ingredients" disclosure, and "sized for what is left" becomes compact chips |
| Plan | The suggested week had two stacked headings, repeated "Choose the load so that about 2–3 controlled repetitions remain in reserve" under every exercise, stretched empty rest-day cards, and an unreadable "Edit personal setup" button. The weekly-plan card restated its three counts in a sentence | One heading with the setup action beside it; the shared load cue is stated once for the week; rest days stay compact; the weekly-plan card names the scheduled days instead of repeating its counts |
| Overview | "Need a different session?" above "Need a different workout?", a wrapped button arrow, a lowercase sentence start, a membership note shown to existing members, and a doubled divider | One heading per card, inline arrows, corrected sentence case, and a single divider |
| Personal setup | "Personal setup · used by Plan and Nutrition / A LITTLE ABOUT YOU" directly above "One setup · Plan and Nutrition / Build your personal profile" with a near-identical paragraph; a two-line body-fat label pushed its input out of line; "Discard edits" and the step kicker were unreadable | One intro that explains the four steps and that nothing changes until you save; sentence-case heading at the shared destination scale; aligned body-fat field; legible actions |
| Exercises | "Search 320   exercises" rendered the count as a spaced, monospaced label; the kicker still said "Explore" | Inline count and an "Exercises" kicker |
| Train | "Nothing scheduled." above "Nothing is scheduled for this day.", and a "Choose another day" button beside a field with the same label | "Recovery day." and a "Go to Monday →" style button naming the next planned day |
| Account | The next-workout eyebrow ("Tomorrow · Sep 28") was near-white on the lime card | Ink text with readable contrast |

## Fixes in detail

- **Consistency across daylight saving.** Progress floored the distance between Monday-noon timestamps, so in a week after a clock change the previous week's session collapsed into the current week and "Consistency" undercounted. Week distances now round, and a regression test pins a New York March transition.
- **Invisible buttons.** Small buttons defaulted to ink text on dark panels. A zero-specificity dark-surface rule now gives them the accent treatment without overriding established component styles. Small buttons also use `inline-flex`, so arrows no longer wrap onto their own line.
- **Contrast audit.** An axe `color-contrast` pass over every public, member, and Strata+ page (including each tool panel with disclosures open) at 1280 and 390 pixels now reports no violations. This found and fixed the weight-scenario cards (light text on a light card after moving to the dark evidence area), the Plan tool kickers (3.9:1), and the Account eyebrow.
- **Heading order.** Meal-option titles follow the section heading level, keeping the meal area free of axe violations.
- **Ranking rows.** Homepage ranking rows use a `div` with `role="listitem"` instead of an `article`, which does not allow that role.
- **Stylesheet order.** Strata+-only rules moved from the shared `site-experience.css` into `discover.css`, so Strata+ styles no longer depend on a later shared file. Superseded duplicate rules in the shared file were consolidated, restoring the intended phone sizes for the homepage and Train headings. Styles for components removed in 8.5 (the Progress calorie card and its light meal panel) were deleted.

## Data and release behavior

No database migration, server change, API change, billing change, or new asset is required. Coaching profiles, weekly snapshots, diary entries, workouts, and plans keep their existing formats and calculations. The public build and asset versions are `8.6.0` (Build 8.6), which refreshes the versioned service-worker cache so installed apps receive the new styles and scripts.

Releases now publish from the **Release** workflow. Running it on `main` tags the `package.json` version at that commit and uses the matching `docs/release-X.Y.Z.md` guide as the notes. Pushing a matching `vX.Y.Z` tag still works, and re-running for an existing release changes nothing.

## Validation

Local results on Node 24:

- `npm run release:check`, `npm run architecture:check`, `npm run typecheck`, and `npm run lint` pass.
- The Node suite passes 968 of 968 unit, integration, and contract tests, including new daylight-saving, exercise-record, and change-formatting cases. `npm run coverage` meets its floors at 95.15% lines, 83.56% branches, and 91.70% functions.
- `npm run qa:runtime` and `npm run performance` pass.
- 53 of 54 browser tests pass in Chromium, including the coaching, training, weight-progression, training-block, Strata+ state-matrix, session, activation, admin, navigation, responsive-content, high-risk, and Chromium accessibility journeys.
- Visual review covered every Strata+ destination at 1280 and 390 pixels with a seeded member (plan, seven completed workouts, coaching profile, and four diary days), plus the axe contrast and full WCAG passes described above.

This container provides an older Chromium build than the project's pinned Playwright expects and no Firefox or WebKit. The one local browser failure is the offline-workout journey, which fails identically on the unchanged 8.5.0 baseline here because this Chromium build does not apply offline emulation to service-worker requests from a newly opened page. The repository's CI installs the pinned Chromium, Firefox, and WebKit builds and runs the complete gate, including that journey and the three-engine accessibility matrix.
