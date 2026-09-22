# Build 8.5 — Clear destinations, one home for each tool

Strata+ previously repeated its calorie diary and meal suggestions in Progress and Personal Training, while generated workouts were separate from the saved week used by Train. This release separates finding a tool from editing the underlying data.

| Destination | What belongs here | Canonical editable tool |
| --- | --- | --- |
| Overview | The next session and relevant shortcuts | Links to the saved week or current workout |
| Plan | Weekly plan, reviewed progress adjustments, generated suggestions, session builder, templates, shared weeks, monthly schedule and training blocks | Weekly editor at `/planner.html`; generated weeks require a review before replacement |
| Train | Start/resume, log sets, rest timer, completed session history | `/workout.html` |
| Nutrition | Daily calories, optional weight/macros, meal ideas, calorie targets and calculation evidence | One diary and one meal-suggestion surface |
| Progress | Completed-workout trends, consistency, volume, repeat improvements and personal bests | Read-only summary linking to training history or Nutrition |
| Exercises | Library, recommendations, comparisons and exercise-selection preferences | Existing focused tools; shared plans now belong to Plan |
| Personal setup | Measurements, schedule, experience, energy inputs and food preferences | One shared form reached from Plan or Nutrition, returning to the originating destination |

The public exercise rankings and planner's exercise picker retain their contextual roles: one supports browsing, the other adds a selected movement to a day. Shortcuts lead to the same tool instead of embedding another copy. The session builder creates a single session, the monthly scheduler assigns actual dates, and the training block reviews a repeating week; their purpose is stated beside each entry.

## Everyday experience

- Homepage shortcuts lead directly to exercises, a free week preview, Train and Nutrition.
- The Strata+ directory keeps all six destinations visible on narrow screens. Supporting tools retain their parent navigation highlight and working deep links, skip links and browser history.
- Generated training suggestions appear in Plan. Review shows every day's exercise/set totals; cancel makes no write. Confirm uses the reviewed weekly-plan revision and does not silently overwrite a remotely changed week. Partial/unavailable suggestions are rejected for wholesale replacement.
- Completed workouts keep their optional check-in in Train. A suggested change links to Plan, where a single approval/dismissal surface owns the saved-plan decision.
- A generated week transfers exercises, sets and repetition/measurement text into the existing weekly-plan schema. Suggested loads and rest guidance remain in the displayed suggestion, as explained before confirmation. Workout history and nutrition logs are untouched.
- Nutrition puts the daily diary before method details. Maintenance keeps its single daily value, with the calculation and uncertainty accessible in a disclosure. Evidence, alternate goals and weight scenarios do not crowd the primary action.
- The shared visual finish applies across public, account, planning, training and supporting pages. All new assets are registered in the static server and versioned offline cache.

## Data and release behavior

No database migration, billing configuration change or new service is required. Account-specific request guards, stale-response handling, optimistic concurrency, draft retention and private-data reset remain in place. Older stored coaching profiles retain their existing equation semantics until explicitly reviewed. This release does not claim measured metabolic accuracy or a guaranteed percentage error.

The public build and asset versions are `8.5.0` (Build 8.5). Deploy through the existing workflow. A version bump refreshes the service-worker cache, including the new shared stylesheet.

## Validation

The release uses the repository's full `npm run check` gate, targeted program-conversion/concurrency tests, the real browser coaching flow, and visual review at desktop and narrow mobile sizes. The browser flow verifies a generated week can be reviewed and saved and that Progress has no second diary. Detailed checks include keyboard routing, responsive layout, text enlargement, accessible labels and contrast, account changes, diary conflicts, historical dates and offline assets.

Final local result: `npm run check` passed on Node 24 with 967 unit/integration/contract tests and 54 browser tests. Application coverage was 95.14% lines, 83.52% branches, and 91.64% functions. All runtime checks and performance budgets passed. The public-information tests also passed after updating the privacy page’s workspace terminology.
