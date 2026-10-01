# Build 9.0.0 — cut and integrate (in progress)

Build 9 reduces STRATA to one coherent product. This file is the running record for
the release; it moves into `CHANGELOG.md` as the `## 9.0.0` entry when the version is
bumped. Decisions and verdicts are in `AUDIT_BUILD9.md`; parked ideas are in
`PROPOSALS.md`.

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
- The navigation rename (Rankings · My Week · Train · Recovery · Profile) and the Personal
  setup → Profile merge are the next PR: they move Nutrition and Progress between sections and
  depend on the Phase 3 data layer.

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

## Rollback
Migration 008 is reversible by hand: `ALTER TABLE archive_discovery_trials RENAME TO
discovery_trials` restores the rows (the code that read them is in Build 8.9.0).
Migration 007's drop and the product-signal rebuild lose nothing a member can see.
Migration 009 is reversible the same way: `ALTER TABLE archive_community_weekly_plans RENAME
TO community_weekly_plans` restores the listings (the routes that served them are in 8.9.0).
