# Questions a VC will ask

Have a short, honest answer ready for each. A weak number stated plainly lands better than a dodged question. Fill in
the numbers from Admin → Metrics the week of the meeting.

**How many people use it every week, and do they come back?**
Weekly active members for the last 12 weeks, and week-4 and week-8 retention by sign-up week, from the
[metrics sheet](metrics.md). Say what "active" means (saved or logged something, not just signed in). If the numbers
are small, show the trend and what changed it.

**Why STRATA over Hevy, Strong, or Fitbod?**
One sentence: STRATA ranks every exercise with its reasons and sources, builds your week from those rankings and your
equipment, and shows last time's numbers while you lift. Then show How FitScore works on the home page and its sources.

**Can someone copy the rankings?**
The list can be copied; the method and the data behind it are harder to copy: the scoring method and its sources, and
members' ratings and logged sets that can improve the rankings over time. Be honest that the second part grows with
usage.

**Does $2.99 cover your costs as you grow?**
The [pricing table](metrics.md#pricing-maths): Paddle keeps 22% of a $2.99 payment. Running costs are low: one
Render server, a Turso database, and Strata AI cost per active Strata+ member from Admin → Metrics. Then your plan
to test a yearly plan or a higher price, with the trade-off: $4.99 a month keeps $1.90 more per member each month,
while a $29.99 yearly plan keeps about the same per month as today ($2.33 against $2.34) and gains in churn
([roadmap](roadmap.md#open-decisions-for-the-owner)).

**You're a full-time student working alone. What if you're busy or unavailable?**
The [runbook](runbook.md) (roll back, rotate keys, restore the database), the deployment guide, more than 1,350 automated
tests that gate every change, and a trusted person with emergency access to every account. Then your plan for a
co-founder or contractor.

**How much of the code did AI write, and can you maintain it?**
Be open about it. Show that you can explain each part ([technical one-pager](technical.md)), and the review process:
every change passes the same automated gate, architecture policies limit what each module may touch, and the 9.4–9.6
releases came from audits of the code.

**Why nutrition, AI, and Polar if the core is rankings?**
Show usage for each from the opt-in activity counts and Strata AI usage on Admin. Keep what members use as Strata+
extras and cut what they don't, as Build 9 already did ([what was cut](roadmap.md#what-build-9-cut-and-why)).

**What would you spend the money on?**
Your answer: a specific list with amounts, for example user-acquisition tests, the Android app, a second developer.
