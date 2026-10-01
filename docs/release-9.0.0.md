# Build 9.0.0 — Cut and integrate

Build 9.0.0 turns STRATA into one product with five sections, one entitlements module, and one
data layer every screen and Strata AI read from. It adds no features: it cuts duplicates and
unfinished screens, connects what was built separately, moves Strata AI to Groq behind consent
and a shared budget, and polishes what a first-time visitor sees. Subscription and pricing are
unchanged. The full record is `CHANGELOG_9.0.0.md`.

## What changed

### Five sections
- Every page shares one navigation: **Rankings · My Week · Train · Recovery · Profile**.
- Rankings, My Week, and Recovery follow the member: Strata+ members open the studio's Library,
  Overview, and Recovery; everyone else gets the public rankings, the free planner, and the
  Strata+ plan that includes Recovery. Old URLs keep working.
- Profile replaces the separate Account buttons; members reach Personal setup and Nutrition
  targets from it.

### Cut and merged
- The legacy trial, the admin elevation and V3 Polar tables, the trial product signal,
  community weekly plans, the homepage directory and demo blocks, the exercise hub, the
  decision board (now the Library's Saved), the share-card generator, the homepage compare tray,
  Train's history stat boxes, and the one-off calendar file. Archived tables keep their rows for
  one release.
- Build numbers left every footer; Profile's About line shows the build.

### One data layer
- `GET /api/profile`, `GET /api/training-log`, and `GET /api/snapshots` serve the Athlete
  Profile, the Training Log (logged workouts, Polar sessions, and planned days, deduplicated),
  and Daily Snapshots (sleep, recovery, heart rate, training done versus planned, nutrition).
- Coaching reads the saved weekly plan instead of generating a second program; every plan save
  records whether it came from the member, Strata AI, or setup.
- Events keep stored records in step (`DATA_MODEL.md`).

### Polar
- Sessions join the Training Log, nights join the Daily Snapshot, My Week shows last night's
  Nightly Recharge, and a Polar gym session completes an unlogged planned day.
- When Strata+ ends, imported data stays readable and syncing pauses. Webhooks and daily
  activity wait for AccessLink V4 documentation (`POLAR_INTEGRATION.md`).

### Strata AI on Groq
- Server-side calls to Groq's OpenAI-compatible API with strict JSON schemas and a fallback
  model; consent before anything is sent; a shared daily budget with a reserved share for Daily
  Briefs; context from the data layer; care notes only when STRATA's own flags fire.
- The Daily Brief is written each morning and shown on the Overview. The owner sees today's use
  on the admin Overview (`STRATA_AI.md`).

### Polish
- Open Graph share card on public pages, optional Polar step at the end of onboarding, upgrade
  lines from the entitlements module, human copy where Recovery was "coming soon", and the
  stranger-test fixes in `docs/stranger-test-9.0.0.md`.
- One design-token file (`public/styles/tokens.css`) every page loads, with the dead palette
  copies removed; setup's secondary text is readable again (`docs/design-tokens.md`).
- Production responses send HSTS (`docs/security-audit-9.0.0.md`).

## Upgrade notes

1. **Strata AI settings.** Set `GROQ_API_KEY`, `STRATA_AI_MODEL`, and
   `STRATA_AI_FALLBACK_MODEL`; Strata AI stays off until the key and the primary model are set.
   The Build 9 plan names `openai/gpt-oss-120b` and `openai/gpt-oss-20b`. The old `AI_*`
   settings are no longer read; keep them until the release settles, for a rollback.
   Optional limits: `STRATA_AI_DAILY_REQUESTS`, `STRATA_AI_BRIEF_SHARE`,
   `STRATA_AI_REQUESTS_PER_MINUTE`, `STRATA_AI_USER_DAILY_LIMIT`, `STRATA_AI_DAILY_BRIEF`,
   `STRATA_AI_BRIEF_HOUR`, `STRATA_AI_TIER`. See `docs/deployment.md#strata-ai`.
2. **Before launch, in the Groq console:** confirm both models are listed and turn on Zero Data
   Retention; the privacy policy says it is on. The server needs outbound HTTPS to
   `api.groq.com`.
3. **Database.** Migrations `008` and `009` and the new tables run automatically on startup, on
   SQLite and Turso.
4. **Installed apps.** Every asset URL and the offline cache name advance to 9.0.0.
5. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.0.0 npm run smoke:deploy`,
   then walk `REGRESSION_CHECKLIST.md` on staging.

## Validation

`npm run check` passes on the release commit: release markers, architecture policy, strict
types, lint, the Node suite with coverage floors, runtime smokes, the performance budgets, and
every browser journey. Performance before and after is in `CHANGELOG_9.0.0.md`. The security
audit and the stranger test are in `docs/`.

## Rollback

Redeploy 8.9.0 after the steps in `CHANGELOG_9.0.0.md` under "Rollback": rename the archived
tables back first if the retired features must return, restore the old `AI_*` settings, then
redeploy. The new tables are additive and 8.9.0 ignores them.
