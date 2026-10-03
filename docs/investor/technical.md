# STRATA — technical one-pager

## Stack

| Layer | Choice |
|---|---|
| Server | Node.js 24, the built-in `http` server, no framework. One production dependency (`@tursodatabase/serverless`). |
| Routing | One route table (`src/router.js`): 78 API paths, each declaring who may call it. One dispatcher applies the origin, session, CSRF, and JSON checks to every route the same way. |
| Database | Turso (hosted SQLite) in production, SQLite on a laptop. One schema, both adapters held to the same contract and parity tests; migrations are an ordered, idempotent ledger. |
| Hosting | Render, one web service (`render.yaml`), health checks on `/healthz`, `/livez`, and `/readyz`. |
| Browser | Plain HTML, CSS, and JavaScript, installable as a PWA with an offline workout page. 22 pages, about 100 browser modules, each page's modules held to a layer policy (logic, state, API, render, events). |
| iOS | A native shell around the same site, with Apple In-App Purchase and native extras (haptics, rest-timer alerts, AirPrint). |
| Providers | Paddle (web payments, merchant of record), Apple (App Store payments), Resend (account email), Groq (Strata AI, Zero Data Retention), Polar AccessLink V4 (wearables), Google (sign-in). |

About 100 server modules, each with a size budget and an allow-list of the modules it may use, checked on every
build (`architecture-policy.json`, `docs/module-architecture.md`).

## Security

- **Accounts.** scrypt password hashes with a per-account salt; random session tokens stored only as hashes, in
  HttpOnly, SameSite=Strict, Secure cookies; email verification, password reset, and deletion by one-time links that
  expire in 30 minutes. A password reset signs out every device.
- **Every write** passes one router that checks a trusted origin, the session, its CSRF token, and a JSON body. A route
  can run without a session only by opting out by name, and a test lists every one that does.
- **Payments.** Paddle webhooks are verified by signature (HMAC) before anything is applied, and access is granted only
  after STRATA confirms the transaction and the subscription with Paddle. App Store purchases are verified against
  Apple's pinned root certificate (Apple Root CA - G3); Sandbox purchases unlock Strata+ in production only for the
  listed review accounts.
- **Wearables.** Polar access and refresh tokens are encrypted at rest (AES-256-GCM) under a rotatable key.
- **Browser.** A strict Content-Security-Policy, HSTS, `X-Frame-Options: DENY`; every HTML template escapes its values
  and the page refuses raw strings, enforced by the linter.
- **Limits.** Rate limits on every write and every expensive read, held in the database.
- **Strata AI** never receives a member's name, email, or account ID, runs only after the member allows it, and its
  proposals are checked by the server before they can change anything.
- **Owner access.** One verified owner account, bound by ID; every admin action is audited with a server-written reason.
- `npm audit`: no known vulnerabilities. Vulnerability reports go privately to the address in `SECURITY.md`.

## Tests

- **1,371 Node tests** across unit, integration (a real server on a temporary database), and contract layers
  (database adapters, architecture), with coverage floors of 90% lines, 78% branches, and 85% functions.
- **18 browser journeys** in Chromium, Firefox, and WebKit, including accessibility checks, phone layouts, offline
  workouts, and a visitor's clean console.
- Load tests with 100 simulated members, and page-weight and latency budgets.

## How a release ships

1. Every change runs `npm run check`: formatting, release-version markers, both architecture policies, strict types,
   lint, the Node suite with coverage floors, runtime smoke tests, performance budgets, and the browser journeys.
2. GitHub Actions runs the same gate on every pull request, plus the 100-member load tests.
3. A release bumps every cached asset URL with `npm run release:version`, so installed apps fetch the new files, and
   ships with a release guide (`docs/release-x.y.z.md`) and a changelog entry.
4. The merged commit on `main` is deployed to Render; `npm run smoke:deploy` checks the live build afterwards.
5. A tag publishes the release guide as the GitHub release notes.

Rolling back, rotating keys, and restoring the database are in the [runbook](runbook.md).
