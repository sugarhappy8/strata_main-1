# Build 10.1.1 — Polish

Build 10.1.1 fixes what a review of 10.1.0 found across the website, the iPhone app, and the Android app. It changes no
prices, plans, or policies. The Android and iPhone apps have their own changes in their repositories
(`sugarhappy8/strata-fitness-android` and `sugarhappy8/strata-fitness-ios`); this guide covers the website's side.

## What changed

### Google Play billing
- **Bad tokens are refused, not retried.** Google answers 400, 404, or 410 for a purchase token it does not know or
  no longer keeps. STRATA now answers `400 GOOGLE_PLAY_PURCHASE_INVALID` for these, as the guide always said, instead
  of `503 GOOGLE_PLAY_UNAVAILABLE`. As a result, the app stops sending the token and Pub/Sub stops redelivering it.
- **One stuck subscription no longer holds up the rest.** The 10-minute refresh skips a subscription Google keeps
  failing on for 30 minutes, doubling up to a day. A failed lookup is logged as `google_play.lookup_failed` with
  Google's error code.
- **A subscription survives a deleted account.** A Google Play subscription bought for a STRATA account that was
  later deleted keeps billing the same Google Account. The member restoring it on a phone signed in to that Google
  Account can now attach it to their new STRATA account, as long as no existing account holds it.
- **On hold or paused: resume, don't buy again.** These subscriptions give no access but bill again once resumed.
  - Paddle checkout answers `409 GOOGLE_PLAY_SUBSCRIPTION_HELD`.
  - The pricing page shows why, with Google Play's link instead of Subscribe.
  - The Android paywall does the same.
- **Several subscriptions.** Account and the paywall describe the subscription giving access, else one still in
  progress (pending, on hold, or paused), else the latest that ended. Before, an old expired subscription could hide
  a pending one.
- **Configuration preflight.** `npm run preflight:production` checks the Google Play settings once either secret is
  set. It warns when Google Play Billing is off or `GOOGLE_PLAY_NOTIFICATION_TOKEN` is missing.

### The apps' paywall and app mode
- **The paywall explains store errors.**
  - Purchases turned off by Screen Time (`PURCHASE_NOT_ALLOWED`, from the iPhone app) say so.
  - A store that cannot be reached says to check the connection.
  - Canceling Restore Purchases shows no error.
  - A test purchase reads "Test purchase", in the paywall and in Account.
- **Focus stays on the paywall.** When a control disappears (Subscribe after a purchase), focus moves to the
  paywall's heading.
- **No tab bar over the keyboard.** In both apps the tab bar hides while a text field has focus, so it never covers
  the field.
- **Calendar in the Android app.** Android's calendar takes no reminder with a new event, so the Train screen no
  longer offers one there.
- **Printing in the Android app** names Google Play, not the App Store.
- **No website card under the paywall.** The pricing page in the apps ends with the paywall; the website's free-plan
  card (with its Install link) no longer follows it.

### The website
- **Home.**
  - The hero follows who is signed in: "Build my free week" for a visitor, "Open my week" for a member, and
    "Open Dashboard" and "Start today's workout" for a Strata+ member.
  - The visitor-only lines are visitor-only.
  - The header no longer repeats the navigation's Sign in or Profile.
  - The figures under the hero have no stray divider after the last one.
- **Planner.**
  - Each card's actions read Guide, Video, and Remove.
  - The day picker keeps the full day name, and the move buttons wrap below it in a narrow column.
  - On a phone the exercise library scrolls with the page instead of inside a short box.
  - A rest day says "Rest day" throughout.
  - Week templates lost its odd glyph.
- **Navigation.** The current tab is marked the same way on every page: bright text over a short accent underline.
  The planner and Account used other marks before.
- **Onboarding.** The week preview no longer scrolls the page sideways on a phone.
- **Dashboard.** Card descriptions no longer run under their arrows.
- **Workout.** "Preview exercises" shows its open and close mark.
- **Progress.** The weekly volume reads "13.9K kg", not "13.9Kkg".
- **Pricing.**
  - The large "+" mark no longer sits under the price on a phone.
  - Complimentary Strata+ with no end date says "No end date", not "until an administrator revokes it".
- **Account.** Focus rings show only for keyboard focus, not on headings the page focuses for screen readers.
- **Addresses.** `/discover` and `/onboarding` open their pages, as `/discover.html` and `/onboarding.html` do.
- **Spelling.** The copy uses "canceled" and "canceling" throughout.

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 10.1.1.
2. **Database.** No migration.
3. **Configuration.** Nothing new is required. Run `npm run preflight:production` to see the new Google Play check.
4. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=10.1.1 npm run smoke:deploy`.

## Validation

All of these pass:
- the format check, the release markers, and both architecture policies;
- strict types and lint;
- the Node suite with its coverage floors;
- the runtime smokes and the performance budgets;
- the browser journeys, including a new one for the Android app's calendar without a reminder.

New and changed checks cover:
- Google's 400, 404, and 410 answers;
- the refresh backoff, with a fake clock;
- restoring a subscription bought for a deleted account;
- which subscription the summary describes;
- the server refusing Paddle checkout for a paused or on-hold Google Play subscription;
- the pricing page sending that member to Google Play;
- the preflight's Google Play check;
- the paywall's store messages, test purchases, and focus;
- the tab bar while typing;
- the friendly routes;
- the planner's phone library.
