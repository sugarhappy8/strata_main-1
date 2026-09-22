# STRATA — Exercise Rankings and Workout Planning

STRATA is an evidence-informed workout index with server-backed, email-verified accounts, a private Strata+ studio, and weekly, community, and monthly workout planning. It includes 320 resistance-training exercises—including 71 bodyweight options—across 8 muscle groups and 26 sub-muscle targets. Build 8.5.0 is an installable Progressive Web App (PWA) with Training Memory, Resend-powered account email, Paddle-powered Strata+ subscriptions, and a private owner dashboard.

**Build 8.5.0 is the navigation and everyday-use release.** Strata+ now has six visible destinations: Overview, Plan, Train, Nutrition, Progress, and Exercises. Nutrition owns calorie and weight logging and meal suggestions; Plan owns generated training weeks, with an explicit review before replacing the saved week used by Train. A shared personal setup feeds both. Homepage shortcuts, compact page headings, mobile wayfinding, and progressively disclosed calculation details make the common actions easier to find. The individualized activity calculations and cautious calibration from 8.0.1 are preserved. See the [8.5.0 release guide](docs/release-8.5.0.md) and [coaching methodology](docs/coaching-methodology.md).

The [7.9.0 release](docs/release-7.9.0.md) added constraint-aware daily food options based on saved dietary pattern, supported allergies or uncertainty, dietary requirements, favorite-food categories, meal count, optional budget, and that day's remaining calorie and macro targets. Hard filters are never relaxed, and results disclose cross-contact, editorial nutrition estimates informed by generic FoodData Central values, and rough non-live cost limitations.

The [7.8.8 release](docs/release-7.8.8.md) redesigned the coaching profile as a guided four-step surface with separate cards, compact mobile orientation, labeled known-exercise inputs, 200% text reflow, and stronger contrast. It also moved new checkout to $2.99 USD monthly, failing closed unless Paddle confirms the exact 299-cent recurring catalog item while a server-only allowlist can preserve qualifying existing subscribers on an earlier recurring price.

The [7.8.7 release](docs/release-7.8.7.md) expanded the library to 320 movements and introduced transparent Personal training and calorie counting. It uses the member's measurements, goals, schedule, experience, equipment, movement limitations, and optional known lifts to build a stable current-week plan, calorie schedule, optional macro targets, intake log, and explicitly uncertain weight scenarios. Formula sources and safety limits remain documented in the [coaching methodology](docs/coaching-methodology.md).

**Build 7.8.3 restored STRATA's established visual identity and clarified Strata+.** The weekly plan is again the clear center of Plan, secondary tools are progressively disclosed, Today now distinguishes no-plan, next-scheduled, and active-session states, Train handles an empty selected day explicitly, and Progress never presents blank statistics as results. The 7.8.2 performance-based weight progression remains intact. See the [7.8.3 release guide](docs/release-7.8.3.md) for behavior and validation.

The [7.8.0 release](docs/release-7.8.0.md) established the training loop from week preview through account verification, a deliberate seven-day no-card trial, Plan review, training, and completed-workout evidence. Its Paddle lifecycle protections and enforced logic, state, API, rendering, event, and coordinator boundaries remain in place across the seven largest browser surfaces; Build 8.5.0 also preserves the direct sole-owner Admin workflow from 7.8.4, the interrupted-checkout deletion recovery from 7.8.5, and the previous releases' Plan/comparison, coaching, and food-option refinements. See [release readiness](docs/release-readiness.md) and the [founder plan](docs/founder-plan.md).

STRATA also includes a login-free local weekly planner, account-synced plans, structured community-plan sharing, a deterministic 31-day workspace, community ratings, printable exports, and a private administrator help desk. Strata+ is a **$2.99 USD per month recurring subscription** and offers one optional free 7-day trial per eligible account. The trial requires no card, ends automatically, and never converts into a subscription; subscribing always requires explicit checkout. Paddle is the merchant of record, and the server grants paid access only after a matching transaction is provider-verified and linked to validated signed subscription state. Prior lifetime buyers remain grandfathered with no recurring charge.

See [CHANGELOG.md](CHANGELOG.md) for the concise release history.

Start at `/` for the no-account recommendation and complete-week preview, `/planner.html` for free manual planning, or `/discover.html` for the private five-destination Strata+ workspace: Today, Plan, Progress, Explore, and Personal training and calorie counting. A guest week remains on the device through signup and is never allowed to overwrite an account Plan without a visible claim, compare, or keep choice. Signed-in plans, workouts, optional check-ins, training blocks, coaching profiles and weekly snapshots (including saved food preferences), daily nutrition logs with optional morning-weight and completeness evidence, and approved adaptations sync to the account. Remaining-day food options are derived when requested and are not stored as food eaten.

## Requirements

- Node.js 24.x (the included `.node-version` selects the supported major)
- npm

## Quick start

```bash
npm ci
npm start
```

Open `http://127.0.0.1:4173`. Local development creates `data/strata.sqlite`; a Turso account is not required.

Copy `.env.example` to `.env` and fill in the required values when testing email, admin, proxy, or payment configuration. `npm start` loads `.env` if present; host-provided environment values take precedence. Keep database tokens, email secrets, Paddle API keys, webhook secrets, and private promotion codes out of Git, browser code, logs, screenshots, and chat.

## Project structure

Build 8.5.0 separates browser files from private server code while preserving every public URL used by visitors, Paddle, Render, and installed PWAs:

```text
server.js          Stable npm/Render bootstrap
src/               Private application modules, storage adapters, and schema
scripts/           Allowlisted release-version tooling
public/pages/      HTML served at stable public routes
public/scripts/    Browser JavaScript
public/styles/     Browser stylesheets
public/data/       Intentionally public exercise catalog
public/icons/      PWA and site icons
public/fonts/      Self-hosted interface fonts
public/images/     Public product and editorial artwork
data/              Generated local SQLite data; ignored by Git
test/              Unit, integration, and contract Node tests
qa/e2e/            Isolated browser-level security journeys
qa/                Runtime and optional broader browser checks
docs/              Architecture and deployment guidance
```

See [docs/architecture.md](docs/architecture.md) for request and data flow, [docs/module-architecture.md](docs/module-architecture.md) for the enforced dependency graph and module sizes, and [docs/testing.md](docs/testing.md) for test-layer boundaries.

## Quality commands

```bash
npm run check       # complete release gate, including browser E2E
npm run architecture:check # module budgets, dependencies, and cycles
npm run typecheck   # strict checkJs at domain boundaries
npm run lint        # correctness-focused ESLint checks; no formatting policy
npm test            # Node test suite
npm run test:unit   # focused tests with mocked/injected collaborators
npm run test:integration # HTTP/application composition tests
npm run test:contract    # storage and architecture contracts
npm run test:e2e    # isolated high-risk browser journeys
npm run coverage    # Node suite with enforced coverage floors
npm run performance # reproducible endpoint/storage regression evidence
npm run qa:runtime  # browser-free runtime smoke checks
npm run qa:ui       # optional Playwright accessibility/layout audit
npm run load:100    # 100 simultaneous accounts, isolated Linux loopback
npm run load:100:shared # same workload behind one shared IP
```

Coverage is enforced at calibrated application-code floors, not chased to 100%. Performance budgets are conservative regression tripwires, not production capacity claims. See [docs/testing.md](docs/testing.md), [docs/performance.md](docs/performance.md), and [qa/README.md](qa/README.md) for exact scope and prerequisites.

Before a release, audit managed version references with `npm run release:check`. Preview a bump with `npm run release:version -- --dry-run x.y.z` or `x.y.z.NNN`, then apply it without `--dry-run`. Four-part public builds retain an npm-compatible three-part package version and store the exact public build in `strataBuild`. The tool changes only its explicit release manifest.

## Accounts, plans, and administrator access

- Passwords use scrypt with a unique random salt; plaintext and reversible passwords are never stored.
- Sessions are random database-backed tokens in HttpOnly, SameSite cookies. Sensitive writes also require a same-session CSRF token and trusted origin.
- Signup verification, password reset, and account deletion use time-limited email flows. Reset revokes every session; deletion requires a one-time registered-email confirmation.
- Signed-in members can review active session times, sign out one or all other sessions without exposing token/IP/device details, and download a private `no-store` JSON export of their account training and support data.
- Signed-out plans stay in that browser. Signed-in weekly and monthly plans are private account records and sync through the configured store.
- Community plans publish validated structured workout data and a display name, never the member's email address or a binary upload.
- The one verified account matching server-only `ADMIN_EMAIL` may become the permanently bound primary owner. That bound owner opens Admin with its normal live account session; Admin does not ask for a second password or email code.
- Each Admin mutation retains one explicit review dialog, but requires no typed command or operator-entered reason. The server supplies a bounded action-specific audit reason and enforces the live owner session, trusted Origin, CSRF, JSON content, rate limits, revisions, and guarded storage operations. A reviewed non-owner deletion pauses the account, revokes its sessions, reconciles Paddle state, and atomically records the removal; active subscriptions and unresolved checkouts block it and leave the account paused for an explicit retry or restore. The primary owner cannot suspend or delete itself through Admin.

No separate administrator password or Gmail integration is required. `SUPPORT_EMAIL` selects the support-notification and help-desk mailbox; `EMAIL_REPLY_TO` controls the reply-to address for transactional mail sent through Resend. Changing `ADMIN_EMAIL` does not transfer an already bound owner identity.

## PWA behavior

The deployed site can be installed from `/install.html` on supported iPhone, iPad, Android, Chrome, and Edge environments. The service worker uses a build-versioned cache, deletes older STRATA cache versions during activation, and caches only an explicit set of public assets and public offline fallbacks.

Account APIs, authentication routes, and health checks bypass the service worker. Personalized pages, the administrator area, recovery/deletion pages, and saved account data are never cached or served as offline account content; a failed private-page navigation may receive only the generic public offline explanation. The special offline workout route is a public shell, not a cached account page: it can read only a bounded account-scoped draft created after online authorization, and it must recheck identity, access, and server revision before sync. Bearer-link reset and deletion pages intentionally do not initialize the PWA. An internet connection is required to sign in, use Admin or support, complete account actions, subscribe to Strata+, or sync changes.

## Public pricing, support, and policies

Build 8.5.0 has public, mobile-friendly pages at `/pricing`, `/contact`, `/policies`, `/terms`, `/privacy`, and `/refunds`. The Policies directory is the single public entry point for legal documents and the founder story. The published refund window is 14 calendar days after an eligible monthly charge. Subscription cancellation and refunds are separate actions. Support is available through the Contact form and at `stratafitness.official@gmail.com`.

Paddle receives payment information; STRATA does not receive or store full payment-card or bank-account details. Do not change the displayed amount or monthly renewal interval independently of the live Paddle catalog. Members open short-lived Paddle portal links from Account to manage payment or cancellation. Before accepting payments, make sure the public operator details match the identity required by Paddle and applicable law rather than inventing missing legal information.

## Deployment

Production is a Node web service, not a static site. The application fails closed in production without Turso credentials, preventing account data from being accepted into an ephemeral filesystem. Email verification and checkout each remain disabled until their complete provider configuration is present.

Use [docs/deployment.md](docs/deployment.md) for:

- Turso and Render setup
- Resend domain and account-email configuration
- Paddle catalog, checkout, webhook, and go-live checks
- configuration preflight, liveness/readiness, deployment smoke, rollback, and production-limit checks

The checked-in `render.yaml` is the source of truth for fixed deployment values and secret prompts. The checked-in `.env.example` documents every supported local variable without containing credentials.

## Storage modes

- Without `TURSO_DATABASE_URL`, development and tests use a local SQLite file.
- With `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, the application uses Turso.
- Both adapters implement the same application-facing contract and schema behavior.
- Production intentionally refuses to start without the durable Turso configuration.

## Security

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Please report security issues privately instead of opening a public issue. The architecture and trust-boundary notes in [docs/architecture.md](docs/architecture.md) are useful context for review.

## Production limitations

Free hosting can sleep, has usage limits, and uses an ephemeral filesystem. An installed PWA cannot eliminate a server cold start, and account syncing still depends on the live web service and Turso. Transactional email also depends on Resend and valid sender-domain DNS. For real users, choose an appropriate service tier and operational monitoring.

STRATA currently has one verified, permanently bound owner account protected by the normal account session. It does not add a second Admin-specific password or email-code challenge and does not include delegated administrator roles, authenticator-app or hardware-key MFA, file attachments, real-time chat, or automated community-content moderation.

## Editorial note

FitScore is an editorial synthesis for hypertrophy-oriented exercise selection. It is not a validated clinical scale, personalized medical prescription, or a claim made by the cited sources.
