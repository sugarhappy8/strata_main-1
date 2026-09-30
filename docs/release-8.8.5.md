# Build 8.8.5 — Polish, accessibility, and cleanup

Build 8.8.5 is a maintenance release from a page-by-page audit of every public page and every Strata+ destination at desktop and phone widths. It fixes the layout, contrast, wording, and heading problems that audit found, makes Strata AI more tolerant of incomplete model output, and removes code, settings, and styles that nothing uses any more.

## Navigation and layout

Opening a Strata+ destination now keeps the destination tabs on screen. STRATA previously scrolled the new panel to the top of the window, which slid the tabs under the sticky site header and hid the selected tab on phones; it now brings the tab row into view with the panel below it. A link straight to a destination, such as `/discover.html#nutritionWorkspace`, lands the same way once the workspace has loaded instead of scrolling while it is still hidden.

Nutrition's target cards no longer show a seam between the heading and the cards, phone Progress charts no longer clip their week labels, the suggested week numbers its recovery days, and the workout page footer sits on one baseline.

## Readability and accessibility

Text that a later style rule had turned dark on a dark surface is readable again: the homepage preview introduction, the Policies support kicker and founder label, and the offline page kicker. The Pricing page's inline Contact and Terms links now match the body text around them.

Every page now has exactly one top-level heading. The Strata+ studio names the workspace for screen readers and keeps Overview's headline as a section heading, the signed-in Account page has a page heading, and the phone workout page hides its introduction visually instead of removing it, so the page keeps its heading and "Skip to workout" lands on it.

On Strata AI, the message box now sits below the starter prompts until the conversation begins, so on a phone the prompts are no longer hidden behind it under the words "pick one of these". Once a conversation starts, the box stays pinned to the bottom of the screen as before, it is fully opaque, and moving through the conversation with the keyboard stops above it instead of behind it.

## Clearer workout and nutrition screens

The workout room shows dates as "Wed, Sep 30" instead of `2026-09-30`, including the target card's source date, the Repeat-last explanation, and chart tooltips, and the target card is labeled "Today's target". The note that appeared between the check-in and the calendar reminder after a workout had no styling; its message now sits in the progression card.

When Nutrition has no saved food preferences, meal ideas offer "Add food preferences", which opens Personal setup, instead of a Refresh button that could not load anything. Member-facing messages use the Personal setup name, and the homepage Strata+ offer is shorter while keeping the price, the no-card seven-day trial, and the renewal terms.

## Strata AI

A proposed week with a missing or blank set count now uses STRATA's default of three sets; a missing count previously became a single set. When STRATA falls back from the schema request to plain JSON or a plain request, or reports a failed provider status, it cancels the response it discards so the connection is released promptly.

On the Strata AI page, choosing Try again on an earlier error while a new question was still being sent removed the error without asking again, so that question was lost. Try again now waits until the page is free, and its button is disabled while a request is being sent or answered, like the quick replies.

## Code and repository cleanup

- Remove the administrator email-code module that Build 7.8.4 replaced with the owner's live account session, and the `ADMIN_EMAIL_MFA_REQUIRED` setting that `.env.example` still described. The server never read that setting.
- Remove a no-op option from the email-verification countdown.
- Delete stylesheet rules for 25 classes that no page or script renders any more. A computed-style snapshot of every element on 42 page and viewport combinations is identical before and after.
- Add the missing 8.8.3 and 8.8.4 changelog entries, refresh the module-size notes in the architecture guide, and regenerate `SHA256SUMS`, which had not been updated since 8.8.2.
- Move `brace-expansion` to 5.0.12 in the lockfile to clear an advisory in ESLint's dependency tree; `npm audit` reports no vulnerabilities.
- Let every browser journey honor `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, and start the activation journey inside `try`/`finally` so a failed browser launch no longer leaves its server running.

## Compatibility

This release has no database migration, API change, or new environment variable. `ADMIN_EMAIL_MFA_REQUIRED` can be removed from existing environments; it has had no effect since Build 7.8.4.

Validation covered the full Node test suite, architecture checks, strict JavaScript type checking, lint, coverage, runtime QA, performance checks, and the Chromium browser journeys, plus an axe accessibility sweep of 31 page states at 1440 and 390 pixels with no violations, and before-and-after screenshots of every changed page. The standard GitHub release gate also runs the accessibility matrix in Firefox and WebKit.
