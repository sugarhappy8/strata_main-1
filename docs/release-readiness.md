> Historical snapshot: these results describe Build 8.0.1 and are kept because older release guides link here. Current gate results come from `npm run check` on the release commit.

# STRATA 8.0.1 readiness

Verification uses Darwin arm64 with supported Node.js 24.20.0, isolated temporary accounts, controlled provider fixtures, and Chromium. Promotion also requires the exact release commit to pass the Node 24 Linux GitHub Actions gate, including configured browser engines and both 100-account load profiles. Linux resource measurements are not claimed from a macOS run.

## Verification

| Check | Result |
| --- | --- |
| Node regression suite | 941 passed; no failures, skips, or cancellations |
| Coverage | 95.13% lines, 83.40% branches, 91.61% functions; unchanged 90/78/85 floors passed |
| Energy and training leaves | 100% line coverage for activity budgeting, calorie calibration, energy planning, and sensitivity scenarios; 99.07% for training composition |
| Numerical benchmark | Fixed-seed alignment, noise, missing-intake, fluid-step, density, repeated-week, and under-reporting assertions passed; adverse outcomes retained |
| Storage and service integration | Coaching database/HTTP contracts passed, including SQLite/Turso parity, profile-version compatibility, snapshot continuity, historical dates, and account/revision isolation |
| Complete local release gate | `npm run check` passed |
| Browser journeys | 54 passed; no failures, skips, or cancellations |
| Responsive UI audit | 18 routes × 8 widths; zero horizontal overflow, text-containment issues, navigation-focus overlap, or unexpected browser errors |
| Runtime and performance | All runtime surfaces and seven endpoint/storage budgets passed; 40 measured samples after eight warmups per operation |
| Architecture | 54 server modules, 74 browser modules, seven browser boundaries; zero cycles or policy violations |
| Types, lint, managed versions | Passed; 8.0.1 aligned across 32 managed files |
| Linux release gate | Required on the exact GitHub head, including both 100-account load profiles |

Focused verification includes four non-workout movement anchors, three separate-activity intensities, adult and older-adult energy conventions, usable generated-session minutes, exact weekly budgets, integer macro accounting, requested-versus-actual deficit pace, optional composition and lower-scenario guards, credible recent weights, legacy model rollover, recorded training targets, historical targets, and delayed-save draft preservation. The benchmark is mathematical regression evidence, not clinical validation.

## Behavior and limitations

New version-4 profiles separate ordinary daily movement from generated STRATA sessions and separately entered weekly activity. Maintenance starts from Mifflin–St Jeor and adds the net energy of each usable activity source once; unavailable sessions add zero. The 2023 adult EER remains visible as a population cross-check, not an override. Complete intake aligned with actual morning-weight intervals within the prior 42 dates can gradually inform a later weekly target, while quality and provenance checks can withhold an adjustment. Credible recent weights inform the applicable equation, activity budget, macros, BMI guard, and scenario starting point.

Gentle and moderate fat-loss options request 0.25% and 0.50% of planning weight per week, then apply downward-rounded weight-rate and 20%-maintenance caps, an absolute 500-kcal/day cap, a 1,200-kcal floor, BMI and lower-scenario review, and optional disclosed body-composition restrictions. Body fat never raises the maintenance midpoint. Stored profile versions 1–2 preserve their original resting-energy × activity-multiplier behavior, and version 3 preserves its whole-day 2023 EER behavior without adding workout calories again.

Balanced, strength, and hypertrophy training goals control repeatable prescriptions that respect equipment, actual experience, movement constraints, and the selected duration. Direct-muscle coverage and recorded per-set targets are reviewable. Missing required movements produce partial or unavailable sessions; valid equipment-limited profiles keep access to calories and the diary without claiming more equipment or a different experience level. Food quantities scale with servings, and menus disclose calorie or known-macro shortfalls.

Saved current weeks remain fixed through deployment and diary edits. Concurrent generation at the same profile revision keeps the first stored snapshot. Today and the preceding 42 diary dates accept corrections, and old dates use their original saved target or show none. An older profile remains viewable and unchanged; only an explicit review/save of the two new activity answers creates version 4 and regenerates the current week. A compatible version-3 prior calibration remains a rate limiter across the model-label transition but cannot be reused as version-4 provenance.

The synthetic benchmark demonstrates corrected interval alignment and greater adaptation to sustained equation bias. It also documents worse outcomes with missing intake, some noise/density cases, and systematic under-reporting. The method cannot distinguish omitted food from lower expenditure using these observations alone. Calculations and heuristics are not clinically validated; food nutrition and prices remain editorial estimates.

## Deployment and rollback

Deploy the server and versioned public assets from the same commit. This release requires no database migration, new secret, or food/pricing provider. Existing nullable evidence columns, authenticated Strata+ access, CSRF/origin guards, account-bound requests, optimistic revisions, private export/deletion, and network-only private responses remain in use.

Use a compatibility rollback that can still read profile version 4 and preserves profile semantics, saved-week continuity, and all existing diary fields. Do not downgrade profiles, guess a legacy-to-current activity mapping, rewrite private evidence, or drop calibration columns. Keep the current-week first-writer rule so a rollback cannot silently replace a saved target.

See the [release guide](release-8.0.1.md), [methodology](coaching-methodology.md), [module architecture](module-architecture.md), and [test architecture](testing.md).
