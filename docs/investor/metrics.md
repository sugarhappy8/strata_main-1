# Metrics sheet

Admin → **Metrics** shows the numbers an investor asks for first, and **Download CSV** saves them as one file
(`strata-metrics-YYYY-MM-DD.csv`) with one table per figure. The server computes every figure from records STRATA
already keeps for running the product; the page shows only weekly and monthly totals, never a list of people or any
plan, workout, diary, or Polar content.

Bring the CSV and a screenshot of the Metrics tab, both from the week of the meeting. If a number is small, show the
trend and say what you learned from it.

## Who is counted

Customer accounts only. Left out:

- the owner (`ADMIN_EMAIL`);
- App Store review accounts (`APPLE_SANDBOX_ACCOUNTS`);
- the demo account and any test accounts, listed in `STRATA_INTERNAL_ACCOUNTS`.

The page says how many internal accounts it left out. Add every test account to `STRATA_INTERNAL_ACCOUNTS` before
an investor sees the numbers.

## Definitions

| Figure | How it is counted |
|---|---|
| **Active member** (weekly) | A customer account that saved or logged something that week: started a workout, saved a weekly plan, logged nutrition (counted on the day the entry is for and the day it was last changed), submitted a workout check-in, or sent Strata AI a message. Signing in alone does not count, and neither does a Daily Brief, which STRATA writes on its own. Weeks start on Monday (UTC); the last 12 are shown, the current one marked "so far". |
| **Sign-ups** (weekly) | Accounts created that week, split into email and Google (an account created with Sign in with Google). |
| **Activation** | Of the accounts created since 9.8.0 whose first seven days are over, the share that saved a **full week** within seven days of signing up. A full week has as many days with exercises as the training days the member chose (four if they never chose). 9.8.0 starts recording this; earlier accounts are not counted either way. |
| **Week 4 / week 8 retention** | Of the accounts whose week 4 (days 28–34 after signing up) or week 8 (days 56–62) is over, the share active in it, grouped by sign-up week. |
| **Free-to-paid conversion** | Accounts that ever started a paid subscription (Paddle, or the App Store outside Sandbox), out of all customer accounts. |
| **Paying members** | Accounts with a Paddle subscription that is active or past due, or an App Store subscription that has not expired or is in its billing grace period. Lifetime purchases from before the subscription and owner grants are shown separately and are not paying members. |
| **MRR** | Each paying subscription at its list price per month: $4.99 for monthly, $29.99 ÷ 12 ($2.50) for yearly. Also shown after Paddle's 5% + $0.50 per charge or Apple's 15%. Before VAT and sales tax; App Store prices outside the US differ. A subscription started before 9.8.0 is counted at today's monthly price. |
| **Monthly churn** | Subscriptions paying when a month began that ended during it, divided by those paying when it began. A paused or canceled Paddle subscription ends at its last change; an App Store one ends when it expires or is revoked. |
| **Strata AI cost per active Strata+ member** | Tokens used by customer accounts that month × `STRATA_AI_USD_PER_MILLION_TOKENS`, divided by members who used a Strata+ feature that month (a workout, nutrition log, check-in, or Strata AI message). Set the rate from the Groq bill: the month's bill divided by that month's tokens in millions. AI usage is kept 90 days, so a month is shown only while every day of it is kept: three months for most of a month, two near its end. |

## What the numbers cannot say

- **Where people came from.** STRATA does not record a referrer, campaign, or source for a sign-up; the email/Google
  split is the only "where" it has. Adding one would mean storing a new fact about each account and updating the
  privacy policy, which is a decision for the owner, not a 9.8.0 fix. Until then, use tagged links and ask people.
- **Activation before 9.8.0.** Weekly plans are stored only as the current week, so a full week saved before 9.8.0
  cannot be reconstructed.
- **Plan saves before 9.8.1.** Plan history kept only a member's latest 50 saves, so someone who edited a lot may show
  fewer earlier active days. Since 9.8.1 it also keeps the latest save of each day for 120 days.
- **Revenue in other currencies, or at an earlier price.** STRATA stores no charged amounts, so MRR uses today's list
  prices. The Paddle and App Store dashboards are the record of what was charged.
- **Opt-in product counts** (the Overview's aggregate activity) are action counts, not people, and are not part of
  these figures.

## Pricing maths

Paddle's fee is 5% + $0.50 per charge, so the fixed $0.50 weighs most on small charges. Until 9.8.0 Strata+ was $2.99
a month, of which Paddle kept 22%. 9.8.0 sells $4.99 monthly and $29.99 yearly.

| Plan | Paddle fee | You keep via Paddle | You keep via Apple (15%) | Paddle fee share |
|---|---|---|---|---|
| $2.99 monthly (until 9.8.0) | $0.65 | $2.34 | $2.54 | 22% |
| $4.99 monthly | $0.75 | $4.24 | $4.24 | 15% |
| $29.99 yearly | $2.00 | $27.99 ($2.33 a month) | $25.49 ($2.12 a month) | 7% |

Figures are before VAT and sales tax. Apple's 15% needs enrolment in the App Store Small Business Program; the
standard rate is higher. Paddle's terms for products under $10 can be negotiated; confirm Strata's actual rate.

$4.99 monthly keeps $1.90 more per member each month than $2.99 did. The $29.99 yearly plan is half the monthly price
over a year and keeps about what $2.99 monthly did ($2.33 a month against $2.34); its gain is twelve months without a
chance to churn. Watch the share of new members who choose yearly (Admin → Metrics, Yearly subscriptions): a high
share lowers MRR per member but should lower churn.
