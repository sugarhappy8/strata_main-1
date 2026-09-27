# Build 8.6.1 — Reliable drafts and offline workouts

Build 8.6.1 is a reliability release. An audit of 8.6.0 confirmed nine defects: two that could lose a member's work, five that could make saved or displayed data wrong, and two smaller correctness problems. This build fixes all nine and adds a regression test for each. Calculations, stored data formats, and APIs are unchanged.

## What was fixed

| ID | Priority | Before | Build 8.6.1 |
| --- | --- | --- | --- |
| B1 | High | Returning to the Strata+ tab cleared the whole workspace before re-checking the account, erasing unsaved Nutrition and personal-setup input, comparisons, and generated sessions | The view is hidden while the account is re-checked. The same session gets its view back as it was, unsaved input included, and workout history refreshes without touching forms. A different account, a signed-out session, or ended access still clears everything. A failed check keeps the view hidden and the input in memory until a retry succeeds |
| B2 | High | The offline page stored any finite number, so a value such as `-1` reps made the device draft unreadable after a reload | Each value is checked with the same rules as the online logger before it is applied. An invalid value stays highlighted for correction but never reaches storage, and a write that could not be read back is refused. Drafts saved by older builds reopen with each invalid value cleared and listed |
| B3 | Medium | Completed offline sets stayed editable, so clearing a value left a completed set invalid | Completed sets are read-only until they are unchecked, and a finished workout is read-only |
| B4 | Medium | Offline Finish accepted a workout with no completed set, which the server then refused | Finish requires a completed set and shows how many sets are done. A draft finished that way by an older build reopens as active with an explanation |
| B5 | Medium | After a failed device write, the next render restored "Saved on device" and finishing replaced the error | The status stays "Couldn't save — Retry" and the error stays visible until a write succeeds. Syncing is refused while changes exist only in the tab, and leaving the page warns |
| B6 | Medium | In a superset whose exercises had different set counts, "Next set" could point at a set that did not exist | Guidance skips missing sets and returns only real unfinished sets |
| B7 | Medium | The plate calculator used kilogram plates in pound mode (135 lb on a 45 lb bar gave 25 + 20 per side) | Pound mode uses 45, 35, 25, 10, 5, and 2.5 lb plates (135 lb gives one 45 per side), and the calculator lists the plates it assumes |
| B8 | Low | Share-card text stopped after the first word of its last line and dropped the rest silently | Every allowed line is filled first, and an ellipsis appears only when words are left out |
| B9 | Low | The admin activity report used 1 day when the range was missing or blank, instead of its 30-day default | A missing, blank, or invalid range uses 30 days; numeric ranges are still limited to 1–90 |

Exercise notes also drop invisible control and direction characters as they are typed. The server already rejected those characters, and on the offline page they made a device draft unreadable.

## Data and release behavior

No database migration, server contract change, billing change, or new asset is required. Device drafts, workouts, coaching profiles, diary entries, and plans keep their existing formats. Strict draft reads are unchanged; only the offline page falls back to the repair path, and it clears only set values that could never be saved. The public build and asset versions are `8.6.1`, which refreshes the versioned service-worker cache so installed apps receive the fixed scripts.

## Validation

Local results on Node 24:

- `npm run release:check`, `npm run architecture:check`, `npm run typecheck`, and `npm run lint` pass.
- The Node suite passes 974 of 974 unit, integration, and contract tests. New cases cover superset guidance with unequal set counts, pound plates, field-level input rules, draft repair, note cleaning, share-card wrapping, and the analytics range. `npm run coverage` meets its floors at 95.16% lines, 83.71% branches, and 91.73% functions.
- `npm run qa:runtime` and `npm run performance` pass. The Strata+ runtime smoke now checks that a same-session return keeps state and unsaved input, and that a different account is still cleared.
- New browser coverage: `qa/e2e/offline-workout-safety.js` drives the offline page through invalid input, reloads, completed-set locking, a zero-set finish, a simulated full storage quota, and drafts saved by older builds. The coaching journey now checks that unsaved intake and setup input survive a same-account tab return and a failed account check followed by a retry.
- Each new unit and browser check was also run against the 8.6.0 code, where it fails.
- 54 of 55 browser tests pass in Chromium. The one local failure is the last step of the service-worker offline journey, where a newly opened page must load offline. This container's older Chromium does not apply offline emulation to that page, and the step fails identically on unchanged 8.6.0 here. The journey's offline logging, save status, sync, and recovery steps all pass. CI installs the pinned Chromium, Firefox, and WebKit builds and runs the complete gate.
