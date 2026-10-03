# Demo

## The demo account

A separate account with a realistic month: a four-day upper/lower week, four weeks of logged workouts with loads that
rise week by week (one session missed, as in a real month), check-ins, and 28 sample Polar nights including one poor
night. It is not the App Review account, and it never counts in Admin → Metrics.

1. Choose its email, for example `demo@stratafitness.online`, and add it to `STRATA_INTERNAL_ACCOUNTS` on Render and in
   your local `.env`.
2. With the production `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `DEVICE_TOKEN_KEY` in your local `.env`, run:

   ```bash
   STRATA_DEMO_PASSWORD='choose a long password' npm run demo:account -- --email demo@stratafitness.online --yes
   ```

   Leave out `STRATA_DEMO_PASSWORD` to have one generated and shown once. `--yes` confirms writing to Turso.
   Without `DEVICE_TOKEN_KEY` the account gets no Polar nights.
3. In Admin → People, find the account and grant Strata+ with no end date. The script never grants access itself.
4. Sign in as the demo on a phone and check Plan, Train (history and Training Memory), Progress, and Recovery.

The script only creates a new account. It refuses the owner's email, any email that already has an account, and any
email missing from `STRATA_INTERNAL_ACCOUNTS`. The Polar connection is a sample: its next sync is a year away so it
never calls Polar. Do not press **Sync now** on the demo; Polar would refuse the sample connection. To start again,
delete the account from Admin → People and run the script again.

## The two-minute recording

Record on a phone (or the iOS app) signed in as the demo, at 390 px wide, with notifications off.

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Home → Rankings, sorted by FitScore; open one exercise's guide and its sources | "Every exercise is ranked, and you can see why." |
| 0:20–0:50 | Plan: the four-day week; swap one exercise from the library | "Build a week from what you have and the days you train." |
| 0:50–1:25 | Train: start today's session, log a set with last time's numbers beside it, finish | "Last time's sets are on screen while you lift." |
| 1:25–1:45 | Progress and Recovery: four weeks of loads going up, last night's Polar recovery | "Your work adds up, next to how you slept." |
| 1:45–2:00 | Pricing: Free, and Strata+ monthly or yearly | "The rankings and planner are free; Strata+ is $4.99 a month or $29.99 a year." |

Say once that the Polar nights are sample data on a demo account.

## TestFlight

Invite the demo's Apple ID as a tester in App Store Connect → TestFlight. The Strata+ grant already unlocks everything
in the app. To show buying Strata+ in TestFlight as well, add the demo email to `APPLE_SANDBOX_ACCOUNTS`: a Sandbox
purchase unlocks Strata+ in production only for accounts listed there, and only once their email is verified (the
demo's is).

## The live site on a phone

After deploying 9.8.0, open stratafitness.online signed out on a phone and on desktop with the developer tools open.
Go through Home, Rankings, Plan, Pricing, and Sign in, then sign in as the demo and open Plan, Train, Recovery, and
Profile. The console should show no errors and no `401`s (`npm run test:e2e` checks the same pages locally), and
`npm run smoke:deploy` should pass against the live site.
