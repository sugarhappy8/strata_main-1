# Polar integration (Build 9)

STRATA reads a member's own Polar data through **Polar AccessLink V4** and turns it into the
shared data layer described in `DATA_MODEL.md`: Polar sessions join the **Training Log**, and
sleep, recovery, and heart rate join the **Daily Snapshot**. Polar measures, STRATA explains,
the member decides: nothing in the plan or calorie targets changes without a tap, and nothing
is presented as a diagnosis.

## Who can use it

| Member | Connect, Sync now, settings | See stored data | Disconnect and delete |
|---|---|---|---|
| Strata+ (`plus.recovery`) | Yes | Yes | Yes |
| Strata+ ended | No; syncing pauses | Yes, read-only | Yes |
| Free, never connected | No | — | — |

Access is decided by the entitlements module (`requireFeature("plus.recovery")` on the server,
`StrataEntitlements.can` on the page).

## Connection flow

1. **Connect** (Account, "Connected devices"): `POST /api/devices/polar/connect` creates a
   one-time `state` bound to the member's session and returns Polar's authorize URL
   (`https://auth.polar.com/oauth/authorize`) with exactly these scopes: `sleep:read`,
   `nightly_recharge:read`, `continuous_samples:read`, `training_sessions:read`.
2. **Callback**: `GET /api/devices/polar/callback` checks the `state`, then
   `POST /api/devices/polar/complete` exchanges the code at `https://auth.polar.com/oauth/token`.
3. **Tokens at rest**: the access token, rotating refresh token, expiry, and granted scopes are
   sealed together with `DEVICE_TOKEN_KEY` (AES-256-GCM, `src/devices-crypto.js`).
   `DEVICE_TOKEN_KEY_PREVIOUS` lets a key rotate without reconnecting everyone. A rotated
   envelope is saved before any data is read. A plain V3 token, a missing scope, or a missing
   key fails closed and asks the member to reconnect.
4. **One connection per account**: V4 gives no stable Polar account id, so each completed
   authorization gets a random local id. Reconnecting clears the earlier connection's rows so
   two Polar accounts never mix.
5. **Disconnect** (`DELETE /api/devices/polar`): deletes the sealed credentials, every imported
   night, day, and session, the Training Log links, and the member's Daily Snapshots (they are
   rebuilt from what remains). Consent at Polar is removed by the member at
   https://account.polar.com/; V4 has no remote deregistration endpoint.

## What is imported

| Polar data (V4 path under `https://www.polaraccesslink.com/v4/data`) | Stored in | Feeds |
|---|---|---|
| Sleep (`/sleeps`, with sleep result, evaluation, and score) | `wellness_nights` | Daily Snapshot `sleep`; Recovery |
| Nightly Recharge (`/nightly-recharge-results`) | `wellness_nights` | Daily Snapshot `recovery`, stress signals; Train's lighter-session offer |
| Continuous heart rate (`/continuous-samples`, heart-rate samples) | `wellness_days` | Daily Snapshot `heart` |
| Training sessions (`/training-sessions/list`) | `wellness_workouts` | Training Log (`source: polar`), links to logged workouts, cardio load |

**Not yet imported: daily activity (steps, active calories) and physical info.** The Build 9
spec asks for them, and for webhooks. Both depend on endpoints and scopes that must be checked
against Polar's current AccessLink documentation before any code is written, and polar.com was
not reachable from the build environment. The Daily Snapshot already has an `activity` field
(null today) so adding them later is an import change only.

## Sync model

- **First import**: up to 28 days, started right after connecting.
- **Scheduled pull**: every active connection is read at least daily, spread over a four-hour
  window per member so connections do not all sync at once. Each pull re-reads at least the
  last 3 days so late Polar uploads are caught (the daily reconciliation).
- **Sync now**: `POST /api/devices/polar/sync`, with a five-minute cooldown.
- **Webhooks**: none today. The client keeps to V4 polling (see Known limits). If Polar's
  current docs confirm V4 push notifications, the handler
  should verify the signature and only mark the member's connection due
  (`store.markDeviceConnectionDue`), so every update still flows through the same idempotent
  sync path.
- **Idempotence**: every row is an upsert keyed by member, provider, and date or session id, so
  re-reading a window never duplicates anything. A connection never syncs twice at once.
- **Rate limits**: Polar's `ratelimit-*` headers are tracked; a 429 honors `retry-after` and
  schedules the next attempt for then. Other failures back off exponentially (5 minutes, up to
  6 hours).
- **After each sync**: `polar.sync.finished` (`userId`, `provider`, `from`, `to`). The Training
  Log relinks sessions in that window and the Daily Snapshot rebuilds those days.

## Where members see it

- **Recovery** (Strata+ studio): latest night, stress signals against the member's usual
  nights, sleep, heart rate, and 4/8/12-week trends next to training.
- **Overview card** and the studio's **Plan** view: the latest Nightly Recharge and, after a poor night, the
  lighter-session note with a link to Train.
- **Train**: offers a lighter session after a poor or very poor Nightly Recharge, or two nights
  in a row with more stress signals than usual.
- **Progress**: a Polar gym session on a planned day with nothing logged counts as that day
  done.
- **Training Log** and **Daily Snapshot** APIs, and Strata AI's context (Phase 5).

## States

| State | Shown as | Member action |
|---|---|---|
| Not connected | "Connect your Polar Loop" | Connect in Account |
| Importing | "Importing from Polar…" | Wait; the page updates on return |
| Connected | Last sync time and synced-through date | Sync now |
| Error | Human message from the last error code; retried automatically | Sync now, or wait |
| Reconnect needed | "Polar needs you to reconnect" | Reconnect in Account |
| Strata+ ended | Data stays visible, read-only; syncing paused | Renew to resume, or disconnect |

## Downgrade rule

When Strata+ ends, syncing stops at the next scheduled pull (`PLUS_INACTIVE`) and resumes on
renewal. Stored data stays readable (`/api/devices`, `/api/wellness/*`) and exportable, and
the member can disconnect to delete it at any time. Nothing extra is deleted on lapse; all
Polar rows and snapshots older than 400 days are removed by the hourly cleanup, paid or not.

## Failure modes

| Failure | Code | What happens |
|---|---|---|
| Refresh token rejected or revoked at Polar | `POLAR_AUTH`, `POLAR_V4_RECONNECT` | Connection marked "reconnect"; no more pulls until the member reconnects |
| Sealing key missing or rotated away | `DEVICE_KEY_MISSING`, `DEVICE_TOKEN_UNREADABLE` | Same as above |
| Polar rate limit | `POLAR_RATE_LIMIT` | Next attempt at Polar's `retry-after` |
| Polar unavailable or unreadable response | `POLAR_UNAVAILABLE`, `POLAR_BAD_RESPONSE` | Exponential backoff, up to 6 hours |
| Strata+ ended | `PLUS_INACTIVE` | Paused, checked daily, resumes on renewal |
| Two syncs for one connection | — | The second returns "busy"; nothing runs twice |
| A provider record outside STRATA's bounds | — | That record is skipped; the rest of the window imports |

## Known limits

- **No stable Polar identity.** AccessLink V4 does not expose a documented, stable Polar account
  id through this flow. STRATA keeps a random local connection id and allows one active Polar
  connection per STRATA account, but cannot recognize the same Polar account connected to two
  STRATA accounts.
- **Field units need a live check.** The tests use synthetic V4 fixtures. A redacted fixture
  from a real, authorized account is still needed to confirm provider field meanings, especially
  that `meanNightlyRecoveryRri` and `meanNightlyRecoveryRespirationInterval` are intervals that
  STRATA converts to per-minute rates with `60000 / interval`.
- **Consent at Polar stays with the member.** Disconnecting deletes STRATA's credential and
  imported data; the member removes STRATA's consent at https://account.polar.com/ if they want.
- The original Build 8.8.6 plan (AccessLink V3, webhooks, long-lived tokens) is superseded and
  lives only in Git history (`strata-polar-plan.txt`, removed in 9.0.0).

## Configuration

`POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET`, `DEVICE_TOKEN_KEY` (32 random bytes, base64), and an
https `POLAR_REDIRECT_URI` or `APP_BASE_URL` in production. Optional: `DEVICE_TOKEN_KEY_PREVIOUS`,
`POLAR_AUTH_URL`, `POLAR_TOKEN_URL`, `POLAR_API_URL`, `DEVICE_SYNC_INTERVAL_MS`. Until the
required values are set, the feature stays off and the pages say so.
