# Build 8.7 — Clear calorie math and a calmer STRATA

Build 8.7.0 makes Nutrition's numbers checkable, adds five small features that save time every day, and gives every page one consistent design. The energy formulas were already sound (Mifflin–St Jeor resting energy, net session METs, 7,700 kcal per kilogram, exact weekly totals, and 4/4/9 macros), but the page did not show them, and some of the numbers it did show looked wrong. This build fixes what members could see.

## Calorie math you can check

| Before | Build 8.7.0 |
| --- | --- |
| The target was a range such as 2,437–2,595 kcal/day with no visible link to maintenance, and the deficit sat inside a details panel | The target reads "2,750 maintenance − 225 deficit = 2,525 kcal/day" (or "+ surplus"), followed by "Training days 2,585 · Rest days 2,445" |
| Identical rest days read 2,437 and 2,438 and training days 2,586 and 2,595, because each generated session kept its own few-kcal estimate and integer remainders landed on single days | Zigzag splits the week's session energy evenly across training days. Days of the same kind share one target in multiples of 5 kcal, and the seven days still add up to exactly seven times the average. Across every supported pattern, each day stays within 15 kcal of its exact share |
| Maintenance was one number with a planning range | See calculation lists resting energy × the movement factor, planned workouts per week ÷ 7, any other activity, the estimated daily expenditure, the rounding to 25 kcal, and any calibration, in whole-calorie rows that add up on screen |
| Logged protein, carbs, and fat never had to match logged calories, so "calories left" and "macros left" could disagree without explanation | The diary shows what the macros add up to (4 kcal per gram of protein or carbohydrate, 9 per gram of fat), flags a gap from the calories entered, and offers the macro total with one tap. Meal ideas explain any remaining gap |
| Weights and heights were stored to 0.1, so 180 lb read back as 179.9 lb | Profile weight, height, known loads, and morning weights keep two decimals, so every 0.1 lb and 0.01 in entry reads back as typed |

Week generation is now `coaching-week-v7`. Saved weeks keep their numbers until the next weekly snapshot or an explicit refresh.

## New features

- **Quick add.** Enter the calories in a meal or snack, or tap +100, +250, or +500. STRATA adds it to the day's running total and saves in one step. Values outside 1–5,000 kcal are refused without saving.
- **Copy previous day.** Fills the diary form from the day before (calories, and macros when tracked) and leaves the decision to save with you.
- **Logging streak.** Counts consecutive logged days ending today or yesterday, and reminds you to log today when the streak would otherwise end.
- **Weight trend.** Morning weights appear as dots with a seven-day average line, the weekly change from a least-squares fit over the last 14 days once four weigh-ins span at least a week, and a hidden data table for screen readers. The chart is drawn at its own width, so labels stay legible on phones and wide screens.
- **Calendar reminders on Train.** Download one calendar file with a weekly repeating event for every planned training day, at a time you choose, with an optional reminder 15, 30, or 60 minutes before. Each weekday keeps the same event identity, so importing a new file after a plan change updates the earlier events in calendar apps that support event updates.

## One design across every page

- **Type.** Every heading, label, navigation link, and button uses one type family in sentence case. All-capital headlines and monospace labels are gone, display headings leave room for descenders, and text is at least 11px everywhere except one decorative bullet and a miniature illustration.
- **Color.** Lime stays the accent on dark surfaces; an olive accent with at least 5.2:1 contrast replaces the red accent on light surfaces. Red now appears only for errors, warnings, and destructive actions, and every focus ring uses one mid-olive that keeps at least 3:1 contrast on light, dark, and lime backgrounds.
- **Components.** Actions are pill-shaped with consistent label sizes, header account actions match across the product pages, and section labels no longer carry "01 /" numbering.
- **Homepage.** The ranking shows the ten best matches first, with a "Show all" button for the rest, which makes the homepage about 30% shorter.

## Data and release behavior

No database migration, API change, billing change, or stored-data format change is required. Existing profile values keep their saved precision; new entries keep two decimals. `public/scripts/discover-coaching-trend.js` is the only new browser file, and the server and service worker list it. The public build and asset versions are `8.7.0`, which refreshes the versioned service-worker cache so installed apps receive the new scripts and styles.

## Validation

Local results on Node 24:

- `npm run release:check`, `npm run architecture:check`, `npm run typecheck`, and `npm run lint` pass.
- The Node suite passes 986 of 986 unit, integration, and contract tests. New cases cover the daily-target distribution (for every supported combination of day weights: an exact weekly total, one target per kind of day, multiples of 5 kcal, and at most 15 kcal from each day's exact share), the maintenance steps and target summary, macro reconciliation, pound and inch round trips, quick add, copy previous day, the streak, the weight trend and its chart sizing, the weekly calendar file including RFC 5545 line folding, and the homepage's top-ten ranking. `npm run coverage` meets its floors at 95.18% lines, 83.72% branches, and 91.77% functions.
- `npm run qa:runtime` and `npm run performance` pass. The workout runtime smoke now checks the calendar reminder wiring.
- Browser coverage: the coaching journey opens See calculation and checks that the maintenance rows add up, then uses quick add, the +100 button, an invalid entry, and copy previous day against the real server. The training journey sets a reminder time and checks the downloaded calendar file. The accessibility matrix, including its axe contrast audit, passes with the new colors.
- A computed-style sweep of every public and signed-in page found no visible text outside Manrope except the raw local-signals summary, which intentionally keeps a monospace face.
- Payment test fixtures now wait for the checkout claim that the server releases just after its 201 response. With a 150 ms delay injected before that release, the five affected tests failed before this change and pass after it.
- 54 of 55 browser tests pass in Chromium. The one local failure is the service-worker offline step documented for 8.6.1: this container's older Chromium does not apply offline emulation to a newly opened page. CI installs the pinned Chromium, Firefox, and WebKit builds and runs the complete gate.
