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

## Rollback
Migration 008 is reversible by hand: `ALTER TABLE archive_discovery_trials RENAME TO
discovery_trials` restores the rows (the code that read them is in Build 8.9.0).
Migration 007's drop and the product-signal rebuild lose nothing a member can see.
