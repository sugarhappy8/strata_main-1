# Build 8.8 — Strata AI

Build 8.8.0 adds Strata AI, a planning assistant for Strata+ members. Describe your week in your own words and Strata AI proposes a training week, offers matching nutrition targets, and suggests improvements. STRATA checks every proposal before you see it, calculates every calorie number itself, and changes nothing until you apply it.

## What members can do

| Ask | What happens |
| --- | --- |
| "4 days a week, 45 minutes, dumbbells at home. I want stronger legs." | A proposed week: a seven-day strip of training and rest days, each day's exercises with sets and reps, and STRATA's estimate of working sets and minutes. **Apply to my plan** saves it as the weekly plan; replacing a plan that already has exercises asks first. |
| "Include Bulgarian split squats and nordic curls." | Exercises named in full are always offered, even outside your usual equipment. If you ask for something that isn't on the shortlist, Strata AI can search all 320 exercises once and use what it finds. |
| "Yes, add matching calorie targets." | Strata AI chooses the goal, pace, calorie pattern, and macro preference. STRATA's calculator produces the numbers, shown as "2,150 maintenance − 200 deficit = 1,950 kcal/day" with a target for each day. **Apply nutrition targets** updates your personal setup, and its training days follow your plan. Without a personal setup, it links you to create one. |
| **Review my plan** | Up to three specific suggestions. A suggested exercise swap applies to the saved plan with one tap if that exercise is still there. |

Quick replies under the latest week accept the calorie offer or ask for shorter sessions. The conversation stays in the browser tab, survives a reload, and resumes a request that was still running.

## Getting there

- The homepage asks, "Don't feel like planning things yourself? Ask Strata AI to do it for you." Members with Strata+ go to `/ai`; everyone else goes to pricing.
- Pricing explains that Strata AI is part of Strata+. Sign-up, sign-in, and the trial return to `/ai`.
- Strata+ Overview has an **Ask Strata AI to plan** button.
- Opening `/ai` while signed out asks you to sign in and then returns; without Strata+, it opens pricing.

## How proposals are checked

- **Exercises.** The model sees a shortlist chosen for each request: default picks for every muscle group that fit your equipment and experience, focus groups when you name a muscle, anything you name, and your saved plan's exercises. It may use shortlist codes or exact library names. Unknown exercises, exercises your movement limits exclude, and repeats within a day are removed, and the week notes what was removed.
- **Days and sets.** One to six training days; each day needs at least two exercises, holds at most eight, and allows at most 30 sets. Sets are limited to 1–6 per exercise and rep targets are normalized, falling back to the library's typical range. Session length comes from STRATA's estimate (2.5 minutes a working set plus a 5-minute warm-up), never from the model's claim, so the week, Plan, and nutrition targets agree.
- **Nutrition.** Only STRATA's own goal, pace, pattern, and macro choices are accepted. Calories come from the same equations as Nutrition, and a proposal made against an older personal setup cannot overwrite a newer one.
- **Swaps.** A swap must name an exercise in your saved plan and a different exercise not already on that day, and the page checks the plan again before saving.
- **Text.** Replies are plain text, limited in length, and inserted without HTML parsing.

## Running the model

Strata AI works with any OpenAI-compatible chat server. The pilot runs a local model in Atomic Chat on the owner's PC, reached through Atomic Chat's remote access with an API key. Set `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in Render; see [Strata AI in the deployment guide](deployment.md#strata-ai).

- Requests wait in an in-memory queue, so no web request waits on the model. The page polls for the answer and shows its place in line. Defaults: 3 requests at a time, 20 waiting, and 30 requests per member per UTC day, one at a time.
- Requests the model never received (offline, refused key, unavailable) do not count against the daily limit.
- The server asks for JSON output and turns off model reasoning where the server supports it, and falls back if it doesn't. A context overflow gets one compact retry without history, a cut-off answer gets one retry asking for a shorter reply, and a broken answer gets one quieter retry.
- Tunnel and gateway timeouts, including Cloudflare's 100-second limit, read as a slow answer. When the model is offline, `/ai` says so and every other STRATA feature keeps working.
- In production, a plain `http://` model address other than this machine is ignored so the key never travels unencrypted.

## Privacy

The model receives your message, up to six recent turns, and a summary STRATA prepares from your saved plan, personal setup, recent completed-workout count, and recent calorie-log and morning-weight averages. It never receives your name, email address, or account ID. Requests are held in server memory only until answered, and answers for up to 10 minutes. Logs record only the request type, outcome, and duration. The privacy policy and terms describe Strata AI, the tunnel provider, and its limits.

## Data and release behavior

No database migration or stored-data format change is required. Strata AI adds four server modules (`src/ai-provider.js`, `src/ai-catalog.js`, `src/ai-core.js`, and `src/ai.js`), one page (`public/pages/ai.html` and `public/styles/ai.css`), and six browser modules, all under the architecture policies. The routes are `GET /api/ai/status`, `POST /api/ai/requests`, and `GET /api/ai/requests/:id`, all Strata+ only; the POST route also requires a trusted origin, CSRF, and JSON. Proposals are applied through the existing `PUT /api/plan` and `PUT /api/coaching/profile`. The public build and asset versions are `8.8.0`, and the service worker precaches the new assets while keeping `/ai` network-only.

## Validation

Local results on Node 24:

- `npm run release:check`, `npm run architecture:check`, `npm run typecheck`, and `npm run lint` pass.
- The Node suite passes 1,025 of 1,025 unit, integration, and contract tests. New tests cover the provider client (keys, JSON options and fallback, timeouts, oversized prompts, and settings), the shortlist and library search, the proposal rules, nutrition previews against STRATA's calculator, the page's logic, storage, and requests, and the full HTTP flow against a scripted OpenAI-compatible server: access, validation, weeks, nutrition, swaps, the library search, retries, the queue, refunds, and daily limits. `npm run coverage` meets its floors at 95.48% lines, 84.35% branches, and 92.02% functions, with every Strata AI server module and browser leaf at 100% of lines.
- `npm run qa:runtime` and `npm run performance` pass.
- A new browser journey runs the real server against a scripted model: pricing and homepage routing, a starter request, applying a week, the nutrition offer before and after personal setup, applying targets, a suggested swap, the replace-plan confirmation, a retry after a broken answer, a reload, axe accessibility checks, and no horizontal scrolling from 1280px to 320px.
- 56 of 57 browser tests pass in Chromium. The one local failure is the service-worker offline step documented for 8.6.1: this container's older Chromium does not apply offline emulation to a newly opened page. The pricing layout test now expects six Strata+ benefits. CI installs the pinned Chromium, Firefox, and WebKit builds and runs the complete gate.
