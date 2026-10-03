# Build 9.7.0 — First-visit polish

Build 9.7.0 works through the user-facing half of the 9.5 fix list, which came from using STRATA as a signed-out
visitor on a 390 px phone and on desktop. The site looked polished; the problems were confusing navigation, a crowded
planner screen, page weight, and a console full of errors. This build fixes those. It adds no features.

## What changed

### One navigation on every page
- Every page's primary navigation has the same tabs in the same order. Before, the home page's bottom bar had three
  tabs (Rankings, Dashboard, Install) and every other page had five.
- Each tab names the audiences it serves (`data-audience`), and `site-experience.css` hides the rest:
  - A visitor sees only what they can use: **Rankings · Plan · Strata+ · Sign in**. Train and Recovery, which only
    led to a sign-in wall, are gone for visitors.
  - A member sees **Rankings · Plan · Train · Recovery · Profile**.
  - A Strata+ member sees **Dashboard** in place of Plan, because for them Dashboard opens the Strata+ dashboard.
- Each tab is named after the page it opens: "Plan" opens the Weekly Plan, where "Dashboard" used to.
- The visible tabs share the bar, and every page's tab labels are the same size.
- So the right tabs show from the first paint, `app-shell.js` reads a `strata_nav` cookie in `<head>` and marks
  `<html data-audience>`. The server sends `strata_nav=member` with every session it issues (sign-up, sign-in,
  verification, Google) and clears it whenever it clears the session. `/api/me` refreshes it to `member` or `plus`
  and clears a leftover one. The cookie names only the audience, never the account; it decides which links show,
  never what a request may do.
- The Strata+ studio and Strata AI keep their own navigation, which already shows the Strata+ tabs.

### Install, out of the way
- Install is no longer a main tab. It stays in the footers and on Profile.
- From a person's second visit, a small note suggests installing STRATA. It shows once per visit until STRATA is
  installed or the person chooses "Not now", and never inside the iOS app.

### The planner's first screen on a phone
- The save bar appears only after a change. Opening the planner has nothing to report, so the phone's first screen
  starts with the exercise library. The bar is still a live region, so the first change is announced.
- The plan banner is one line on a phone: what the plan is and the one thing to do next. The link now ends it, so the
  stray space before the full stop ("synced plan .") is gone.
- A rest day in the day picker says "Rest day" instead of only looking greyed out. Turn it into a training day on the
  week board.

### What the rankings are sorted by
- The home rankings say "Ranked by FitScore, highest first", following the Sort control. A line says what FitScore
  rates, and links go to How FitScore works and the sources.
- The planner library says "Highest FitScore first" with the same link, so the top of "All" never looks arbitrary.

### Sign in
- The sign-in page's tab says "Sign in — STRATA" until an account is open, then "Profile — STRATA".
- The home header says Sign in, as the tab does.

### Lighter pages
- The hero photo is AVIF or WebP, with a JPEG fallback, in a 960 px phone crop and a 1600 px desktop frame: about
  70 KB on a phone instead of a 530 KB JPEG. A phone downloads only the phone file.
- The home page loads the exercise catalog only when the free-week preview or the rankings are needed: when one comes
  into view, at the first scroll, or when a link opens them (`/rankings`, `/#preview`).
- Plan opens on `exercise-library.json`, the catalog without guide text (111 KB). The first exercise guide loads the
  full catalog and the guide builder once; offline, both come from the cache.
- Phone, signed out, empty cache:

  | Page | 9.6.0 sent / decoded | 9.7.0 sent / decoded |
  |---|---|---|
  | Home | 702 KB / 1.13 MB | 185 KB / 343 KB |
  | Plan | 187 KB / 666 KB | 134 KB / 408 KB |

- `npm run performance` now holds each page to a byte budget (`docs/performance.md`).

### A clean console for visitors
- `GET /api/me` answers `200 { user: null }` without a session instead of `401`. Member routes still answer `401`.
- Pages ask `/api/me` first and request member data only for a member; Plan no longer requests `/api/plan` for a
  visitor. No public page logs a `401` or any console error for a visitor, and a browser check keeps it that way.
- The browser still treats a `401` from `/api/me` (an older server, or a session that ends between requests) as
  signed out.

### Smaller fixes
- A button's hover lift is motion, so it now applies only without a reduced-motion preference. With reduced motion it
  could jump up and down under a resting pointer.

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 9.7.0.
2. **API.** `GET /api/me` without a session answers `200 { user: null }`. Anything outside STRATA that treated its
   `401` as "signed out" must read `user` instead.
3. **Cookies.** Sign-in now also sets `strata_nav` (readable by scripts, `SameSite=Lax`). It carries no account data.
   Members signed in before the deploy see member tabs from their next `/api/me`, which nearly every page asks.
4. **Images.** `/images/hero-training.jpg` is gone; the hero is `/images/hero-training-{960,1600}.{avif,webp,jpg}`.
   The server serves `.avif` and `.webp` with their types.
5. **No database or configuration changes.**
6. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.7.0 npm run smoke:deploy`.

## Validation

The format check, release markers, both architecture policies, strict types, lint, the Node suite with coverage
floors, runtime smokes, the performance budgets (latency and page weight), and the browser journeys pass. New checks
cover the one navigation for each audience, the navigation cookie from sign-in to sign-out, a visitor's console on
nine public pages, the hero files and the byte budgets, the deferred catalog, and the planner's quiet first screen.
