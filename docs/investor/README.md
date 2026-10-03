# STRATA investor pack

Build 9.8.0 prepares STRATA for an investor's first look. An investor decides on usage numbers first and code second,
so this pack puts the numbers, the story, and the evidence that the product can be run in one place. It adds no
product features.

| Document | What it answers |
|---|---|
| [One-page overview](overview.md) | The problem, who STRATA is for, what is free, what Strata+ adds, and the price |
| [Metrics sheet](metrics.md) | How each number on Admin → Metrics is counted, how to export it, and the pricing maths |
| [Technical one-pager](technical.md) | Stack, security, tests, and how a release ships |
| [Runbook](runbook.md) | Rolling back a release, rotating keys, restoring the database: what happens if the founder is unavailable |
| [Roadmap to V1](roadmap.md) | What Build 10 delivers, what was cut in Build 9 and why, and the open decisions |
| [Demo](demo.md) | The demo account, the two-minute recording, the TestFlight invite, and the live-site check |
| [Questions a VC will ask](questions.md) | A short, honest answer to prepare for each |

Privacy policy, terms, and refunds were checked against the product in 9.8.0; the corrections are listed in the
[9.8.0 release guide](../release-9.8.0.md).

## Status

What the code delivers is done in 9.8.0. What needs the founder, their accounts, or a camera is listed here so
nothing is mistaken for finished.

| Item | Status |
|---|---|
| Admin → Metrics with CSV export | Done in 9.8.0 |
| Demo account script (`npm run demo:account`) | Done in 9.8.0; run it against production once (see [Demo](demo.md)) |
| Overview, technical one-pager, runbook, roadmap, metrics definitions | Done in 9.8.0 |
| Privacy policy, terms, and refunds checked | Done in 9.8.0 |
| Set `STRATA_INTERNAL_ACCOUNTS` and `STRATA_AI_USD_PER_MILLION_TOKENS` on Render | Founder |
| Grant the demo account Strata+ in Admin → People | Founder |
| Add the demo account to `APPLE_SANDBOX_ACCOUNTS` for TestFlight | Founder (see [Demo](demo.md) for the trade-off) |
| Record the two-minute screen recording | Founder |
| Check the live site on a phone with a clean console | Done after the 9.8.0 deploy: every public page, in the browser and as the app; the Pricing console errors were fixed in 9.8.1 |
| Fill in the real numbers from Admin → Metrics | Founder, the week of the meeting |
| "What would you spend the money on?" | Founder (see [Questions](questions.md)) |
| Give a trusted person emergency access to Render, Turso, Paddle, and GitHub | Founder (see [Runbook](runbook.md)) |
