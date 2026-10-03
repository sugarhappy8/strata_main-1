# Stranger test — Build 9.0.0

A first-time walk through STRATA, done twice: as a brand-new free user, then as the same
person after Strata+ access was granted. Each screen was opened in Chromium at phone width
(390 × 844) and desktop width (1280 × 860) on a fresh local server with an empty database.
Polar, Paddle checkout, and Strata AI were not configured, as on a new deployment before keys
are added.

The script lives outside the repository; it follows this route:

1. **Visitor:** home, Rankings, My Week, Recovery, Train, Profile.
2. **New free account:** home, My Week, Profile, Recovery, Train.
3. **Same account with Strata+:** onboarding, My Week, Recovery, Rankings, Progress, Train,
   Strata AI, Profile, pricing.

No page threw a script error. The console showed only the expected signed-out identity checks
(401 on `/api/me` and `/api/plan`) and Paddle's checkout script, which the build environment
blocks. (Since 9.7, a visitor's `/api/me` answers `200 { user: null }` and pages no longer request
`/api/plan` for a visitor, so those 401s are gone; see "Browser to server" in `architecture.md`.)

## What a stranger would trip over, and what changed

| Where | Finding | Fix |
|---|---|---|
| Phone homepage, signed in | The "Sam profile" pill ran past the right edge of the header. | Hidden on phones; Profile in the bottom bar is the way to the account. |
| Pricing | "Cancel anytime · From Account" while the navigation says Profile. | "From Profile". |
| Train, onboarding, Profile billing | "Your free Plan" for a screen that is now called My Week. | "Your free week in My Week". Train's lapsed-access button reads "Open your free week". |
| Onboarding footer | A member was offered "Return to free Plan". | "Back to My Week", which opens their Overview. |
| My Week (Strata+, no week yet) | "You have not built a weekly plan yet." appeared twice, in the hero and the card under it. | The hero now says what the week is for: "Choose your days and equipment once, and your next session is always ready." |
| Train, no workouts yet | Both empty panels said "Your progress appears after your first completed workout." | The sessions panel says "Finished sessions appear here, set by set." |
| Train status line | Linked to "Account". | "Profile". |
| Recovery without Polar keys | "Recovery is coming soon" (fixed in the first Phase 6 slice). | "Polar connections are paused", with a line saying the rest of Strata+ works as usual. |

## Seen and kept

- **The studio's view switcher** (Overview, Recovery, Progress, Rankings) sits under the site
  navigation, so two section names appear twice on that page. It switches views in place and
  carries short descriptions. Merging it into the site navigation is parked as proposal 9 in
  `PROPOSALS.md`.
- **/ai without a provider key** says "Strata AI is unavailable right now" and that the plan and
  nutrition tools work as usual. That is the right message until the Groq key is set.
- **Faded lower sections in full-page captures** are the scroll-in animation. They appear as
  soon as a person scrolls, and they never animate when reduced motion is requested.
