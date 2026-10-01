# STRATA data model (Build 9)

One owner per fact. Every screen and every API reads a fact from its owner, through the
read model named here, and writes it back through the same route. When two stored records
must agree, a sync listens on the event bus; no route updates another feature's table.

## Read models

| Read model | Route | Composed from | Who reads it |
|---|---|---|---|
| **Account** | `GET /api/me` | `users`, `sessions`, billing (`paddle_purchases`, `paddle_subscriptions`, `admin_account_controls`), `plans` stats | Every page header, entitlement checks (`capabilities`) |
| **Athlete Profile** | `GET /api/profile` | `preferences` (ranking lens) + `coaching_profiles` (training, body, energy, schedule, food) | Rankings "Personal match", Library, Plan, Nutrition, Strata AI context |
| **Weekly plan** | `GET /api/plan`, `PUT /api/plan` | `plans.plan_json` | Planner, studio Overview and Plan, Train, Monthly schedule, coaching, Strata AI |
| **Training log** | `GET /api/workouts`, `POST/PUT /api/workouts/:id` | `workouts.workout_json` (+ `summary_json` cache, `workout_check_ins`) | Train, Progress, training block review, progression, coaching evidence |
| **Coaching week** | `GET /api/coaching/week` | `coaching_weeks.snapshot_json`, built from the weekly plan, the Athlete Profile, and the training log | Plan view ("Your week · with coaching targets"), nutrition targets, diary, meal ideas, Strata AI nutrition preview |
| **Recovery** | `GET /api/devices/polar/…` | `device_connections`, `wellness_nights`, `wellness_days`, `wellness_workouts` | Recovery view, Overview card |

## Field owners

| Fact | Owner | Mirror | Rule |
|---|---|---|---|
| Training goal, experience, equipment, movement limitations | `coaching_profiles` when it exists, else `preferences` | `preferences` ↔ `coaching_profiles` | Saving either side mirrors into the other (`src/athlete-profile.js`). The mirror write is an ordinary revision bump, so a stale client gets a conflict instead of a silent overwrite. |
| Days per week | `coaching_profiles.workoutDays` (named days) | `preferences.days` (count) | Count follows the named days; the count never invents day names. |
| Session minutes, usual lifts, time zone | `coaching_profiles` | — | Strata+ only. |
| Exercise preferences (stable, compound, …) | `preferences` | — | Ranking lens only; coaching never reads them. |
| Body, energy, calorie pattern, food | `coaching_profiles` | `coaching_weeks.inputs` (frozen per week) | A week snapshot keeps the inputs it was built from; the live values are in the profile. |
| Weekly plan | `plans` | `monthly_plans` (dated expansion), `coaching_weeks.snapshot_json.training` (read view) | Coaching reads its training sessions from `plans`: same days, exercises, sets, and reps, with rest and history-based targets added. A changed plan (by content fingerprint) regenerates the stored week on the next read; the coaching profile is never edited. Only a member with no training days saved gets a generated starter week, which they can review and save as their plan. |
| Completed sets | `workouts.workout_json` | `workouts.summary_json`, `started_at` | Derived columns are a read cache written in the same statement. |
| Polar nights, days, sessions | `wellness_*` | — | Imported by `devices-sync.js`; Phase 4 links `wellness_workouts` to `workouts` by time overlap and tags the source. |
| Entitlement | `paddle_purchases` + `paddle_subscriptions` + `admin_account_controls` | `/api/me.capabilities` | Decided once in `billing.hasCurrentAccess`; every route asks `requireFeature`, every page asks `StrataEntitlements.can`. |

## Events (`src/events.js`)

| Event | Emitted by | Payload | Listeners today |
|---|---|---|---|
| `plan.saved` | `PUT /api/plan`, `PUT /api/setup` | `userId`, `plan`, `updatedAt` | — (Phase 5: Daily Brief invalidation) |
| `workout.saved` | `POST/PUT /api/workouts` | `userId`, `workout`, `created` | — (Phase 4: Polar session matching; Phase 5: brief) |
| `preferences.saved` | `PUT /api/preferences`, `PUT /api/setup` | `userId`, `preferences` | Athlete Profile sync → `coaching_profiles` |
| `coaching.profile_saved` | `PUT /api/coaching/profile` | `userId`, `profile` | Athlete Profile sync → `preferences` |
| `polar.synced` | `devices-sync.js` (Phase 4) | `userId`, `provider`, `range` | — |

Handlers run in order and are awaited before the route answers; a failing handler is logged
and never fails the request that caused it.

## Device copies

The browser keeps a few copies that never leave the device: the free device week
(`strata_guest_plan_v1`), the homepage preview (`strata_activation_intent_v1`), one decision
record per account, and safety copies taken before a week is replaced
(`strata_activation_backup_v1:*`, newest three per account). The account's week in `plans` is
always the source of truth once a member signs in.

## Archived tables

`archive_discovery_trials` (migration 008) and `archive_community_weekly_plans` (migration 009)
hold the retired features' rows for one release so the cuts can be reversed by renaming them
back. No code reads them.
