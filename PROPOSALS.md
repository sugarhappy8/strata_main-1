# PROPOSALS — ideas parked during Build 9 (not built)

Build 9 adds no features. Anything that looked missing during the audit is written here instead.

| # | Idea | Why it came up | Earliest build |
|---|---|---|---|
| 1 | Link Polar training sessions to STRATA workouts on the server (store `external_id` on the workout) so one session is not counted twice and Polar load can feed progression, calories and the AI | §9 item 5 of the audit: matching is a browser-side time-overlap heuristic | 9.x (Phase 3/4 integration, not a new screen) |
| 2 | Persist AI daily usage and rate buckets in the database | In memory today; reset on every deploy and not shared between replicas | 9.x (Phase 5 quota manager) |
| 3 | Daily activity and physical info from Polar (steps, active calories, weight) feeding the energy model | Nutrition uses self-reported activity minutes while measured activity exists | after 9.0 |
| 4 | Server-side week templates (sync across devices) | Templates are device-only localStorage today | after 9.0 |
| 5 | HSTS header from the app, not only the host | No `Strict-Transport-Security` is set anywhere in `src/` | 9.0 security pass (fix, not feature) |
| 6 | Readiness badge on Train and My Week computed from the Daily Snapshot | Only the Overview card and the lighter-session offer use recovery today | 9.x (Phase 3 integration) |
| 7 | One shared "replace my plan" review flow with a before/after diff | Six separate confirmations exist | 9.x (Phase 2 merge) |
| 8 | Clean URLs (`/rankings`, `/plan`, `/train`, `/recovery`, `/profile`) with redirects from `.html` paths | Mobile apps and marketing need stable, readable routes | 9.x (Phase 6) |
