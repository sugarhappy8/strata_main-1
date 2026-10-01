# Build 8.8.8 — Clock-relative billing test fixtures

Build 8.8.8 is a maintenance release. It ships the same Polar AccessLink V4 integration and product behavior as [Build 8.8.7](release-8.8.7.md) and fixes the test suite so release validation keeps passing after 2026-10-01.

## What changed

- The Paddle subscription webhook fixtures in the account-recovery server tests and the browser payment journey now derive `current_billing_period` from the current clock (one day in the past to 31 days ahead), matching the existing server payment tests.
- Previously both fixtures used a fixed billing period ending on 2026-10-01, so once that date arrived the Strata+ entitlement read as expired and the password-recovery, account-deletion, and browser entitlement tests failed.

## Upgrade notes

- No configuration, migration, or data changes. Deploy as a normal version bump.
- Existing Polar connections and Paddle subscriptions are unaffected.

## Validation

Release validation covers the full Node test suite, architecture policy, strict type checking, lint, coverage thresholds, runtime QA, performance checks, and Chromium browser journeys, with the CI job green on the release commit.
