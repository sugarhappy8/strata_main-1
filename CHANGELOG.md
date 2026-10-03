# Changelog

## 9.6.0 — Fix list

- The App Store paywall says "Welcome to Strata+" only when STRATA reports that the purchase unlocked it. A purchase STRATA saved but did not unlock gets a plain warning instead, and an App Store test (Sandbox) purchase is told that test purchases do not unlock Strata+.
- An `APPLE_SANDBOX_ACCOUNTS` address unlocks Strata+ with a Sandbox purchase only once that STRATA account has verified its email, so nobody can sign up with the review address and inherit its access.
- `html` (in `public/scripts/html.js`) returns trusted markup instead of a string, so a template nested inside another is escaped exactly once, and `setHtml`, `insertHtml`, and `replaceHtml` refuse plain strings. Every hand-built template in 37 browser modules now uses `html`, and the hand-written `esc()` calls are gone; links, IDs in `data-*` attributes, class names, and chart attributes that were never escaped now are. ESLint rejects markup in plain strings, hand escaping, and joining or concatenating `html` results.
- The old Paddle checkout code is removed: `src/legacy-checkout.js`, the earlier-monthly-price allowlist (`PADDLE_LEGACY_RECURRING_PRICE_IDS`), the Build 7.4 one-time draft migration and late completion, and catalog migration of subscriptions. STRATA entitles only `PADDLE_PRICE_ID`. Switching off abandoned drafts at Paddle, account-deletion checks, and access from completed one-time purchases are unchanged. An abandoned checkout on any other price is now switched off when the member starts a new checkout, instead of blocking it.
- `POST /api/discovery/trial` (answering `410` since 8.9.0) is removed and returns `404`.
- Migration `011-drop-build9-archives` drops `archive_discovery_trials` and `archive_community_weekly_plans`; migration `012-close-build7-checkouts` closes any unfinished checkout on the retired Build 7.4 one-time price.
- API path IDs must be letters, digits, `_`, and `-` (up to 200). They are matched against the raw path and never decoded, so an encoded `/` (`%2F`), `..`, or a control character can no longer reach a handler inside an ID; such a path answers `404`.
- Advance every asset version and the offline cache to 9.6.0.

See the [9.6.0 release guide](docs/release-9.6.0.md).

## 9.5.0 — Structure and maintainability

- Every API route is declared in one table (`src/router.js`): `{ method, path, feature, handler }`. One dispatcher applies the checks to every route the same way: a trusted STRATA origin on each write, the session (or the Strata+ feature, or the bound owner), the session's CSRF token on each signed-in write, and a JSON body. A write is protected unless its route opts out by name with `public: true`, `auth: "optional"`, or `webhook: true`; a test lists the 14 writes that run without a session, so adding one is a reviewed change. `handleApi` no longer walks 15 modules, and the services no longer check CSRF or origin themselves.
- These refusals have one code each on every route: `403 ORIGIN_REQUIRED`, `403 INVALID_CSRF`, `415 JSON_REQUIRED`, `405 METHOD_NOT_ALLOWED`. The module codes (`WORKOUT_ORIGIN_REQUIRED`, `ADMIN_ORIGIN_REQUIRED`, and the rest) are retired. A write with no `Origin` header is refused on every route, as it already was on most.
- Browser code has one HTML escaper: `public/scripts/html.js` (`StrataHtml.escape`) and an `html` tagged template that escapes every value put into it. Every page loads it first. The 15 local copies are gone, every `innerHTML`, `outerHTML`, and `insertAdjacentHTML` write goes through `StrataHtml`, and ESLint rejects any other. Elements that were only cleared use `textContent`.
- The code is formatted with Prettier (`printWidth` 100) in a commit with no other change, and `npm run check` starts with `prettier --check`. ESLint `max-len` (140, strings, templates, regexes, URLs, and type tags exempt) keeps lines from growing back. SQL that did not fit on one line is written one clause per line, including the 1,900-character admin queries.
- Strata+ (`/discover.html`) loads one `<script type="module">` entry, `discover-page.js`, instead of 36 body script tags; the three scripts that must run before paint stay in `<head>`. The architecture check follows the entry's imports to verify the load order, and `discover-program.js` joins the offline cache.
- Advance every asset version and the offline cache to 9.5.0.

See the [9.5.0 release guide](docs/release-9.5.0.md).

## 9.4.0 — Hardening

- Apple Sandbox purchases are still verified and saved, but in production they unlock Strata+ only for accounts listed in `APPLE_SANDBOX_ACCOUNTS` (put the App Review demo account there).
- `POST`, `PUT`, and `DELETE` on `/api/workouts` require a trusted origin; a write with no `Origin` header is refused with `WORKOUT_ORIGIN_REQUIRED`.
- Product activity counts: a signed-in count needs the session's CSRF token, anonymous counts have their own rate limit and total, each action counts once per account or network per UTC day, and signed-in and anonymous counts are stored apart, with decisions made from the signed-in ones.
- The Strata AI member allowance and shared daily budget are claimed with one conditional write each, and a member's simultaneous requests can no longer each claim the quota.
- `/api/status` returns only `{ ok, version }`; setup flags moved to the admin Overview, and the deploy smoke checks that nothing else is public.
- A failed event reaction is saved to an outbox and retried with backoff; reading a member's Daily Snapshots retries their queued reactions first, so a failed rebuild heals on the next read.
- The renewed session cookie is added with `appendSetCookie` before handlers write, replacing the `res.writeHead` override.
- Rate limits (`rate_buckets`), the Strata AI queue (`ai_jobs`), and the Polar sync loop's lock (`locks`) live in the database. STRATA runs as one server (`numInstances: 1`) and logs `service.multiple_instances` if a second one shares the database.
- Advance every asset version and the offline cache to 9.4.0.

See the [9.4.0 release guide](docs/release-9.4.0.md).

## 9.3.0 — Sign in with Google

- Members can create an account or sign in with Google from Profile, next to email and password. STRATA uses Google's OpenID Connect sign-in with PKCE and a nonce, checks every ID token against Google's published keys, and finishes only in the browser that started. A Google account links to an existing STRATA account only when both have verified the same email; otherwise it creates a verified account without a password, which can add one through the emailed set-a-password link. The button stays off until `GOOGLE_SIGN_IN_CLIENT_ID` and `GOOGLE_SIGN_IN_CLIENT_SECRET` are set.
- The iOS app keeps email sign-in only, because Google refuses sign-in inside embedded web views; its sign-in panel tells members who signed up with Google to set a password with Forgot password?. In the app, an account without a password deletes with DELETE alone within 15 minutes of signing in.
- The Content-Security-Policy's `form-action` allows Google's sign-in page. Exports list a linked Google sign-in without Google's account identifier, and deleting an account removes it. The privacy policy describes what Google shares.
- The Google logo carries its own size, so a stale cached stylesheet can no longer stretch it across the button.
- A Strata AI test no longer races a slow signup against its 400 ms busy-queue window.
- Advance every asset version and the offline cache to 9.3.0, so installed apps and returning browsers fetch the new account page styles and scripts instead of mixing them with cached 9.2.0 files.

See the [9.3.0 release guide](docs/release-9.3.0.md).

## 9.2.0 — The STRATA iOS app

- The website half of the STRATA iOS app (`sugarhappy8/strata-fitness-ios`). Inside the app (user agent `StrataApp/<n>`) every page gets one tab bar and top bar, app-style transitions and press feedback, and native extras through the app: haptics, the screen kept on during a workout, a "Rest is over" notification, Add to Calendar through iOS's New Event sheet, AirPrint, and downloads handed to the share sheet. Browsers see the site exactly as before.
- Strata+ in the app is sold through Apple In-App Purchase (Strata+ Monthly, the same $2.99). The server verifies StoreKit 2 transactions and App Store Server Notifications V2 against Apple's pinned root, binds each purchase to the STRATA account, and treats Paddle, App Store, and admin grants as one Strata+. Family Sharing copies never unlock it; Paddle checkout refuses App Store members and the portal points them to Apple.
- Account deletion completes inside the app with the password and DELETE (`POST /api/account/delete/now`), with the same protections as the emailed link; App Store subscribers are told Apple keeps billing until they cancel.
- Sessions in the app renew while in use (60-day cap). Daily Snapshots and the Training Log date "today" in the member's own time zone. Strata AI says it is not medical advice.
- Advance every asset version and the offline cache to 9.2.0, so installed apps and returning browsers fetch the new scripts instead of mixing them with cached 9.1.0 files.

See the [9.2.0 release guide](docs/release-9.2.0.md).

## 9.1.0 — Dashboard

- Dashboard replaces My Week in the navigation. Strata+ members land on a page with two choices, Plan and the Strata+ dashboard; free accounts and visitors go straight to Plan. `/my-week` still works.
- The homepage's top bar is now Rankings, Dashboard, and Install. On phones the signed-in name stays in the header so Profile is one tap away.
- Profile drops the "Your next move" card and button; it no longer fetches the plan and workout history it only used for that card.
- Advance every asset version and the offline cache to 9.1.0, so installed apps pick up the new navigation and the Dashboard page.

See the [9.1.0 release guide](docs/release-9.1.0.md).

## 9.0.0 — Cut and integrate

- One navigation on every page: Rankings, My Week, Train, Recovery, and Profile. Rankings, My Week, and Recovery open the Strata+ studio for members and the public rankings, the free planner, and the Strata+ plan for everyone else.
- Cut what was duplicated or unfinished: the legacy trial and its tables, community weekly plans, the exercise hub and decision board, the share-card generator, the homepage compare tray, Train's history stat boxes, the one-off calendar file, and build numbers in the main UI. Archived tables keep their rows for one release.
- One entitlements module decides every page and route (`can(user, feature)`), and upgrade lines come from it.
- One data layer: the Athlete Profile, a deduplicated Training Log, Daily Snapshots, Rankings Signals, and plan history, kept in step by events. Coaching reads the saved weekly plan.
- Polar sessions and nights join that layer; My Week shows last night's Nightly Recharge, and a Polar gym session completes an unlogged planned day.
- Strata AI runs on Groq behind member consent and a shared daily budget, reads its context from the data layer, and writes a Daily Brief each morning. The owner sees today's use on the admin Overview.
- One design-token file every page loads; setup's secondary text is readable again.
- A share card for public pages, an optional Polar step at the end of onboarding, HSTS in production, and the fixes from a first-time-visitor walk.

See the [9.0.0 release guide](docs/release-9.0.0.md) and the full record in [CHANGELOG_9.0.0.md](CHANGELOG_9.0.0.md).

## 8.9.0 — Subscription-only Strata+ and a simpler studio

- Retire the free Strata+ trial. Pricing, the homepage, Account, Terms, and Privacy no longer offer it; `POST /api/discovery/trial` answers `410 TRIAL_RETIRED`; a trial started earlier runs to its recorded end.
- Move Strata AI off the homepage into a Strata AI chat on every Strata+ view: a round launcher that glows on a slow beat and says “Strata AI chat” on hover or keyboard focus opens a small chat panel (full screen on phones) for asking questions and applying proposed weeks, nutrition targets, and swaps. The chat and the full `/ai` page share one conversation engine and one conversation per tab.
- Advance every asset version and the offline cache to 8.9.0; the earlier 8.9.0 changes had shipped under the 8.8.8 asset versions, so installed apps showed the new Overview cards and Strata AI button without their styles. `npm run release:check` now fails when the newest changelog entry names a build the version markers do not carry.
- Reduce the Strata+ tabs to Overview, Recovery, Progress, and Exercises. Overview keeps everything it showed and adds Plan, Train, and Nutrition cards; Plan and Nutrition open their views with a way back, and Train opens the Train page. Switching views no longer takes focus back from a card or control focused before the next frame, so Enter on an Overview card always opens it.
- State each pricing fact once and drop the repeated trial, comparison, and assurance sections.
- Remove the Weekly progress, Recent momentum, and Training signal cards from Account.
- Unlock Strata+ in tests, E2E journeys, and the 100-user load check through a complimentary-grant fixture instead of the trial.

See the [8.9.0 release guide](docs/release-8.9.0.md).

## 8.8.8 — Clock-relative billing test fixtures

- Derive the Paddle subscription billing period in the account-recovery server tests and the browser payment journey from the current clock instead of a fixed window that ended on 2026-10-01, so entitlement checks in CI no longer expire with the calendar.
- No product or runtime behavior changes; Build 8.8.8 ships the same Polar AccessLink V4 integration as 8.8.7.

See the [8.8.8 release guide](docs/release-8.8.8.md).

## 8.8.7 — Polar AccessLink V4

- Move Polar authorization to `auth.polar.com`, request only sleep, Nightly Recharge, continuous-sample, and training-session read scopes, and read data from the V4 range endpoints.
- Seal a versioned access/refresh credential bundle, refresh near-expiry grants, and persist each rotated refresh token before using the new access token. Existing V3 connections fail closed into reconnect.
- Replace V3 user registration, deregistration, and signed webhooks with documented V4 polling. Disconnect and account deletion now erase credentials and imported data locally; members can separately manage Polar authorization at `account.polar.com`.
- Map V4 nested sleep, Nightly Recharge, continuous-heart-rate, and training-session payloads, including the wider ANS-status range, and exercise the flow with V4 unit, storage-parity, HTTP integration, and browser stand-ins.

See the [8.8.7 release guide](docs/release-8.8.7.md).

## 8.8.6 — Polar connected devices for Strata+

- Let each Strata+ member connect their own Polar account from a new Connected devices card on Account, after a consent step. The OAuth return is completed by the session that started it, and tokens are sealed with AES-256-GCM and never leave the server.
- Import Polar's last 28 days on connect, then sync at least daily and sooner after signed Polar webhooks, within Polar's reported rate limits. Syncing pauses while Strata+ is inactive, and members are asked to reconnect when Polar rejects their token.
- Add the Recovery destination: Polar's Nightly Recharge, overnight stress signals compared only with the member's usual nights, sleep with stages, overnight and 24/7 heart rate, and 4-, 8-, and 12-week trends next to STRATA workouts and Polar cardio load. The Overview gains a recovery card, and all seven destinations stay visible on phones.
- After a poor night, or two nights with more stress signals than usual, Train can offer a lighter session: the same exercises with one set fewer each, for that day only, without changing the Plan. History marks lighter sessions and shows the Polar workout recorded during each STRATA session.
- Disconnecting or deleting the account deletes imported Polar data and ends STRATA's access at Polar; the account export includes Polar data without tokens or Polar identifiers. The Privacy Policy and Terms describe connected devices.
- Add `npm run polar:webhook`, a Polar check in `npm run preflight:production`, Polar settings in `.env.example` and `render.yaml`, and a deployment guide section.

See the [8.8.6 release guide](docs/release-8.8.6.md).

## 8.8.5 — Polish, accessibility, and cleanup

- Keep the Strata+ destination tabs on screen when a destination opens or a link opens one directly, instead of sliding them under the sticky header.
- Restore readable contrast on the homepage preview introduction, the Policies support kicker and founder label, and the offline page kicker, and size the Pricing page's inline links like body text.
- Give every page one top-level heading, including the Strata+ studio, the signed-in Account page, and the phone workout page, whose "Skip to workout" link has a target again.
- Show workout-room dates as "Wed, Sep 30", label the target card "Today's target", and move the unstyled post-workout note into the progression card.
- Offer "Add food preferences" when Nutrition has no saved preferences, number recovery days in the suggested week, remove the seam above the Nutrition targets, and stop clipping phone chart labels.
- On Strata AI, show the starter prompts before the message box until the first message, keep keyboard focus above the pinned message box, keep a failed question's Try again until it can be sent, and treat a missing set count as three sets. Discarded provider responses are cancelled so their connections close promptly.
- Remove the unused administrator email-code module and its `ADMIN_EMAIL_MFA_REQUIRED` setting, stylesheet rules for 25 retired classes, and a no-op email-verification option. Add the missing 8.8.3 and 8.8.4 changelog entries, refresh the architecture notes and `SHA256SUMS`, and update `brace-expansion` to clear an audit advisory.

See the [8.8.5 release guide](docs/release-8.8.5.md).

## 8.8.4 — Strata AI responses that apply correctly

- Send Atomic Chat the llama.cpp schema dialect it enforces (`json_object` with the bounded schema in `response_format.schema`), so a proposed week can no longer hide inside `reply`. Providers that reject the schema fall back once to plain JSON mode and then to a plain request.
- Make "only two rest days" mean exactly five training days on a balanced schedule, and "make sessions longer" keep the same days while moving every session to the next 15-minute tier. Explicit targets and deltas such as "increase sessions to 75 minutes" or "add 15 minutes to each session" are read separately.
- Send correction instructions as the final member turn, and when a local model still misses a pure day-count or duration requirement, build the change from the validated draft and run it through the same catalog, plan, and contract checks.
- Check equipment-only requests against the exercise catalog, keep questions about the week on screen reply-only, and force pain, injury, pregnancy, medication, eating-disorder, and diagnosis wording onto the reply-only safety path.

See the [8.8.4 release guide](docs/release-8.8.4.md).

## 8.8.3 — Reliable Strata AI plan edits

- Send the latest unapplied proposal to the server as a bounded, validated structured plan, so follow-up edits act on the week the member is viewing instead of a 1,200-character prose recap.
- Convert measurable schedule wording into a server-owned edit contract: exact rest and training-day counts, added or removed days, explicit session lengths, and "longer" or "shorter" sessions. A proposal that contradicts it gets one precise correction, and a second mismatch fails clearly.
- Keep questions such as "Should I make sessions longer?" informational, give a valid proposal with a missing reply a short server fallback, allow the documented 90-minute working-set ceiling, and apply a proposal only against the plan revision it was generated from.

See the [8.8.3 release guide](docs/release-8.8.3.md).

## 8.8.2 — Conversational Strata AI

- Answer ordinary questions about training, exercises, recovery, and general nutrition directly instead of forcing every message into a plan or settings proposal.
- Treat informational questions as read-only conversation: a week, calorie or macro targets, and plan-review suggestions are created only after an explicit request.
- Allow direct answers up to 90 words while keeping proposal replies at 60 words and preserving every existing proposal validator and apply-time confirmation.
- Update the Strata AI page, starter prompts, composer guidance, and waiting text so members can clearly see that they may ask a question or request a plan.

See the [8.8.2 release guide](docs/release-8.8.2.md).

## 8.8.1 — Faster Strata AI answers

- Ask the model for each exercise as `[code or exact name, sets, reps]` instead of an object, which makes a proposed week about 45% shorter. The object form is still accepted.
- Cap replies at 60 words and each answer at 900 tokens (from 90 words and 1,100 tokens), so answers arrive sooner and a model that loops stops sooner.
- Show the seconds elapsed while Strata AI works, with the usual 10–30 second range.
- Log a content-free `ai.unreadable_answer` warning (length, whether it was cut off, whether it started as JSON) when a model's answer cannot be read. Messages and answers are still never logged.
- Recommend official instruction-tuned models in the deployment guide, and explain why community merges, upscaled models, and thinking models can fail.

See the [8.8.1 release guide](docs/release-8.8.1.md).

## 8.8.0 — Strata AI

- Add Strata AI at `/ai` for Strata+ members. Describe a week in your own words and Strata AI proposes one from all 320 STRATA exercises: a shortlist chosen for each request (default picks per muscle group, anything you name, and your equipment, experience, and movement limits), plus one search of the full library when you ask for something that isn't on it.
- Check every proposal on the server before it appears: unknown exercises, exercises your movement limits exclude, duplicate exercises, days with fewer than two exercises or more than 30 sets, and weeks with no rest day are dropped or refused. Session length always comes from STRATA's estimate of 2.5 minutes a working set plus a warm-up.
- Offer matching nutrition after a week. Strata AI picks the goal, pace, calorie pattern, and macro preference; STRATA's own calculator produces the calories, shown as maintenance minus the deficit with a target for each day, and the personal setup's training days follow the plan. Apply saves it with the usual revision check.
- Add "Review my plan": up to three suggestions, where a suggested exercise swap applies to the saved plan with one tap if that exercise is still there.
- Apply nothing without a tap. Replacing a saved plan asks first, and quick replies under the latest week accept the calorie offer or ask for shorter sessions.
- Queue requests in memory so no web request waits on the model; the page polls for the answer and shows its place in line. Each member gets 30 requests per UTC day, one at a time, and requests the model never received are not counted.
- Retry a context overflow once without history, a cut-off answer once with a request for a shorter reply, and a response the model broke once at a lower temperature. Tunnel timeouts, an offline model, and a refused key each show a clear message, and the rest of STRATA keeps working.
- Add a homepage section, "Don't feel like planning things yourself? Ask Strata AI to do it for you.", which opens `/ai` for members with Strata+ and pricing for everyone else. Pricing explains that Strata AI is part of Strata+ and returns people to `/ai` after sign-up, sign-in, or the trial. Strata+ Overview links to it.
- Configure it with `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` for any OpenAI-compatible server, with optional limits and a Cloudflare Access service token. In production the key is never sent over plain HTTP to another machine.
- Update the privacy policy and terms to describe what Strata AI receives, how long answers are held, and its limits.
- Match exercise names by singular form, so "flat dumbbell presses" finds Flat Dumbbell Press.

See the [8.8.0 release guide](docs/release-8.8.0.md).

## 8.7.0 — Clear calorie math and a calmer STRATA

- Show Nutrition's arithmetic: the target reads as maintenance minus the deficit (or plus the surplus), with one target per kind of day, and See calculation lists resting energy × the movement factor, planned workouts ÷ 7, other activity, the rounded estimate, and any calibration, in rows that add up on screen.
- Split zigzag session energy evenly across training days, so days of the same kind share one target in multiples of 5 kcal while the seven days still add up to exactly seven times the average. Week generation is now `coaching-week-v7`; saved weeks keep their numbers until the next snapshot.
- Check diary macros against the calories entered (4 kcal per gram of protein or carbohydrate, 9 per gram of fat), offer the macro total as the calorie entry, and explain a remaining mismatch beside meal ideas.
- Keep two decimals for profile weight, height, known loads, and morning weights, so pound and inch entries read back as typed.
- Add quick add (a meal or +100, +250, or +500 kcal, added and saved in one step), copy the previous day, a logging streak, and a morning-weight trend chart with its seven-day average and weekly change.
- Add weekly calendar reminders on Train: one calendar file with a repeating event for every planned day at a chosen time and an optional reminder. Downloading again updates the same events in calendar apps that honor event updates.
- Redesign every page around one type family in sentence case, one olive accent on light surfaces and lime on dark ones, red only for errors and destructive actions, one focus ring, pill-shaped actions, and readable minimum text sizes.
- Show the ten best homepage matches first with a "Show all" button, which makes the homepage about 30% shorter.
- Make payment test fixtures wait for the checkout-claim release that follows the 201 response instead of racing it.

See the [8.7.0 release guide](docs/release-8.7.0.md).

## 8.6.1 — Reliable drafts and offline workouts

- Keep unsaved Strata+ input when you return to the tab: the view is hidden while the account is re-checked, then restored as it was for the same session. A different account, a signed-out session, or ended access still clears it, and a failed check keeps the input in memory until a retry succeeds.
- Check each offline workout value with the same rules as the online logger before saving it, so an invalid entry can no longer make the device draft unreadable. Drafts saved by older builds reopen with any invalid value cleared and listed.
- Keep completed offline sets read-only until they are unchecked, and refuse to finish an offline workout without a completed set, matching the server rule so every finished workout can sync.
- Show "Couldn't save — Retry" until a device write succeeds; finishing, re-rendering, and reconnecting no longer replace a failed save with "Saved on device", and leaving the page warns while changes exist only in the tab.
- Point superset guidance only at sets that exist when paired exercises have different set counts.
- Use 45, 35, 25, 10, 5, and 2.5 lb plates for the plate calculator in pound mode, and list the assumed plates.
- Fill the last line of share-card text before truncating, adding an ellipsis only when words are left out.
- Default the admin activity report to 30 days when the range is missing or blank.
- Strip invisible control and direction characters from exercise notes, which the server rejects.

See the [8.6.1 release guide](docs/release-8.6.1.md).

## 8.6.0 — Organized Strata+ destinations

- Replace Progress's overlapping "repeat improvements" and "personal bests" lists with one exercise-records list showing the latest result, the change since the last comparable session, and the best, with a "New best" badge.
- Add an eight-week workouts-per-week chart, week-over-week volume change, and a 2 × 2 phone summary to Progress, with one always-visible link to Nutrition.
- Count Progress consistency and weekly history correctly across daylight-saving changes.
- Reorder Nutrition as targets, today's intake with a logged-vs-target meter, the week at a glance with per-day logged progress, meal ideas, and a "Behind the numbers" evidence group; align the diary fields and panel gutters and fold meal ingredients behind a disclosure.
- Remove duplicated headings and copy across Overview, Plan, Personal setup, Exercises, and Train, state the suggested week's shared load cue once, and keep rest days compact.
- Fix unreadable small buttons on dark panels, wrapped button arrows, the Account next-workout eyebrow, Plan tool kickers, and the weight-scenario cards; an axe contrast audit now passes on every page at desktop and phone widths.
- Move Strata+-only styles into `discover.css`, consolidate superseded shared rules, and delete styles for components removed in 8.5. No migration, API, or calculation change.
- Publish releases from the **Release** workflow: running it on `main` tags the package version and uses `docs/release-X.Y.Z.md` as the release notes. Pushing a matching `vX.Y.Z` tag still works.

See the [8.6.0 release guide](docs/release-8.6.0.md).

## 8.5.0 — Clear destinations, one home for each tool

- Give Strata+ six visible destinations—Overview, Plan, Train, Nutrition, Progress, and Exercises—with one canonical home for each tool and one shared personal setup.
- Move generated training weeks to Plan behind an explicit review that transfers exercises, sets, and repetitions only and never silently overwrites a remotely changed week.
- Give Nutrition the only calorie diary and meal-suggestion surface, with maintenance shown as one daily value and its calculation, uncertainty, and alternate goals in disclosures.
- Include the build 8.1 calculation corrections: standard MET reference oxygen at every age for generic activity, exact generated-session seconds in weekly energy accounting, withheld above-range optional set targets, stricter early/late calibration coverage, and replayed-evidence protection.
- Add homepage shortcuts, compact page headings, and mobile wayfinding across public, account, planning, and training pages.

See the [8.5.0 release guide](docs/release-8.5.0.md).

## 8.0.1 — Individualized activity and deficit model

- Replace the ambiguous whole-day activity answer for new coaching profiles with explicit non-workout daily movement and optional separate weekly activity minutes/intensity.
- Calculate maintenance from Mifflin–St Jeor resting energy plus ordinary movement, the actual usable minutes in the generated STRATA week, and separately entered activity—each counted once.
- Make gentle and moderate deficits request 0.25% and 0.50% of current planning weight per week, rounded conservatively and capped by 20% of maintenance, 500 kcal/day, BMI/scenario rules, the 1,200-kcal floor, and optional body-composition review guards.
- Show the activity contribution, generated-session minutes, requested and actual deficit, optional composition floor and cross-check difference, and lower-scenario status in the Personal training and calorie counting dashboard.
- Keep profile versions 1–3 readable under their exact prior calculation semantics and require an explicit version-4 review instead of silently translating an old activity answer.
- Add focused unit, HTTP, compatibility, architecture, and real-browser regressions. No database migration is required.

See the [8.0.1 release guide](docs/release-8.0.1.md) and [calculation methodology](docs/coaching-methodology.md).

## 8.0.0 — Personal training and calorie refinement

- Align complete intake with actual morning-weight intervals across a bounded 42-day history; use robust estimates, explicit quality checks, gradually changing targets, and expiring evidence.
- Use credible recent weights consistently, reconcile exact weekly calories and macro energy, and propagate maintenance uncertainty through explicit weight scenarios.
- Add balanced, strength, and hypertrophy training goals; retain main exercises, fit sets and rest to available time, show direct-muscle coverage, and derive optional per-set targets from comparable completed workouts.
- Scale listed food quantities with portions and disclose whole-menu calorie and macro gaps.
- Support today and 42 previous diary dates, original historical targets, hidden-macro preservation, and safe delayed-save handling.
- Preserve saved weeks across deployment and enforce first-writer-wins for concurrent generation at the same profile revision. No new database migration is needed.

See the [8.0.0 release guide](docs/release-8.0.0.md) and [methodology](docs/coaching-methodology.md), including synthetic benchmark tradeoffs and limits.

## 7.10.0 — Trend-informed energy planning

- Add coaching profile schema version 3 for the sex-specific 2023 adult Dietary Reference Intake EER primary maintenance estimate; retain Mifflin–St Jeor and the optional Cunningham body-composition estimate as visible resting-energy cross-checks.
- Preserve every stored version-1/version-2 profile's exact prior resting-energy × legacy activity-factor calculation until the member explicitly reviews and saves it as version 3. Calibration evidence does not adjust legacy targets, so deployment cannot silently reinterpret an existing activity answer or change its target.
- Treat activity as a whole-day category only in version 3 and do not add workout calories twice; show approximate targets, a conservative planning range, the calculation method, and limitations instead of false precision.
- Add optional morning-weight evidence and an explicit complete-day marker to both daily intake surfaces while preserving incomplete and legacy entries as non-calibrating diary data.
- Add Starting estimate, Calibrating, and Trend-informed states. A correction requires 18 complete intake days, 12 morning weights, and at least 14 days between the first and last usable weight inside the prior 21 days; it uses a robust trend with heavy shrinkage and is rounded and capped at 150 kcal. Every threshold remains a disclosed, non-clinical STRATA heuristic.
- Reject sparse, future, incomplete, implausible, and contradictory evidence, and keep the current weekly snapshot stable so targets do not chase daily scale noise.
- Restore the optional balanced versus higher-protein macro preference, improve activity/body-fat/input explanations, and keep the evidence panel accessible and responsive.
- Add nullable calibration fields through idempotent SQLite/Turso migration `005`, extend strict storage and account-export boundaries, and preserve deletion behavior without adding an unnecessary index.
- Separate energy estimation and calibration from workout generation, identify the new implementation as `energy-planning-v2` independently of profile schema version 3, version its evidence identity, and add focused equation, evidence, API, migration, parity, export, runtime, and browser tests.

Evidence, privacy, deployment, and rollback details are in the [7.10.0 release guide](docs/release-7.10.0.md). Calculation order and limitations are in the [coaching methodology](docs/coaching-methodology.md).

## 7.9.0 — Constraint-aware daily food options

- Extend the private coaching profile with an explicit allergy state, supported allergens, an other-or-uncertain-allergy note, dietary pattern and requirements, favorite-food categories, a preferred 1–6 meals per day, and an optional whole-cent daily USD budget.
- Add remaining-day food options to the daily intake experience, using the saved current-week target and intake log to show up to three deterministic menus with portions, ingredients, calorie and optional macro differences, and rough ingredient cost.
- Apply allergy, dietary-pattern, gluten-free, and dairy-free rules before favorites or budget ranking; return manual review or no compatible option instead of silently relaxing a hard constraint.
- Add a bundled, fingerprinted recipe catalog with rounded STRATA editorial estimates informed by generic USDA FoodData Central values, plus explicit FDA allergy/cross-contact, non-live nutrition, and non-live cost limitations.
- Keep the server authoritative through an authenticated, current-week `GET /api/coaching/food-options/:date` boundary; the browser supplies neither account identity, nutrition targets, nor catalog data, and generated options are not persisted as food eaten.
- Preserve existing version-1 coaching profiles, store new preferences in version-2 profile JSON without a database migration, repeat those inputs in the private weekly snapshot, and keep account export/deletion and SQLite/Turso behavior aligned.
- Separate pure meal filtering/generation, browser form normalization/display shaping, request/render orchestration, and the existing coaching coordinator, with focused unit, integration, contract, runtime, and browser coverage.

Safety, data provenance, deployment, verification placeholders, and the version-2 rollback boundary are documented in the [7.9.0 release guide](docs/release-7.9.0.md). Calculation order and limitations are in the [coaching methodology](docs/coaching-methodology.md).

## 7.8.8 — Guided coaching setup and $2.99 monthly pricing

- Redesign the Personal training and calorie counting profile as a clear four-step setup with separate cards, compact mobile orientation, persistent known-exercise labels, a useful empty state, stronger contrast, and 200% text reflow coverage.
- Change the current Strata+ offer from $0.99 to $2.99 USD per month across product, legal, account, runtime, configuration, documentation, and test surfaces while keeping the seven-day no-card trial unchanged.
- Require Paddle's new-transaction response to confirm the exact 299-minor-unit USD base price in addition to the trusted product, price, quantity, collection mode, monthly cycle, and account metadata.
- Add the server-only `PADDLE_LEGACY_RECURRING_PRICE_IDS` transition allowlist so explicitly named earlier monthly subscriptions keep entitlement without becoming valid for new checkout.
- Keep wrong-product, annual, malformed, duplicate, current, and retired one-time catalog values fail-closed, and migrate recoverable unfinished recurring checkouts only to the current configured price.

Deployment order, verification, and rollback guidance are in the [7.8.8 release guide](docs/release-7.8.8.md).

## 7.8.7 — Personal training and calorie planning

- Expand the exercise catalog from 200 to 320 movements, including 71 bodyweight options, while preserving unique IDs and complete scoring, instruction, caution, and guide metadata.
- Add Personal training and calorie counting as the fifth Strata+ destination, with a metric or imperial profile for schedule, experience, activity, goals, optional body fat, equipment, movement limitations, and known exercise capabilities.
- Generate a deterministic, reviewable training week that remains stable through the member's current week, rotates on Monday in the saved time zone, and regenerates after a profile change.
- Show resting-energy method, maintenance range, deficit, maintenance, and building estimates; distribute the selected seven-day budget as steady, training-day zigzag, or one flexible day with conservative floors and disclosed fallbacks.
- Add optional daily macro targets, calorie and macro logging in both Coaching and Progress, remaining or over-target feedback, and explicitly uncertain 4-, 8-, and 12-week weight scenarios.
- Keep coaching data private to an authenticated active Strata+ account with trusted-origin, CSRF, account-identity, rate, current-week, and optimistic-revision checks.
- Add SQLite/Turso parity, account export and deletion coverage, focused formula and constraint tests, and a real Chromium signup-to-persistence-and-conflict journey.

Behavior, evidence, deployment, and rollback notes are in the [7.8.7 release guide](docs/release-7.8.7.md). Formula sources and safety limits are documented in the [coaching methodology](docs/coaching-methodology.md).

## 7.8.6 — Clear plans and protected comparisons

- Keep Plan evidence collapsed by default so the editable week remains the visual priority.
- Remove the Strata+ next-move guidance card from guest and free Plan views while retaining it for currently entitled members.
- Add a review-first Reset week action that clears every scheduled movement, restores Sunday as the default recovery day, and saves through the existing account CAS or guest exact-copy boundary.
- Preserve workout history, saved templates, monthly plans, and published community copies when resetting the editable week.
- Restrict homepage exercise comparison controls and direct comparison actions to confirmed active Strata+ accounts, failing closed during load, revalidation, logout, network uncertainty, and entitlement loss.
- Revalidate homepage comparison access on a bounded freshness window and Plan guidance on foreground, known expiry, and a bounded periodic timer, with retry backoff after temporary network failures.
- Keep free Plan ownership/conflict comparisons intact because they prevent silent week overwrites rather than provide workout analysis.
- Add pure, runtime, and real-browser regressions for default disclosure state, reset confirmation and focus, account-bound reset saves, guest persistence, and free/Plus comparison states.

Validation is recorded in the [7.8.6 release guide](docs/release-7.8.6.md).

## 7.8.5 — Interrupted checkout deletion recovery

- Fix Admin and self-service account deletion getting stuck behind a Paddle transaction that remained in `draft` after an interrupted checkout.
- Make an abandoned draft non-payable using Paddle's supported manual-collection state, disable its checkout link, and clear STRATA checkout metadata while preserving Paddle's truthful retained record.
- Reconcile both current and earlier monthly Paddle catalogs against durable account, checkout, price, product, quantity, origin, and cadence boundaries; mismatches still fail closed.
- Resume safely when Paddle accepted retirement but STRATA did not finish its local cleanup, without issuing a second mutation.
- Clarify that blocking checkout creation and revoking STRATA login sessions are separate actions, and distinguish checkout, payment, subscription-link, and provider-reconciliation blockers in Admin.
- Extract the retirement policy into a bounded provider leaf and add focused unit, integration, deletion, idempotency, failure, and prior-catalog regressions.

Validation is recorded in the [7.8.5 release guide](docs/release-7.8.5.md).

## 7.8.4 — Direct sole-owner administration

- Let the sole verified account permanently bound as primary owner open Admin with its normal live session; retire the separate Admin password and registered-email-code elevation routes.
- Remove typed action commands and operator-entered audit reasons while retaining one explicit review dialog before each account action.
- Generate a bounded, action-specific reason on the server for every administrator audit record instead of trusting client prose.
- Preserve exact owner binding, live-session and credential-version checks, trusted-Origin, CSRF, JSON-content and rate guards, optimistic revisions, primary-owner self-protection, and redacted private payloads.
- Keep pause-first account deletion, checkout and subscription reconciliation, billing blockers, and the final atomic owner/session, target-state, billing, and audit predicates intact.
- Add focused module, integration, SQLite/Turso parity, payment, private-state invalidation, and browser coverage for the simplified workflow without changing account, billing, provider, or stored-data formats.

Validation is recorded in the [7.8.4 release guide](docs/release-7.8.4.md).

## 7.8.3 — Restored identity and clearer Strata+ states

- Restore the 7.8.1 visual and information-architecture baseline across the homepage, photography, global navigation, four-tab Strata+ workspace, Plan, Train, Account, and Pricing while retaining the functional improvements from 7.8.2.
- Make the saved weekly plan the primary Plan surface and place Workout Builder, Plan Ahead, and Reuse a Week behind clear, progressively disclosed explanations and actions.
- Give Today truthful no-plan, next-scheduled-workout, and active-workout states; give Train distinct no-plan, empty-selected-day, scheduled-workout, and active-workout states so Start, Resume, and editing actions only appear when they apply.
- Distinguish Progress loading, error, retry, empty-history, and populated-history states; add one compact score guide for FitScore, Match, and Community score.
- Add an enforced focused Train context module and state/browser regressions for responsive layout, keyboard focus, reduced motion, the 31-day flow, and the repaired state matrix.
- Keep authentication, billing, storage, API contracts, payment configuration, and the 7.8.2 progression model unchanged.

Validation is recorded in the [7.8.3 release guide](docs/release-7.8.3.md).

## 7.8.2 — Weight progression in Train

- Show specific per-set next targets after completion, with optional effort and check-in feedback.
- Use two complete, comparable sessions at the top of the prescribed range for a small load increase; build reps first or hold when evidence is insufficient.
- Bring the target into the next matching exercise with an explicit Apply action that preserves completed records and saves through existing workout revision checks.
- Handle long history, changed prescriptions, unfinished sets, long breaks, assisted exercises, lighter weeks, and history/account refresh safely.
- Advance managed build references and the service-worker cache to 7.8.2; no schema or provider changes.

Validation is recorded in the [7.8.2 release guide](docs/release-7.8.2.md).

## 7.8.1 — Session selection choices

- Add Random, Not in my week, Needs focus, and My preferences modes to Build a session, with optional muscle-group and specific-muscle focus.
- Make Not in my week exclude every exercise in the saved weekly plan; keep equipment and movement limits enforced across all modes.
- Use completed sets from the last 28 calendar days for Needs focus, and explain when missing or partial history limits the recommendation.
- Let My preferences use the member's saved profile, own ratings, movement board, and repeated completed exercises, while distinguishing repeated use from an explicit positive rating.
- Keep generated sessions reviewable before a revision-checked save, and advance managed build references and the service-worker cache to 7.8.1.

Validation is pending for this candidate. See the [7.8.1 release guide](docs/release-7.8.1.md); earlier release results are historical evidence only.

## 7.8.0 — One clear training path

- Join preview, verified account, deliberate seven-day trial, Plan review, training, and completed-workout evidence into one consistent product journey with stable Rankings, Strata+, Plan, and Train navigation.
- Make Training Memory useful during the first week, simplify workout logging and compact-screen planning, add useful Progress empty states, and protect all changed layouts with real-browser geometry checks.
- Split Home, Strata+, Plan, Train, Pricing, Account, and Admin into enforced pure-logic, state, same-origin API, rendering, event, and coordinator boundaries, with additional focused leaves where responsibilities remain distinct.
- Require password plus registered-email MFA for production owner elevation, rotate the session after verification, clear hidden private Admin and Account DOM, and add aggregate activation milestones without exposing workout contents.
- Test the Paddle entitlement lifecycle from validated payment through renewal, replay, and cancellation; add an explicit real-provider acceptance checklist while keeping live provider claims separate from local fakes.
- Raise useful frontend boundary coverage to 94.35% lines, 79.26% branches, and 89.20% functions across 642 passing Node tests, with the complete high-risk browser suite and performance budgets enforced by `npm run check`.

See [release guide](docs/release-7.8.0.md) and [current verification](docs/release-readiness.md).

## 7.7.1 — Pricing benefit layout

- Keep every pricing benefit heading and description together in the full content column while retaining its separate checkmark column.
- Use shrink-safe grid tracks and content wrappers for both Strata+ and free-tier benefit lists across desktop, tablet, mobile, and text-zoom layouts.
- Add an enforced browser geometry regression at widths from 320 through 1440 px, including the reported 1252 px case, so readable text width is checked rather than overflow alone.
- Advance the build and service-worker cache to 7.7.1 so installed PWAs receive the corrected pricing HTML and CSS.

See [release guide](docs/release-7.7.1.md) and [current verification](docs/release-readiness.md).

## 7.7.0 — Founder account controls

- Grant complimentary Strata+ for a custom duration, exact expiry, or until revoked, including the owner's account, while keeping the grant visible when paid access also exists.
- Preserve paid subscriptions and trial eligibility independently of gifts; show grant expiry in Account and Pricing.
- Delete member accounts with one confirmation; automatically pause and revoke sessions, with billing blockers and owner protection retained.
- Block new checkouts and attempt closure of fresh or interrupted Paddle payment sessions; retain durable holds and unresolved records on failure.
- Add SQLite/Turso controls, explicit account-deletion cleanup, revision conflict detection, atomic audits, private export data, and focused security/concurrency tests.

See [release guide](docs/release-7.7.0.md) and [current verification](docs/release-readiness.md).

## 7.6.0 — First-week value

- Seven-day no-card trials for new eligible accounts; valid existing trials keep their expiry.
- Equipment starter weeks, clearer Training Memory positioning, a labeled sample and free/Plus comparison.
- Completed scheduled-day progress in Today and a next-session link after logging a workout.
- Checkout errors remain visible; trial controls respect open checkout and pending payment confirmation.
- Day/hour trial status, regression coverage, and a focused founder launch plan.

See [release guide](docs/release-7.6.0.md) and [current verification](docs/release-readiness.md).

## 7.5.1 — Checkout continuity and guarded deletion

- Added a narrow compatibility path for an abandoned checkout from the exact retired Build 7.4 one-time Paddle catalog. A validated `draft` is updated in place to the current $0.99 USD monthly item and reused; a provider-cancelable stale transaction must be confirmed canceled before STRATA creates a fresh checkout. A delayed, strictly validated completion of that exact retired checkout is recorded as the paid lifetime purchase it represents; existing completed lifetime purchases remain unchanged, while unknown or mismatched transactions fail closed.
- Added an exceptional administrator permanent-deletion action for a paused, non-owner account. It requires the exact stored email, a bounded audit reason, origin and CSRF checks, and a currently elevated owner session.
- Made the final storage mutation atomically revalidate the paused target, byte-exact email, billing-safe state, live owner identity/session/elevation, and matching success audit so a state change cannot turn a reviewed deletion into a different action.
- Reconciled interrupted and stale incomplete checkout transactions before deletion, then applied the locally stored signed subscription state and other billing blockers. Administrative deletion does not refund a payment or cancel a live Paddle subscription.
- Removed the public and server fallback to the retired product for new checkouts. Deployments must supply both matching current Paddle catalog IDs, and the browser now accepts the live product validated by the same-origin server.
- Prevented an active workout recovery saved on the device from briefly exposing a second Start action while account history is still loading.

## 7.5.0 — Training Memory and operational trust

- Preserved the complete guest-generated week through account creation, verification, and onboarding, then required an explicit claim, compare, or keep decision before replacing either the device preview or an existing account Plan.
- Rebuilt the workout logger around Training Memory: exact prior comparable sets and dates, reviewable targets, set add/copy/remove controls, private notes, RIR or RPE, warm-up and plate calculators, and explicit superset groups.
- Added explainable in-workout exercise swaps with separate “this workout only” and revision-checked Plan-proposal paths; neither path silently rewrites the saved week.
- Added an account-scoped offline continuation shell for a workout already opened while authorized. It stores a bounded device draft, never caches private pages or API responses, and rechecks the account, access, and server revision before handing a draft back for sync.
- Made training blocks operational with date-derived weeks, planned-versus-completed workout and set evidence, muscle coverage, logged improvements, explicit skips/replacements, one next decision, and reviewed carry, lighter-week, or finish actions.
- Added explainable planner balance signals and a copy-day review that previews merge or replace behavior, creates fresh exercise identities, and refuses stale Plan revisions.
- Changed Strata+ to a $0.99 USD monthly recurring subscription and added one optional free 30-minute app trial. The trial needs no card, ends automatically, never converts automatically, and remains limited to one use per account; qualifying earlier lifetime buyers remain grandfathered without renewal.
- Hardened Paddle subscription state around signed, replay-safe, ordered events, exact account/catalog/customer/transaction matching, time-bounded entitlement, scheduled cancellation or pause, equal-timestamp downgrade resistance, adjustment-to-transaction binding, and short-lived portal links that are validated but never persisted.
- Added structured redacted request logs and request IDs, distinct liveness/readiness checks, production preflight that shares the runtime provider validators, post-deploy smoke tools, and an ordered SQLite/Turso migration ledger.
- Added account-owned active-session review, selective or all-other-session revocation, and a CSRF-protected JSON export of account training and support data without exposing credentials, tokens, IP/device fingerprints, provider customer IDs, administrator records, or aggregate signals.
- Added Chromium, Firefox, and WebKit compatibility journeys for CI, focused axe checks, keyboard navigation, 200% text zoom, and self-hosted Manrope, DM Mono, and homepage photography so normal rendering no longer depends on Google Fonts or Unsplash requests.

## 7.4.1 — Responsive content integrity

- Rebuilt planner library cards around intrinsic content height so long exercise names, metadata, FitScores, and Add/Guide/Video controls stay in their own card instead of colliding with the next result.
- Made planner headings, day selectors, scheduled exercises, move controls, save errors, filters, and touch targets resilient from the 300 px desktop sidebar through compact phone and tablet layouts.
- Kept long Strata+ recommendation names readable, restored visible exercise-detail controls and context, and stopped the comparison tray from covering the mobile navigation.
- Gave narrow workout titles, set progress, logging formats, timers, save actions, check-ins, dialogs, and adaptation choices enough dedicated space to wrap without clipping.
- Corrected the weekly-setup mobile navigation and replaced translucent compact headers with opaque surfaces across setup, account, public information, and administration pages.
- Hardened public cards and actions against long account names, email addresses, server messages, identifiers, translated labels, and other dynamic content without masking it with ellipses.
- Added real-Chromium responsive regressions, card-text containment checks, and a live 18-route matrix at 320, 339, 360, 390, 430, 600, 700, and 768 px; planner geometry is additionally checked through 1440 px.

## 7.4.0 — A calmer, guided training loop

- Reorganized Strata+ around four clear destinations—Today, Plan, Progress, and Explore—so the next workout remains primary while advanced tools stay available without dashboard clutter.
- Added a Today brief with one Start or Resume action, estimated duration or elapsed time, relevant equipment, and the latest comparable result in the loaded 100-session window; replaced day-specific command copy with the stable “Start working out” action.
- Added honest log-derived adherence, external-load volume, four-week consistency, repeat improvements, and personal bests while keeping partial history, measurement formats, assistance, bodyweight, kilograms, and pounds explicitly separate.
- Added an optional 4–8 week training-block record with revision-safe updates, milestones, current-week state, and an optional lighter week without automatically rewriting the weekly Plan.
- Added catalog-backed exercise guidance across Rankings, Plan, and Train, including one setup cue, two additional technique cues, a caution or common mistake, purpose, prescription, and a same-target different-equipment alternative where available.
- Streamlined first-use setup with a deterministic three-day beginner profile, one explicit equipment choice, a visible week preview, and a direct first-workout hand-off after saving.
- Added an optional four-answer post-workout check-in plus conservative, deterministic next-session guidance: first results stay baselines and increases require a comparable repeated result and an explicit acceptable check-in.
- Added explicit, revision-bound plan-adjustment proposals for difficult check-ins. Suggestions never change a plan silently; acceptance atomically verifies the workout check-in and current Plan, while dismissal and replays cannot mutate it.
- Added owner-scoped SQLite/Turso storage parity, account-deletion cleanup, strict checkJs boundaries, unit/integration/contract/browser coverage, private-cache exclusions, and public privacy/fitness disclosures for the complete training loop.
- Improved responsive layout, touch targets, dialog focus restoration, reduced-motion behavior, validation errors, and consistent Saving… / Saved / Couldn't save — Retry states across the changed journeys.

## 7.3.0 — Product proof and returning-member clarity

- Added a no-account homepage preview that ranks three real catalog movements from a visitor’s goal, muscle group, equipment, and experience while explaining the personal match, immutable editorial FitScore, strongest decision factors, and clearest trade-off.
- Clarified the free-versus-Strata+ boundary across the homepage, weekly planner, setup, workout room, and pricing without removing free rankings or browser-local weekly planning.
- Rebuilt the signed-in Account view around one useful next action, scheduled-day progress, recent saved activity, comparable progress records, honest partial-history labels, and conservative adaptation cues.
- Made an open workout directly resumable from Account while preserving dirty-draft recovery, account isolation, one-active-session enforcement, and saved-history behavior.
- Added public recommendation methodology that keeps editorial FitScore, personal match, community ratings, recommendation feedback, and product activity counts distinct and appropriately limited.
- Added optional, inspectable device product insights and an explicit aggregate-sharing choice. The server stores only UTC-day plus allowlisted-action counts for 90 days, never raw events, cookies, accounts, URLs, exercises, plans, workouts, or recommendation payloads.
- Added an elevated owner readout for directional activity counts and labeled repeated actions, automated traffic, non-unique people, and the absence of connected cohorts so the numbers cannot be mistaken for audited conversion analytics.
- Kept SQLite and Turso aligned through a shared additive aggregate schema, narrow store methods, retention behavior, query-plan evidence, and real composed-server, adapter-parity, client-privacy, and owner-elevation tests.
- Improved first-session language, validation and conflict announcements, focus targets, touch sizing, fixed-navigation spacing, mobile headers, and narrow-screen layouts across setup, Plan, Train, pricing, and the consent surface.

## 7.2.0 — Connected training system and founder-led relaunch

- Reframed the public experience around one Rank → Plan → Train → Refine workflow while preserving the complete 200-exercise index, scoring boundaries, licensed photography, founder story, and purchase facts.
- Added original layered STRATA artwork, a clearly labeled illustrative training workspace, a calmer pricing path, secure support guidance, and refined policy/founder presentation.
- Turned Strata+ into a more useful training studio with a live weekly brief, visible ranking lens, and an account-keyed, device-private four-movement decision board that can feed the existing comparison tool.
- Made weekly setup more legible with live training/recovery/session facts and a generated-week summary; added contextual plan readiness and a compact weekly distribution graphic without adding server-side state.
- Improved the workout room with selected-session facts, next-set guidance, per-exercise progress, remembered rest preferences, and clearer mobile states while preserving the existing save, recovery, conflict, and entitlement boundaries.
- Added a signed-in account command center, clearer install/offline routes, useful PWA shortcuts, and a reduced-motion-aware page progress indicator.
- Closed final accessibility and presentation gaps around excluded-movement labels, detail-dialog focus, context-dependent hidden actions, device-storage disclosure, and clean print output.
- Kept the release additive and presentation-focused: no database migration, pricing change, authentication change, new payment contract, or production deployment.

## 7.1.3 — Unified visual system and clearer public journeys

- Applied the clean Strata+ design language across Rankings, Plan, Train, weekly setup, accounts, public information, installation, and private administration while retaining the existing photography and product imagery.
- Standardized Manrope and DM Mono typography, dark navigation, softer lime accents, card/control geometry, hover feedback, focus treatments, and reduced-motion behavior.
- Rebuilt reveal motion to stage before first paint, preventing content from flashing backward while preserving a fully visible no-JavaScript fallback.
- Removed repeated promotions and legal-link clusters, simplified pricing and support copy, and standardized four-destination mobile product navigation.
- Moved the founder biography out of the homepage into a new public `/policies` directory that links Terms, Privacy, Refunds, support, and founder information.
- Added responsive regressions for policy routing, footer consolidation, narrow layouts, navigation order, and the updated Strata+ card grid.

## 7.1.2 — Coherent Strata+ journeys and responsive UI

- Replaced display-name-driven recommendation headings with stable, readable copy and kept long member names contained in account chrome.
- Reworked Strata+ into a clear dashboard: one primary workout action, one weekly-plan action, seven equally weighted tools, and explicit session generation before anything can be added to a plan.
- Standardized Rankings, Strata+, Plan, and Train navigation; added durable mobile bottom bars, touch-sized controls, clearer focus states, and corrected light/dark panel contrast.
- Made empty and recovery workout days actionable, removed duplicate recovery/history surfaces, and ensured repeated or concurrent starts resume the one active account workout.
- Saved weekly setup and its matching recommendation profile atomically with SQLite/Turso parity and both revision boundaries, including a safe recovery-day default for legacy seven-day plans.
- Added strict setup-boundary typing and expanded unit, integration, browser, runtime, accessibility, breakpoint, and concurrency regressions.
- See docs/release-7.1.2.md for deployment and rollback notes, and docs/release-readiness.md for verified results.

## 7.1.1 — Focused free planning and Strata+ training

- Moved workout starts and Set up my week into Strata+. Logging, history and setup now require paid or active trial access; API reads/writes and direct training pages enforce the entitlement.
- Kept manual planning, exercise editing, undo, templates, export and sharing available in the free planner.
- Added independent rest-day toggles, including removing the last rest day. Removed rest recommendations and automatic rest relocation.
- Preserved old plans and exports with an additive restDays field. Repair keeps every scheduled exercise, including weeks with training on all seven days.
- Restyled the Strata+ workspace with setup-inspired dark panels, softer lime, readable controls, responsive layouts and reduced-motion support.
- Preserved workout-day destinations through sign-in; closed private workout views on session expiry; retained stored sessions when Plus access ends.
- Updated pricing, offline cache rules, regression tests and the 100-user harness for the new feature boundary.
- See docs/release-7.1.1.md for migration and rollback limits, and docs/verification/7.1.1-load-shared.json for that release's measured load record.

## 7.1.0 — Training workflows and account safety

- Added a free workout room with actual loads/reps/timed sets, completion controls, absolute rest timer, save/close, interrupted-session recovery and account synchronization.
- Added owner-scoped workout storage, strict validation, idempotent creation, atomic revision conflicts, bounded summary history and account-deletion cleanup.
- Added history/details, previous results, recorded bests and accessible progress charts grouped by exercise, logging format and unit. Bodyweight, assistance and timed work have explicit measurement semantics.
- Added first-week onboarding for goals, experience, equipment, movement filters and availability, with editable preview and deliberate replacement of existing weeks.
- Added undo, searchable exercise replacement, local reusable week templates, JSON import/export and recoverable per-tab/account drafts.
- Fixed the administrator password-reset login race, cross-account planner token adoption, stale guest saves, onboarding storage retry and missing auth return destinations.
- Added isolated Paddle sandbox configuration without altering live checkout defaults; matching credentials and a separate catalog are required.
- Added responsive black/lime screens, purposeful motion, clear save/error states, keyboard controls and reduced-motion styling; updated factual storage disclosures.
- Extended 100-user workloads to workout lifecycle, conflicts, isolation and resource measurements; added migration, online backup/restore and full browser journey regressions.
- Source is based on the actual 7.0.0 tag. Production deployment, provider transactions and full Chromium verification remained pending; see docs/release-7.1.0.md and docs/verification/7.1.0-load-distinct.json for that release's records.

## 7.0.0 — Pilot readiness and interface update

- Added 100-user workloads for separate IPs and one shared network, covering private-plan isolation, concurrent writes, stale-edit rejection, restart persistence, and auth limits.
- Replaced the shared ten-attempt login/signup bottleneck with bounded network and hashed-identity limits. Verification limits follow the challenge; durable email restrictions remain enforced.
- Reject non-object JSON with HTTP 400. Preload/precompress allowlisted public assets within 16 MiB; private HTML remains dynamic.
- Added HTTP timeouts and a ten-second graceful shutdown deadline.
- Added atomic monthly plan revision checks for both storage adapters, conflict guidance, and recovery of corrupt monthly records.
- Prevent new weekly plans exceeding 30 exercises/day or 140/week; preserve older oversized guest drafts and offer explicit offline guest access.
- Enforce equipment and movement constraints on imported monthly exercises; reject eligibility calculation errors.
- Correct logout failures, rating/monthly save races, comparison focus, and mobile Account access.
- Added coordinated styling, score indicators, a weekly distribution chart, and finite animations with reduced-motion support.
- Updated the deployment blueprint to an always-on 1 CPU / 2 GB baseline, deterministic npm installation, and optional local .env loading. No hosted services are changed by this source update.


## v6.9.9.007 — 2026-09-06

Build 6.9.9.007 turns the previous quality measurements into enforceable release boundaries.

- Added an explicit server-module policy with reviewed size budgets, allowed dependency edges, cycle detection, and a generated dependency/size report.
- Added strict `checkJs` type checking for HTTP, Paddle, storage registration, and production service wiring, with declared dependency interfaces for the extracted authentication, administration, and support modules.
- Enforced calibrated 90% line, 78% branch, and 85% function coverage floors while keeping risk-focused tests more important than a 100% headline.
- Separated unit, integration, contract, and E2E test entry points and documented where each class belongs.
- Added isolated Chromium journeys for login and recovery, concurrent plan-conflict resolution, signed Paddle entitlement and replay handling, and emailed account deletion.
- Added reproducible median/p95 evidence and conservative regression budgets for health, status, authenticated-plan, session lookup, plan lookup, and compare-and-swap operations.
- Expanded `npm run check` and GitHub Actions so architecture, types, lint, coverage, runtime QA, performance, and browser E2E all gate the release.

## v6.9.9 — 2026-09-06

Build 6.9.9 is a focused maintenance and security release with no major feature expansion.

- Split authentication, session, administrator, audit, and support responsibilities out of the HTTP composition root.
- Added correctness-focused ESLint, a single `npm run check` release gate, and informational test coverage reporting.
- Expanded trust-boundary tests for authentication, CSRF, administrator permissions, session revocation, storage parity, and Paddle webhook replay and mismatch cases.
- Documented the architecture and security-reporting process, tightened PWA maintenance checks, and removed speculative database indexes.
- Improved dialog keyboard behavior, accessible status announcements, actionable validation/conflict errors, and consistent `Saving…`, `Saved`, and `Couldn't save — Retry` states.
