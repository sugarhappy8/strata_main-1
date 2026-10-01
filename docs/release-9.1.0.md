# Build 9.1.0 — Dashboard

Build 9.1.0 replaces My Week with a Dashboard, gives the homepage a shorter top bar, and takes
the "Your next move" card off Profile. Subscription, pricing, and the data layer are unchanged.

## What changed

### Dashboard
- Every page's navigation reads **Rankings · Dashboard · Train · Recovery · Profile**.
- Strata+ members who open Dashboard get two choices: **Plan**, the weekly planner, and
  **Strata+ dashboard**, the studio's Overview with today's session, recovery, progress,
  nutrition, and Strata AI.
- Free accounts and visitors have only one choice, so Dashboard takes them straight to Plan
  instead of showing a page with a single card.
- Dashboard is in every page's navigation, so anyone can get back to it at any time. Old
  `/my-week` links keep working: they open the Dashboard for members and the planner for
  everyone else. Offline, Dashboard opens the cached planner.

### Homepage
- The homepage's top bar is **Rankings · Dashboard · Install**, on desktop and in the phone's
  bottom bar. Train, Recovery, and Profile stay in every other page's navigation.
- On phones the signed-in name stays in the homepage header, shortened to fit, so Profile is
  still one tap away.

### Profile
- The "Your next move" heading, its button, and the Next up card are gone. Profile no longer
  loads the weekly plan and workout history it only used for that card.
- Access, billing, connected devices, data export, links, and security are unchanged.

## Upgrade notes

1. **Installed apps.** Every asset URL and the offline cache name advance to 9.1.0, so installed
   apps fetch the new navigation and the Dashboard page on their next visit.
2. **No configuration or migration changes.** Strata AI, Polar, Paddle, and database settings
   are the same as 9.0.0.
3. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.1.0 npm run smoke:deploy`,
   then open Dashboard signed out, as a free account, and as a Strata+ member.

## Validation

`npm run check` passes on the release commit: release markers, architecture policy, strict
types, lint, the Node suite with coverage floors, runtime smokes, the performance budgets, and
every browser journey. New server tests cover where Dashboard and `/my-week` lead for visitors,
free accounts, and members, and that the members' Dashboard page is never cached.
