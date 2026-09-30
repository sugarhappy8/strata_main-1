# Build 8.8.7 — Polar AccessLink V4

Build 8.8.7 migrates STRATA's connected-device integration from Polar AccessLink V3 to V4 while preserving the Recovery, Overview, Train, and workout-history experiences introduced in Build 8.8.6.

## What changed

- Polar authorization now uses `auth.polar.com` and requests only `sleep:read`, `nightly_recharge:read`, `continuous_samples:read`, and `training_sessions:read`.
- STRATA reads the V4 range endpoints for sleep, Nightly Recharge, continuous samples, and training sessions.
- The encrypted credential envelope now stores the access token, rotating refresh token, expiry, and granted scopes. Refresh rotation is persisted before the new access token is used.
- Sync is polling-only: on connect, on **Sync now**, and through the scheduled daily pull. The V3 registration, deregistration, signed-webhook route, webhook setup script, and webhook secret have been removed.
- Disconnect and account deletion erase the local Polar credential and imported data. Members can separately remove Polar-side consent at [account.polar.com](https://account.polar.com/).

## Upgrade notes

- Existing V3 connections cannot be converted safely and must reconnect from Account after deployment.
- Keep `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET`, `POLAR_REDIRECT_URI`, `DEVICE_TOKEN_KEY`, `DEVICE_TOKEN_KEY_PREVIOUS`, and `DEVICE_SYNC_INTERVAL_MS` configured as described in the [deployment guide](deployment.md#polar-connected-devices).
- Remove `POLAR_WEBHOOK_SECRET`; V4 operation in STRATA does not use it.
- Startup migrations add the V4 ANS-status shape and remove queued legacy V3 revocation tokens.
- V4 does not provide STRATA a documented stable Polar account identifier, so STRATA enforces one active Polar connection per STRATA account but cannot deduplicate the same Polar account across independent STRATA accounts.

## Security and privacy

- Polar credentials remain sealed with AES-256-GCM and never reach the browser or account export.
- OAuth completion remains bound to the signed-in session that started the connection.
- Polar data remains private to the member, is not sent to Strata AI, and is removed locally on disconnect or account deletion.
- Access is limited to the four documented read scopes; STRATA requests no write scope.

## Validation

Release validation covers the full Node test suite, architecture policy, strict type checking, lint, coverage thresholds, runtime QA, performance checks, and Chromium browser journeys. The Polar coverage includes OAuth and token rotation, V4 payload mapping, migration and storage parity, server integration, reconnect behavior for legacy V3 credentials, local deletion, and Account and Recovery accessibility scans.

Automated Polar tests use synthetic local provider fixtures. Before treating interval-derived heart or breathing rates as production evidence, validate a redacted authorized V4 fixture and confirm the units used by STRATA's interval conversion. A live Polar account remains the final deployment smoke test.
