# Module architecture evidence

Build 8.0.1 keeps extraction as an enforceable boundary. `npm run architecture:check` inventories both server JavaScript and the seven largest interactive browser surfaces. It reports physical lines, nonblank lines, bytes, reviewed line budgets, and every statically analyzable local dependency. It fails when a module exceeds its budget, gains an unapproved dependency, is omitted from the relevant policy, loads out of dependency order, references a missing local module, introduces a dependency cycle, or uses server module loading that cannot be audited.

The policies live in `architecture-policy.json` and `frontend-architecture-policy.json`; they should change only with an intentional architecture review. A larger line budget is not the default response to a failure: first decide whether the module has accumulated another responsibility.

## Dependency direction

Build 8.0.0 added focused modules for coaching evidence, energy calibration, sensitivity scenarios, training selection, and exercise prescriptions. The current profile-version-4 work adds one pure server activity-budget leaf and one pure browser energy-field leaf. The current inventory covers 54 server modules and 74 browser modules across 7 page boundaries. Existing module budgets remain enforced; new responsibilities have their own reviewed limits.

```text
root bootstrap
    └── HTTP composition root
          ├── auth service ── account self-service ── account-export serializer
          ├── billing service ── checkout policy ── Paddle provider boundaries
          ├── admin service ── administrator actions ── access-control rules
          ├── support/setup/training services
          ├── coaching service
          │     ├── coaching core
          │     │     ├── energy-planning core
          │     │     │     ├── energy-activity core
          │     │     │     ├── energy-calibration core
          │     │     │     ├── energy-scenarios core
          │     │     │     └── Plan date catalog
          │     │     ├── coaching-training core
          │     │     │     ├── coaching-prescription core ── progression ── Plan catalog
          │     │     │     └── Plan exercise catalog
          │     │     ├── meal-planning core
          │     │     └── Plan catalog
          │     ├── coaching-evidence helper ── coaching core / calibration constants
          │     ├── energy-calibration constants
          │     └── meal-planning core (shared downward leaf)
          ├── product-signal boundary
          ├── database adapter
          │     ├── account self-service store ── account query catalog
          │     ├── billing store ── billing schema
          │     ├── coaching store ── coaching schema
          │     ├── migration ledger / shared schema ── focused schema leaves
          │     ├── training-loop store ── training-loop schema
          │     └── store contract
          ├── structured observability
          └── static and HTTP helpers
```

The HTTP root supplies services and adapters through explicit factories. Services do not import the composition root or construct storage. Coaching evidence receives narrow store capabilities from the service; the generation, prescription, progression, energy, activity, and meal cores remain independent of storage and HTTP. Activity budgeting, calibration, sensitivity scenarios, and meal planning do not access storage or HTTP. The exact edge inventory appears in the generated server table below.

Missing catalog coverage yields explicitly partial or unavailable training sessions. This preserves calorie and diary access for valid older equipment-limited profiles without widening their equipment, level, or movement restrictions.

## Current server boundary

`src/coaching.js` owns entitlement, account, request, revision, and date checks. `src/coaching-evidence.js` assembles owner-filtered observations: up to 42 prior diary days, six prior coaching snapshots, and the latest 100 workout summaries with full records from the preceding 56 days. Missing, malformed, truncated, or concurrently changed workout records mark the history incomplete. Historical calorie targets retain their original profile and week; identity checks and date bounds prevent another week's snapshot from replacing them. Same-profile-revision snapshot creation keeps the first persisted result, while an explicit profile revision can replace the current week's snapshot.

`src/coaching-core.js` validates the versioned profile and composes the weekly result. `src/energy-planning-core.js` preserves exact version-1/version-2 resting-energy behavior, version-3 whole-day adult EER behavior, and dispatches version 4 to `src/energy-activity-core.js`. That pure leaf combines a reviewed non-workout movement anchor with net energy from usable generated sessions and separately entered weekly activity; it has no access to account data, storage, or HTTP. The calibration leaf aligns complete intake with morning weights, qualifies intervals, reports evidence quality, and bounds updates. The scenario leaf owns the explicitly labeled sensitivity model. `src/coaching-training-core.js` selects repeatable exercises, fits the estimated duration, and counts direct working sets before energy planning consumes the resulting session durations. `src/coaching-prescription-core.js` preserves measurement and assistance semantics and reuses `src/progression.js` for conservative completed-set targets. `src/meal-planning-core.js` owns food constraints, the bundled recipe catalog, provenance, and calorie/macronutrient-aware options. These are planning suggestions; generation does not write the saved Plan. Version 3 never receives added workout energy; version 4 counts each separated activity source once.

The coaching HTTP boundary is 134 physical lines, its core 132, and its evidence helper 84. Activity budgeting is 49 lines; energy planning, calibration, and scenarios are 116, 152, and 27. Training selection and prescriptions are 107 and 87; meal planning is 168. The HTTP composition root remains at 798 lines under its 800-line ceiling, and the dual database adapter remains at 1,198 under 1,200. The existing coaching schema and parity adapter own persistence, including the nullable morning-weight and intake-completeness fields introduced by migration `005-coaching-calibration`; the new activity fields remain inside the already-versioned coaching-profile JSON. The existing owner/date key serves bounded 42-date diary reads.

Earlier extraction boundaries remain intact: billing delegates provider validation and checkout retirement, authentication delegates account self-service and bounded export serialization, and the database adapter delegates focused schema and storage responsibilities. The current server report has 54 modules, zero dependency cycles, and zero policy violations.

## Browser boundaries

Build 8.0.1 keeps the existing Home, Plan, Train, and Strata+ page boundaries. `personal-training-energy-ui-core.js` now owns validation and compatibility shaping for the separated daily-movement, additional-minutes, and intensity fields. It deliberately returns an unanswered movement choice for older profiles so the browser cannot silently reinterpret them. `personal-training-ui-core.js` owns unit conversion, the remaining profile and training-goal form values, progress math, and presentation of server estimates. `personal-training-diary-ui.js` owns historical date/target selection and draft comparisons. `personal-training-meals-ui-core.js` owns food preferences, remaining-nutrition shaping, and formatting. `discover-coaching-meals.js` handles food-option requests and rendering; `discover-coaching.js` retains coaching state, profile/log events, conflicts, and private-state clearing. `discover-coaching-render.js` presents the server's activity breakdown, population cross-check, deficit guardrails, calibration quality, sensitivity ranges, workout durations, and direct muscle coverage without recalculating the model. The existing Strata+ API leaf remains the single HTTP transport boundary.

The current report inventories 74 modules across 7 page boundaries, with zero cycles and zero policy violations. The Strata+ coordinator is 722 physical lines under its 730-line ceiling. The energy-field leaf is 48 under 80, the personal-training UI core is 215 under 220, the diary leaf 15 under 80, and the coaching renderer 101 under 110. Food-preference logic is 84 under 140, food-option events/rendering 62 under 120, and coaching events 67 under 100. Progress and Personal training share the account-backed diary and its server-provided historical targets.

Home still coordinates comparison state through its existing logic, state, API, rendering, and event modules. Plan retains its canonical empty-plan, save, reset, and conflict boundaries. Train retains focused workout context and progression renderers. The pure `session-selection-core.js` retains the four explicit workout-builder selection modes; its form events remain in `discover-session.js`.

`frontend-architecture-policy.json` enforces one-way, page-local boundaries for Home, Strata+, Plan, Train, Pricing, Account, and Admin. Each page supplies logic, mutable state, same-origin API access, rendering, event binding, and exactly one final coordinator. Shared cores load before consumers. The report resolves CommonJS imports and published `Strata*` globals, checks dependency direction, and verifies the HTML script order.

```text
shared domain logic
    → page logic
    → page state
    → same-origin API
    → rendering
    → event binding
    → page coordinator
```

This graph is page-specific: it does not permit calls into unrelated page coordinators. The application keeps its existing HTML/CSS and public URLs while moving reusable calculations, transport, state, and rendering into independently testable modules.

### Browser size result

The original coordinator sizes below provide historical context; the after sizes and leaf counts are the current Build 8.0.1 report:

| Page | Coordinator before → after | Extracted modules (physical lines) |
| --- | ---: | --- |
| Home | `app.js` 626 → 146 | logic 117; state 36; API 24; render 154; events 63 |
| Strata+ | `discover.js` 1,364 → 722 | state 54; API 51; navigation 110; progress logic 74; base render 47; coaching render 101; catalog 86; detail 54; community 52; session 60; selection logic 158; energy-field logic 48; coaching logic 215; diary logic 15; meal UI logic 84; sharing 31; events 64; food-option events/rendering 62; coaching events 67 |
| Plan | `planner.js` 1,233 → 679 | logic 83; state 60; API 36; render 75; conflicts 106; templates 82; sharing 120; activation 96; events 147 |
| Train | `workout.js` 784 → 397 | state 57; API 52; calendar logic 29; progression logic 92; base render 66; context render 65; guidance 109; history 113; events 99 |
| Pricing | `pricing.js` 414 → 213 | logic 56; state 17; API 30; render 109; events 22 |
| Account | `account.js` 835 → 271 | logic 238; state 31; API 68; render 186; events 44 |
| Admin | `admin.js` 848 → 203 | state 53; logic 92; API 45; render 189; session 53; events 53 |

These totals are not presented as deleted functionality: much of the former coordinator code moved into named leaves, and new user-facing behavior was added. The evidence of improvement is the enforced direction, independent tests, smaller orchestration roots, and zero-cycle report—not a lower aggregate line count. `node scripts/frontend-architecture-report.js` prints the exact live line/nonblank/byte table and every resolved dependency for all 74 browser modules across seven page boundaries.

## Resulting module sizes

The command-generated table below is the current server snapshot. CI generates the same table on every architecture check, while the policy enforces budgets and edges against the live sources.

| Module | Responsibility | Lines | Nonblank | Size | Line budget | Local dependencies |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `server.js` | Process bootstrap | 4 | 3 | 113 B | 20 | `src/server.js` |
| `src/access-controls-schema.js` | Admin grant and checkout hold schema and authorization guards | 22 | 22 | 2.4 KiB | 55 | — |
| `src/access-controls-store.js` | Atomic audited account controls for SQLite and Turso | 34 | 34 | 2.1 KiB | 65 | `src/access-controls-schema.js` |
| `src/access-controls.js` | Complimentary access state and duration validation | 35 | 34 | 2.1 KiB | 65 | — |
| `src/account-export.js` | Bounded streaming account export serialization | 83 | 77 | 8.2 KiB | 120 | — |
| `src/account-self-service-schema.js` | Account self-service query catalog | 37 | 35 | 4.7 KiB | 55 | — |
| `src/account-self-service-store.js` | SQLite and Turso account self-service storage parity | 72 | 67 | 4.2 KiB | 95 | `src/account-self-service-schema.js` |
| `src/account-self-service.js` | Authenticated session inventory, revocation, and privacy-safe data export | 84 | 80 | 6.2 KiB | 150 | `src/account-export.js` |
| `src/admin-mfa.js` | Session-bound administrator email MFA challenge and delivery | 62 | 55 | 4.6 KiB | 100 | — |
| `src/admin-user-actions.js` | Audited administrator account and payment actions | 87 | 86 | 9.2 KiB | 160 | `src/access-controls.js`, `src/plans.js` |
| `src/admin.js` | Administrative authorization and actions | 209 | 195 | 12.4 KiB | 280 | `src/access-controls.js`, `src/admin-user-actions.js`, `src/plans.js` |
| `src/auth.js` | Authentication and account lifecycle | 812 | 769 | 53.4 KiB | 840 | `src/account-self-service.js`, `src/email.js`, `src/plans.js` |
| `src/billing-schema.js` | Commercial entitlement and recurring-subscription schema | 126 | 120 | 17.6 KiB | 140 | — |
| `src/billing-store.js` | SQLite and Turso commercial storage parity | 240 | 233 | 22.8 KiB | 240 | `src/access-controls-schema.js`, `src/billing-schema.js` |
| `src/billing.js` | Commercial entitlement, checkout, trial, webhook, and reconciliation service | 719 | 690 | 44.5 KiB | 720 | `src/access-controls.js`, `src/checkout-reconciliation.js`, `src/http.js`, `src/legacy-checkout.js`, `src/payments.js`, `src/plans.js` |
| `src/checkout-reconciliation.js` | Validated checkout closure and settlement reconciliation | 99 | 98 | 8.0 KiB | 130 | `src/legacy-checkout.js`, `src/payments.js`, `src/plans.js` |
| `src/coaching-core.js` | Validated coaching inputs and deterministic weekly training composition | 132 | 125 | 19.6 KiB | 300 | `src/coaching-training-core.js`, `src/energy-planning-core.js`, `src/meal-planning-core.js`, `src/plans.js` |
| `src/coaching-evidence.js` | Owner-filtered coaching history and original-target diary assembly | 84 | 78 | 6.9 KiB | 130 | `src/coaching-core.js`, `src/energy-calibration-core.js` |
| `src/coaching-prescription-core.js` | Measurement-aware prescriptions from comparable completed training history | 92 | 91 | 12.2 KiB | 180 | `src/progression.js` |
| `src/coaching-schema.js` | Coaching profile, weekly snapshot, and daily-log schema | 50 | 47 | 4.5 KiB | 80 | — |
| `src/coaching-store.js` | SQLite and Turso coaching storage parity | 48 | 42 | 3.9 KiB | 80 | `src/coaching-schema.js` |
| `src/coaching-training-core.js` | Repeatable goal-specific training composition with duration and coverage accounting | 107 | 106 | 13.3 KiB | 220 | `src/coaching-prescription-core.js`, `src/plans.js` |
| `src/coaching.js` | Strata+ coaching profile, weekly snapshot, and daily-log API | 134 | 130 | 14.0 KiB | 180 | `src/coaching-core.js`, `src/coaching-evidence.js`, `src/energy-calibration-core.js`, `src/meal-planning-core.js` |
| `src/database.js` | SQLite and Turso store adapters | 1198 | 1171 | 63.8 KiB | 1200 | `src/access-controls-store.js`, `src/account-self-service-store.js`, `src/billing-store.js`, `src/coaching-store.js`, `src/migrations.js`, `src/schema.js`, `src/store-contract.js`, `src/training-loop-store.js` |
| `src/email.js` | Resend integration and email security | 388 | 355 | 19.9 KiB | 400 | `src/admin-mfa.js` |
| `src/energy-activity-core.js` | Profile-v4 non-workout and generated-session activity energy budget | 51 | 48 | 3.7 KiB | 100 | — |
| `src/energy-calibration-core.js` | Aligned intake/weight estimation, quality diagnostics, and bounded weekly adaptation | 156 | 151 | 22.7 KiB | 220 | — |
| `src/energy-planning-core.js` | Versioned energy estimation, bounded trend calibration, and nutrition planning | 117 | 108 | 21.6 KiB | 190 | `src/energy-activity-core.js`, `src/energy-calibration-core.js`, `src/energy-scenarios-core.js`, `src/plans.js` |
| `src/energy-scenarios-core.js` | Explicit dynamic sensitivity scenarios with propagated maintenance uncertainty | 27 | 25 | 2.9 KiB | 100 | — |
| `src/http.js` | HTTP transport helpers | 170 | 155 | 5.9 KiB | 180 | — |
| `src/legacy-checkout.js` | Strict retired-checkout migration and completion policy | 71 | 66 | 7.4 KiB | 75 | `src/payments.js` |
| `src/meal-planning-core.js` | Validated dietary preferences and deterministic remaining-day food options | 168 | 157 | 25.6 KiB | 300 | — |
| `src/migrations.js` | Ordered, idempotent SQLite and Turso schema migration ledger | 143 | 130 | 7.8 KiB | 145 | `src/billing-schema.js` |
| `src/observability.js` | Structured request tracing and redacted operational logging | 81 | 72 | 4.0 KiB | 90 | — |
| `src/paddle-catalog.js` | Paddle catalog, credential, exact checkout-price, and subscription-transition policy | 72 | 68 | 4.7 KiB | 80 | — |
| `src/paddle-checkout-retirement.js` | Interrupted Paddle checkout retirement policy | 52 | 45 | 3.3 KiB | 80 | — |
| `src/paddle-subscriptions.js` | Recurring subscription validation and temporary customer-portal links | 136 | 129 | 8.2 KiB | 165 | — |
| `src/paddle-webhooks.js` | Paddle signature and webhook source verification | 118 | 108 | 4.6 KiB | 150 | — |
| `src/payments.js` | Paddle integration boundary | 419 | 396 | 20.9 KiB | 430 | `src/paddle-catalog.js`, `src/paddle-checkout-retirement.js`, `src/paddle-subscriptions.js`, `src/paddle-webhooks.js` |
| `src/plans.js` | Plan domain validation | 355 | 321 | 18.5 KiB | 380 | — |
| `src/product-signals-schema.js` | Aggregate product-activity schema and statements | 23 | 20 | 1.4 KiB | 35 | — |
| `src/product-signals.js` | Consent-gated aggregate product-activity boundary | 135 | 122 | 5.5 KiB | 140 | — |
| `src/progression.js` | Pure per-set performance progression and comparison rules | 177 | 175 | 13.2 KiB | 300 | `src/plans.js` |
| `src/schema.js` | Shared storage schema and statements | 364 | 358 | 44.3 KiB | 390 | `src/access-controls-schema.js`, `src/account-self-service-schema.js`, `src/billing-schema.js`, `src/coaching-schema.js`, `src/product-signals-schema.js`, `src/training-loop-schema.js` |
| `src/server.js` | HTTP composition root | 800 | 775 | 42.3 KiB | 800 | `src/access-controls.js`, `src/admin.js`, `src/auth.js`, `src/billing.js`, `src/coaching.js`, `src/database.js`, `src/email.js`, `src/http.js`, `src/observability.js`, `src/payments.js`, `src/plans.js`, `src/product-signals.js`, `src/service-composition.js`, `src/setup.js`, `src/static-assets.js`, `src/support.js`, `src/training.js`, `src/workouts.js` |
| `src/service-composition.js` | Typed auth/admin/support composition | 40 | 38 | 1.8 KiB | 60 | — |
| `src/setup.js` | Atomic weekly-plan and preference setup | 84 | 77 | 4.9 KiB | 105 | `src/plans.js` |
| `src/static-assets.js` | Bounded public asset representations | 46 | 41 | 1.9 KiB | 65 | `src/http.js` |
| `src/store-contract.js` | Storage boundary contract | 175 | 172 | 4.7 KiB | 175 | — |
| `src/support.js` | Public and administrative support workflow | 137 | 129 | 10.0 KiB | 160 | `src/email.js`, `src/plans.js` |
| `src/training-loop-schema.js` | Check-in, training-block, and adaptation storage schema | 57 | 54 | 6.4 KiB | 70 | — |
| `src/training-loop-store.js` | SQLite and Turso training-loop adapter parity | 136 | 133 | 7.1 KiB | 140 | `src/training-loop-schema.js` |
| `src/training.js` | Check-ins, deterministic progression, blocks, and approved adaptations | 358 | 346 | 24.8 KiB | 450 | `src/plans.js`, `src/progression.js` |
| `src/workouts.js` | Workout validation, history summaries, and authenticated lifecycle | 214 | 208 | 14.3 KiB | 230 | `src/plans.js` |

Snapshot result: 54 server modules, zero dependency cycles, and zero policy violations. The separate browser report covers 7 page boundaries and 74 browser modules with zero cycles and zero violations.

## Static boundary types

`tsconfig.boundaries.json` runs TypeScript in strict `allowJs` plus `checkJs` mode with no output. The enforced slice covers HTTP transport, Paddle transaction/subscription/webhook validation, billing policy, account self-service and its two store implementations, store registration, setup, product signals, the training loop, coaching evidence and prescriptions, activity budgeting, energy calibration and sensitivity scenarios, and meal-option generation/API/schema/storage, workouts, and the production service composition. Shared declarations in `src/domain-types.d.ts`, `src/plans.d.ts`, and `src/workouts.d.ts` keep untrusted payloads unknown until validation narrows them; preserve the versioned daily-movement, additional-activity, and generated-session energy fields at the coaching boundary; type nullable morning-weight and intake-completeness observations; and keep injected capabilities smaller than the full application store.

This is an incremental boundary strategy rather than a cosmetic file-extension migration. It does not claim that every browser DOM controller or every legacy service implementation is fully typed. Runtime guards, focused tests, and the architecture edge policy remain necessary alongside static checking.

## Interpreting the result

Line counts are a maintenance signal, not a quality score. They matter here because they are paired with dependency direction and a cycle gate: a small cyclic module or a thin pass-through split would not be an improvement. Future additions to authentication, billing, the dual adapter, or the composition root should first ask whether the responsibility belongs in an existing leaf or a new independently testable boundary rather than automatically increasing a ceiling.
