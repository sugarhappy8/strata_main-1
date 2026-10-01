# STRATA QA

## Fast checks

Install the maintained browser engines once after `npm install`; Linux CI and the complete three-engine compatibility matrix require all of them:

```bash
npx playwright install chromium firefox webkit
```

Run the release audit, module-architecture and static-boundary checks, correctness-focused linter, coverage-gated Node suite, all browser-free runtime smokes, performance regression check, and high-risk browser E2E suite:

```bash
npm run check
```

`npm run qa` remains an alias for the same full check. The runtime smokes execute the Account, Strata+, planner, and workout scripts against a small fake DOM, then start a real local server to verify PWA routes, headers, icons, manifest, versioned-cache lifecycle, private-data exclusions, protected-page gating, and build status. The planner smoke also exercises desktop catalog pagination, unique-card expansion, and focus transfer after **Load more**. These checks catch initialization, rendering, and deployment regressions, but they do not replace the real-browser audit.

The E2E command uses isolated local applications and provider fakes. Most risk-focused journeys run in Chromium. Linux CI runs the focused compatibility matrix in Chromium, Firefox, and WebKit for axe serious/critical checks, keyboard navigation, copy-day behavior, and 200% text reflow. Local Darwin runs default to Chromium and WebKit because Playwright Firefox cannot use its headless framebuffer in the Codex app sandbox; use `STRATA_E2E_ENGINE=firefox npm run test:e2e` to request that diagnostic explicitly. No path contacts production Paddle, Resend, or Turso services.

`npm run test:visual` runs the deterministic responsive geometry contracts directly. They measure containment, sibling collisions, touch targets, sticky-navigation separation, collapsed secondary content, and horizontal overflow from 320 through 1,440 px. These invariant checks avoid fragile pixel hashes while still failing CI on the overlap, clipping, unreadably narrow text, and mobile-action regressions that have affected STRATA before. They are also included in the complete E2E gate.

To run the coverage-gated Node suite by itself:

```bash
npm run coverage
```

Coverage fails below the calibrated 90% line, 78% branch, and 85% function floors. See [`docs/testing.md`](../docs/testing.md) for the unit, integration, contract, and E2E boundaries and the rationale for those floors.

To collect the local endpoint/storage performance evidence separately, run `npm run performance`. Its method, budgets, and interpretation are documented in [`docs/performance.md`](../docs/performance.md).

## Browser audit

Start STRATA in a separate terminal. Use an isolated data directory so QA accounts do not enter the development database:

```bash
NODE_ENV=test ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS=true EMAIL_VERIFICATION_ENABLED=false \
  STRATA_DATA_DIR="$(mktemp -d)" npm start
```

Then run, pointing `STRATA_QA_DATA_DIR` at the same data directory so the audit can give its account Strata+ (there is no free trial to start):

```bash
STRATA_QA_DATA_DIR=/path/to/that/data/dir npm run qa:ui
```

The signup override is intentionally paired with `NODE_ENV=test`; the application rejects it in production.

The audit expects `http://127.0.0.1:4173` by default. It creates a temporary account through the UI, exercises the inline battle, detail and rating views, search and equipment filters, planner autosave, every main route at a 320px viewport, and the device-aware install guide. It exits nonzero on assertion failures, first-party browser errors, failed first-party requests, undersized primary install controls, or horizontal mobile overflow.

Configuration:

- `STRATA_QA_BASE_URL` points the audit at another running instance.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` uses a specific Chromium executable.
- `STRATA_QA_ARTIFACT_DIR` enables screenshots and writes them to the specified directory. Screenshots are disabled by default.

The audit closes its browser reliably, but it does not start or stop STRATA. Stop the separate server when the run finishes and remove its temporary data directory if your operating system does not clean it automatically.
