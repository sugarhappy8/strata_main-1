# Roadmap to V1

STRATA adds no features until V1. Each release since Build 9 has been fixes and cuts only.

| Build | What it did |
|---|---|
| 9.0 | Cut and integrate: one product with five sections instead of overlapping tools, one data layer, Strata AI on Groq |
| 9.1–9.3 | Dashboard, the iOS app with Apple In-App Purchase, Sign in with Google |
| 9.4–9.6 | Hardening: App Store Sandbox limited to review accounts, one route table with uniform security checks, one HTML escaper, the old checkout code removed |
| 9.7 | First-visit polish: one navigation, a quieter planner on a phone, the home page from 702 KB to 185 KB, a clean console |
| 9.8 | Investor pack: Admin → Metrics with CSV, a demo account, these documents, policies checked |
| **10 (V1)** | stratafitness.online and the iOS app in the App Store, with a real Polar account tested end to end |

## Build 10 — V1

- **iOS app in the App Store.** Submit with the App Review account in `APPLE_SANDBOX_ACCOUNTS`, check the subscription
  in Sandbox, then release. The App Store sells the monthly plan only; add a yearly App Store product to match the
  website's $29.99 yearly plan.
- **Polar with a real account.** Polar sync has been tested only against recorded and made-up data. Connect a real
  Polar device, compare a week of nights and sessions with Polar Flow, and fix any field that does not match
  (`src/polar-mapping.js`, `POLAR_INTEGRATION.md`).
- **Provider confirmations** that the build environment could not make: Groq Zero Data Retention switched on for the
  account, Paddle's actual rate for the $4.99 and $29.99 prices, and a Turso restore drill into a separate database
  ([runbook](runbook.md)).
- **The live site on a phone** with a clean console after the 9.8.0 deploy.

## After V1

- Turn Strata+'s 36 browser files into real modules, one file at a time (they still share globals, so load order
  matters). Planned after V1 so it cannot put the launch at risk.
- Ideas parked during Build 9 are in `PROPOSALS.md` (server-side week templates, one "replace my plan" review,
  measured activity from Polar feeding nutrition, and others). Each waits for usage numbers that say it is needed.

## Open decisions for the owner

These are product decisions, so 9.8.0 prepares the facts and leaves the choice.

- **Price — decided in 9.8.0.** Strata+ moved from $2.99 a month to $4.99 a month or $29.99 a year
  ([pricing maths](metrics.md#pricing-maths)). The server accepts exactly these two Paddle prices: checkout fails
  closed on any other amount, and only the configured prices unlock Strata+. Next: watch how many members choose
  yearly, and add the yearly App Store product.
- **Where sign-ups come from.** STRATA records no referrer or campaign for a sign-up today
  ([metrics](metrics.md#what-the-numbers-cannot-say)). Recording one is a new fact about each account and needs a
  privacy-policy change.
- **Strata AI inside Strata+ or as an add-on.** Built as one switch (`plus.ai` in `src/entitlements.js`), so it can
  move without code changes. Decide from AI cost per member on Admin → Metrics.
- **Groq's paid tier.** Planned when active Strata AI members pass about 120, or after the first week of daily rate
  limits.

## What Build 9 cut, and why

Build 9 judged every part of STRATA as a first-time paying customer on a phone would: does it make sense in five
seconds, would they miss it, would they pay for it, does it look finished? Two "no" answers meant cut or merge
(`AUDIT_BUILD9.md`).

| Cut or merged | Why |
|---|---|
| The free seven-day trial (retired in 8.9) | Strata+ became subscription-only; a trial started earlier ran to its end |
| Community weekly plans | No reader in a new install, user-generated content with display names to moderate, and a second copy of every shared plan |
| Exercises hub, recommendations panel, decision board | Three menus over the same data; merged into one Library with a "Personal match" sort and "Saved" |
| A second weekly programme in coaching, the separate 31-day plan, training blocks as their own tool | Several plans for one week; merged into the weekly plan and one "Plan ahead" |
| Share cards and the share-shortlist images | Showed raw errors and a wrong footer, came in three variants, and were not core |
| Homepage directory, ticker, "demo console", compare tray | Repeated the navigation, read as a developer project, or put a Strata+ tool on a public page |
| A second calendar export, Train's history boxes, build numbers in every footer | Duplicates of other screens; the build stays on Profile |
| Admin elevation and the old Polar V3 tables | Replaced by the bound owner session and Polar V4 |
| The old checkout code (9.6) | Four billing paths for one plan; dead code is still attack surface |
