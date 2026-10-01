# AUDIT_BUILD9 — STRATA Build 9 Phase 1 audit

**Status:** output only. Nothing in the codebase was changed for this audit. Nothing is removed until the verdict matrix (§3) is approved.

**Audited at:** `main` @ `21dc429` (Build **8.9.0**, 1 Oct 2026). The master prompt says "Current build: 8.8.x"; 8.9.0 shipped this morning (PR #30) and is the base for Build 9.

**How this was produced:** five read-only sweeps of the repository (HTTP API, database, browser pages/features, infrastructure, tier gating + AI + Polar) plus 45 screenshots of every page as an anonymous visitor, a free member, a Strata+ member and the admin owner, at desktop and phone widths, using a local server with a scripted model. Anchors are `file:line` from that commit.

**Stack (filling in the prompt's brackets):** vanilla HTML/CSS/JS progressive web app, no framework (`public/`) · Node 24 `http` server with hand-written routing (`src/server.js`, 11,939 lines of server modules) · SQLite via `node:sqlite` locally, Turso in production, one shared SQL contract · Render web service (`render.yaml`) · home-grown auth (scrypt passwords, HttpOnly session cookies, 6-digit email codes via Resend) · Paddle (merchant of record, $2.99/month) · Polar AccessLink V4 (polling, no webhooks) · Strata AI on any OpenAI-compatible endpoint, today an Atomic Chat/llama.cpp box behind a Cloudflare tunnel.

**Size:** 23 HTML pages, 100 browser scripts (11,718 lines), 17 stylesheets (5,208 lines), 69 server modules, 42 database tables, 97 dynamic endpoints, 122 Node test files + 16 browser journeys. The browser bundle is ~1.9 MB of source before compression.

**Usage data:** none is available from the repository. The only analytics are the opt-in anonymous daily counts in `product_signal_counts` (13 events, 90-day retention), readable in Admin → Overview → "Aggregate activity". **Read that view before approving any CUT**; every "usage" cell below is an inference from the code, not a measurement.

---

## 1. Feature inventory

### 1.1 Pages and routes

| Page | URL(s) | Access | Purpose | Visual (1–5) |
|---|---|---|---|---|
| Home | `/` | public (header changes when signed in) | Pitch, free week preview, public exercise rankings, method, pricing CTA | 4 (hero and rankings strong; lower half is marketing filler, see §7) |
| Plan (planner) | `/planner.html` (no clean alias; the service worker maps `/planner` but the server 404s it) | public; device plan without an account, synced plan when signed in | Manual weekly plan builder, templates, sharing, export | 4 |
| Strata+ studio | `/discover.html` + `#panelId` deep links | Strata+ | 14 panels: Overview, Plan menu, Session builder, Monthly, Community, Progress, Exercises hub, Recommendations, Library, Compare, Preferences, Personal setup, Nutrition, Recovery; plus the AI chat | 3–4 (see per-panel scores) |
| Train | `/workout.html` | Strata+ | Set logging, timers, Workout Memory, progression, check-in, history, calendar export, lighter session | 4 |
| Offline workout shell | `/workout-offline.html` | public shell, opens only a draft authorized online | Continue an active workout offline, sync later | 3 |
| Strata AI | `/ai`, `/ai.html` | Strata+ | Full-page chat (same engine as the studio chat widget) | 4 |
| Account | `/account.html`, `?mode=login|signup&next=` | public (auth) / signed-in dashboard | Sign in/up, next workout, access status, billing portal, Polar devices, sessions, export, security | 4 |
| Onboarding | `/onboarding.html` (no alias) | **Strata+ only** (reached from Account's main action) | 3-step week setup, preview, save plan + preferences atomically | 4 |
| Pricing | `/pricing`, `?reason=` | public | Price facts, Paddle checkout, benefits, free tier | 4 |
| Install | `/install` | public | PWA install instructions per device | 5 |
| Offline fallback | `/offline.html` | public (service worker) | Retry / cached links | 3 |
| Contact | `/contact` | public | Support form → ticket reference, email fallback | 4 (no-JS fallback form is broken, §7) |
| Policies / Terms / Privacy / Refunds | `/policies` `/terms` `/privacy` `/refunds` | public | Legal, method explainer, founder story, product-insights controls | 4 |
| Admin | `/admin` | bound owner only | Overview KPIs, People (11 actions), Help desk, Activity audit | 4 |
| Verify / Forgot / Reset / Delete | `/verify-email` `/forgot-password` `/reset-password` `/delete-account` | public with token/cookie | Account lifecycle flows | 4 |

### 1.2 Features (grouped), what they read/write, who else touches them, cost

Cost = rough maintenance weight from lines of JS (browser + server), CSS and dedicated tests. Usage = inference only (see note above).

**Core: Rankings (free)**

| Feature | What it does | Reads / writes | Touched by | Cost | Visual |
|---|---|---|---|---|---|
| Public rankings `index.html:160-230` | 320 exercises, muscle tabs, filters, 6 sort keys, FitScore, detail dialog, "Add to weekly planner" | `exercises.json` (static) | planner library, studio Library/Recommendations, AI catalog | ~970 lines home-* + discovery-core (shared) | 4 |
| Exercise detail dialog | Why/caution/cues/YouTube search | static | **4 variants**: home, planner guide, studio detail, workout guide | duplicated | 4 |
| Home compare dock (2 exercises, Strata+ only) | Head-to-head on a public page | `/api/me` every 30 s | studio Compare (2–4) | small | 3 |
| Method / "A score you can interrogate" `index.html:291` | Explains FitScore | static | studio score guide, policies methodology (**3 copies**) | small | 4 |

**Core: Plan your week (free)**

| Feature | What it does | Reads / writes | Touched by | Cost | Visual |
|---|---|---|---|---|---|
| Weekly planner `planner.html` | Drag/quick-add from library, sets/reps, rest days, undo, reset, summary, plan evidence (sets per muscle, patterns, equipment) | `plans` via `GET/PUT /api/plan`; guest: `strata_guest_plan_v1` | Train (reads plan), studio Plan menu, AI apply, community apply, adaptations, setup | 1,484 JS + 393 CSS, 1 unit test file + 3 journeys | 4 |
| Week templates (device) `planner.html:174` | Save/use/import JSON, up to 12 | `strata_week_template_v1:*` | community plans (same idea, public) | ~105 | 3 |
| Copy a day, replace exercise, reset dialogs | Small editing tools | — | workout swap, AI swap (replace = 3 variants) | small | 4 |
| Share week → community `planner.html:103` | Publish/unpublish one week with display name | `community_weekly_plans` (free users may publish; only Strata+ may browse) | studio Community | ~210 | 3 |
| Save conflict / draft recovery `planner.html:55` | Keep latest vs review unsaved | `strata_plan_draft_v1:*` | Train has the same pattern | small | 3 |
| Device-week claim `planner.html:35` | After signup, compare device week with account week | `strata_activation_*` | home preview, onboarding, account handoff | ~518 (activation-*) | 3 |
| Home "preview week" generator `index.html:99` | 3 presets or 6 fields → 7-day preview; keep → claim | `onboarding-core.buildWeek` in the browser | onboarding (same generator), AI week, session builder, coaching week | shared | 3 (three literal "Recommendation" placeholder cards, §7) |

**Strata+ studio**

| Panel | What it does | Reads / writes | Touched by | Cost | Visual |
|---|---|---|---|---|---|
| Overview (`today`) | Next step hero (Start/Resume/Build), training brief, planned-days progress, Plan/Train/Nutrition cards, Polar "Last night" card, "Need a different workout?" card, AI chat launcher | `/api/discovery`, `/api/plan`, `/api/workouts?limit=100`, `/api/training`, `/api/wellness/today` | everything | discover.js is 724 lines (at its budget) | 4 |
| Plan menu (`plan`) | Summary card + 3 disclosures linking to session builder, training block, monthly, templates, shared plans; progression card; "suggested week from personal setup" | `/api/plan`, `/api/training-block`, `/api/training/adaptations/:id`, `/api/coaching/week` | planner | ~380 (training/program) | 3 (a menu page with a "Back to Overview ↑" link) |
| Session builder (`session`) | Random / Not in my week / Needs focus / My preferences → one session for a day | `discovery-core` + `/api/plan` | Overview "different workout" card, Train "Create a different workout" | ~218 | 4 |
| Training block (`plan` → 03) | 4–8 week block, weekly review, carry forward / lighter week / finish | `training_blocks` | monthly (naming clash: both are called "training block") | ~160 core + UI | 3 |
| Monthly 31-day plan (`monthly`) | Expand weekly plan or muscle schedule into 31 dated days, import JSON, "Download PDF" (print), share text | `monthly_plans` (`PUT /api/monthly-plan`; GET is unused) | training block, planner export | ~301 | 3 |
| Community plans (`community`) | Browse/search shared weeks, preview, replace own plan | `community_weekly_plans`, `/apply` | planner sharing, templates | ~210 + 6 endpoints (2 unused) | 3 |
| Progress (`progress`) | This week, volume, consistency, workouts logged; 8-week chart; exercise records; link to history | `/api/workouts` | Train history (same data), Account stats | ~100 | 4 |
| Exercises hub (`explore`) | Four cards: Recommendations, Library, Compare, Preferences | — | — | small | 3 (a page that is only a menu) |
| Recommendations | Personal-match shortlist, ranking lens chips, decision board (device, ≤4), share-shortlist PNG, feedback buttons | prefs + catalog; `strata_plus_movement_board_v1` | Library sorted by "Personal match" is the same list | ~110 | 3 |
| Library | 7 collections (incl. "Saved · N" = the decision board), 6 filters, detail dialog with rating form, add to compare/plan, share card | `/api/ratings/*`, `/api/ratings/aggregates` | home rankings, planner library | ~185 | 4 |
| Compare ("battle") | 2–4 exercises side by side + tray | catalog | home compare (limit 2) | small | 3 |
| Preferences (`profile`) | Goal, experience, days, equipment, exercise preferences, constraints | `preferences` (`PUT /api/preferences`) | Personal setup (overlapping fields, different vocabulary), onboarding | small | 4 |
| Personal setup (`coaching`) | 4 steps: body/energy, training, known lifts, calories/macros/food | `coaching_profiles` (`PUT /api/coaching/profile`) | Nutrition, coaching week, AI, Plan "suggested week" | 1,932 JS (coaching family), 18 test files | 4 |
| Nutrition (`nutrition`) | Targets + maintenance math, daily diary (quick add, copy previous, morning weight, macros), 7-day view, weight trend, meal ideas, "Behind the numbers" | `coaching_weeks`, `coaching_daily_logs`, `/food-options/:date` | AI nutrition targets | (same family) | 3 in setup state, 4 with data |
| Recovery (`recovery`) | Polar last night, 4/8/12-week trends, weekly averages vs training | `/api/wellness/today|trends` | Overview card, Train lighter session, Account devices | 1,872 JS (devices family), 10 test files | 2 when Polar is not configured ("Recovery is coming soon"), ~4 connected |
| Score guide | FitScore vs Match vs Community rating | — | home method, policies | small | 3 |
| Strata AI chat widget + `/ai` page | Chat, starters, "Review my plan", apply week/nutrition/swap, full-screen page | `/api/ai/*`, then `/api/plan`, `/api/coaching/profile`; sessionStorage conversation | all plan writers | 3,754 JS (AI family incl. server), 24 test files | 4 |

**Train**

| Feature | What it does | Reads / writes | Touched by | Cost | Visual |
|---|---|---|---|---|---|
| Start panel + day picker | Next session, brief, go to next day | `/api/plan` | Overview hero, Account "Next up" (**3 copies of "next workout"**) | 1,769 JS (workout family) | 4 |
| Set logging | Timers, rest, progress ring, Workout Memory, "Use previous values", warm-up ramp, plate calculator, swap, notes, finish | `workouts` (`POST/PUT /api/workouts`), drafts in localStorage | Progress, AI context, coaching evidence | — | 4 |
| Workout Memory / previous comparable | Last comparable sets per exercise | `/api/workouts?memory=1` | Overview "previous comparable", Progress records (**3 copies**) | — | 4 |
| Progression target + check-in + adaptation proposal | "Your next workout target", 4 sliders, proposes one plan edit | `workout_check_ins`, `training_adaptations`, `/api/workouts/:id/progression` | studio progression card (**3 surfaces**) | ~380 | 4 |
| History section | Stats, recent sessions, chart | `/api/workouts` | studio Progress (**duplicate**) | — | 4 |
| Calendar export (.ics) ×2 | Weekly repeating event; next-workout event | — | — | ~50 | 3 |
| Polar lighter session | One set fewer per exercise today after a poor night | `/api/wellness/today|workouts` | Recovery, Account toggle | ~70 | 4 |
| Offline shell | Finish a workout offline, sync later | localStorage draft + `/api/workouts/:id` | — | ~300 | 3 |

**Account, billing, auth, admin, platform**

| Feature | What it does | Reads / writes | Cost | Visual |
|---|---|---|---|---|
| Account dashboard | Greeting, main action, next up, stat grid, access line, billing portal, Polar devices (connect/sync/disconnect/consent/toggle), sessions, export, quick links, security | `/api/me`, `/api/plan`, `/api/workouts`, `/api/billing/portal`, `/api/devices/*`, `/api/account/*` | 3,056 JS (auth/account family) | 4 |
| Storage status pill `account.html:35` | "Permanent account storage is active" / "temporary" | `/api/status` | small | 2 (developer copy) |
| Pricing + Paddle checkout | Config, checkout claim, portal, webhooks, legacy price allowlist, reconciliation | 9 `paddle_*`/billing tables | 2,447 JS | 4 |
| Auth flows | Signup/login with email codes, reset, delete, sessions, export; 7 no-JS form fallbacks | `users`, `sessions`, `signup_verifications`, `account_action_*` | (above) | 4 |
| Admin | Overview, People, Help desk, Activity; grant/revoke Strata+, suspend, delete, close checkouts | 6 admin endpoints + `admin_*` tables | 984 JS | 4 |
| Product signals | Opt-in anonymous daily counts; privacy page controls incl. "Inspect the exact local summary / Copy"; admin aggregate | `product_signal_counts` | 460 JS | 3 |
| PWA | Service worker (129 precached URLs, network-first navigation, private paths never cached), manifest with 4 shortcuts, install page | — | small | 5 |
| Legacy trial | `POST /api/discovery/trial` → 410, `discovery_trials` read-only, `trial_started` signal, `test/trial-policy.test.js` | `discovery_trials` (no writer) | dead weight | — |

### 1.3 API endpoints (97 dynamic + 166 static URLs)

Full table in the API sweep; summary:

- **Core routes** (`src/server.js`): status, plan GET/PUT, community plans (6), monthly plan GET/PUT, discovery bootstrap, ratings, preferences.
- **Auth** (`src/auth.js`, `account-self-service.js`): 19 JSON routes + 7 `/auth/*` HTML-form fallbacks.
- **Admin / support / signals**: 11.
- **AI**: 3 (`status`, `requests`, `requests/:id`), in-memory queue, writes nothing to the DB.
- **Training loop**: 9. **Coaching**: 6. **Devices/Polar + wellness**: 10. **Workouts + setup**: 7. **Billing**: 6 incl. the Paddle webhook. **Health**: 3.
- **Endpoints with no caller at all (10):** `GET /api/community-plans/:id`, `PATCH /api/community-plans/:id`, `GET /api/monthly-plan`, `GET /api/training-block`, `GET /api/training/progression/latest`, `GET /api/training/adaptations/latest`, `GET /api/coaching/logs/:date`, `DELETE /api/workouts/:id`, `POST /api/discovery/trial` (deliberately retired), `GET /api/billing/subscription`.
- **Inconsistencies:** workout writes skip the trusted-origin check that every other write enforces (`src/workouts.js`); `contact.html`'s no-JS form posts form-encoded data to an endpoint that requires JSON (always 415); several rate-limit buckets are keyed by user *and* IP so they reset when the IP changes; `src/server.js:673` has an unreachable `planner.html` branch.

### 1.4 Background jobs

All in-process, no external cron/queue: hourly cleanup (`src/server.js:785`), Polar sync loop every 60 s handling 5 due connections, daily per member with backoff (`src/devices-sync.js`), AI queue (3 concurrent, 20 queued, results kept 10 min, **daily quota in memory → resets on every deploy**), Paddle IP allowlist cache. Nothing persists AI usage or rate buckets, and nothing is shared between replicas.

### 1.5 Database (42 tables + migration ledger)

Groups: auth/account (7), training (4), plans/preferences (5), coaching (3), devices/wellness (6), billing/access (8), admin/support/telemetry (6). Three tables are dead or legacy with no writer: `discovery_trials`, `admin_elevations`, `device_revocations`. `paddle_webhook_events` grows forever (no cleanup). 13 store methods have no caller. Details in §9.

### 1.6 Environment variables and dependencies

Every documented variable is read; every dependency is used (1 runtime dependency: `@tursodatabase/serverless`). Undocumented but read: `POLAR_AUTH_URL/TOKEN_URL/API_URL` (accepted in production), `PADDLE_API_BASE`, `RESEND_API_BASE` (test only). `config-preflight` never checks the AI variables. No HSTS header is set by the app (relies on Render).

---

## 2. Customer-eyes test

Judged as a first-time paying customer on a phone. Columns: Understand in 5 s? / Miss it? / Pay for it? / Looks finished? Two or more "no" → CUT or MERGE.

| Feature | Understand | Miss | Pay | Finished | Result |
|---|---|---|---|---|---|
| Public rankings | yes | yes | n/a (free) | yes | KEEP |
| Weekly planner | yes | yes | n/a | yes | KEEP |
| Home preview week | yes | yes | n/a | **no** (placeholder "Recommendation" cards) | KEEP, fix |
| Home "What would you like to do?" directory | yes | **no** (the nav says the same) | no | yes | MERGE |
| Home system/ticker/demo console/editorial/sources | **no** ("demo console"?) | **no** | no | partly | CUT/MERGE |
| Home compare dock (Strata+ feature on a public page) | **no** | **no** | no | yes | MERGE into one Compare |
| Overview | yes | yes | yes | yes | KEEP |
| Plan menu panel | partly | **no** | no | yes | MERGE into Plan page |
| Session builder | yes | maybe | yes | yes | MERGE (one generator, one entry) |
| Suggested week from personal setup | **no** (why is there another week?) | **no** | no | yes | MERGE into Plan |
| Training block | partly | **no** | maybe | yes | MERGE with Monthly → "Plan ahead" |
| Monthly 31-day plan | **no** ("Pick my workouts" / "31-day training block") | **no** | no | yes | MERGE → "Plan ahead" (CUT the separate stored plan) |
| Community plans | yes | **no** | **no** | yes (but empty) | CUT (decision; see §3) |
| Progress | yes | yes | yes | yes | KEEP (owner of stats) |
| Exercises hub (4 cards) | yes | **no** | no | yes | MERGE (hub becomes the Library) |
| Recommendations + decision board | partly | **no** (Library "Personal match" + "Saved") | no | yes | MERGE into Library |
| Library | yes | yes | yes | yes | KEEP |
| Compare | yes | maybe | maybe | partly (four dropdowns) | KEEP, one copy |
| Preferences | yes | **no** (same fields as Personal setup) | no | yes | MERGE into Personal setup |
| Personal setup | yes | yes | yes | yes | KEEP (becomes Athlete Profile) |
| Nutrition targets + diary | yes | yes | likely | yes | KEEP (**tier decision needed**, §10) |
| Meal ideas | yes | maybe | maybe | yes | KEEP |
| "Behind the numbers" | **no** ("engineering heuristics", "Cunningham", "unvalidated heuristic") | **no** | no | no | MERGE → one short "How we calculate" + FOLD explanations INTO AI |
| Recovery (Polar) | yes | yes | yes | **no** when unconfigured ("coming soon") | KEEP, fix states |
| Lighter session | yes | yes | yes | yes | KEEP |
| Train set logging | yes | yes | yes | yes | KEEP |
| Workout Memory | yes | yes | yes | yes | KEEP (one surface) |
| Progression / check-in / adaptation | yes | yes | yes | yes | KEEP (one surface each) |
| Train history section | yes | **no** (Progress) | no | yes | MERGE into Progress |
| Calendar export ×2 | yes | maybe | no | yes | MERGE into one |
| Offline workout shell | yes | yes | yes | yes | KEEP |
| Strata AI page + widget | yes | yes | yes | yes | KEEP widget; MERGE page |
| Share cards (PNG) | partly | **no** | **no** | **no** (raw errors, wrong footer) | CUT |
| Monthly PDF/share | yes | **no** | no | partly ("PDF" = print) | goes with Monthly |
| Onboarding (Strata+ only) | yes | yes | n/a | yes | MERGE into one first-run flow for all members |
| Account | yes | yes | n/a | yes | KEEP |
| Storage status pill | **no** | **no** | no | no | CUT |
| Privacy "Inspect local summary / Copy" | **no** | **no** | no | no | CUT (keep the opt-in toggle) |
| Admin | n/a (owner) | yes | n/a | yes | KEEP |
| Install / offline pages | yes | yes | n/a | yes | KEEP |
| Legacy trial code | n/a | no | no | n/a | CUT |

---

## 3. Verdict matrix

Labels: **KEEP** · **MERGE → target** · **CUT** · **FOLD INTO AI**. Conservative by instruction: CUT is used only for duplicates, dead code, broken/unfinished surfaces, and clear off-mission pieces. Rows marked **(decision)** are ones I would not remove without your explicit yes.

### 3.1 Core — must get better, never worse

| Feature | Verdict | Notes |
|---|---|---|
| Public exercise rankings (`/#rankings`) | **KEEP** | Owner of ranking for visitors. Give it a clean URL (`/rankings`). |
| Weekly planner (`/planner.html`) | **KEEP** | Becomes the single owner of the weekly plan ("My Week"). Clean URL. |
| Planner templates, copy a day, replace exercise, undo/reset | **KEEP** | Small, understood. |
| Planner save-conflict / draft recovery | **KEEP** | Share the component with Train (one implementation). |
| Device-week claim after signup | **KEEP** (simplify) | Keep the mechanism; delete the unbounded `strata_activation_backup_v1:*` copies and the never-cleared `strata_activation_intent_v1` (§9). |
| Home preview week | **MERGE → one first-run flow** | Same generator as onboarding. Keep it on the homepage as the free "Build a starter week"; replace the three placeholder "Recommendation" cards with the real top-3 or remove them. |
| Exercise detail dialog | **MERGE → one component** | 4 implementations today (home, planner, studio, workout guide). |
| FitScore explainer | **MERGE → one "How scoring works"** | Home method + studio score guide + policies methodology → one page section, linked from each. |

### 3.2 Homepage

| Feature | Verdict | Notes |
|---|---|---|
| Hero, stats, rankings, preview week, footer | **KEEP** | |
| "What would you like to do?" four cards | **MERGE → nav** | Repeats the primary nav and the Overview cards. |
| Ticker + "One training system" four steps + demo console | **CUT** | Marketing filler; "demo console" reads as a dev project. |
| Editorial + research ledger (sources) | **MERGE → method page** | Keep the references; they support "evidence-informed". Move off the homepage. |
| Strata+ offer block | **MERGE → pricing** | One CTA on the homepage, one pricing page. |
| Compare dock (Strata+ feature on the public page) | **MERGE → one Compare** | One compare with one limit (4), reachable from any exercise. |

### 3.3 Strata+ studio (`/discover.html`)

| Feature | Verdict | Notes |
|---|---|---|
| Overview | **KEEP** | Becomes "My Week" home for members: next step, this week's days, readiness badge (Polar), AI brief inline. |
| Overview "Need a different workout?" card | **MERGE → one entry** | Same as Train's "Create a different workout" and the Plan menu's "Workout builder". Keep one entry on Train. |
| Plan menu panel (summary + disclosures) | **MERGE → planner** | A menu of links; the planner is the real Plan. |
| Session builder | **MERGE → one generator** | Keep the deterministic generator (free, instant, offline) as the one "Generate a day/week" tool on the Plan page; its four pick modes stay. |
| "Suggested week from personal setup" (coaching week sessions) | **MERGE → planner** | The coaching module must read training days/minutes from `plans` instead of generating a second weekly program (§9 item 4). Keep the nutrition half. |
| Training block (4–8 weeks) | **MERGE → "Plan ahead"** | One longer-range tool: a block of N weeks laid on real dates, derived from the weekly plan, with the existing weekly review. |
| Monthly 31-day plan | **MERGE → "Plan ahead"**; **CUT** the separate `monthly_plans` store and JSON import **(decision)** | It is a second plan copy with no revision link. Calendar/print export survives as an export of the block. |
| Community plans (browse/apply) + planner publishing | **CUT (decision)** | Social feature with no reader in a fresh install, user-generated content with display names, 6 endpoints (2 unused), a table that copies the plan. If Admin aggregate activity shows real use, MERGE into templates as "Shared weeks" instead. |
| Progress | **KEEP** | Single owner of stats. Absorbs Train's history stats/chart. |
| Exercises hub page | **MERGE → Library** | The hub is only a menu. |
| Recommendations panel | **MERGE → Library** | Becomes the default "Personal match" sort/lens of the Library. |
| Decision board | **MERGE → Library "Saved"** | Same data shown twice today. |
| "Share shortlist" / share cards (PNG) | **CUT** | Raw `Share failed: ${error.message}`, wrong footer text, three variants. Not core. |
| Recommendation feedback buttons (useful / not relevant / not clear) | **KEEP** | They are Rankings Signals (Phase 3). |
| Library | **KEEP** | Member-side owner of ranking. |
| Exercise ratings (comfort/pump/…/overall + aggregates) | **KEEP (simplify)** | Behaviour that feeds rankings. Six sliders is a lot; consider overall + one note. |
| Compare | **KEEP (one)** | |
| Preferences panel | **MERGE → Personal setup** | Same fields, different vocabulary (§9 item 2). |
| Personal setup | **KEEP** | Becomes the Athlete Profile; absorbs Preferences and onboarding; gets equipment + constraints (today it links out for them). |
| Nutrition: targets, diary, 7-day, weight trend | **KEEP** | **Decision needed:** the prompt's tier table does not list nutrition. See §10. |
| Meal ideas | **KEEP** | Deterministic, offline, tested. |
| "Behind the numbers" (energy breakdown, calibration, goal comparison, weight scenarios, method) | **MERGE → one short "How we calculate"** + **FOLD INTO AI** the narrative ("why your target changed this week") | Developer-voice copy today. |
| Recovery | **KEEP** | Fix the unconfigured state (§7) and make readiness visible on My Week and Train. |
| Score guide | **MERGE → "How scoring works"** | |
| Strata AI chat widget | **KEEP** | The inline surface. |
| Strata AI full page `/ai` | **MERGE → widget full-screen** | The widget already has "Open full screen"; make `/ai` the expanded chat with the same layout, drop the second page layout and its side cards. |

### 3.4 Train

| Feature | Verdict | Notes |
|---|---|---|
| Start panel, set logging, timers, Workout Memory, progression, check-in, adaptation proposal, swap, finish | **KEEP** | Train owns "next workout" and "previous comparable"; Overview and Account link to it instead of re-rendering it. |
| History section (stats, chart) | **MERGE → Progress** | Train keeps the raw session list. |
| Calendar export ×2 | **MERGE → one** | |
| Lighter session (Polar) | **KEEP** | |
| Offline workout shell | **KEEP** | Mobile-ready behaviour; needed in gyms. |

### 3.5 Account, onboarding, pricing, platform

| Feature | Verdict | Notes |
|---|---|---|
| Account dashboard, billing portal, devices, sessions, export, security | **KEEP** | Account stops re-rendering "next workout" and plan stats (links instead). |
| Storage status pill | **CUT** | "Account storage is temporary; accounts may be lost" is a server-ops message. |
| Onboarding page (Strata+ only) | **MERGE → one first-run flow** | Goals → schedule → equipment → (optional Polar) → first ranked workouts, for every member, writing the Athlete Profile. Session minutes move from localStorage to the profile. |
| Pricing | **KEEP** | Fix "Use last values" wording. |
| Install, offline fallback | **KEEP** | |
| Contact, policies, terms, privacy, refunds, founder | **KEEP** | Fix the no-JS form (415). |
| Product signals (opt-in counts, admin aggregate) | **KEEP** | Remove `trial_started`; CUT the privacy page's "Inspect / Copy local summary" developer tools. |
| Admin | **KEEP** | Replace its separate entitlement SQL with the central module (§8). |
| Auth flows incl. 7 no-JS form fallbacks | **KEEP** | |
| Service worker, manifest | **KEEP** | Fix the `/planner` alias mismatch. |

### 3.6 Dead code and legacy (all **CUT**)

- `POST /api/discovery/trial` (410), `discovery_trials` reads in `billing.js`/`userPayload`/admin, `test/trial-policy.test.js`, `trial_started` signal + DB CHECK + admin label, the `trial` branches in `account-logic.js`, `pricing-logic.js`, `planner-state.js`, `workout-core.js` (keep a one-line read-only path only if any legacy trial rows exist in production; check first).
- Tables `admin_elevations`, `device_revocations` and their store methods; migration 007 stays in the ledger.
- Unused endpoints: `GET/PATCH /api/community-plans/:id` (goes with community), `GET /api/monthly-plan`, `GET /api/training-block`, `GET /api/training/progression/latest`, `GET /api/training/adaptations/latest`, `GET /api/coaching/logs/:date`, `DELETE /api/workouts/:id`, `GET /api/billing/subscription`.
- 13 store methods with no caller (`accountCredentialsById`, `upsertAccountAction`, `upsertCommunityWeeklyPlan`, `createAdminElevation`, `rotateAdminSessionForElevation`, `adminElevation`, `insertDeviceRevocation`, `markDeviceConnectionDue`, `cancelDeviceRevocations`, `rescheduleDeviceRevocation`, `deviceConnectionByProviderUser`, `hasDiscoveryAccess`, `hasPaidDiscoveryAccess`).
- Dead client values `accessType === "lifetime" | "subscription"` (server never emits them).
- Unreachable `planner.html` branch (`src/server.js:673`); fallback UI the server redirects before (`workout.html:36`, `onboarding.js:82`).
- `wellness_nights.ans_charge` (V3) once `ans_charge_v4` is backfilled.
- Root `strata-ai-plan.txt` (stale) and the archived half of `strata-polar-plan.txt`; `docs/release-readiness.md` (describes 8.0.1).
- `qa/calibration-benchmark.js` (no npm script runs it) — or wire it into `check`.

### 3.7 FOLD INTO AI

Only logic whose *explanation* is the product; the deterministic calculation stays server-side so the free tier and offline paths keep working.

| Today | Becomes |
|---|---|
| Nutrition "Behind the numbers" narrative (calibration, goal comparison, weight scenarios) | A line in the Daily Brief / a chat answer ("your target moved 75 kcal because…") |
| Training-block weekly review text ("carry forward / lighter week") | A Daily Brief recommendation; the block state stays deterministic |
| "Previous comparable performance" prose on Overview | Daily Brief "today's recommendation"; Train keeps the numbers |
| Recovery "stress signals" explanation | Daily Brief readiness read; Recovery keeps the charts |

---

## 4. Repeated features report

Each must collapse to **one** place.

| # | The same thing in several places | Places | One owner |
|---|---|---|---|
| 1 | **Build or change the weekly plan** — 12 paths, **5 generators**, **6 "replace my plan" confirmations** | planner manual; templates/copy/import; device claim; home preview; onboarding; session builder; coaching suggested week; community apply; monthly; training block + progression card; AI (page + widget); Train swap/adaptation | **Plan page** owns the plan and one review-and-replace flow; generators (one deterministic + AI) only produce candidates |
| 2 | **Exercise rankings** | home rankings; home preview top-3; studio Recommendations; Library "Personal match"; Compare; decision board = "Saved"; planner library; 4 detail dialogs; 3 FitScore explainers | **Library/Rankings** (public on `/`, personal lens for members); one detail; one explainer |
| 3 | **Progress and stats** | Overview brief; Plan summary card; Progress; training-block review; Train history; Workout Memory; Account stat grid; planner evidence; Recovery weekly table; onboarding snapshot | **Progress** (numbers), **Train** (raw log + per-exercise memory); "sets by muscle" one shared component |
| 4 | **Next workout** | Overview hero, Account "Next up", Train start panel | **Train** |
| 5 | **Polar recovery** | Overview card, Recovery tab, Train lighter session, Account devices | **Recovery** (data), readiness badge on My Week/Train, connect/disconnect on Profile |
| 6 | **Progression suggestion** | studio progression card, Train "next target", Train adaptation proposal | Train shows the target; Plan shows one pending change |
| 7 | **Nutrition entry points / body weight** | home card, Overview card, Progress link; weight in Personal setup *and* the diary | **Nutrition**; weight entered once (diary), profile keeps the baseline |
| 8 | **Profile / preferences** — 4 label sets for one "goal" field | home preview, onboarding, Preferences, Personal setup, Account intro, workout rest prefs | **Athlete Profile** (one vocabulary) |
| 9 | **Sharing / export** | planner publish; community browse; share cards ×3; monthly PDF/share; planner JSON export/import; monthly import; account export; 3 draft downloads; 2 calendar exports | Plan page: export/import; Account: data export; one calendar export; everything else CUT |
| 10 | **AI entry points** | Overview button, launcher, `/ai`, pricing | Launcher + full-screen |
| 11 | **Conflict / draft recovery panels** | planner, Train | One component |
| 12 | **Strata+ generated week vs saved plan** (data) | `coaching_weeks.training.sessions` vs `plans` | `plans` |

---

## 5. "Feels like a project" report

| Giveaway | Where |
|---|---|
| **Build number in every footer** ("STRATA · Build 8.9.0") and in `index.html:395`, `pricing.html:104` | every page → keep only in Account/Settings → About |
| **"Coming soon" / infrastructure copy:** "Recovery is coming soon… Polar connections aren't switched on yet" (a top-level tab!); "Strata AI isn't switched on yet"; "Permanent account storage is active" / "accounts may be lost when the server restarts"; "This shell contains no cached account page or private API response"; "Offline fallback" | `discover-recovery.js:20`, `ai-logic.js:118`, `account.html:35`, `workout-offline.html:22`, `offline.html:35` |
| **Placeholder cards:** three cards literally titled "Recommendation" with "The result will explain itself instead of asking for blind trust"; "Rules-based result"; "Training is not enabled here" | `index.html:136-147` |
| **Engineering vocabulary shown to members:** "engineering heuristics/checks", "unvalidated STRATA heuristic", "Cunningham", "Interval-derived estimate", "A newer coaching model is available", "deterministic", "Loading exercise intelligence…", "WEEK n REVIEW", "Completed sessions in the loaded history", "Previous comparable · 100 most recent", "Workout Memory received an incomplete history page", "Searched STRATA's 320 exercises for: …" | `discover.html:240,394,398,404,535`, `discover-coaching-render.js:62,67`, `discover.js:174,247`, `discover-catalog.js:50`, `workout.js:159`, `ai-render.js:90`, `policies.html:59` |
| **Raw IDs / internal values:** exercise IDs in monthly-plan errors; title-cased IDs as fallbacks; `?reason=discovery-required`; share filenames `strata-ranking-<timestamp>.png`; enum values with underscores stripped | `monthly-plan-core.js:95,163,214,246`, `discover.js:155`, `discover-sharing.js:29-32`, `discover-coaching-render.js:14,72,80` |
| **Dead or misleading links:** "Templates" / "Import/export" point at planner button IDs that nothing opens; header "Exercises" goes to the public homepage while the tab "Exercises" opens the studio library; "Download PDF ↓" opens print; "Connect Polar" points at a card hidden when Polar is unconfigured; "Video" opens a YouTube *search*; pricing mentions a "Use last values" button that is "Use previous values"; free users can publish to a library they cannot see; `href="#"` calendar links until JS fills them | `discover.html:30,88,159,412,613`, `planner-render.js:28,37`, `pricing.html:80`, `planner.html:108-123`, `workout.html:54,85` |
| **Developer tools in the product:** privacy page "Inspect the exact local summary / Copy summary"; Admin's "System readiness" card is fine (owner only) | `privacy.html:82-83` |
| **Gmail support address** `stratafitness.official@gmail.com` | home, contact, policies |
| **Inconsistent naming** (see §4 and the table below) | everywhere |
| **Old nav still in docs:** "fifth destination, after Today, Plan, Progress, and Explore"; `release-readiness.md` describes 8.0.1; deployment smoke example uses build 7.8.7 | `docs/architecture.md:158`, `docs/testing.md:120`, `docs/release-readiness.md`, `docs/deployment.md:199` |
| **No console/debug output** in `public/scripts` — good. No HSTS header set by the app — check Render adds it. | |

**Naming to settle (one name each):**

| Concept | Variants today | Proposed |
|---|---|---|
| Members' area | Strata+, Strata+ Studio, Strata+ workspace, coaching workspace, `/discover.html`, "discovery" | **Strata+** (badge), no "studio" |
| Weekly plan | Plan, Weekly Plan, Build your week, My week, weekly planner, free planner, Free device plan, Offline planner, studio Plan panel | **My Week** |
| Training page | Train, Workout Room, The workout room, Open Train, Offline Workout | **Train** |
| Exercise list | Exercises, Rankings, The index, Library, Exercise library, Explore every movement, Find an exercise | **Rankings** (public) / **Exercises** (nav) — pick one |
| Compare | Compare, battle, Exercise battle, Add to battle, Head to head, Compare moves; limit 2 vs 4 | **Compare**, limit 4 |
| Saved exercises | decision board, Saved · N, shortlist | **Saved** |
| Profile | Personal setup, coaching profile, personal profile, Preferences, Tune your ranking lens, selection rules, Personalize recommendations | **Profile** |
| Last-time performance | Training Memory, Workout Memory, Previous comparable performance, Previous performance | **Training Memory** (it is the pricing headline) |
| Session generator | Workout builder, Personalized session builder, Build a session, Alternative session, Create a different workout, one-off workout | **Build a session** |
| Longer range | Training block (4–8 wk) vs "31-day training block", Monthly schedule, Pick my workouts, 31-day planner | **Plan ahead** |
| Brand | STRATA, Strata, Strata Index, STRATA Fitness | **STRATA** (one casing) |

---

## 6. Proposed navigation (max 5)

| New section | Contents | Old → new |
|---|---|---|
| **Rankings** (free) | Public rankings with filters, one exercise detail, Compare, Saved; members get the "Personal match" lens and ratings | home `#rankings`, studio Library, Recommendations, Compare, decision board, planner library |
| **My Week** (free; richer with Strata+) | The weekly plan (planner), today's next step, "Build a starter week/day" generator, Plan ahead (blocks on dates), templates/import/export; readiness badge and AI brief inline for Strata+ | planner, studio Overview, Plan menu, session builder, training block, monthly, onboarding's week step, AI "apply" |
| **Train** (Strata+ logging; free users see their plan read-only) | Start/resume, set logging, Training Memory, progression/check-in, session list, offline shell, calendar export | workout.html, Overview hero's start action, Account "Next up" |
| **Recovery** (Strata+) | Polar last night, trends, lighter-session offer, Progress (volume, consistency, records) — *or* keep Progress under Train (decision) | studio Recovery, Progress, Train history stats |
| **Profile** | Account, Athlete Profile (goals, schedule, equipment, body), Nutrition targets + diary + meal ideas, devices, billing, privacy, About (build number) | Account, Personal setup, Preferences, Nutrition, onboarding, devices, pricing links |

Strata AI is not a section: the launcher lives on every member screen, the Daily Brief appears inline on My Week / Train / Recovery, and `/ai` is the expanded chat.

**Open layout question:** Nutrition is a daily-logging habit like Train. Alternatives: (a) Profile owns targets, Train gets a "Food" log tab; (b) Nutrition replaces Recovery as a top-level section if Polar adoption stays low. I recommend (a) once we know the tier decision.

---

## 7. Visual quality pass (1–5) and what blocks a 4

| Screen | Score | Blocker to reach ≥ 4 |
|---|---|---|
| Home | 4 | Lower half: placeholder "Recommendation" cards, demo console, duplicated CTAs |
| Planner | 4 | Five-button toolbar stacks on phones; "Account" label on the sign-in link |
| Pricing, Account, Install (5), Contact, Policies, Login | 4–5 | — |
| Studio Overview | 4 | — |
| Plan menu | 3 | It is a menu; merge |
| Session builder | 4 | — |
| Monthly | 3 | Form-heavy; "Download PDF" opens print |
| Community | 3 | Empty state only |
| Progress | 4 | — |
| Exercises hub | 3 | It is a menu; merge |
| Recommendations | 3 | Empty decision board dominates |
| Library | 4 | — |
| Compare | 3 | Four `<select>`s; pick from Saved/Library instead |
| Preferences | 4 | — |
| Personal setup | 4 | Long; equipment lives elsewhere |
| Nutrition (no profile) | 3 | One card; with data 4 |
| Recovery (unconfigured) | 2 | "Coming soon" copy on a top-level tab |
| Train | 4 | — |
| AI page / widget | 4 | — |
| Onboarding | 4 | — |
| Admin | 4 | — |
| Offline shell / offline page | 3 | Infrastructure copy |

Anything that cannot reach 4 after the merges above (Monthly as a standalone, Community, Exercises hub, Plan menu) is already marked MERGE/CUT.

---

## 8. Tier gating today → `can(user, feature)`

- One server function computes Strata+: `billing.hasCurrentAccess` = paid (lifetime purchase or active subscription on the entitled catalog) **or** legacy trial **or** complimentary admin grant (`src/billing.js:107`, `src/billing-store.js:135`, `src/access-controls.js:4`). The route guard is `requireDiscoveryAccess` → 402 `DISCOVERY_ACCESS_REQUIRED` (`src/server.js:361`).
- **But:** which routes are free vs Strata+ is decided inside each module's `handleApi`; the browser re-derives access in 8 modules from `user.discovery.*`; Admin uses a *different* SQL rule (no catalog filter) so its "Strata+ active" count can disagree; the grant rule exists twice (JS and SQL); the client checks `accessType` values the server never emits; and the grandfathered-lifetime display can be wrong when a canceled subscription row exists.
- Oddities to decide: free users may **publish** community plans but not browse them; Polar status/disconnect stays available after lapse (correct); admin does not imply Strata+ (correct).
- **Target:** one module returning `{ allowed, reason, until }` per feature, exposed as `user.capabilities` on `/api/me`, used by every route guard, the SSR header, Admin, the offline window in `workout-core.js`, and every upsell. Feature keys: `plus.studio`, `plus.ai` (+ provider configured + quota), `plus.polar`, `plus.plan_ahead`, `plus.nutrition` (pending §10), `plus.training_log`, `community.*` (if kept), `admin`, `checkout.start`.

---

## 9. Data duplication report

Full table in the database sweep. The ones that matter:

1. **Weekly plan stored ~12 times.** `plans.plan_json` is canonical. Copies: `community_weekly_plans.plan_json` (stale after edits), `monthly_plans` (`schedule.sourceItems` + 31 expanded days, no revision link), `coaching_weeks.snapshot_json.training.sessions` (**a second, unrelated weekly program** built from `coaching_profiles.workoutDays`; `ai-core.js:248-257` works around the mismatch only on the AI path), `training_adaptations.change`, the AI draft in sessionStorage, and 5 localStorage keys (`strata_guest_plan_v1` never cleared after claim; `strata_activation_intent_v1` never removed; `strata_activation_backup_v1:*` **grows without limit**; `strata_plan_draft_v1:*`; `strata_week_template_v1:*`).
2. **Training profile in four places with different vocabularies:** `preferences` (goal/level/days count/equipment/limitations) vs `coaching_profiles` (trainingGoal/experience/workoutDays/sessionMinutes/availableEquipment/movementLimitations + stored `sessionsPerWeek` that is just `workoutDays.length`) vs onboarding localStorage `strata_setup_v1` (the **only** copy of onboarding session minutes, on a 20/35/50 scale vs coaching's 30–90) vs `strata_activation_intent_v1.profile`. Nothing keeps them in sync after setup.
3. **Body weight:** `coaching_profiles.weightKg`, `coaching_daily_logs.morning_weight_kg` (the series), and a frozen copy in every `coaching_weeks.inputs`.
4. **Workouts:** `workouts.summary_json` and `started_at` are derivable from `workout_json`, and both consumers re-derive them anyway.
5. **Polar vs STRATA workouts:** `wellness_workouts` and `workouts` are unlinked; the same session can exist twice; matching is a time-overlap heuristic in the browser, not persisted, and not fed into progression, calories or AI.
6. **Entitlement:** `paddle_subscriptions` repeats five columns of `paddle_purchases`; the purchase-or-trial-or-grant rule is written out in four places.
7. **Counters:** `product_signal_counts` and the browser's `strata_product_signals_v1` overlap what `workouts`/`plans` already hold; AI daily usage and rate buckets live only in memory.
8. **Dead/legacy tables:** `discovery_trials`, `admin_elevations`, `device_revocations`; `paddle_webhook_events` has no cleanup.
9. **Schema changes outside the ledger:** all `CREATE TABLE IF NOT EXISTS` run at startup; a data rewrite and a trigger rebuild run on every boot.

**Phase 3 mapping (preview, for approval later):** Athlete Profile = `coaching_profiles` + `preferences` + onboarding minutes (one vocabulary); Training Log = `workouts` + `workout_check_ins` + `wellness_workouts` (linked, source-tagged `manual|polar|ai|system`); Daily Snapshot = `wellness_nights` + `wellness_days` + `coaching_daily_logs` + planned-vs-done + AI brief (one row per user per day); Rankings Signals = `ratings` + recommendation feedback + Training Log counts.

---

## 10. Open decisions for you (asked, not assumed)

1. **AI included in Strata+ or a ~10 USD/month add-on?** Groq free-tier arithmetic to inform it: today one member request can cost up to ~9 completions (first try, compact retry, JSON repair, search re-ask, contract correction). At ~1,000 requests/day per model, a nightly Daily Brief (1 call) plus a cap of ~5 chat calls per member per day supports roughly **150 active AI members** on the free tier, double that with the 20b fallback's separate quota. Beyond that the quota manager serves cached briefs.
2. **Data retention after Strata+ cancellation:** today Polar data is kept read-only (400-day cleanup) and sync pauses; workouts/plans are kept. Keep read-only, or delete after X days?
3. **Nutrition tier:** it is built as Strata+ and not in your tier table. Keep as Strata+ (my recommendation), move to free, or make it part of the AI add-on?
4. **Community plans:** CUT, or MERGE into templates as "Shared weeks"? Check Admin → Aggregate activity for `plan_saved` vs any sharing first (there is no share signal, which itself suggests it was never measured).
5. **Monthly 31-day plan:** fold into "Plan ahead" (my recommendation) or keep as its own stored plan?
6. **Progress placement:** under Recovery (readiness + results) or under Train?
7. **Any feature you want kept regardless of the matrix?**
8. **Groq paid tier threshold:** suggest switching when active AI members exceed ~120 (80% of the free quota by the maths above), or on the first week of daily 429s.

---

## 11. What happens next (not started)

Phase 2 begins only after you approve §3. First Phase 2 PR would be the no-risk half: dead endpoints, dead tables and store methods, legacy trial code, stale docs, naming, and the "project giveaway" copy — none of which change what a member can do. The merges (§3.3) follow one at a time, each shippable.
