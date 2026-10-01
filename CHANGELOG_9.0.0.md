# Build 9.0.0 — cut and integrate

Build 9 turns STRATA from a collection of features into one product. It adds no new features:
it cuts what was duplicated or unfinished, puts every screen on one shared data layer, finishes
the Polar integration that could be verified, moves Strata AI to Groq behind consent and a
shared budget, and polishes what a first-time visitor sees. Subscription and pricing are
unchanged.

**At a glance**
- One navigation on every page: **Rankings · My Week · Train · Recovery · Profile**.
- One entitlements module (`can(user, feature)`) behind every page and route.
- One data layer: Athlete Profile, Training Log, Daily Snapshot, Rankings Signals, and plan
  history, kept in step by events (`DATA_MODEL.md`).
- Polar data in the Training Log and Daily Snapshot, a readiness badge on My Week, and planned
  days completed by Polar sessions (`POLAR_INTEGRATION.md`).
- Strata AI on Groq: consent first, a shared daily budget, context from the data layer, and a
  Daily Brief (`STRATA_AI.md`).
- No build numbers, "coming soon", or duplicate exports in the main UI; a share card; an owner
  view of AI use.

**Release documents**
- Audit and verdicts: `AUDIT_BUILD9.md`. Parked ideas: `PROPOSALS.md`.
- Data model: `DATA_MODEL.md`. Polar: `POLAR_INTEGRATION.md`. Strata AI: `STRATA_AI.md`.
- Regression checklist: `REGRESSION_CHECKLIST.md`. Stranger test:
  `docs/stranger-test-9.0.0.md`. Security audit: `docs/security-audit-9.0.0.md`.
- Release guide and deployment steps: `docs/release-9.0.0.md`.

## Phase 2a — dead code, legacy trial, giveaway copy

### Removed
- **Legacy Strata+ trial.** Access is paid access or an admin grant. The server, store,
  admin overview and account search, account export, and every client module stop
  carrying trial state; `/api/me` no longer has `discovery.trial`, and `accessType` is
  `"paid"`, `"grant"`, or `null` (the dead `"lifetime"` and `"subscription"` values are
  gone). `POST /api/discovery/trial` still answers `410 TRIAL_RETIRED` for installed apps
  from older builds.
- **`discovery_trials` table** — renamed to `archive_discovery_trials` by migration
  `008-build9-retired-tables` so the cut is reversible for one release; it grants nothing.
- **`admin_elevations` table** and its four store methods, SQL, and cleanup job (never
  used by any route).
- **`device_revocations` table**, its store methods, and the Polar sync step that emptied
  it. Migration 007 now drops the table (V4 has no deregistration endpoint).
- **`trial_started` product signal** from the allowlist, the admin "Started a trial" stat,
  and the counts table (rebuilt without it).
- **Account page storage pill** ("Permanent account storage is active"): server
  infrastructure state has no place on a member page. `/api/status` and `/healthz` stay
  for operators.
- `strata-ai-plan.txt` (superseded by the Strata AI chat shipped in 8.9.0).

### Fixed
- The contact form works without JavaScript: a plain form post to `/api/support` is
  accepted and redirected back to `/contact` with the ticket reference (or the error
  code) in the query string, where the page shows it. It used to answer 415 JSON.
- `/planner` is a page alias on the server, matching the service worker.
- The protected-page login redirect lost an unreachable planner branch.

### Changed
- Copy: "Strata AI isn’t switched on yet" → "Strata AI is unavailable right now";
  offline shell footer "Offline fallback" → "Offline"; workout offline eyebrow
  "Device-safe continuation" → "Offline workout".
- Docs: trial sentences removed from architecture, deployment, testing, and founder
  plan; old navigation ("fifth destination after Today, Plan, Progress, Explore")
  corrected; `docs/release-readiness.md` marked as a historical 8.0.1 snapshot; the
  deploy smoke example reads the version from `package.json`.

### Kept on purpose (audit items reconsidered during implementation)
- **Build label in every footer.** `test/pwa.test.js` and the deploy smoke use it to
  detect stale service-worker caches, which caused the 8.8.8 broken Overview. It stays.
  *Revisited in Phase 6:* stale caches are caught by the asset version on every page and the
  service-worker cache name, and the deploy smoke reads the build from `/api/status`, so the
  visible label moved to Profile's About line as the plan asks.
- **Privacy page "Inspect the exact local summary" / "Copy summary".** This shows a member
  exactly what the browser stores; it is transparency, not a developer tool.
- **Test-only store probes** `hasPaidDiscoveryAccess`, `hasDiscoveryAccess`,
  `discoveryAccessSummary` and the read-only API routes the client does not call yet
  (`GET /api/training-block`, `GET /api/coaching/logs/:date`, `DELETE /api/workouts/:id`,
  `GET /api/billing/subscription`): API-first means a mobile client can use them.
- Community-plan and monthly-plan endpoints are removed wholesale in Phase 2d, not here.

## Phase 2b — one entitlements module

- **`src/entitlements.js`** holds the tier table (Free: rankings, weekly plan, basic profile,
  account; Strata+: studio, train, nutrition, recovery, progress, library, compare, AI) and
  builds the `capabilities` map that `/api/me` now carries.
- **`requireFeature("<name>")`** guards every member route in the composition root; workouts
  and training use `plus.train`, coaching `plus.nutrition`, devices `plus.recovery`, Strata AI
  `plus.ai`, the rest of the studio `plus.studio`. Errors name the feature. A feature the owner
  switched off answers `403 FEATURE_UNAVAILABLE`.
- **`STRATA_AI_TIER`** is the AI switch the audit asked for: `plus` (default) or `off`. Making
  AI an add-on later is a new tier value here, not a route change.
- **`public/scripts/entitlements.js`** (`StrataEntitlements.can`) replaces every
  `discovery.active===true` read on the home, pricing, planner, account, and studio pages. A
  payload cached by an older build falls back to the Strata+ flag.

## Phase 2c — one Library, one Compare

- **Exercises hub removed.** The "Exercises" destination opens the Library directly;
  Recommendations, Compare, and Preferences are a tool row inside it, and "Back to
  Exercises" links now read "Back to Library".
- **Decision board folded into the Library's Saved collection.** Saving still works
  from recommendations, the library, and the detail view and still stays on the device
  (same four-movement limit, same storage key); "Compare saved" and "Clear saved" appear
  inside the Saved collection instead of on a separate board.
- **One explainer.** The studio score guide is now a short "How we calculate" that hands
  off to the public method page (`/policies#methodology`) instead of a second explanation.
- **Share cards cut.** The PNG share-card generator (`discover-sharing.js`) and its three
  "Share card" buttons are gone. Weekly-plan sharing between members is untouched.
- **One Compare.** The homepage's two-exercise compare tray and dialog are removed, with
  the 30-second access-freshness timer that existed only for them. A Strata+ member's
  exercise detail on the homepage offers one link, "Compare in Strata+", to the Library's
  side-by-side comparison (up to four exercises). Free visitors see no comparison control,
  as before.

### Deferred from Phase 2c (recorded, not dropped)
- Merging the three exercise-detail dialogs (homepage, studio, Train history) into one
  module is a code-level duplication members never see at once; it moves to Phase 6.
  *Outcome:* still deferred, and parked as proposal 10. Members see one dialog per page, and
  merging three pages' dialogs in the release that rebuilt navigation would put Rankings at
  risk for no visible gain.
- The Nutrition "Behind the numbers" panel folds into Strata AI in Phase 5.

## Phase 2d — Plan consolidation (first slice)

- **Community weekly plans cut.** The studio's "Shared plans" browser, the apply dialog, the
  planner's "Share week" publishing panel, the five `/api/community-plans*` routes, their
  store methods and validation helpers, and the public copy that described them are gone.
  Migration `009-build9-archive-community-plans` renames `community_weekly_plans` to
  `archive_community_weekly_plans` (reversible for one release) and drops its index.
  Community *ratings* are a different feature and stay. Templates and import/export remain
  the two ways to reuse a week.
- **Homepage trimmed to hero → free week preview → rankings → method → sources.** The
  "What would you like to do?" directory cards (the navigation already says it), the
  Rank→Plan→Train→Review ticker, the "From question to working set" demo console, the
  editorial story block, and the Strata+ offer block are gone, with their styles and the two
  photographs only they used. Price and renewal terms plus the contact address move to a
  short footer line; the pricing page remains the one place that sells Strata+. The
  research "receipts" section stays: it is trust content that the footer links to.

### Phase 2d decisions recorded during implementation
- **Monthly plan stays** as the content of "Plan ahead" (training block + 31-day schedule). It
  holds member data and is not a duplicate of the weekly plan; `monthly_plans` is not archived.
- **Session builder stays** where it is: it is already the one deterministic generator, reached
  from Plan, Overview, and Train.
- **"Suggested week from personal setup"** is addressed in Phase 3, when coaching reads the
  weekly plan from `plans` instead of generating a second week.
- **Onboarding gating** is decided with Personal setup → Profile in Phase 2e: onboarding writes
  through `/api/setup`, which is Strata+ today.

## Phase 2e — Train, Progress, Profile (first slice)

- **Progress owns the numbers.** The Train page's three history stat boxes (completed sessions,
  sets, open sessions) are gone; the Progress view already reports adherence, volume,
  consistency, and sessions from the same records.
- **`/ai` is the expanded chat.** The side cards ("How it works", "What Strata AI sees") leave
  the page; the chat column is centred. The same facts stay in the privacy policy and the
  chat's own empty state.

### Five sections everywhere (second slice)

- **One navigation on every page: Rankings · My Week · Train · Recovery · Profile.** It replaces
  Exercises · Strata+ · Plan · Train and the separate Account links. Old URLs keep working.
- **Sections follow the member.** `/rankings`, `/my-week`, and `/recovery` are server routes:
  - Strata+ members open the studio's Library, Overview, and Recovery.
  - Everyone else gets the public rankings and the free planner.
  - Recovery for non-members opens the Strata+ plan with a line saying what Recovery includes.
  - Offline, My Week opens the planner kept on the device.
- **The studio highlights where you are.** Recovery highlights Recovery; Progress highlights
  Train; the Library, recommendations, and Compare highlight Rankings; Personal setup highlights
  Profile. Inside the studio the section links switch views in place, without a reload.
- **Profile is the account.** The header "Account" buttons on the studio, `/ai`, Train, and the
  planner are gone; Profile reaches the same page. The planner's guest link says "Sign in".
  Members see "Personal setup" and "Nutrition targets" on Profile.
- **Train links to Progress.** The progress chart links to the studio's weekly consistency and
  records.
- Consistent names: the studio tab, footers, and the admin header say "Rankings"; the brand
  link is "STRATA home" on every page.
- **Kept on purpose:**
  - The studio's own view switcher (Overview, Recovery, Progress, Rankings) stays; it switches
    views inside Strata+ and carries the short descriptions.
  - The homepage keeps its sign-in and Strata+ buttons, which show who is signed in.

## Phase 3 — one data layer (first slice)

- **Athlete Profile.** `GET /api/profile` is one read model over the ranking lens
  (`preferences`) and the coaching profile (`coaching_profiles`): training facts in one
  vocabulary for everyone, plus body, energy, schedule, and food for Strata+. `DATA_MODEL.md`
  names the owner of every fact.
- **No more two training profiles.** Saving the ranking lens mirrors goal, experience,
  equipment, and limitations into the coaching profile; saving the coaching profile mirrors them
  (and the day count) back. The mirror is an ordinary revision bump, so a stale screen gets the
  usual "changed elsewhere" conflict instead of overwriting.
- **Events.** `src/events.js` is a small in-process bus. Plan, workout, preferences, and
  coaching-profile saves announce themselves; the profile sync is the first listener, the
  Polar matcher and the Daily Brief come next.
- **One weekly program.** The coaching week no longer builds a second program next to the
  member's plan. It reads the saved week (same days, exercises, sets, and reps) and adds rest,
  effort guidance, duration estimates, and targets from logged sets. Calorie targets and the
  zigzag training days now follow the days the member actually plans to train, matching the
  Strata AI nutrition preview. Editing the plan refreshes the coaching week; the coaching
  profile is untouched. A member with no training days saved still gets a starter week to
  review and save as their plan.
- **Training Log.** `GET /api/training-log` lists logged workouts, Polar sessions, and this
  week's planned days in one shape, each tagged `manual`, `polar`, `ai`, or `system`. A Polar
  session that matches a logged workout (by overlapping time, or the day's only gym session and
  workout) is linked to it and shown once, and a Polar gym session on a planned day completes
  that day. Earlier weeks never show a guessed plan.
- **Daily Snapshot.** `GET /api/snapshots` returns one stored row per day with sleep, recovery,
  heart rate, training done versus planned, and the diary entry. Rows rebuild when a Polar sync
  finishes, a workout is completed, a diary entry is saved, or the plan changes, and they leave
  with the Polar data they came from.
- **Plan history.** Every saved week records whether it came from the member, an accepted
  Strata AI proposal, or setup and approved adjustments, so the Training Log and the AI can tell
  them apart.
- **Events follow the spec's names:** `plan.updated`, `workout.completed`,
  `polar.sync.finished`, and `snapshot.ready`, plus `coaching.log_saved` and
  `polar.data_deleted` for the snapshot rebuilds. `DATA_MODEL.md` has the diagram, the fields,
  and every listener.
- **Device copies stay bounded.** Each claim or keep decision used to leave another full
  copy of both weeks in the browser's storage, forever. The device now keeps the newest three
  safety copies per account. The free device week and the homepage preview are single entries
  and stay as they are, so a signed-out visitor keeps their own week.

## Phase 4 — Polar

- **Polar data lands in the shared layer.** Sessions join the Training Log (linked to the
  logged workout they duplicate, or completing a planned day), and sleep, recovery, and heart
  rate join the Daily Snapshot. `POLAR_INTEGRATION.md` documents the flow, states, events, and
  failure modes.
- **Readiness on My Week.** The Plan view shows last night's Nightly Recharge as a badge, with a
  link to a lighter session in Train after a poor night.
- **Planned days completed by Polar.** Progress counts a Polar gym session on a planned day
  with nothing logged as that day done, and says how many came from Polar.
- **Downgrade rule.** When Strata+ ends, syncing pauses (as before) and the member keeps
  read-only access to everything already imported, plus disconnect. Nothing extra is deleted on
  lapse; the existing 400-day retention still applies.
- **Not done, pending Polar's documentation:** webhooks, daily activity, and physical info.
  Each needs AccessLink V4 endpoints and scopes confirmed against Polar's current docs, which
  were not reachable from the build environment. Polling (first import, Sync now, daily pull
  with a three-day re-check) stays the sync model until then.

## Phase 5 — Strata AI on Groq

- **Groq replaces the local PC endpoint.** The provider adapter talks to Groq's
  OpenAI-compatible API by default (`GROQ_API_KEY`, `STRATA_AI_MODEL`,
  `STRATA_AI_FALLBACK_MODEL`; models are never hard-coded). Every structured task uses a strict
  JSON schema. A rate-limited or retired model rests for its `retry-after` while the fallback
  model answers. The Cloudflare Access headers and local-server options are gone, and the old
  `AI_*` settings are no longer read.
- **Consent first.** Nothing is sent to the provider until the member taps "Allow Strata AI".
  The `/ai` page has settings to turn the Daily Brief off, delete stored AI notes, or turn
  Strata AI off. The privacy policy has a new section 8 on Strata AI and Groq.
- **A shared budget that survives restarts.** Requests and tokens are counted per day in
  `ai_usage_days`; the quota keeps a share of the day for Daily Briefs, caps bursts per minute,
  and keeps each member's chat allowance. When chat's share is spent, the chat says it is
  resting until tomorrow instead of failing. The owner can read today's usage at
  `GET /api/ai/usage`.
- **Context from the data layer.** Chat and the brief read compact lines from Daily Snapshots,
  the Training Log, Rankings Signals, and plan history. STRATA computes care flags itself
  (resting heart rate, stress signals, or very short sleep three days running) and the AI adds
  a gentle "consider a health professional" note only then.
- **Daily Brief.** Each morning, after last night's Polar sync, Strata AI writes readiness,
  today's recommendation, up to two suggested plan adjustments, and one insight. It is stored
  on the day's snapshot, shown on the Overview, exported, and deletable.
- **Kept on purpose:** the deterministic explanations (nutrition "Behind the numbers", the
  training-block review, previous comparable performance, recovery stress signals) stay on
  their screens for members who don't use Strata AI; the brief explains the same facts.
- `STRATA_AI.md` documents prompts, schemas, context fields, token budgets, the quota, and the
  cost per member.
- **Not verified from the build environment:** Groq's model list and docs were unreachable, so
  confirming both models and turning on Zero Data Retention are deployment steps.

## Phase 6 — product polish (first slice)

### Removed "project" giveaways
- **Build numbers leave the main UI.** Footers on every page dropped "Build 8.9.0". Profile
  keeps one "About STRATA · Build" line, and the private admin page keeps its own. Asset version
  markers still drive cache busting, so `npm run release:version` works as before.
- **One calendar export.** Train's post-workout "Add to calendar" file for the next session
  duplicated the weekly calendar file, which already repeats every planned day at a chosen time
  with a reminder. The weekly file stays; the one-off file and its code are gone.
- **No "coming soon".** With Polar not configured, Recovery says Polar connections are paused
  and that the plan, training, and nutrition work as usual.
- **Profile everywhere.** Copy that sent members to "Account" now says Profile (Recovery, Polar,
  billing, the privacy policy, terms, refunds, and account deletion). The page title is
  "Profile — STRATA".
- The archived half of `strata-polar-plan.txt` is gone. Its two open points, the missing stable
  Polar identity and the live field-unit check, moved to `POLAR_INTEGRATION.md` under Known
  limits.
- `qa/calibration-benchmark.js` stays as a documented manual check and gets
  `npm run benchmark:calibration`. It loads its reference engine from Git history, so it is not
  part of `npm run check`.

### Product polish
- **Upgrade lines come from the entitlements module.** `StrataEntitlements.upsell(reason)` holds
  one sentence per Strata+ entry point (Strata AI, Recovery, Strata+ pages), and the pricing page
  uses it for signed-in and signed-out visitors.
- **Share card.** The nine public pages carry Open Graph and large Twitter card tags with a
  1200×630 image (`/images/strata-og.jpg`, 63 KB) built from the homepage hero.
- **Onboarding ends with Polar, optionally.** After the week is saved, next to "Review my first
  workout", members see "Wear a Polar Loop? Connect it in Profile (optional)".
- **The owner sees Strata AI use.** The admin Overview shows today's chats, Daily Briefs,
  tokens, and requests left against the daily budget. A failed read shows dashes and never
  blocks the overview.
- Server errors without a known cause now read "Something went wrong on our side. Try again in a
  moment." instead of "Unexpected server error."

### Stranger test fixes (second slice)
The first-time walk is written up in `docs/stranger-test-9.0.0.md`. What changed:
- The phone homepage no longer shows a signed-in name pill that ran off the header; Profile in
  the bottom bar is the way to the account.
- "From Account" on pricing, "free Plan" on Train, onboarding, and Profile billing, and the
  "Account" link on Train now use Profile and My Week.
- The Strata+ Overview no longer repeats "You have not built a weekly plan yet."; Train's two
  empty panels no longer share one sentence.
- Onboarding's footer offers members "Back to My Week" instead of "Return to free Plan".
- Production responses send `Strict-Transport-Security: max-age=31536000` (proposal 5).
- `PROPOSALS.md` marks what Build 9 delivered and parks merging the studio's view switcher into
  the site navigation (proposal 9).

## Phase 7 — QA and release

- **Tests for the areas the plan names.** Entitlements (`test/entitlements.test.js`, now with
  upgrade lines), the data layer (`training-log`, `daily-snapshot`, `data-service`,
  `server-data-layer`), Polar backfill (`devices-sync`: first import, re-checks, gaps), dedupe
  (`training-log`: overlap and same-day linking, each side once), the AI context builder
  (`ai-context`), AI output validation (`ai-daily-brief`, `ai-response-schema`), and migrations
  (`database-migrations`, including a test that runs this release's rollback statements).
  Polar webhooks have no tests because there are no webhooks; see `POLAR_INTEGRATION.md`.
- **Regression checklist** for Rankings and Plan your week: `REGRESSION_CHECKLIST.md`, each
  behavior mapped to the test that pins it. All pass.
- **Stranger test** as a new free user and then a new Strata+ member, on phone and desktop:
  `docs/stranger-test-9.0.0.md`. Everything it found is fixed or parked with a reason.
- **Security audit:** `docs/security-audit-9.0.0.md`. No secrets in the repository, Polar
  tokens sealed with AES-256-GCM, Paddle webhooks signed and time-checked, rate limits on every
  write, and `npm audit` clean. HSTS was missing and is now sent in production.

### Performance, 8.9.0 → 9.0.0

Same machine, same Chromium, cold loads at phone size, median of 7 (page weight counts every
same-origin byte, uncompressed); API medians from `npm run performance` with 150 samples, two
runs each.

| Page | Weight 8.9.0 | Weight 9.0.0 | Load 8.9.0 | Load 9.0.0 |
|---|---|---|---|---|
| Home `/` | 1,118.5 KB | 1,092.8 KB | 179 ms | 149 ms |
| Planner | 635.6 KB | 615.8 KB | 113 ms | 109 ms |
| Pricing | 133.7 KB | 134.3 KB | 281 ms | 303 ms |
| Studio | 1,115.6 KB | 1,093.2 KB | 226 ms | 227 ms |
| Train | 628.8 KB | 623.0 KB | 77 ms | 81 ms |
| Profile | 191.5 KB | 190.7 KB | 76 ms | 75 ms |

| Endpoint | 8.9.0 median | 9.0.0 median | Budget |
|---|---|---|---|
| Health | 1.1 ms | 1.0–1.2 ms | 20 ms |
| Status | 0.9 ms | 0.9–1.0 ms | 20 ms |
| Read the weekly plan | 1.2 ms | 1.6–1.7 ms | 35 ms |
| Save the weekly plan | 1.8–2.1 ms | 4.1–4.2 ms | 35 ms |

- Pages got lighter where Build 9 cut things (home, planner, studio). Pricing's load time
  includes Paddle's script, which the build environment blocks, so its timing is noise.
- **Saving the plan costs about 2 ms more**, by design: the save now records plan history and
  rebuilds this week's Daily Snapshots before it answers, so the next read is consistent.
  Reading the plan costs about 0.4 ms more for the entitlement map in the account payload. Both
  stay far inside the budgets.

## Rollback

Build 9.0.0 is safe to roll back to 8.9.0 by redeploying the `8.9.0` commit
(`21dc429`). The database stays compatible both ways. Do the steps in this order.

1. **If the retired features must return with their data, rename the archives back first**,
   while 9.0.0 is still running (it never reads these tables). A test runs these statements:
   ```sql
   ALTER TABLE archive_discovery_trials RENAME TO discovery_trials;
   ALTER TABLE archive_community_weekly_plans RENAME TO community_weekly_plans;
   ```
   Order matters: 8.9.0 creates empty tables with those names when it starts. If it already
   has, drop the empty table, then rename.
2. **Restore the old Strata AI settings.** 8.9.0 reads `AI_BASE_URL`, `AI_API_KEY`,
   `AI_MODEL`, the `AI_*` limits, and `AI_ACCESS_CLIENT_ID` / `AI_ACCESS_CLIENT_SECRET` when
   the endpoint sits behind Cloudflare Access. It ignores `GROQ_API_KEY` and `STRATA_AI_*`.
   Without the old names, 8.9.0's Strata AI shows as unavailable; nothing else breaks.
3. **Redeploy 8.9.0.** Every asset URL and the offline cache name change with the version, so
   installed apps pick up the old files on their next visit.

What stays harmless:
- Build 9's new tables (`training_links`, `daily_snapshots`, `plan_changes`, `ai_settings`,
  `ai_usage_days`) are additive; 8.9.0 never reads them. The first four cascade when 8.9.0
  deletes an account. `ai_usage_days` has no foreign key, so an account deleted while 8.9.0
  runs leaves its daily AI request counts behind (counts only, no content): delete those rows
  by user id, or drop the table once the rollback is final. Drop the others only then too,
  because rolling forward again rebuilds snapshots but cannot recreate plan history or consent.
- 8.9.0's migration runner ignores ledger entries it does not know (`008`, `009`).
- Migration 007 dropped queued V3 Polar deregistrations, which V4 cannot use anyway.
- The product-signal table rebuilt by migration 008 no longer accepts `trial_started`. On 8.9.0,
  that one anonymous count fails with an error the browser ignores; every other count works.

Rolling forward again after a rollback is the normal deploy: migrations `008` and `009` are
already recorded, and the archive renames above are the only step to undo first.
