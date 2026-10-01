# STRATA architecture

This document describes the current application boundaries and the invariants they are intended to preserve. It is an implementation map, not a promise that a provider or deployment is always available.

## System shape

```text
Browser / installed PWA
        |
        | same-origin HTTPS, cookies, CSRF-protected writes
        v
Node HTTP application
   |          |             |
   |          |             +--> Paddle API and signed webhooks
   |          +----------------> Resend transactional email
   +---------------------------> Store contract
                                      |          |
                                      v          v
                                local SQLite    Turso
```

The application is intentionally server-served and framework-light. Public HTML, CSS, JavaScript, icons, and the exercise catalog live under `public/`; server code and editorial discovery data live under `src/`. `src/server.js` serves only files in its literal static-file map, so placing a file somewhere under `public/` does not automatically make it reachable.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `server.js` | Stable process bootstrap used by npm and Render. |
| `src/server.js` | HTTP composition root, request dispatch, public route aliases, static serving, health endpoints, startup, and shutdown. |
| `src/service-composition.js` | Strictly checked composition function for auth, admin, and support factories and their narrow capabilities. |
| `src/auth.js` | Login, signup, email verification, recovery, reset, deletion, cookie/session/CSRF helpers, native auth forms and JSON routes, account-action delivery, account self-service composition, and auth-data cleanup. |
| `src/admin.js` | Primary-owner binding, live-session permission gates, redacted admin payloads, server-owned audit reasons and helpers, and route composition. |
| `src/admin-user-actions.js` | Audited administrator account, complimentary-access, deletion, and payment-session actions. |
| `src/access-controls.js` | Complimentary-access state and duration validation shared by server and administration boundaries. |
| `src/access-controls-schema.js` | Administrator grant and checkout-hold schema, entitlement predicates, and guarded statements. |
| `src/access-controls-store.js` | Atomic audited SQLite and Turso mutations for complimentary access and checkout holds. |
| `src/support.js` | Public support validation and durable rate reservations, acknowledgment/notification delivery, admin support workflow and responses, safe payload shaping, and retention cleanup. |
| `src/account-self-service.js` | Authenticated active-session review/revocation and rate-limited full-account JSON export orchestration. |
| `src/account-export.js` | Allowlisted export serialization and bounded workout-history keyset streaming. |
| `src/account-self-service-store.js` | Local SQLite and Turso implementations of session management, owner-scoped export reads, and stable workout-history keyset pages. |
| `src/account-self-service-schema.js` | Owner-scoped session mutations and explicit export queries shared by both storage adapters. |
| `src/setup.js` | Authenticated weekly setup boundary that validates matching plan/preferences revisions and commits them atomically. |
| `src/training.js` | Authenticated Strata+ boundary for optional workout check-ins, deterministic next-session suggestions, 4–8 week training blocks, and explicitly approved plan adaptations. |
| `src/training-loop-schema.js` | Additive check-in, training-block, and adaptation schema and parameterized statements shared by both storage adapters. |
| `src/training-loop-store.js` | Focused local SQLite and Turso implementations of the training-loop methods, including atomic compare-and-swap adaptation acceptance. |
| `src/coaching.js` | Authenticated Strata+ API for coaching profiles, persisted weekly snapshots, current-week calorie/macro/weight evidence, and derived remaining-day food options. |
| `src/coaching-core.js` | Strict versioned profile/log validation plus deterministic training-week composition. Profile version 4 explicitly separates ordinary movement, generated sessions, and other weekly activity while retaining older profile semantics. |
| `src/energy-activity-core.js` | Pure profile-version-4 activity budget: reviewed non-workout PAL anchors plus net generated-session and separately entered weekly activity energy. |
| `src/energy-planning-core.js` | Pure version-dispatched legacy, whole-day EER, and structured-activity calculation; bounded trend calibration; calorie-pattern, deficit, macro, and weight-scenario policy. |
| `src/meal-planning-core.js` | Strict food-preference validation, bundled recipe nutrition/cost provenance, hard allergy and dietary filtering, and deterministic remaining-day menu generation. |
| `src/coaching-schema.js` | Additive coaching-profile, weekly-snapshot, and daily-log schema and parameterized statements shared by both adapters. |
| `src/coaching-store.js` | Focused SQLite and Turso coaching reads, optimistic writes, and account-deletion cleanup. |
| `src/devices.js` | Authenticated Strata+ connected-device API: Polar V4 connect with consent and session-bound completion, sync requests, settings, local disconnect, and `/api/wellness` reads. |
| `src/devices-config.js` | Polar and token-key settings; the feature stays off until the client credentials and a 32-byte key are present. |
| `src/devices-crypto.js` | AES-256-GCM token sealing with key identifiers for rotation, plus hashing and constant-time comparison helpers. |
| `src/devices-sync.js` | Scheduled V4 imports, refresh-token persistence, daily polling, pausing without Strata+, and reconnect detection. |
| `src/polar-client.js` | Polar V4 OAuth, credential validation/refresh, range reads, timeouts, rate-limit backoff, and typed errors. |
| `src/polar-mapping.js` | Range-checked mapping of Polar sleep, Nightly Recharge, 24/7 heart-rate, and exercise payloads into wellness rows. |
| `src/wellness-core.js` | Usual ranges from the member's own nights, overnight stress signals, lighter-session advice, today's summary, and trends. |
| `src/devices-schema.js` | Device connection, connect-state, revocation, and wellness tables, the account-deletion trigger, and statements shared by both adapters. |
| `src/devices-store.js` | Focused SQLite and Turso connected-device methods, including atomic disconnect deletion and retention cleanup. |
| `src/product-signals.js` | Anonymous allowlisted product-event intake, transient abuse limiting, UTC-day aggregation, retention, and bound-owner readout. |
| `src/product-signals-schema.js` | Isolated aggregate-count table and statements shared by the two storage adapters. |
| `src/database.js` | Local SQLite and remote Turso implementations of the same application store contract. |
| `src/store-contract.js` | Explicit method allowlist checked when either store is created; missing and extra methods fail fast. |
| `src/schema.js` | Shared schema and parameterized statements used to keep both adapters behaviorally aligned. |
| `src/migrations.js` | Ordered, idempotent SQLite and Turso migration ledger, including security, index, active-workout, recurring-subscription, coaching-evidence, Polar V4 ANS-range, and legacy V3 credential-cleanup migrations. |
| `src/http.js` | Security headers, JSON/redirect helpers, body limits and parsing, compression negotiation, and response semantics. |
| `src/observability.js` | Structured JSON request logs, validated or generated request IDs, bounded fields, and defensive redaction. |
| `src/email.js` | Browser-safe email configuration plus privately retained Resend credentials, HMAC digests, address masking, and transactional message delivery. |
| `src/entitlements.js` | Feature tiers and the `can(user, feature)` capability map that `/api/me` carries and every route guard reads. |
| `src/billing.js` | Checkout, entitlement, subscription, portal, webhook, and reconciliation-service composition, plus the retired trial route. |
| `src/checkout-reconciliation.js` | Validated unfinished-checkout closure, settlement recovery, and deletion-safety reconciliation. |
| `src/payments.js` | Browser-safe Paddle configuration, privately retained server credentials, and provider transaction orchestration. |
| `src/paddle-catalog.js` | Deployment catalog and credential validation, bounded legacy recurring-price parsing, exact current checkout-price identity, and allowed subscription catalog direction. |
| `src/paddle-subscriptions.js` | Monthly transaction/subscription validation and short-lived customer-portal sessions. |
| `src/paddle-webhooks.js` | Raw-body signature verification plus optional Paddle webhook-address validation. |
| `src/billing-schema.js` | Recurring billing tables, entitlement predicates, queries, and statements shared by both storage adapters. |
| `src/billing-store.js` | Focused local SQLite and Turso billing methods, including atomic subscription/purchase catalog migration, single-query entitled-catalog summaries, checkout claims, events, and adjustments. |
| `src/plans.js` | Plan/preferences/community/monthly validation and sanitization shared by routes and storage. |
| `public/scripts/` | Progressive browser behavior. Activation continuity, planner insights, weekly review, discovery, monthly-plan, coaching, workout, onboarding, and guest-preview cores are also exercised directly by Node tests. The Strata+ coaching flow keeps unit conversion, version-4 energy-field normalization, food-option display shaping, rendering, interaction, and final orchestration in separate modules. `product-signals.js` owns the reviewable local summary and credential-free aggregate-event transport. |
| `public/service-worker.js` | Explicit public precache, network-first navigation, a generic account-safe workout-continuation shell, public offline fallbacks, and versioned cache cleanup. |

Factories receive their dependencies explicitly instead of importing a global server object. That keeps authentication, account self-service, administration, support, billing, training, and coaching behavior testable at their boundaries and prevents the HTTP composition root from regaining all domain logic.

## Request flow

1. The Node server parses the URL and dispatches process liveness or storage readiness before application routes.
2. Within `/api/`, the Paddle webhook reaches its raw-body signature boundary first. Other state-changing API requests pass the global same-origin guard before a domain service is offered the request.
3. API services are offered requests in an explicit order: anonymous product signals, support, auth (including account self-service), admin, private training, private coaching, workouts, atomic setup, then billing. Each service returns whether it handled the request and still applies its own authentication, CSRF, entitlement, and validation rules as required.
4. Remaining application APIs, plans, discovery data, and ratings are handled by the composition root and their focused helpers.
5. `/auth/` form submissions are delegated to the auth service. Static `GET` and `HEAD` requests are resolved through the explicit URL-to-file map. Unknown paths receive a controlled `404`; user input is never joined directly to the filesystem.
6. Response helpers attach security and cache headers. Account and API responses use `no-store`; public versioned assets may use public caching.

Route ordering matters. A new sensitive route must be placed behind its applicable session, owner, origin, and CSRF guards before any broad public or static handler.

## Trust boundaries

### Browser to server

Every request field is untrusted, including JSON, form values, headers, URL parameters, uploaded plan text, and Paddle values returned by browser code. The server validates sizes, shapes, identifiers, and state transitions. Client-side validation improves feedback but never authorizes an action.

Session tokens are random and stored only as hashes in the database. Cookies are HttpOnly, SameSite=Strict, scoped to `/`, and Secure in production. A session lookup also checks expiry, credential version, suspension, and required verification state. Password reset increments the credential version and revokes all sessions.

State-changing authenticated routes require the session's CSRF value and a trusted same-origin request. Public recovery endpoints use origin checks, generic responses where account enumeration is a concern, durable or in-memory quotas as appropriate, expiry, attempt caps, and one-time tokens.

### Entitlement boundary

`src/entitlements.js` is the only place that says which tier a feature belongs to. Free covers `rankings`, `plan.week`, `profile.basic`, and `account`; Strata+ covers `plus.studio`, `plus.train`, `plus.nutrition`, `plus.recovery`, `plus.progress`, `plus.library`, `plus.compare`, and `plus.ai`. The composition root guards every member route with `requireFeature("<name>")`, which answers `402 DISCOVERY_ACCESS_REQUIRED` when Strata+ is needed and `403 FEATURE_UNAVAILABLE` when the owner has switched a feature off (`STRATA_AI_TIER=off` hides Strata AI for everyone). `/api/me` carries the resulting `capabilities` map, and the browser asks `StrataEntitlements.can(user,"<name>")` instead of reading billing state, so moving a feature between tiers is a one-line change on the server.

### Activation and device-state boundary

A guest can build a complete recommendation week before creating an account. That preview remains browser-local through signup, verification, and onboarding. The versioned handoff record contains only the validated profile and Plan copy on that device. After authentication, STRATA compares it with the current account Plan and revision and shows a claim/compare/keep decision; it does not silently replace either copy. A remembered decision is scoped to the authenticated user ID and both Plan fingerprints. The actual account write still uses the normal session, origin, CSRF, account-identity, and Plan compare-and-swap checks.

Browser-local state is not an authorization credential. Anybody with access to the same browser profile may be able to inspect device copies. Clearing site data, using a different browser profile, changing accounts, or encountering an incompatible record version can prevent a handoff even though another device copy may still exist. The activation record is versioned but is not an access token and does not use the workout trial or paid-access expiry boundary.

### Administrator boundary

An email setting is only eligible to claim an empty administrator principal; the durable user ID becomes the authority. Admin reads require a normal, unexpired session for that verified, unsuspended, permanently bound primary owner. There is no separate Admin password prompt, registered-email security code, elevation cookie, or privileged time window. Changing `ADMIN_EMAIL` alone cannot transfer an existing binding, and a newly claimed binding still requires a fresh sign-in before private data opens.

Mutations require the same bound-owner session plus trusted-Origin, CSRF, JSON-content, and rate checks. The browser presents one explicit review dialog but sends no typed command or operator-written audit reason. The server accepts only allowlisted actions and supplies a bounded action-specific reason for the audit record. The primary owner remains protected from self-suspension and deletion; optimistic revisions prevent a stale account-controls view from overwriting a newer change. Admin payloads are allowlisted and must never include password material, raw tokens, verification codes, provider credentials, or full payment data.

The Admin browser clears its rendered private data and invalidates every in-flight private operation before a persisted BFCache page reload or an ordinary foreground recheck. It restores the dashboard only after `/api/me` still identifies the same durable administrator and `/api/admin/session` confirms that the bound owner session remains authorized; delayed overview, account, support, audit, and mutation responses cannot repaint the locked view.

Direct administrator deletion is one explicitly reviewed operation. The server first pauses the non-owner target, revokes its sessions, prevents new trials, purchases, or checkout claims, then reconciles earlier Paddle checkout work and rejects active or uncertain recurring billing. A blocker leaves the account paused for an explicit retry or restore. The final parameterized delete rechecks the pause, primary-owner, purchase, and checkout-claim predicates, plus the acting owner's current session, auth version, and expiry, and records the successful audit event in the same SQLite transaction or Turso batch. It removes STRATA's account mapping—including explicit cleanup of administrator controls when a Turso connection cannot rely on foreign-key state—and may close a stale incomplete checkout during reconciliation; it never cancels a live Paddle subscription or issues a refund.

### Account self-service boundary

An authenticated member can list only their own non-expired sessions. The response exposes a one-way public session identifier, whether it is current, and creation/expiry times; raw token hashes, IP addresses, user agents, and device fingerprints never leave the server. Single-session and all-other-session revocation require trusted origin and CSRF checks. The current session is explicitly protected from the selective route, foreign or stale identifiers look absent, and the store mutation atomically rechecks ownership and current-session existence.

The Account browser likewise purges rendered identity, Plan, workout, session, and billing data before a persisted BFCache reload or foreground identity check. It reopens only for the same durable account ID, and export or Paddle-portal results receive a fresh same-account identity check before the browser consumes a download or temporary provider URL.

The account export is an authenticated, CSRF-protected, rate-limited `POST` returned as a versioned JSON attachment with private `no-store` headers. Its owner-scoped collections are read through the same adapter boundary, while workout history is serialized in stable `(started_at,id)` keyset pages so the server does not buffer an account's complete history or silently truncate it. It deliberately avoids holding a database transaction open for the duration of an HTTP download, so concurrent account changes can be reflected progressively rather than forming one point-in-time snapshot. The allowlist includes profile data, weekly and monthly plans, community-plan listings owned by the member, preferences, the member's ratings, workout records and summaries, check-ins, training blocks and adaptations, coaching profile/weeks/intake logs, trial and safe billing state, and the member's support tickets. It excludes password hashes and salts, all session and CSRF material, verification, recovery, and deletion tokens, network or device fingerprints, Paddle customer identifiers and temporary checkout/webhook state, internal support/admin notes, administrator audit data, and aggregate product signals.

### Public support boundary

Anonymous support is intentionally narrow. Input is length-limited and rejects secret- or payment-card-shaped content before persistence. Quotas are durably reserved so restarting the process does not reset abuse protection. Notification email contains a reference rather than copying the complete private message outside the help desk.

### Anonymous product-signal boundary

Product measurement is optional and deliberately separate from account analytics. The browser accepts only named milestones from a fixed allowlist, keeps a user-reviewable local count summary, discards arbitrary event detail, honors Global Privacy Control and Do Not Track, and exposes disable and clear controls. Its aggregate POST uses `credentials: "omit"`, a same-origin URL, and a one-field JSON body. It never needs a session or CSRF token because it cannot mutate account state.

The server independently requires a trusted same-origin request, JSON content, exactly one allowlisted event name, and bounded network/global rates. It HMACs the request address with a process-random salt only to form an in-memory rate-limit key; neither the address nor hash reaches storage. The accepted event increments one row keyed by UTC day and event name. There are no raw event, visitor, account, session, URL, exercise, recommendation, plan, or workout rows. Counts expire after 90 days.

The read route uses the existing bound-owner session boundary. Its response labels browser-supplied product signals as aggregate action counts: repeated actions increment the count, unique people and connected journeys cannot be derived, and those numbers must not be represented as conversion rates. Separately, the owner overview derives aggregate milestones from existing account, workout, trial, purchase, and subscription rows. Five values count distinct accounts: first completed workout, second completed workout, completed workouts whose start times are at least seven days apart, trial start, and any validated completed Paddle payment record. The sixth counts subscriptions whose current provider period has advanced beyond one 32-day initial-window bound; it is not a distinct-account count or proof that a particular renewal charge succeeded. The overview exposes totals only—not account names or workout contents—and treats them as operational funnel evidence rather than proof of fitness outcomes. Deleting an account removes its underlying rows, so a later overview no longer includes it; the anonymous action-count table still has no account relationship.

### Private training-loop boundary

Workout check-ins, training blocks, calculated progression, and plan-adaptation proposals require an authenticated account with active Strata+ access. Every mutation also requires a trusted same-origin request, JSON content, the current session's CSRF token, a bounded request rate, and server-side input validation. Reads and writes are owner-scoped; a browser response is never accepted as evidence that another account owns a record.

A check-in contains only four explicit 1–5 answers: difficulty, energy, comfort, and enjoyment. STRATA does not infer pain, fatigue, recovery, readiness, technique, or injury risk. A first completed result establishes a baseline. An increase is suggested only after a later completed result matches or improves a comparable entry for the same exercise, measurement, load type, and unit and the member has submitted an acceptable check-in. Missing check-in data, low comfort or energy, maximum difficulty, or a result below the prior comparable target produces a repeat/hold suggestion.

Progression output is advisory and does not mutate a workout or plan. A low-comfort, low-energy, or maximum-difficulty check-in may create one account-private proposal to reduce a planned set. The proposal captures the source workout, check-in revision, and exact plan revision. Accepting it requires a second explicit action and atomically compares and updates the plan while resolving the proposal; dismissing it resolves the proposal without touching the plan. Changed check-ins, stale plans, resolved proposals, cross-account requests, and replays fail closed. Training-block writes similarly use an exact per-account revision.

Training Memory compares only the same exercise, measurement, load type, and unit and shows the exact prior comparable sets and date. Suggested targets are reviewable values, not automatic prescriptions. Notes, RIR/RPE, set edits, warm-up calculations, plate calculations, and superset labels are explicit workout data. An in-session exercise replacement first discloses its target, equipment, FitScore, and stability trade-off. “This workout only” changes the active workout; the Plan path creates a separate reviewed proposal bound to the current Plan revision.

An already-open workout can continue through a dedicated generic offline shell. The normal online workout page records an account ID, access boundary, draft key, and server revision in a bounded local context after access has been confirmed. The shell can read only that matching device draft. Trial authorization never extends beyond the server-issued trial expiry. Grandfathered lifetime access is limited to 24 hours before an online recheck; recurring paid access also requires a verified future current-period end and is bounded to the earliest of 24 hours, that period end, or a scheduled cancellation/pause effective time. Reconnection first requires the same signed-in account and active access, then fetches the latest server revision. A conflict is shown for review and never overwritten automatically. The shell does not make an offline draft authoritative and cannot start a new server workout, authenticate, buy access, or alter Plan while offline.

Training-block review derives its displayed week from the saved start date rather than trusting a manually advanced counter. Planned and completed workout/set counts, muscle coverage, improvements, records, skips, and replacements come only from the loaded Plan and saved workout evidence. When evidence is unavailable, the interface says so instead of inferring progress. Carry, lighter-week, and finish actions each require review and change only the training-block record; the weekly Plan stays unchanged.

### Private coaching boundary

Nutrition (personal training and calorie counting) is a Strata+ card on Overview. Every coaching route requires an authenticated account with current Strata+ access; expired or absent access denies both reads and writes without changing stored coaching data. Writes additionally require a trusted same-origin JSON request, the live session's CSRF token, an expected revision, and a bounded request rate. The optional expected user ID lets the browser fail closed if an account changes while a form is open. Profiles, weekly snapshots, and daily logs are always selected from the authenticated account rather than a client-supplied owner ID.

The profile boundary accepts an exact, versioned field set: measurement units, height, weight, optional body-fat percentage, the energy-equation coefficient, goal and pace, experience, available days and session duration, equipment, movement limitations, optional known-exercise capabilities, calorie pattern, optional macro preference, time zone, and one nested `mealPreferences` object. Version 4 replaces the old whole-day activity field with ordinary daily movement outside planned workouts, other weekly activity minutes, and that other activity's light/moderate/vigorous intensity. Profile version is authoritative calculation state. Stored versions 1–2 keep the exact pre-7.10 resting-energy × legacy activity-factor semantics; version 3 keeps its whole-day 2023 EER semantics. All remain readable without mutation, and reads, week rollover, and deployment never reinterpret their answers. New setup and every explicit profile review/save write version 4, require ages 19–80 plus a published Mifflin coefficient, and require the member to answer the separated activity fields. The meal object records an explicit allergy state, supported allergen tags, a bounded other-or-uncertain-allergy note, dietary pattern, gluten-free or dairy-free requirements, favorite-food categories, a preferred 1–6 meals per day, and an optional whole-cent daily USD budget. Unknown fields, repeated days or movements, invalid catalog IDs, contradictory allergy states, impossible units, and out-of-range values are rejected. Entered sets, repetitions, and load are treated as unverified capability context and only cap the first-week prescription conservatively; they are not interpreted as tested one-repetition maximums or measured energy expenditure.

A weekly snapshot is generated from the canonical profile and its semantic version, revision, the Monday in the saved time zone, the exercise and meal catalog fingerprints, the generator and energy-model versions, and a bounded summary of observations from the 42 dates before that Monday. Model identifiers invalidate incompatible cached generation, but they never upgrade a profile by themselves. The same week and profile revision reuse the persisted snapshot; completing a diary entry does not move the current week's targets. Editing the profile deliberately creates a new current-week snapshot. In particular, reviewing and saving a version-1, version-2, or version-3 profile writes version 4 and makes the changed activity meaning explicit. The following Monday changes the key and rotates at least one eligible unconstrained movement. Exercise selection respects experience, session duration, equipment, and saved movement limitations and returns a reviewable constraint error when it cannot build a complete session. The snapshot stores its canonical profile inputs—including the profile version, separated activity fields, and nested food preferences—plus the calibration cutoff, counts, decision, assumptions, references, and safety caveats alongside the result. This private duplication keeps the generation evidence reviewable; it does not create a public profile. The detailed formulas and limits are recorded in [the coaching methodology](coaching-methodology.md).

Energy output exposes which profile semantics produced it. Versions 1–2 retain the exact earlier resting-energy × stored activity-factor baseline, return the Legacy profile calibration state with zero adjustment, and do not reinterpret the stored activity choice. Version 3 retains the 2023 adult DRI whole-day EER baseline and never adds workout energy to a category that already includes it. Version 4 starts with Mifflin–St Jeor resting energy, applies one reviewed normal-day movement anchor, and adds net energy from each usable generated session and separately entered weekly activity once. The form explicitly partitions usual work/chores/commuting from separately entered planned activity to reduce double counting. The 2023 EER is a visible population cross-check rather than an override. Optional body fat supplies a secondary Cunningham comparison and may restrict a deficit through a labeled fat-free-mass screen; a material Cunningham–Mifflin disagreement also widens the disclosed planning band used by the lower-scenario guard, but neither mechanism raises the maintenance midpoint. A compatible recent-weight change within 2% retains those restrictions, while a larger change withholds the stale composition estimate and blocks automated deficit generation pending profile review. Version-4 deficit pace is weight-relative and bounded by both 20% of maintenance and 500 kcal/day. Steady, generated-session-aware zigzag, and flexible-day patterns redistribute one exact weekly calorie budget; a pattern falls back to steady if variation would cross the conservative floor or no usable generated session can receive a training-day shift. Macros are optional. Weight values are broad 4-, 8-, and 12-week planning scenarios with uncertainty bands, not promised outcomes.

Daily writes are limited to the current coaching week and store calories, either all three macros or none, an optional morning weight, and a nullable complete-day state. Null preserves a legacy row's unknown completeness; only an explicit true value can qualify as calibration evidence. Before generation, the service requests the preceding 42-date owner/date range. The pure energy leaf may expose evidence counts for a version-1/version-2 profile but must return zero adjustment. Versions 3–4 require a recent aligned interval with at least 14 consecutive complete intake days, eight usable morning weights, and at least 14 days between endpoint weights. The leaf rejects excessive outliers, gaps, noise, implausible trends, and contradictory estimates, then shrinks and caps any accepted change. These gates are engineering heuristics rather than clinical or statistical validation. Profile and log revisions use compare-and-swap semantics so a stale tab receives the latest safe state for explicit review instead of overwriting it. The existing `(user_id, log_date)` primary key is the actual evidence lookup path, so no secondary index is added.

`GET /api/coaching/food-options/:date` is a private, read-only derivation over the authenticated account's saved profile, current weekly target, and saved intake for that date. The browser does not submit an owner, target, or nutrition catalog. `src/coaching.js` performs the account, entitlement, current-week, and date boundary checks, then calls the pure `src/meal-planning-core.js` leaf. That leaf subtracts saved intake from the day's target; applies supported allergen, dietary-pattern, and dietary-requirement filters before ranking; and returns deterministic menu alternatives with a catalog fingerprint, ingredient list, rounded nutrient totals, rough USD cost, and explicit limitations. An other-or-uncertain allergy state withholds automatic matching, and an empty eligible set never relaxes a hard filter. Favorite categories and budget affect ordering only. Meal options are generated on request and are not persisted as consumed food.

The Strata+ browser clears coaching profile fields, generated-week markup, projection output, intake values, and food-option markup before account revalidation, then reloads only after the same durable account and entitlement are confirmed. The Progress destination mirrors the account-backed daily intake entry and remaining-day options without creating a second source of truth. `personal-training-energy-ui-core.js` owns the version-4 movement/minutes/intensity form normalization and deliberately leaves older profiles unanswered until review; `personal-training-ui-core.js` owns the remaining profile conversion. `personal-training-meals-ui-core.js` normalizes the nested food-preference form and display units, while `discover-coaching-meals.js` owns the bounded food-option request and rendering flow. Coaching responses are private `no-store` data, and the service worker never caches or answers `/api/coaching/*`.

### Connected-device boundary

Polar connections are a Strata+ feature and each member connects only their own Polar account. Starting a connection requires the live session, CSRF token, trusted origin, JSON, and a rate limit; the server stores a hash of a random state bound to the account and the session token hash, valid for 10 minutes. Session cookies are `SameSite=Strict`, so Polar's redirect carries no session: the callback validates the state, parks `state.code` in an `HttpOnly`, `SameSite=Lax` cookie limited to `/api/devices/polar/complete`, and redirects to Account. Account then completes the link with a same-origin request, which consumes the state only for the same account and session. A code captured from another browser therefore cannot link a Polar account to someone else's STRATA account. V4 exposes neither a documented stable account subject nor the V3 numeric user id, so STRATA assigns each authorization a random local connection id. The database still guarantees one active Polar connection per STRATA account, but cannot safely detect independent V4 grants for the same Polar account across two STRATA accounts.

The V4 access token, refresh token, expiry, and granted scopes form one versioned envelope sealed with AES-256-GCM under `DEVICE_TOKEN_KEY`; responses and exports expose only status, times, and settings. Before a due sync, the worker refreshes credentials with five minutes of headroom and atomically stores any rotated refresh token before using the new access token. Plain V3 token records fail closed into reconnect. Every wellness write is joined to the member's current local connection id, so a slow sync cannot write data for a connection that was disconnected or replaced. V4 has no compatible webhook, app-user registration/deregistration, or revocation endpoint, so STRATA polls at least daily. Disconnect and the `BEFORE DELETE` account trigger erase the connection, sealed credentials, and imported rows locally; a member may separately withdraw Polar-side consent at `account.polar.com`. Wellness reads, recovery summaries, and the lighter-session offer are private `no-store` responses, and the service worker never caches `/api/devices/*` or `/api/wellness/*`.

### Server to storage

The store contract is the only application-facing database API. Both adapters use parameterized statements and normalized row/result semantics. Multi-record security changes—such as password reset plus session revocation, owner actions plus audit records, and entitlement transitions—belong in guarded database transactions or batches. An ordered migration ledger records each additive or reconciliatory step exactly once for both adapters; startup failure is safer than continuing against an unknown schema.

The server treats database errors as unavailable state, not permission to continue with a partial mutation. Production never falls back from Turso to local storage.

### Server to Resend

Resend is trusted only to deliver a prepared message. API keys and the independent verification HMAC secret remain in a private configuration side channel and are not enumerable in browser-safe status objects. Verification codes and account-action tokens are stored as purpose-bound digests rather than recoverable plaintext.

Delivery success does not replace database state checks. Challenges and actions still enforce generation, expiry, attempt, one-time use, address binding, and durable state transitions.

### Server to Paddle

The Paddle client token may be sent to the browser; the API key and webhook secret may not. Checkout transactions are created on the server for one configured $2.99 USD monthly price, quantity one, automatic collection, and fixed account metadata. A redirect or client callback is never proof of payment. A deployment must supply the recurring price ID explicitly; the retired one-time price is rejected and incomplete configuration keeps checkout disabled.

The server may also hold an operator-supplied `PADDLE_LEGACY_RECURRING_PRICE_IDS` allowlist. It is intentionally absent from the public payment configuration and is used only to validate, reconcile, and entitle subscriptions that began on an earlier monthly price. Every allowlisted price must still belong to the currently configured product, carry a monthly billing cycle, have quantity one, and match the exact account, checkout, purchase, and subscription trust chain. Transaction creation and Paddle item replacement always use only `PADDLE_PRICE_ID`, so the allowlist cannot sell an older price. Subscription catalog changes may move atomically from an exact allowlisted price to the current price, but never backwards or sideways between legacy prices. Every unfinished current checkout returned after creation, recovery, or catalog migration must identify its item as exactly 299 minor units in USD. Completed historical and grandfathered subscription events remain validated by their exact stored or allowlisted catalog identity rather than today's amount.

Webhook processing uses the exact raw request bytes for signature verification before JSON parsing. The completed initial transaction and subscription snapshot must agree with the locally pending transaction, account metadata, customer, product, price, quantity, automatic collection, and monthly billing cycle before paid access exists. A provider migration from an allowlisted monthly price to the current price updates the linked purchase and subscription catalog atomically in both adapters; partial or stale transitions fail closed and remain retryable. Stored event IDs make duplicate deliveries and replays idempotent; event occurrence times reject stale subscription updates. `active`, `trialing`, and `past_due` subscriptions retain access only with a verified future current-period end; a missing or expired bound fails closed, while `paused` and `canceled` do not grant access. A scheduled cancellation or pause stops access at its effective time even if a delayed provider update still reports an otherwise eligible status. Approved full refunds or chargebacks can revoke the associated purchase through recorded adjustments.

The account can request an authenticated, CSRF-protected Paddle customer-portal session. Returned overview, payment-method, and cancellation URLs must belong to Paddle's customer-portal host and match the stored customer/subscription pair. These provider-issued URLs are temporary and are returned with `no-store`; STRATA never persists them.

## Database flow and parity

`createStore()` selects Turso when `TURSO_DATABASE_URL` is present. Without it, non-production environments use local SQLite; production throws instead of accepting durable-looking data on an ephemeral disk.

Both stores are constructed through `defineStore()`, which checks the complete method set in `src/store-contract.js`. `src/schema.js` and focused schema modules centralize statements; `src/migrations.js` orders schema evolution. Adapter-specific code is limited to transport, row normalization, transaction mechanics, and affected/returned-row interpretation.

Parity tests should compare observable results rather than private implementation details. Important parity surfaces include:

- nulls, numeric fields, timestamps, and returned rows;
- unique and foreign-key behavior;
- compare-and-swap plan revisions and atomic plan/preferences setup;
- owner-scoped check-ins and training blocks, exact block revisions, and atomic proposal/plan acceptance;
- owner-scoped coaching profiles (including the calculation-semantics version and food preferences), deterministic week snapshots that repeat their canonical profile inputs, daily logs, and profile/log compare-and-swap revisions;
- one-time verification and account-action claims;
- session and credential-version revocation;
- selective and all-other session revocation plus owner-scoped export selection and stable workout keyset paging;
- admin mutations with their audit record;
- checkout claims, transaction-to-subscription linking, ordered subscription state, grandfathered lifetime access, webhook replay records, and adjustments; and
- cleanup and cascade behavior.

The training-loop, coaching, and billing-subscription tables are additive. Their keys and indexes match actual owner/workout, owner/week, owner/date, pending-proposal, and subscription-by-account reads. Build 7.9 added no table or index because nested food preferences use the existing versioned coaching-profile JSON. Build 7.10's idempotent migration adds nullable morning-weight and intake-completeness columns to the existing daily-log table in both adapters; the owner/date primary key already serves its bounded calibration lookup. Account export includes the canonical profile, its private weekly-snapshot copy, and the new daily evidence, while account deletion removes every coaching record through the same SQLite/Turso cleanup. The product-signal table is an intentional exception to user-owned application records: both adapters expose only daily increment, bounded-range count read, and retention delete operations. Its primary key is the actual lookup and update pattern; no speculative secondary index or raw-event table exists.

Add an index only for a demonstrated high-frequency lookup, join, ordering, or cleanup pattern. Keep its definition shared and cover it through behavior/query-plan evidence; speculative indexes slow writes and make adapter parity harder to maintain.

## Paddle lifecycle

1. An authenticated, CSRF-protected request claims one checkout creation for the account.
2. The server asks Paddle to create an automatically collected, quantity-one transaction for the explicitly configured monthly price/product and account metadata.
3. The durable purchase record stores the provider transaction before the browser receives its checkout reference.
4. A signed `transaction.completed` event or an authenticated Paddle recovery read records the completed initial payment and subscription/customer link, but paid access still requires validated signed subscription state.
5. Signed `subscription.created` and `subscription.updated` events validate ownership, customer, monthly billing cycle, catalog, occurrence order, and the current-period boundary. `active`, `trialing`, and `past_due` grant access only before that verified end; `paused` and `canceled` deny it.
6. A scheduled cancellation or pause leaves an otherwise eligible subscription usable only until its effective timestamp, and never beyond the current-period end. The Account page links to a short-lived Paddle portal for management.
7. Duplicate webhook event IDs return an idempotent replay outcome, and stale subscription events cannot regress newer state.
8. Later ordered transaction events update pending state without overriding a terminal completion. Applicable adjustment events are upserted and may revoke the corresponding purchase.

STRATA has no free trial. `POST /api/discovery/trial` answers `410 TRIAL_RETIRED` for installed apps from earlier builds, the store has no trial table, and `/api/me` carries no trial state. Build 9 archived the last legacy trial rows under `archive_discovery_trials` (migration `008-build9-retired-tables`); they grant nothing. A previously completed, unrevoked one-time lifetime purchase remains valid without requiring or fabricating a monthly subscription row.

Checkout recovery is bounded and validates every provider response, pagination link, and durable account reference. Account deletion reconciles or blocks unsettled checkout work so a late webhook cannot recreate access for a deleted user.

## Resend lifecycle

Signup creates a short-lived pending verification challenge, reserves a send slot, stores a purpose- and generation-bound digest, and then sends the code. The user row and normal session are created together only after the correct code is atomically claimed. Login verification follows the same challenge boundary for accounts that need it.

Password-reset and account-deletion links put the random bearer value in the URL fragment, keeping it out of ordinary server access logs and referrer paths. The browser posts it explicitly to a status or completion endpoint. Tokens expire, are purpose-bound, and are consumed once. Provider errors never silently turn an unverified or incomplete action into success.

## PWA architecture

The manifest supplies the full-scope install metadata, icons, theme, and shortcuts. `public/scripts/pwa.js` registers the worker with `updateViaCache: "none"` and owns the deferred browser install prompt.

The worker cache name includes the application build. Install precaches one literal allowlist; activate deletes older caches with the STRATA prefix while preserving unrelated origin caches, then claims clients. Successful same-origin GETs enter runtime caching only when their complete URL—including an expected build query—is in the public asset allowlist. Unexpected query variants cannot create unbounded cache entries. Self-hosted fonts and editorial photography are ordinary public assets; normal rendering does not call Google Fonts or Unsplash. The public product-signal script and styles may be cached like other versioned interface assets, while `/api/product-signals` remains network-only under the complete `/api/` exclusion.

Navigation is network-first. When offline, designated public information/planner pages may use their matching cached HTML and `/workout` may use the generic workout-continuation shell described above; all other navigation falls back to the generic offline page. Paddle transaction-return URLs never use cached pricing. API/auth/liveness/readiness paths—including every check-in, progression, block, adaptation, coaching profile/week/log/food-option, subscription, portal, and account endpoint—cross-origin requests, non-GET requests, and unlisted non-navigation assets bypass the worker. Same-origin private-page navigations may pass through that network-first handler, but the worker never caches personalized HTML or serves it from Cache Storage or as an offline account fallback; a network failure returns only a generic public fallback or the separately guarded workout shell.

Private server responses also carry `no-store`. The service-worker exclusion is one layer, not a substitute for correct HTTP caching headers.

## Quality and change discipline

`npm run check` is the default pre-commit command: release consistency, module-architecture constraints, static boundary typing, correctness-focused ESLint, the coverage-gated Node suite, runtime QA, reproducible performance checks, and the high-risk browser E2E journeys. `docs/testing.md` defines the unit, integration, contract, and E2E layers, including the real-server coaching journey through profile generation, weekly rendering, food-option constraints, intake persistence, conflict recovery, and account-state purging. `docs/performance.md` records what the local performance evidence can and cannot prove. The CI compatibility matrix adds Chromium, Firefox, WebKit, keyboard navigation, axe serious/critical rules, 200% text sizing, and narrow-to-wide reflow checks. Local Darwin runs default to Chromium and WebKit because Playwright Firefox cannot use its headless framebuffer in the Codex app sandbox; `STRATA_E2E_ENGINE=firefox npm run test:e2e` remains an explicit diagnostic. The broader authenticated layout audit remains available through `npm run qa:ui`.

When adding a module or route:

1. identify its trust boundary and authoritative state;
2. inject dependencies rather than reaching around the composition root;
3. update the explicit store/static/route contract when applicable;
4. test denied, expired, replayed, concurrent, and provider-failure paths;
5. verify SQLite/Turso observable parity;
6. confirm private responses and PWA exclusions; and
7. run `npm run check`, the broader UI audit when relevant, and the production dependency audit.
