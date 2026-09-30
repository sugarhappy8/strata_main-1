# Build 8.8.6 — Polar connected devices for Strata+

Build 8.8.6 lets each Strata+ member connect their own Polar account, such as a Polar Loop, to their own STRATA account. STRATA imports Polar's recovery, sleep, heart-rate, and workout data and shows it next to the member's training, compared only with that member's usual nights. The feature stays off until the owner adds the Polar settings described in [the deployment guide](deployment.md#polar-connected-devices).

## Connecting Polar

Account has a new Connected devices card. A Strata+ member chooses **Connect Polar**, reads what STRATA will read and keep, agrees, and continues to Polar's own sign-in page; STRATA never sees the Polar password. When Polar sends the member back, Account finishes the connection, imports the last 28 days, and shows the card as connected with the last sync time. Members can sync on request, choose whether Train may offer a lighter session, and disconnect after a confirmation that explains what is deleted.

Free members see what the feature does and a Strata+ link. If Strata+ ends, syncing pauses and the imported data stays until the member disconnects or deletes their account. If Polar stops accepting STRATA's access, the card asks the member to reconnect.

## Recovery

Strata+ has a seventh destination, Recovery, with a Sleep & stress label. It shows:

- **Nightly Recharge** as Polar reports it, with ANS charge and sleep charge.
- **Overnight stress signals**: more than usual, within usual, or fewer than usual. A night counts as more than usual when Polar's ANS charge is below usual, or when two of these are true: heart rate variability below the member's usual range, overnight heart rate above it, or breathing rate above it. Usual ranges are the middle half of up to 28 earlier nights, and nothing is compared until 7 nights exist.
- **Sleep**: time asleep with deep, light, and REM stages, sleep score, and the member's usual range.
- **Heart**: overnight heart rate, heart rate variability, and breathing rate, plus today's resting estimate and range from 24/7 heart rate.
- **Trends** for 4, 8, or 12 weeks: a Nightly Recharge strip, heart rate variability, overnight heart rate, and sleep charts with the usual band, and weekly averages next to completed STRATA workouts and Polar cardio load.

The Overview shows a recovery card for last night with sleep, heart rate variability, and resting heart rate. None of this is described as a diagnosis, and Polar's own results are labeled as Polar's.

## A lighter session on Train

After a poor or very poor Nightly Recharge, or after two nights in a row with more stress signals than usual, Train shows the offer next to Start workout: the same exercises with one set fewer each, never below one set. It applies only to that day and never changes the weekly Plan. A compromised night earns a note instead of an offer. Members can turn the offer off in Account. Lighter sessions are marked in the session header and in history, and history shows the Polar workout recorded during each STRATA session.

## Privacy and security

- Session cookies stay `SameSite=Strict`. Polar's return only parks its one-time code in a short-lived cookie limited to the completion endpoint, and Account completes the link with the same signed-in session that started it, so a captured code cannot link a Polar account to someone else's STRATA account.
- Polar tokens are sealed with AES-256-GCM under `DEVICE_TOKEN_KEY` and never reach the browser or the account export. The key can be rotated with `DEVICE_TOKEN_KEY_PREVIOUS`.
- One Polar account links to one STRATA account at a time.
- Disconnecting, or deleting the STRATA account, deletes the imported data and ends STRATA's access at Polar. If Polar cannot be reached, only the sealed token, without a link to the account, is kept for up to 30 days while STRATA retries.
- Polar data is not sent to Strata AI, not shown to other members, and not cached by the service worker. The account export includes connection settings and imported Polar data, never tokens or Polar identifiers.
- The Privacy Policy has a Connected devices section, and the Terms explain that Polar values can be delayed or inaccurate and are wellness information, not medical advice.

## Syncing

STRATA reads Polar's 28-day window on connect, then checks every connection at least once a day and sooner after a signed Polar webhook. It stays under the rate limits Polar reports in every response, backs off after failures, and keeps its own copy for about 13 months, with half-hour heart-rate detail for 28 days.

## Owner setup

1. Create an AccessLink client at admin.polaraccesslink.com with the redirect URL `https://<your domain>/api/devices/polar/callback`.
2. Set `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET`, and `DEVICE_TOKEN_KEY` (32 random bytes as base64) in Render and deploy.
3. Run `npm run polar:webhook -- create`, set the printed secret as `POLAR_WEBHOOK_SECRET`, and redeploy.
4. Run `npm run preflight:production`, then connect a real Polar account with a Strata+ test member.

Polar's documentation could not be checked from the build environment, so the first real connection should confirm the field names STRATA maps, the webhook event names (the script accepts `--events` if Polar rejects a default), and that Nightly Recharge appears the morning after a night's sleep.

## Choices made for this release

- Recovery is a new destination rather than part of Progress.
- STRATA shows Polar's Nightly Recharge as Polar reports it and adds only its own overnight stress signals next to it.
- The lighter session applies to one day and is optional.
- Disconnecting deletes the imported data.
- Nutrition and Strata AI do not use Polar data yet. Build 8.8.7 is planned to add Polar evidence to Nutrition and an opt-in for Strata AI.

## Compatibility

New tables are created at startup on both SQLite and Turso: `device_connections`, `device_connect_states`, `device_revocations`, `wellness_nights`, `wellness_days`, and `wellness_workouts`, plus the `device_data_on_user_delete` trigger. Workouts accept an optional `adjustment` value of `recovery`. New optional environment variables are `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET`, `POLAR_WEBHOOK_SECRET`, `POLAR_REDIRECT_URI`, `DEVICE_TOKEN_KEY`, `DEVICE_TOKEN_KEY_PREVIOUS`, and `DEVICE_SYNC_INTERVAL_MS`. Without them, Account shows no Connected devices card and Recovery says it is coming soon.

Validation covered the full Node test suite, including Polar client, mapping, sync, storage-parity, and end-to-end server tests against a local stand-in for Polar, plus architecture checks, strict type checking, lint, coverage, runtime QA, performance checks, and the Chromium browser journeys, including a new Polar journey with axe accessibility scans of Account and Recovery.
