# STRATA performance evidence

Performance work starts with repeatable evidence. Run the local regression check with:

```bash
npm run performance
```

The script starts an isolated SQLite application, creates a real account through HTTP, warms each path, and records 40 sequential samples. The child receives an explicit minimal environment: local SQLite, test-only direct signup, HTTP cookies, fixed loopback binding, UTC, and disabled admin, email, Paddle, proxy, and IP-allowlist behavior. Ambient secrets, provider URLs, `NODE_OPTIONS`, and production settings are not inherited. It also measures storage operations directly against a separate on-disk SQLite database seeded with 500 accounts, sessions, and plans. Every response and database result is validated, so a fast error cannot be mistaken for a successful measurement.

The tracked paths are intentionally small and high-value:

- `GET /healthz`, the compatibility alias for the storage-backed readiness probe;
- `GET /api/status`, the public runtime/configuration boundary;
- authenticated `GET /api/plan`, which composes session, plan, access, trial, deletion, and admin state;
- CSRF-protected `PUT /api/plan`, including validation and compare-and-swap persistence;
- session lookup by its hashed token;
- plan lookup by account; and
- plan compare-and-swap persistence.

The command reports median and p95 latency and exits nonzero when either exceeds its checked-in budget. These budgets are local/CI regression tripwires, not production service-level objectives:

| Operation | Median budget | p95 budget |
| --- | ---: | ---: |
| Health endpoint | 20 ms | 75 ms |
| Status endpoint | 20 ms | 75 ms |
| Authenticated plan endpoint | 35 ms | 125 ms |
| Authenticated plan-save endpoint | 35 ms | 125 ms |
| Session lookup | 5 ms | 20 ms |
| Plan lookup | 5 ms | 20 ms |
| Plan compare-and-swap | 10 ms | 35 ms |

`/livez` is intentionally absent because it performs no storage work and is not a useful proxy for application readiness. The benchmark also does not exercise account email, Paddle checkout/subscription/portal calls, Turso network latency, image transfer, browser rendering, or service-worker installation. Build 7.5.0's request logger is quiet in the isolated test environment, so console transport does not distort these application-path samples. Capture separate hosted evidence before using the result for capacity or provider decisions.

### Page weight

The same server also answers what a signed-out visitor on a phone downloads before touching the homepage and Plan: the HTML, every stylesheet and script the page names, and the first-paint assets the markup does not name — the phone frame of the homepage photo (`hero-training-960.avif`), the body font, and Plan's exercise library (`exercise-library.json`). Each response is fetched with `Accept-Encoding: gzip`; the check sums the bytes the server sends and their decoded size and fails above these budgets:

| Page | Sent (gzip) budget | Decoded budget | 9.6 | Now |
| --- | ---: | ---: | ---: | ---: |
| Homepage `/` | 180,000 B | 385,000 B | 692,887 / 1,156,535 B | 164,352 / 350,767 B |
| Plan `/planner.html` | 123,000 B | 460,000 B | 165,068 / 681,254 B | 111,839 / 417,145 B |

The homepage's exercise catalog (`exercises.json`, 335 KB, 57 KB gzipped) is not part of its first paint: it loads when the free-week preview or the rankings come into view, on the first scroll, or at once for a link to `#preview` or `#rankings` (and `/rankings`, which redirects there). Plan loads the library — the catalog without its setup notes, cues and tutorial links — and fetches the full catalog and `discovery-core.js` the first time a setup guide opens. The check does not run page scripts, so it cannot see a script that starts fetching early; `test/homepage-client.test.js` and `qa/planner-runtime-smoke.js` hold those rules. It also leaves out the service worker's install-time precache, which a first visit starts after the page loads.

## Recorded baseline

The Build 7.8.0 source candidate passed every checked-in budget on the local Darwin arm64 host under Node 25.8.2. Each path used eight warm-ups followed by 40 measured samples:

| Operation | Observed median | Observed p95 |
| --- | ---: | ---: |
| Health endpoint | 0.413 ms | 0.663 ms |
| Status endpoint | 0.357 ms | 0.892 ms |
| Authenticated plan endpoint | 0.320 ms | 0.385 ms |
| Authenticated plan-save endpoint | 0.416 ms | 0.818 ms |
| Session lookup | 0.008 ms | 0.010 ms |
| Plan lookup | 0.004 ms | 0.005 ms |
| Plan compare-and-swap | 0.044 ms | 0.054 ms |

This source-candidate capture used isolated local HTTP, SQLite, and fixture-backed storage. It is regression evidence for the selected code paths, not a production claim or a measurement of hosted Turso, Resend, Paddle, Internet, or multi-user behavior. The supported runtime and CI target remain Node 24, so promotion still requires a green Node 24 CI result.

### Historical Build 6.9.9.007 baseline

A Build 6.9.9.007 pre-release run on 2026-09-06 used the locally installed Node 24.20.0 binary directly on Darwin arm64, 40 measured samples, eight warmups, and the 500-account storage fixture. The application child process used the same binary through `process.execPath`. The capture command was `node scripts/performance-check.js --json` after `node --version` confirmed `v24.20.0`:

| Operation | Observed median | Observed p95 |
| --- | ---: | ---: |
| Health endpoint | 1.781 ms | 2.364 ms |
| Status endpoint | 1.711 ms | 2.573 ms |
| Authenticated plan endpoint | 1.678 ms | 2.028 ms |
| Authenticated plan-save endpoint | 2.075 ms | 2.884 ms |
| Session lookup | 0.006 ms | 0.008 ms |
| Plan lookup | 0.003 ms | 0.005 ms |
| Plan compare-and-swap | 0.042 ms | 0.066 ms |

This is one captured run, not a universal expected value. A second Node 24 check on the same host produced endpoint p95 values from 2.35–3.61 ms, illustrating ordinary scheduler noise while remaining far inside the regression budgets. The JSON output now records its Node version, platform, architecture, sample count, warmups, and fixture size so later evidence identifies its environment. The command output remains authoritative for the machine being evaluated.

Use `STRATA_PERF_SAMPLES` to select 10–500 measured samples and `npm run performance -- --json` to produce machine-readable evidence. Compare runs made with the same Node version, storage mode, hardware class, sample count, and background load. A single local result is evidence of a regression in this code path, not a claim about production network latency or Turso service behavior.

Before optimizing a path, capture the JSON output and a profiler or query-plan explanation. After changing it, rerun the same command under the same conditions, keep correctness tests enabled, and report both the before and after distributions. Do not loosen a budget to make an unexplained regression green. The latest candidate result belongs in [release readiness](release-readiness.md); the Build 6.9.9.007 baseline remains separately labeled as historical evidence.
