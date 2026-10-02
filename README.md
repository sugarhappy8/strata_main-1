# STRATA — Exercise Rankings and Workout Planning

STRATA is an evidence-informed workout index with server-backed, email-verified accounts, a private Strata+ studio, and weekly and monthly workout planning. It includes 320 resistance-training exercises—including 71 bodyweight options—across 8 muscle groups and 26 sub-muscle targets. Build 9.3.0 is an installable Progressive Web App (PWA) with Training Memory, Resend-powered account email, Paddle-powered Strata+ subscriptions, Polar connections and Strata AI on Groq for Strata+ members, and a private owner dashboard.

**Build 9.3.0 is the Sign in with Google release.** Members can create an account or sign in with Google next to email and password; a Google account links to an existing account only when both sides have verified the email, and the button stays off until it is configured. The iOS app keeps email sign-in. See the [9.3.0 release guide](docs/release-9.3.0.md).

The [9.2.0 release](docs/release-9.2.0.md) was the iOS app release. The STRATA iOS app (repository `sugarhappy8/strata-fitness-ios`) shows this site. Inside the app the site switches to an app mode: one tab bar and top bar, app-style motion, and native extras (haptics, rest-timer alerts, the screen kept on during workouts, Add to Calendar, AirPrint, the share sheet). Strata+ is sold there through Apple In-App Purchase, verified on the server, and stays one Strata+ whichever way someone paid; accounts can be deleted in the app with the password. Build 9.1.0 replaced My Week with Dashboard. See [Apple In-App Purchase](docs/apple-in-app-purchase.md).

The [9.0.0 release](docs/release-9.0.0.md) was the cut-and-integrate release. It added no features: it turned STRATA into one product with five sections on every page—Rankings, My Week (now Dashboard), Train, Recovery, and Profile—that open the Strata+ studio for members and the public rankings, the free planner, and the Strata+ plan for everyone else. It removed duplicated and unfinished pieces (community weekly plans, the exercise hub, the decision board, share cards, the homepage compare tray, a second calendar export, and build numbers in the main UI). One entitlements module decides every page and route, and one data layer—the Athlete Profile, a deduplicated Training Log, Daily Snapshots, Rankings Signals, and plan history—feeds every screen and Strata AI ([DATA_MODEL.md](DATA_MODEL.md)). Polar sessions and nights join that layer and complete planned days ([POLAR_INTEGRATION.md](POLAR_INTEGRATION.md)). Strata AI runs on Groq behind member consent and a shared daily budget and writes a Daily Brief each morning ([STRATA_AI.md](STRATA_AI.md)). See [CHANGELOG_9.0.0.md](CHANGELOG_9.0.0.md).

The [8.9.0 release](docs/release-8.9.0.md) made Strata+ subscription-only: the free trial was retired, the old trial route answers `410 TRIAL_RETIRED`, and a trial started earlier runs to its recorded end. It moved Strata AI off the homepage into a Strata AI chat on every Strata+ view, gathered Plan, Train, and Nutrition into the Overview, and stated each pricing fact once.

The [8.8.6–8.8.8 releases](docs/release-8.8.8.md) brought Polar connected devices to Strata+, migrated to Polar AccessLink V4. Each member can connect their own Polar account, such as a Polar Loop, to their own STRATA account from Account, after a consent step that explains what STRATA reads. STRATA uses V4 granular read scopes, sealed access and refresh credentials, and polling at least daily. It imports the last 28 days and shows Polar's Nightly Recharge, overnight stress signals compared only with the member's own usual nights, sleep with stages, overnight and 24/7 heart rate, and 4-, 8-, or 12-week trends next to STRATA workouts and Polar cardio load. The Overview gets a recovery card, and after a poor night Train can offer a lighter session: the same exercises with one set fewer each, for that day only, without changing the Plan. Disconnecting or deleting the account deletes the sealed credentials and imported data. Existing V3 connections must reconnect. The feature stays off until the owner sets the Polar settings; see [POLAR_INTEGRATION.md](POLAR_INTEGRATION.md) and [Polar connected devices in the deployment guide](docs/deployment.md#polar-connected-devices).

The [8.8.5 release](docs/release-8.8.5.md) was the polish and cleanup release. A page-by-page audit at desktop and phone widths kept the Strata+ destination tabs on screen, restored readable contrast, gave every page one top-level heading, showed friendly workout dates, and removed unused code, settings, and 25 retired stylesheet classes.

The [8.8.4 release](docs/release-8.8.4.md) made Strata AI responses apply correctly. Atomic Chat now receives its enforced llama.cpp JSON schema, so a workout cannot be hidden inside conversational text while the structured week is missing. “Only two rest days” means exactly five training days, and “make sessions longer” keeps the same days while moving every session to the next 15-minute tier. STRATA gives a mismatched answer one precise correction, then safely builds pure day-count or duration edits from the validated draft when the local model still misses the requirement. Questions can refer to the week on screen without changing it, equipment-only edits are catalog-checked, and medical wording is forced to a reply-only safety path.

The [8.8.0 release](docs/release-8.8.0.md) introduced Strata AI. Strata+ members can describe their week in their own words ("4 days a week, 45 minutes, dumbbells at home, stronger legs") and Strata AI proposes a full week built from all 320 STRATA exercises, including any exercise the member names and anything it finds with one search of the library. STRATA checks every exercise, set, and day before the proposal appears, and nothing is saved until the member applies it. After a week, Strata AI offers matching nutrition targets; the calories come from STRATA's own calculator, never from the model, and apply to the personal setup with one tap. "Review my plan" returns up to three suggestions, and a suggested exercise swap applies to the saved plan with one tap. The homepage then asked "Don't feel like planning things yourself? Ask Strata AI to do it for you."; since 9.0.0, Strata AI lives in the Strata AI chat inside Strata+, with the full page still at `/ai`. The model runs on an OpenAI-compatible server that STRATA operates; see [Strata AI in the deployment guide](docs/deployment.md#strata-ai).

The [8.7.0 release](docs/release-8.7.0.md) was the clarity release. Nutrition shows its arithmetic: the target reads as maintenance minus the deficit (for example, "2,750 maintenance − 225 deficit = 2,525 kcal/day"), training and rest days each get one target in multiples of 5 kcal that still add up to exactly seven times the average, and See calculation lists every step from resting energy to maintenance. The diary checks that protein, carbs, and fat add up to the calories entered, and weights and heights keep two decimals so pound and inch entries read back as typed. New in the diary: quick add (enter a meal or tap +100, +250, or +500 to add and save), copy the previous day, a logging streak, and a morning-weight trend with its seven-day average. Train can put every planned day on your calendar as a weekly repeating event with a reminder. The whole site now uses one type family in sentence case, one olive-and-lime accent with red kept for errors, and pill-shaped actions, and the homepage ranking leads with the top ten.

The [8.6.1 release](docs/release-8.6.1.md) fixed nine defects found in an audit of 8.6.0. Returning to the Strata+ tab gives the same session its view back, unsaved input included; the offline workout page checks each value before saving it, keeps completed sets read-only, and never shows "Saved on device" after a failed write; and superset guidance, pound plates, share cards, and the admin activity range were corrected.

The [8.6.0 release](docs/release-8.6.0.md) organized Strata+ so each destination states each fact once. Progress replaced its overlapping improvement and personal-best lists with one exercise-records list (latest result, change since last time, and best), added an eight-week workouts chart and week-over-week volume, and counts consistency correctly across daylight-saving changes. Nutrition reads top to bottom—targets, today's diary with a progress meter, the week at a glance, meal ideas, and then the supporting evidence, described in the [coaching methodology](docs/coaching-methodology.md).

The [8.5.0 release](docs/release-8.5.0.md) introduced the six visible Strata+ destinations—Overview, Plan, Train, Nutrition, Progress, and Exercises. Nutrition owns calorie and weight logging and meal suggestions, Plan owns generated training weeks behind an explicit review before replacing the saved week used by Train, and one shared personal setup feeds both.

The [7.9.0 release](docs/release-7.9.0.md) added constraint-aware daily food options based on saved dietary pattern, supported allergies or uncertainty, dietary requirements, favorite-food categories, meal count, optional budget, and that day's remaining calorie and macro targets. Hard filters are never relaxed, and results disclose cross-contact, editorial nutrition estimates informed by generic FoodData Central values, and rough non-live cost limitations.

The [7.8.8 release](docs/release-7.8.8.md) redesigned the coaching profile as a guided four-step surface with separate cards, compact mobile orientation, labeled known-exercise inputs, 200% text reflow, and stronger contrast. It also moved new checkout to $2.99 USD monthly, failing closed unless Paddle confirms the exact 299-cent recurring catalog item while a server-only allowlist can preserve qualifying existing subscribers on an earlier recurring price.

The [7.8.7 release](docs/release-7.8.7.md) expanded the library to 320 movements and introduced transparent Personal training and calorie counting. It uses the member's measurements, goals, schedule, experience, equipment, movement limitations, and optional known lifts to build a stable current-week plan, calorie schedule, optional macro targets, intake log, and explicitly uncertain weight scenarios. Formula sources and safety limits remain documented in the [coaching methodology](docs/coaching-methodology.md).

**Build 7.8.3 restored STRATA's established visual identity and clarified Strata+.** The weekly plan is again the clear center of Plan, secondary tools are progressively disclosed, Today now distinguishes no-plan, next-scheduled, and active-session states, Train handles an empty selected day explicitly, and Progress never presents blank statistics as results. The 7.8.2 performance-based weight progression remains intact. See the [7.8.3 release guide](docs/release-7.8.3.md) for behavior and validation.

The [7.8.0 release](docs/release-7.8.0.md) established the training loop from week preview through account verification, a deliberate seven-day no-card trial, Plan review, training, and completed-workout evidence. Its Paddle lifecycle protections and enforced logic, state, API, rendering, event, and coordinator boundaries remain in place across the seven largest browser surfaces; Build 9.3.0 also preserves the direct sole-owner Admin workflow from 7.8.4, the interrupted-checkout deletion recovery from 7.8.5, and the previous releases' Plan/comparison, coaching, and food-option refinements. See [release readiness](docs/release-readiness.md) and the [founder plan](docs/founder-plan.md).

STRATA also includes a login-free local weekly planner, account-synced plans, week templates with import and export, a deterministic 31-day workspace, community ratings, printable exports, and a private administrator help desk. Strata+ is a **$2.99 USD per month recurring subscription**; subscribing always requires explicit checkout. There is no free trial: Build 8.9.0 retired it. Paddle is the merchant of record, and the server grants paid access only after a matching transaction is provider-verified and linked to validated signed subscription state. Prior lifetime buyers remain grandfathered with no recurring charge.

See [CHANGELOG.md](CHANGELOG.md) for the concise release history.

Start at `/` for the no-account recommendation and complete-week preview, `/planner.html` for free manual planning, or `/discover.html` for the private Strata+ workspace: Overview (which opens Plan, Train, and Nutrition), Recovery, Progress, and Exercises, with one shared personal setup and the Strata AI chat one tap away. A guest week remains on the device through signup and is never allowed to overwrite an account Plan without a visible claim, compare, or keep choice. Signed-in plans, workouts, optional check-ins, training blocks, coaching profiles and weekly snapshots (including saved food preferences), daily nutrition logs with optional morning-weight and completeness evidence, and approved adaptations sync to the account. Remaining-day food options are derived when requested and are not stored as food eaten.

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

Build 9.3.0 separates browser files from private server code while preserving every public URL used by visitors, Paddle, Render, and installed PWAs:

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

Before a release, audit managed version references with `npm run release:check`; it also fails when the newest `CHANGELOG.md` entry names a build that the version markers do not carry, because a release without the bump keeps installed apps on their cached assets. Preview a bump with `npm run release:version -- --dry-run x.y.z` or `x.y.z.NNN`, then apply it without `--dry-run`. Four-part public builds retain an npm-compatible three-part package version and store the exact public build in `strataBuild`. The tool changes only its explicit release manifest. After the release commit reaches `main`, run the **Release** workflow (`.github/workflows/release.yml`) on `main`, or push a matching `vX.Y.Z` tag. It tags the commit when needed and publishes `docs/release-X.Y.Z.md` as the GitHub release notes.

## Accounts, plans, and administrator access

- Passwords use scrypt with a unique random salt; plaintext and reversible passwords are never stored.
- Members can also sign up and sign in with Google (OpenID Connect with PKCE). ID tokens are verified against Google's published keys, a Google account links to an existing account only when both sides have verified the email, and the button stays off until it is configured. See [Sign in with Google](docs/deployment.md#sign-in-with-google).
- Sessions are random database-backed tokens in HttpOnly, SameSite cookies. Sensitive writes also require a same-session CSRF token and trusted origin.
- Signup verification, password reset, and account deletion use time-limited email flows. Reset revokes every session; deletion on the website requires a one-time registered-email confirmation. In the iOS app, deletion completes in the app with the account password and DELETE (`POST /api/account/delete/now`), under the same protections.
- Signed-in members can review active session times, sign out one or all other sessions without exposing token/IP/device details, and download a private `no-store` JSON export of their account training and support data.
- Signed-out plans stay in that browser. Signed-in weekly and monthly plans are private account records and sync through the configured store.
- Community plans publish validated structured workout data and a display name, never the member's email address or a binary upload.
- Strata AI sends the model a STRATA-prepared summary of the member's plan, personal setup, and recent training and nutrition, never their name, email, or account ID. Its proposals are checked by the server and change an account only through the normal plan and personal-setup endpoints when the member applies them. Messages and answers are never stored in the database or logs.
- The one verified account matching server-only `ADMIN_EMAIL` may become the permanently bound primary owner. That bound owner opens Admin with its normal live account session; Admin does not ask for a second password or email code.
- Each Admin mutation retains one explicit review dialog, but requires no typed command or operator-entered reason. The server supplies a bounded action-specific audit reason and enforces the live owner session, trusted Origin, CSRF, JSON content, rate limits, revisions, and guarded storage operations. A reviewed non-owner deletion pauses the account, revokes its sessions, reconciles Paddle state, and atomically records the removal; active subscriptions and unresolved checkouts block it and leave the account paused for an explicit retry or restore. The primary owner cannot suspend or delete itself through Admin.

No separate administrator password or Gmail integration is required. `SUPPORT_EMAIL` selects the support-notification and help-desk mailbox; `EMAIL_REPLY_TO` controls the reply-to address for transactional mail sent through Resend. Changing `ADMIN_EMAIL` does not transfer an already bound owner identity.

## PWA behavior

The deployed site can be installed from `/install.html` on supported iPhone, iPad, Android, Chrome, and Edge environments. The service worker uses a build-versioned cache, deletes older STRATA cache versions during activation, and caches only an explicit set of public assets and public offline fallbacks.

Account APIs, authentication routes, and health checks bypass the service worker. Personalized pages, the administrator area, recovery/deletion pages, and saved account data are never cached or served as offline account content; a failed private-page navigation may receive only the generic public offline explanation. The special offline workout route is a public shell, not a cached account page: it can read only a bounded account-scoped draft created after online authorization, and it must recheck identity, access, and server revision before sync. Bearer-link reset and deletion pages intentionally do not initialize the PWA. An internet connection is required to sign in, use Admin or support, complete account actions, subscribe to Strata+, or sync changes.

## Public pricing, support, and policies

Build 9.3.0 has public, mobile-friendly pages at `/pricing`, `/contact`, `/policies`, `/terms`, `/privacy`, and `/refunds`. The Policies directory is the single public entry point for legal documents and the founder story. The published refund window is 14 calendar days after an eligible monthly charge. Subscription cancellation and refunds are separate actions. Support is available through the Contact form and at `stratafitness.official@gmail.com`.

Paddle receives payment information; STRATA does not receive or store full payment-card or bank-account details. Do not change the displayed amount or monthly renewal interval independently of the live Paddle catalog. Members open short-lived Paddle portal links from Account to manage payment or cancellation. Before accepting payments, make sure the public operator details match the identity required by Paddle and applicable law rather than inventing missing legal information.

## Deployment

Production is a Node web service, not a static site. The application fails closed in production without Turso credentials, preventing account data from being accepted into an ephemeral filesystem. Email verification, checkout, and Polar connected devices each remain disabled until their complete provider configuration is present.

Use [docs/deployment.md](docs/deployment.md) for:

- Turso and Render setup
- Resend domain and account-email configuration
- Paddle catalog, checkout, webhook, and go-live checks
- Strata AI model server, API key, and tunnel settings
- Polar AccessLink V4 client, granular OAuth scopes, refresh-token encryption, and polling sync
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
