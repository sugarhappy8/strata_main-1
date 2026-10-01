# PROPOSALS — ideas parked during Build 9 (not built)

Build 9 adds no features. Anything that looked missing during the audit is written here instead.

| # | Idea | Why it came up | Earliest build | Status in 9.0.0 |
|---|---|---|---|---|
| 1 | Link Polar training sessions to STRATA workouts on the server (store `external_id` on the workout) so one session is not counted twice and Polar load can feed progression, calories and the AI | §9 item 5 of the audit: matching is a browser-side time-overlap heuristic | 9.x (Phase 3/4 integration, not a new screen) | **Built.** `training_links` in the Training Log (Phase 3) |
| 2 | Persist AI daily usage and rate buckets in the database | In memory today; reset on every deploy and not shared between replicas | 9.x (Phase 5 quota manager) | **Built.** `ai_usage_days` and the shared quota (Phase 5) |
| 3 | Daily activity and physical info from Polar (steps, active calories, weight) feeding the energy model | Nutrition uses self-reported activity minutes while measured activity exists | after 9.0 | Parked: needs AccessLink V4 endpoints confirmed |
| 4 | Server-side week templates (sync across devices) | Templates are device-only localStorage today | after 9.0 | Parked |
| 5 | HSTS header from the app, not only the host | No `Strict-Transport-Security` is set anywhere in `src/` | 9.0 security pass (fix, not feature) | **Fixed.** Production responses send `Strict-Transport-Security` (Phase 7) |
| 6 | Readiness badge on Train and My Week computed from the Daily Snapshot | Only the Overview card and the lighter-session offer use recovery today | 9.x (Phase 3 integration) | **Partly built.** My Week shows the Nightly Recharge badge (Phase 4); Train does not yet |
| 7 | One shared "replace my plan" review flow with a before/after diff | Six separate confirmations exist | 9.x (Phase 2 merge) | Parked |
| 8 | Clean URLs (`/rankings`, `/plan`, `/train`, `/recovery`, `/profile`) with redirects from `.html` paths | Mobile apps and marketing need stable, readable routes | 9.x (Phase 6) | **Partly built.** `/rankings`, `/my-week`, `/recovery` (Phase 2e); `.html` paths stay canonical |
| 9 | Merge the studio's view switcher into the five-section navigation, so each section shows only its own views (My Week: Overview, Plan, Nutrition; Rankings: Library, Compare) | The stranger test: on the studio page, Recovery and Rankings appear in both the site navigation and the switcher | 9.x (Phase 6 follow-up) | Parked |
