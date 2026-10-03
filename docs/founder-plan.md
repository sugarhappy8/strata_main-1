# STRATA — Founder plan

**Product decision:** build the most straightforward way for a recreational lifter to know the next workout and remember the last one. Keep Strata+ at **$2.99 USD per month**, and make repeated use the reason to subscribe.

> **Build 8.9.0 note:** the free seven-day trial described below has been retired. Strata+ is now offered only as the $2.99 USD monthly subscription; the trial sections remain as a record of the original plan.

> **Build 9.8.0 note:** Strata+ moved to $4.99 USD a month or $29.99 USD a year. The $2.99 figures below are the plan as written; `docs/investor/metrics.md` has the current pricing maths.

This plan is grounded in the supplied 7.5.1 source and the changes delivered in 7.6.0. It is a product hypothesis to validate with customers, not a forecast of demand or revenue.

## The customer and the promise

Start with people who already know basic exercise technique, train two to four times a week, and currently keep their routine in notes, a spreadsheet, or their head. Their recurring problem is practical: “What am I doing today, and what did I lift last time?”

**Positioning:** Your next workout, ready. Your last workout, remembered.

Training Memory is the strongest subscription benefit already in the product. It shows previous comparable sets beside the current log and allows values to be reused without marking work complete. The weekly plan brings someone in; their own accumulating training history gives them a reason to return. Exercise rankings support that experience.

Do not describe Strata as an AI coach, a medically personalized program, or a clinically validated scoring system. The current recommendation engine is deterministic, and FitScore is editorial. Those are useful tools when the explanation is clear.

## What is delivered in 7.6.0

| Improvement | Customer benefit |
| --- | --- |
| New trials last seven consecutive days | Enough time to train, return, and experience saved history. No card and no automatic subscription. |
| Three working starter-week buttons | Get an editable week from a familiar equipment setup. |
| Benefit-led homepage and pricing | Understand what $2.99 buys, including a clearly labeled Training Memory example. |
| A free-versus-Plus comparison | See the boundary before signup and understand that the manual weekly plan remains free. |
| Actual completed-day progress in Today | A fully planned week no longer appears as completed training. |
| A next-session link after workout completion | Return to the plan and reinforce the value of keeping a log. |
| Visible checkout errors | Payment problems remain visible for members without Strata+. |
| Readable days/hours on the account trial | A week-long trial does not appear as thousands of minutes. |

The build extends the existing app. Accounts, Paddle billing verification, synced plans, PWA behavior, community plans, Training Memory and the rest of the product remain part of the codebase. Valid older trials retain their recorded expiry and cannot be restarted. No production accounts or payment settings were changed.

Equipment categories still need review by the user: bodyweight movements can require a bar or bench, and the Barbell / Smith category includes Smith and attachment-based movements. Experience influences recommendations; it is not a strict exercise-difficulty exclusion. The starter buttons avoid claiming otherwise.

## Why someone would keep paying

Make the useful sequence obvious:

1. Preview a week before signing up.
2. Save a plan and explicitly begin the no-card trial when ready to train.
3. Log one real workout.
4. Return for another workout and find previous comparable values ready to use.
5. Decide whether that convenience is worth $2.99 each month.

The seven-day trial creates room for that sequence. It does not guarantee it: different exercises on different days may mean that a comparable movement does not repeat during the trial. Ask testers whether they actually encountered Training Memory before deciding whether to subscribe. If they consistently do not, revisit the trial length using evidence.

Keep the offer simple: useful rankings and a manual weekly plan for free; guided logging, Training Memory, history, personalization, and extended planning in Plus. Show the cancellation route and the final checkout total clearly. Keep existing customers' access and stored data boundaries honest.

## First 30 days after production checks

These are proposed founder actions, not outreach already sent or automations already scheduled.

| Period | Action | Evidence to collect |
| --- | --- | --- |
| Days 1–7 | Recruit 20 willing testers who already train regularly. Watch five people start without explaining the interface. | Where they hesitate; whether they can preview, save, and start a workout; signup/email delivery problems. |
| Days 8–14 | Have testers use Strata during normal training. Ask what they expected to see on their second visit. | Second completed workout; whether previous sets were useful; friction while logging between sets. |
| Days 15–21 | Offer the actual $2.99 subscription and ask one neutral question of those who decline: “What made you decide not to continue?” | Real payments versus polite praise; trial timing; cancellation reasons. |
| Days 22–30 | Fix the most repeated problem. Show the actual workflow through three short demonstrations and one detailed use case in communities that allow it. | Qualified people trying the app, returning to train, and choosing to pay. |

Use a small, consented pilot roster for research and keep it separate from anonymous product signals. Obtain feedback without asking testers to expose sensitive training or health details publicly.

**Initial learning targets for a 20-person pilot:** 12 complete a second workout within seven days of their first, eight complete a workout during days 8–14, and five choose a paid subscription. These are internal decision targets, not industry benchmarks or statistically reliable validation. Report the counts and the sample size. Five payments are a useful early signal; first renewal still needs observation after a full billing cycle.

If people do not finish a first workout, fix activation. If they finish once but do not return, fix daily usefulness. If they return but do not subscribe, investigate the paid boundary and their stated reasons before adding more features.

## Measure the right things

| Question | Appropriate evidence |
| --- | --- |
| Are people reaching the product's value? | A consented pilot record of a first and second completed workout, on different days. |
| Do they return? | Among pilot members with enough elapsed time, count those completing a workout in days 8–14 after their first. |
| Will they pay? | Confirmed subscription and transaction state in the billing system. |
| Do they keep paying? | Successful renewals, cancellations, refunds, and failed payments after the relevant billing window. |
| Which actions get used? | Existing opt-in aggregate product signals, labeled as repeated action counts. |

The existing product-signals feature does **not** measure unique people or customer cohorts. Dividing its trial, workout, or checkout counts does not yield a reliable conversion rate. Browser `upgrade_activated` events are not a revenue ledger. Do not present them as paying-customer counts or MRR.

## Make $2.99 sustainable

Paddle currently advertises a headline transaction fee of 5% plus $0.50 and directs sellers with products under $10 to request custom pricing. Confirm the actual terms for Strata before live launch. [Paddle pricing](https://www.paddle.com/pricing), checked 9 September 2026.

For illustration only, applying that headline fee to a $2.99 charge leaves **$2.3405**: $2.99 − ($2.99 × 5% + $0.50). That is before hosting, email, support, refunds, and any tax or currency treatment. It is not a confirmed payout or profit estimate. At 1,000 monthly charges, the same simplified scenario is $2,990 charged and $2,340.50 after the illustrated processing fee.

Retain the $2.99 monthly offer, confirm low-price processing terms, and keep service costs low. The present deterministic engine avoids an inference bill for every recommendation. Founder-led support is useful for learning, but track the time it takes; it must become manageable through a reliable product and clear self-service help.

## What to prove before inviting paying customers

Use the existing Node/Turso/Resend/Paddle deployment path. Verify signup email delivery, sign-in on a second device, trial start and expiry, paid checkout, signed webhook processing, entitlement, renewal, cancellation, and the customer portal in the intended provider environments. Confirm the real $2.99 USD monthly catalog item and the actual operator details. Complete browser and mobile checks on the deployed configuration.

This delivery is a tested source release. Production deployment, live email delivery, actual merchant fees, live purchases, and customer willingness to pay were not verified in this session. Source tests with provider fixtures cannot establish those outcomes.

The founder's next job is to watch real people train with it, then use the evidence to make their second and third visits easier.
