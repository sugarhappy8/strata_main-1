# Regression checklist — Rankings and Plan your week (Build 9.0.0)

Rankings and Plan your week are STRATA's core. Build 9 may change the screens around them,
but these two must behave the same as in 8.9.0 or better. Run the automated column on every
release commit (`npm run check`); walk the manual column on staging before promoting.

**9.0.0 result:** every automated check passes on the release commit, and the manual walk was
done as part of the stranger test (`docs/stranger-test-9.0.0.md`) on phone and desktop widths.

## Rankings

| # | Behavior (same as 8.9.0 unless noted) | Automated | Manual check |
|---|---|---|---|
| R1 | All 320 movements are ranked by FitScore; the ten best matches show first and the rest on request | `test/home-modules.test.js` (ranks a catalog), `test/homepage-client.test.js` ("the ranking shows the ten best matches first") | Open `/`, scroll to the index: 320 ranked, ten shown, "show more" works |
| R2 | Muscle-group tabs, target layers, equipment, search, and sort narrow the list without a reload | `test/home-modules.test.js` (validates, filters, and ranks) | Pick Back, a target, Dumbbells, search "row": results update in place |
| R3 | An exercise detail shows setup, cues, common mistakes, and equipment-equivalent swaps | `test/homepage-client.test.js` (exercise details) | Open any row's detail |
| R4 | Visitors get a private no-account shortlist with reasons and trade-offs | `qa/e2e/training-flows.js` ("a visitor can inspect a private recommendation preview") | "Build my free week" without signing in |
| R5 | Homepage rankings carry no comparison controls; members get one link to the Library's Compare | `test/homepage-client.test.js` | Signed in with Strata+: one Compare link |
| R6 | **New:** the Rankings section opens the public index for visitors and free accounts, and the personalized Library for Strata+ members | `test/server.test.js` (section routes), `test/public-info.test.js` (five sections on every page) | Tap Rankings signed out, free, and Strata+ |
| R7 | The Library highlights Rankings in the site navigation and keeps Compare, recommendations, and ratings | `qa/e2e/strata-plus-state-matrix.js` | Open the Library from the studio |
| R8 | Phone layout: no horizontal scroll, 44 px targets, five-item bottom bar at 320 px | `qa/e2e/navigation-layout.js`, `test/public-responsive-css.test.js`, `qa/e2e/accessibility-matrix.js` (CI) | 320 px and 390 px widths |

## Plan your week

| # | Behavior (same as 8.9.0 unless noted) | Automated | Manual check |
|---|---|---|---|
| P1 | Without an account the week lives on the device: add, reorder, sets and reps, rest days, undo, templates, import and export | `qa/e2e/training-flows.js` ("free planning supports rest toggles, replacement, undo, templates and portable imports"), `qa/planner-runtime-smoke.js` | Build a three-day week signed out, reload, it is still there |
| P2 | Signed in, the week autosaves with a revision check; a stale tab or another device never overwrites a newer week | `test/database-plan-concurrency.test.js`, `qa/e2e/training-flows.js` (draft survives a failed save; account switch blocks a stale tab), `qa/e2e/high-risk-flows.js` (conflict UI) | Edit in two tabs: the second shows the conflict review |
| P3 | A device week can be claimed into an account only by an explicit choice | `qa/e2e/activation-continuity.js` | Build a week signed out, then sign up |
| P4 | Plan analysis explains volume, timing, coverage, equipment, and repeats, and never invents recovery claims | `test/plan-insights-core.test.js` | Open "Plan evidence" |
| P5 | Validation: legacy imports, rest markers, and oversized or malformed plans are rejected before saving | `test/plans.test.js` | Import an old export |
| P6 | Free accounts keep the full planner; Strata+ guidance cards appear only for members | `qa/planner-runtime-smoke.js`, `test/planner-modules.test.js` | Free account: no guidance cards |
| P7 | **Changed in 9.1.0:** Dashboard opens the planner for visitors and free accounts; members get a page with two choices, Plan (the same planner) and the Strata+ dashboard. Old `/my-week` links still work | `test/server.test.js`, `qa/e2e/strata-plus-state-matrix.js` | Tap Dashboard in all three states |
| P8 | **New:** offline, Dashboard opens the cached planner with the device week | `test/pwa.test.js` (fallback map) | DevTools offline, tap Dashboard |
| P9 | **Better:** coaching targets and Strata AI read the same saved week (no second generated program); every save records whether it came from the member, Strata AI, or setup | `test/coaching-core.test.js`, `test/server-data-layer.test.js` ("plan saves are tagged by source") | Edit the week, then open Plan: the coaching week follows |
| P10 | **New:** a visitor's Plan asks `/api/me` first (`200 { user: null }`) and opens the device week without requesting `/api/plan`; no public page logs a 401 or any console error | `qa/e2e/navigation-layout.js` ("a signed-out visitor's public pages…"), `qa/planner-runtime-smoke.js`, `test/server.test.js` | Signed out, open Plan with developer tools: the console is clean |

## How a failure is handled

A red item blocks the release. Fix it, or roll back as described in `CHANGELOG_9.0.0.md`. Do
not mark an item "known" to ship around it.
