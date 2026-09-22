# Personal training and calorie counting methodology

The current implementation uses `energy-planning-v5`, `coaching-training-v2`, and `coaching-week-v6`. This document describes the calculations in the shipped code. Published equations and general exercise recommendations are distinguished from STRATA's unvalidated engineering rules. The outputs are planning estimates, not measured metabolism, clinical prescriptions, verified food analyses, or guaranteed outcomes.

## Energy equations and units

Reviewed profile version 4 starts with the Mifflin–St Jeor resting-energy equation: `10 × kg + 6.25 × cm − 5 × age + 5` for the male coefficient or `−161` for the female coefficient. Output is kcal/day. The equation follows [Mifflin and colleagues' original study](https://pubmed.ncbi.nlm.nih.gov/2305711/). The coefficient is requested for the equation and is described separately from gender identity. Supported reviewed profiles are ages 19–80. Metric storage uses kilograms and centimetres even when the form displays imperial units.

Version 4 then separates three activity sources that the form asks about separately:

| Source | Calculation | What it means |
|---|---|---|
| Normal day outside separately entered exercise | `Mifflin RMR × PAL anchor` | Mostly seated `1.35`; lightly moving `1.50`; on feet much of the day `1.60`; physically demanding day `1.75` |
| Generated STRATA resistance session | `max(0, gross MET energy − resting energy during the session)` | Uses the generated session's bounded duration; an unavailable session contributes zero |
| Other weekly activity not in the STRATA plan | The same net-MET calculation, divided across seven days | Member-entered minutes with representative light `3.0`, moderate `4.5`, or vigorous `7.0` MET |

The PAL anchors and representative intensity values are transparent STRATA engineering choices, not measured individual PAL or activity energy. The 2023 Dietary Reference Intakes describe activity levels and caution that individual requirements vary; they do not prescribe these four exact non-workout anchors. See the [National Academies adult energy chapter](https://www.ncbi.nlm.nih.gov/books/NBK591020/?report=printable) and [Health Canada's official EER table](https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/equations-estimate-energy-requirement.html).

For an activity lasting `m` minutes, gross energy is estimated as `MET × reference oxygen × kg / 200 × m`. Standard MET values, including the generic light/moderate/vigorous additional-activity categories at every age, use `3.5 mL/kg/min`. Only values taken from the older-adult MET60+ table use `2.7 mL/kg/min`, consistent with the reference conventions in the [2024 Adult Compendium](https://pubmed.ncbi.nlm.nih.gov/38242596/) and [2024 Older Adult Compendium](https://pubmed.ncbi.nlm.nih.gov/38242593/). General resistance training uses `3.5 MET` for adults and `4.3 MET60+` for older adults. The oxygen reference is paired with its table value rather than switched by age alone: turning 60 must not reduce identical generic activity by changing units. Generated-session energy uses the unrounded duration in seconds; minutes are rounded only for display. Older snapshots without seconds retain a minutes fallback, and intermediate energy is not rounded before weekly aggregation. STRATA subtracts `Mifflin RMR / 1440 × m` because that resting time is already in the non-workout base. MET values are standardized estimates, not wearable measurements, and can be inaccurate for a particular exercise, pace, body composition, or person.

The version-4 starting maintenance estimate is therefore:

```text
Mifflin RMR × non-workout PAL
+ net generated-session kcal per week / 7
+ net separately entered activity kcal per week / 7
```

The generated program's actual estimated session durations are used; workout frequency, equipment, movement limitations, experience, and familiar movements affect the generated sessions before their activity contribution is calculated. Entered kilograms lifted are capability context and are not treated as measured calorie expenditure. The form tells the member to include normal work, chores, errands, and usual commuting in the movement answer, then to exclude every STRATA session and any sport, cardio, or active-travel minutes entered separately. This explicit partition reduces double counting, but incorrect self-classification can still over- or underestimate maintenance.

The 2023 adult EER equations remain a visible population cross-check. Each published equation has the form `constant + ageCoefficient × age + heightCoefficient × heightCm + weightCoefficient × weightKg`; STRATA selects a comparison branch from the version-4 estimate's implied total PAL. The eight male/female and inactive/low-active/active/very-active equations and PAL ranges are documented in the official sources above. For example, the inactive male branch is `753.07 − 10.83 × age + 6.50 × heightCm + 14.10 × weightKg`; at age 30, 175 cm and 75 kg it gives 2623.17 kcal/day. The cross-check does not replace or clamp the version-4 result.

Optional body fat supplies fat-free mass `kg × (1 − bodyFatPercent/100)` and the secondary `370 + 21.6 × fat-free kg` equation from [Cunningham's 1991 synthesis](https://pubmed.ncbi.nlm.nih.gov/1957828/). It is correctly named Cunningham 1991 and is distinct from the `500 + 22 × lean kg` equation in the [1980 paper](https://pubmed.ncbi.nlm.nih.gov/7435418/). Body fat never raises the version-4 maintenance midpoint or replaces Mifflin. Because consumer body-fat estimates can be noisy, it is used for a visible resting-energy cross-check, a possible deficit restriction, and—only when the two resting estimates differ by more than the otherwise applicable planning half-band—a wider visible planning range.

The version-4 planning half-band is the nearest 25 kcal to the largest of 250 kcal, 15% of the rounded baseline, the absolute Cunningham-versus-Mifflin resting-energy difference when available, and the EER reference prediction error: 342 kcal for men or 241 kcal for women. Those reference errors come from [NASEM Table 5-8](https://www.ncbi.nlm.nih.gov/books/NBK591021/table/tab_5_8/?report=objectonly) at average covariates and active PAL. They are population-reference errors, not personalized standard errors. STRATA's final band is neither a confidence interval nor a claimed probability of containing actual expenditure. Calibration does not make it shrink with repeated use.

## Profile compatibility and recent weight

Stored profile versions 1–2 keep their original energy semantics: the saved Mifflin or Cunningham resting result multiplied by the original activity factor (1.2, 1.375, 1.55, 1.725, or 1.9). Version 3 keeps its 2023 whole-day EER semantics and never adds generated-workout calories to an activity answer that already includes the whole day. Legacy versions 1–2 receive zero trend adjustment and do not adopt a new weight anchor. Previously saved age-18 or coefficient-free/body-fat profiles remain readable on that path. Their broader planning half-bands remain `max(300, 15% of baseline)` for Mifflin and `max(350, 17.5%)` for Cunningham, rounded to 25 kcal.

Only an explicit review/save converts an older profile to version 4. The member must answer the new non-workout-movement and separate additional-activity questions; deployment, reading, and week rollover never guess those values or reinterpret an older activity answer.

For profile versions 3 and 4, a newly generated week can use the median of recent morning weights rather than an outdated profile weight. The heuristic requires at least three usable observations within the preceding seven dates, spanning at least two days, with the latest no more than three days old. It rejects excessive outliers, a spread above the greater of 1.5 kg or 2% of the median, and disagreement above 10% with the saved profile weight. Sparse or stale data retain the profile weight; inconsistent data or a large disagreement trigger review. The snapshot records the source, date, observation counts, and quality reason. The profile itself is not rewritten.

A changed anchor is rounded to 0.1 kg and is used consistently for the applicable primary energy equation and activity budget, the EER cross-check, BMI, protein requests, and the starting weight of scenarios. When that anchor remains within 2% of the saved weight, an optional saved body-fat estimate can remain a noisy Cunningham cross-check and conservative composition screen; this prevents ordinary scale drift from removing a restriction. Beyond 2%, the old body-fat percentage is withheld and version 4 requires profile review before generating a deficit. Credible low-weight observations can block a deficit even when disagreement is too large to adopt the new weight. The 2% compatibility threshold and these checks are product rules, not diagnosis or medical screening.

## Aligned intake and weight calibration

The engine examines the 42 calendar dates before the new coaching Monday. Current-week and future dates are excluded. An intake is eligible only when its calories are a valid whole number and the member explicitly marks the day complete. Missing days, incomplete days, and unknown completeness are never filled with zero or assumed typical. Identical duplicate rows have no additional weight; conflicting duplicates exclude that date deterministically.

Intake is aligned between actual morning measurements. If weights exist on mornings A and B, the interval includes food from A through the day before B: `[A, B)`. Food entered on B happened after its morning measurement and cannot explain the preceding weight change. The engine selects the longest recent complete intake interval with at least 14 consecutive days, at least eight usable weights, and at least 14 days between endpoint weights; latest endpoint breaks a tie. The last usable weight must be within seven days of the new week. At most 41 days can be spanned by morning endpoints when all observations lie inside the 42-date window.

For each retained morning `i`, let `C_i` be cumulative complete intake before that morning, `W_i` its weight in kg, and `t_i` elapsed days. For pairs separated by at least seven days:

```text
M_ij = (C_j − C_i − 7700 × (W_j − W_i)) / (t_j − t_i)
M = median(M_ij)
```

`M` is an intake-and-weight estimate in kcal/day. Pair differences account for genuinely changing intake without mixing food and weight from different intervals. They assume a constant average expenditure and a fixed tissue-energy proxy. The 7700 kcal/kg conversion is not a universal physiological constant; [Hall's analysis of weight-loss energy density](https://pubmed.ncbi.nlm.nih.gov/17848938/) explains why body composition changes that relationship.

A robust intercept is fitted to `7700 × W_i − C_i + M × t_i`. Absolute residuals are converted back to kg. Points beyond the greater of 1.5 kg or four times the median absolute residual are removed once and the fit is recomputed; more than 20% removal withholds adjustment. The remaining interval must still meet the observation and span gates. Diagnostics report retained endpoints, aligned intake days, excluded points, and pair counts.

The following additional gates withhold a new evidence adjustment:

| Check | Heuristic rejection boundary |
|---|---|
| Largest gap between retained weights | More than 7 days |
| Median absolute residual weight | More than 0.5 kg |
| Median absolute spread of pair expenditure estimates | More than 400 kcal/day |
| Early/late segment coverage | Either half lacks a pair of weights at least 7 days apart |
| Early/late segment inconsistency | More than 300 kcal/day |
| Replayed evidence | Usable endpoint is no newer than the last accepted endpoint |
| Absolute weekly weight trend | More than 1.5% of representative weight |
| Inferred expenditure | Outside 1000–6000 kcal/day |
| Difference from equation baseline | More than 50% of baseline |

An unavailable segment comparison is reported as unavailable, never as zero disagreement. The minimum counts and total observation span alone do not guarantee acceptance; both halves need temporal coverage. Segment inconsistency is the larger of the difference between early and late estimates and the difference between their mean and the complete-interval estimate. These checks can identify some noise or apparent fluid steps; they do not reliably distinguish tissue, water, illness, or recording errors.

For an accepted interval of `d` days, `n` weights, pair spread `s`, and equation baseline `B`:

```text
spanWeight = 0.25 + 0.50 × clamp((d − 14) / 28, 0, 1)
coverage = min(1, n / ceil((d + 1) / 2))
q = spanWeight × coverage / (1 + (s / 250)²)
candidate = B + q × (M − B)
```

`q` is an engineering quality weight, not statistical confidence or the probability that a target is correct. Each new week recomputes the candidate from the equation and raw observations. Overlapping windows never add the previous estimate as another observation or compound certainty.

The target is rounded to 25 kcal and moves by at most 150 kcal/day from the previous compatible model snapshot, or from the equation starting point when no suitable prior exists. It normally stays within ±25% of the current baseline. A changing baseline can make that bound incompatible with the weekly rate limit. In that case the weekly limit takes priority, the target moves toward the new bound, and `boundReconciliation` explicitly records the temporary exception and its stored reference baseline. A small baseline change therefore cannot discard a legitimate prior target: a saved 3275 target based on 2625 becomes 3250 when the new baseline is 2600, rather than abruptly resetting to 2600.

The service requires the previous snapshot's account, profile revision, canonical profile, date, and stored identity to agree. Calibration additionally checks the energy model, saved baseline, target consistency, and evidence cutoff. During the transition to `energy-planning-v5`, profile versions 3 and 4 may retain correctly paired `energy-planning-v4` priors. Version 3 may also retain an `energy-planning-v3` prior; version 4 never accepts that older provenance, and an explicit profile upgrade changes the revision and canonical profile anyway. A snapshot is a rate limiter, never evidence. Without a fresh usable interval, an accepted prior target can be held temporarily for up to 42 days after its original last accepted weight; changing baseline bounds may still require the gradual reconciliation above. The accepted date is not refreshed by a hold. Once evidence expires, a recent compatible snapshot moves toward the equation baseline within the weekly step; a snapshot more than 42 days old is no longer a rate limiter.

The result retains “Starting estimate,” “Calibrating,” “Trend-informed,” or “Legacy profile” and an explicit explanation. Held and expired states are separate metadata; a held target is not mislabeled as newly accepted evidence. The reported sensitivity interval refits using 5500 and 9500 kcal/kg and adds the largest of 150 kcal, 10% of average recorded intake, or the pair spread. It is an assumption-sensitivity display, not a confidence interval or total error bound, and it is separate from the general planning band.

Every threshold, lookback, robust-fitting choice, shrinkage weight, density, sensitivity margin, and update limit in this section is an unvalidated STRATA engineering heuristic. [Sanghvi and colleagues](https://pmc.ncbi.nlm.nih.gov/articles/PMC4515869/) validated a different dynamic model for changes in intake in 140 people over two years; individual error remained substantial. Their study does not validate STRATA's short-interval estimate of absolute maintenance. Systematic food under-reporting cannot be identified from complete-looking food logs and body weight alone.

The primary maintenance display uses the accepted `targetKcal` as one daily value: “Maintenance is … kcal/day.” The planning band and its limitations remain secondary details. Point formatting does not mean measured expenditure or 99% physiological accuracy.

## Goal targets, daily budgets, and macros

Deficit and surplus options are calculated from the selected maintenance target. For profile version 4, gentle and moderate fat-loss pace mean nominal changes of 0.25% and 0.50% of planning weight per week. The provisional daily deficit is `weightKg × requestedRate × 7700 / 7`; both that result and the separate 20%-of-maintenance cap are rounded down to the next 25 kcal so rounding cannot make the actual deficit exceed either cap. The selected deficit cannot exceed either cap or 500 kcal/day, and the output reports the actual implied percentage after every cap and floor. The 7700-kcal/kg value is a short-horizon bookkeeping proxy rather than a physiological constant or a weight forecast; [Hall's analysis](https://pubmed.ncbi.nlm.nih.gov/17848938/) explains why energy density changes with body composition and over time. The selected pace tiers and caps are conservative STRATA engineering policies, not individualized clinical recommendations or evidence that a member will lose that percentage.

When body-fat percentage is supplied, version 4 also calculates a review floor of `30 kcal × fat-free kg + average structured-exercise kcal/day`, rounded up to the next 25 kcal so rounding cannot weaken the screen. This rearranges the energy-availability expression but does not measure energy availability or diagnose low energy availability. The 30-kcal/kg threshold is a cautious product screen informed by the [IOC REDs consensus](https://doi.org/10.1136/bjsports-2023-106994); the consensus describes important context and uncertainty rather than validating this exact STRATA rule for every adult. The screen may only reduce the deficit or block it—it never raises maintenance. Separately, a large Cunningham–Mifflin resting-estimate disagreement widens the planning band used by the lower sensitivity-scenario guard and is labeled in the output; it does not move the maintenance midpoint. Without body-fat input, the app cannot run either composition check and retains the separate 1,200-kcal review floor.

Profile version 3 retains its existing gentle/moderate 10%/15% deficit behavior for snapshot compatibility. Gentle/moderate surplus rates remain 5%/7.5%, rounded to 25 kcal and bounded to 100–250 kcal. These values are all application policies.

A deficit requires review when the recent-weight anchor is inconsistent or requires review, credible recent weight or planning BMI is below 18.5, maintenance cannot support the calorie floor, or any 4-, 8-, or 12-week lower scenario crosses the BMI boundary. Both the raw and displayed lower scenario are checked so rounding cannot hide a crossing. The engine does not silently replace an unsafe requested deficit with another goal. A member can review the profile and select maintenance. No generated day is below 1200 kcal; this floor and BMI rule do not establish that a target is suitable for a particular person.

Steady, training-day zigzag, and flexible-day patterns preserve the exact seven-day energy budget. In version 4, zigzag shifts each day's target using that generated session's net activity estimate; it does not assume every selected workout day costs the same. Version 3 retains its relative weights of 1.075 on workout days and 0.925 otherwise. A flexible day uses 1.15 and the other days 0.975. The weights are normalized before allocation, then integer remainders are distributed deterministically. If any varied day falls below the floor, the whole week uses a labeled steady fallback. For version-4 fat loss, this also preserves any higher composition review floor already used to calculate the deficit; redistribution cannot undo that restriction. This is the same average-exercise product screen, not a new daily energy-availability measurement.

Optional macros request 2.0 g/kg protein for higher protein, otherwise 1.8 g/kg during fat loss or 1.6 g/kg. Protein is limited to 30% of calories; fat is near 25%, and carbohydrate receives the remainder. The nominal protein request is consistent with the general context in the [ISSN protein position stand](https://pubmed.ncbi.nlm.nih.gov/28642676/); STRATA's exact cap and allocation are product choices. The output records requested and actual protein, and explains when the cap lowers it. Integer gram targets satisfy `4 × protein + 4 × carbohydrate + 9 × fat = daily calories` exactly. This is bookkeeping under the 4/4/9 convention, not precise absorbed energy or a rule that food labels must reconcile exactly.

## Weight sensitivity scenarios

Profile versions 3 and 4 show 4-, 8-, and 12-week scenarios under fixed intake and activity. Let `x` be change from starting weight, `I` the selected daily intake, `M0` initial maintenance, `k` expenditure response in kcal/kg/day, and `rho` tissue-energy density in kcal/kg:

```text
dx/dt = (I − M0 − k × x) / rho
x(t) = (I − M0) / k × (1 − exp(−k × t / rho))
```

The central illustration uses `k = 22` and `rho = 7700`. The envelope includes the combinations of both maintenance planning-band endpoints, `k = 15 or 30`, and `rho = 5500 or 9500`, plus the central result. It may include both gain and loss when uncertainty in maintenance exceeds the intended calorie difference. Display rounds to 0.1 kg; unrounded endpoints remain available to the deficit guard.

The response form is informed by the energy-balance reasoning in [Hall and colleagues' dynamic-model research](https://pmc.ncbi.nlm.nih.gov/articles/PMC3880593/). STRATA does not implement the full NIDDK model, infer individual adaptation, or assign probabilities to these parameters. Its selected values and endpoint envelope are sensitivity assumptions, not fitted physiological parameters or a prediction interval. Water, glycogen, digestion, adherence, changing activity, medications, and health changes remain unmodeled. Legacy profiles retain the earlier labeled scenario calculation for compatibility.

## Weekly training prescriptions

The training goal—balanced, strength, or hypertrophy—is separate from the nutrition goal. Missing older values default to balanced. Days, equipment, actual experience, movement exclusions, and recorded capabilities constrain the exercise catalog. Empty equipment selection means no equipment filter. When the catalog cannot cover a required movement, the session is explicitly partial or unavailable, with missing roles and a review warning. Compatible exercises remain available and nutrition/diary access is preserved. Missing required movements remain explicitly disclosed. An unavailable session has zero working sets and zero estimated training minutes. The generator does not lower restrictions or ask members to overstate experience or claim equipment they do not have.

The deterministic split is full body for one to three days, upper/lower repeated for four, push/pull/lower/upper/lower for five, and push/pull/lower repeated for six. Compatible main exercises from the preceding week are strongly favored, with entered familiar exercises and recent training also considered. Accessories can vary across four-week calendar windows. Variation is not treated as necessary for progress.

Starting prescriptions preserve the catalog's rep, seconds, distance, steps, contacts, and per-side units. Repetition ranges intersect the catalog range with the goal preference where possible: strength compounds 4–8, hypertrophy 8–15, balanced compounds 6–12, and other balanced work 10–15. Beginners start with up to two sets, other profiles generally three; non-compound strength work uses two. Entered capability set/repetition values may lower these starting bounds. Entered weight remains a reference: it is never multiplied by an arbitrary fraction or presented as a verified one-repetition maximum. Time or distance targets are not inferred from a repetitions-only capability form.

Initial guidance suggests approximately two to three repetitions in reserve for repetition exercises. Compound rest is 180 seconds for strength or 120 otherwise; other exercises use 75 seconds, or 90 for distance. Estimated duration includes five warm-up minutes, set time, rest between sets, and one setup minute per exercise. Rep work assumes four seconds per repetition with a 20-second minimum; per-side work is doubled; distance work has a coarse 60-second estimate. The duration calculation is a planning heuristic, not a measured time. The fitter removes later accessories and reduces sets before rejecting a prescription that still cannot fit the selected duration.

Summaries show direct working sets, direct group/muscle frequency, groups with fewer than two direct training days, and consecutive chosen days. Compound overlap is not counted again as direct sets for each secondary muscle. Missing direct work can still receive indirect work; the displayed count is not an estimate of an optimal dose. Consecutive days produce a recovery-spacing note, not a claim that the app measures recovery.

General programming follows the context of [ACSM's current resistance-training position stand](https://journals.lww.com/acsm-msse/fulltext/2026/04000/american_college_of_sports_medicine_position.21.aspx) and [US adult physical activity guidance](https://odphp.health.gov/our-work/nutrition-physical-activity/physical-activity-guidelines/current-guidelines). Those sources support progressive resistance training and attention to major muscle groups; they do not validate STRATA's role templates, selection scores, time model, or exact rep/rest rules. One-day starting plans remain possible with a visible frequency caveat.

### Recorded performance and next-workout targets

The service reads bounded, owner-scoped workout history and check-ins. The training leaf uses completed workouts from the 56 days before the week, checks completion timing in the saved time zone, and rejects current/future evidence. Available history may be incomplete; that state is carried into the output. A latest source over 28 days old requires a fresh baseline.

A recorded target must match the exercise, measurement, load type, unit, rep/time range, and set count of the new prescription. Ambiguous duplicate entries, unchecked drafts, invalid sets, changed prescriptions, unquantifiable assistance, and distance exercises do not become automatic load targets. The latest relevant exposure remains authoritative; the generator cannot skip an inconvenient incomplete or mismatched record to find an older success.

The shared progression engine compares complete sets from two distinct days with comparable loads and effort. It progresses repetitions or time before load. A load change requires both comparable workouts at the range ceiling, and uses 2.5 kg or 5 lb only when the step is no more than 10% of recorded load. Assistance moves in the opposite direction: less assistance is harder. Adverse comfort/energy/difficulty check-ins or high recorded effort suppress increases. A check-in is optional; its absence is not proof of good form or recovery. Limited history cannot authorize an increase. Targets preserve per-set values and are optional for the next comparable workout; they do not edit a saved Plan, mark sets complete, or change the calorie budget.

## Remaining-day food options

Meal options use the saved dietary pattern, supported allergens, gluten-free/dairy-free requirements, favorites, preferred one to six daily meals, and optional USD budget. Allergens and dietary rules filter before ranking. Unsupported or uncertain allergy information withholds automatic options; favorites and budget never reintroduce a filtered meal. The checklist follows the [FDA's nine major allergen categories](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies), which are not exhaustive. Current product labels and cross-contact conditions still require review.

The service subtracts saved intake from the selected day's target, estimates remaining meal count from the remaining calorie fraction, and divides it using fixed meal-share presets. It does not know which meals were eaten. When consumed macros are incomplete, matching uses calories only. Requesting a menu does not record it as eaten.

A bounded beam search compares whole menus rather than independently choosing favorite meals. Portions are rounded to 0.05 base servings within 0.25–3.5 servings. Ingredient quantities, nutrients, and cost all scale by that displayed multiplier. Gram amounts stay in grams; cups, spoons, and count units are not given invented gram conversions. The component list includes qualitative amounts such as lemon to taste. The catalog provides STRATA editorial recipe estimates informed by [USDA FoodData Central](https://fdc.nal.usda.gov/), with no live lookup, verified branded product, or item-level FDC record provenance. Correct scaling does not make these recipes precisely measured.

A menu is a close nutrition fit only when calories and every available macro meet these tolerances:

| Remaining target | Allowed absolute difference |
|---|---|
| Calories | Greater of 50 kcal or 10% |
| Protein | Greater of 10 g or 15% |
| Carbohydrate | Greater of 20 g or 20% |
| Fat | Greater of 8 g or 20% |

Three distinct qualifying alternatives are required for `ready`; fewer alternatives or any calorie/macro mismatch produces `limited` and visible differences. The tolerances are matching heuristics, not safety limits or a guarantee the catalog contains the best possible combination. Matching evaluates rounded recipe nutrition; it does not force editorial meal calories to equal 4/4/9 macro energy.

Costs are rough USD ingredient estimates. The actual diary does not track spending, so the budget comparison uses the entered daily amount, not an invented remaining cash balance. Store, country, packaging, preparation, waste, and pricing can change the cost. A budget affects ranking and shows an over-budget difference; it is not a purchasing guarantee.

## Saved weeks, diary dates, and privacy

Generated weeks include canonical inputs and profile revision, week dates, generator/model identifiers, catalog fingerprints, and fingerprints of eligible evidence. Current generation uses snapshot schema 4, `coaching-week-v6`, and `energy-planning-v5`. A valid current-week snapshot remains unchanged by diary edits, workout completion, page reload, deployment, or a newer model identifier. The interface can label that an update is available for a later week. Next Monday uses the current generator and eligible pre-week evidence. Explicit profile review/save creates a new revision and deliberately regenerates the current week.

Actual intake and morning weight can be recorded for today and the preceding 42 calendar dates in the saved time zone; future observation writes are rejected. Past-day comparisons use that date's stored week target. If no historical target exists, the diary shows no target rather than attaching today's target to the old entry. Extending the diary does not fabricate past complete days or recalculate an already saved week. Remaining-day meal options use current-week targets.

Profile version 4 requires no database migration because coaching profiles are stored as validated versioned JSON and the nullable morning-weight and completeness columns already exist from migration 005. Older profiles remain readable with their original semantics. They must be explicitly reviewed and saved with the new movement fields before they can be updated to version 4.

Coaching profiles, body measurements, workout evidence, allergies, food preferences, budgets, logs, and snapshots remain private account data. Coaching APIs require authenticated, current Strata+ entitlement; mutations enforce origin, CSRF, identity, and revision checks. Responses are not stored in the service-worker cache. Export includes private coaching records and deletion removes them through existing account cascades. The planner is not for pregnancy, breastfeeding, minors, eating-disorder care, medical nutrition therapy, or injury-specific programming; its inputs do not screen those circumstances. Pain or medical concerns require appropriate qualified care.

## Numerical verification and limits

`qa/calibration-benchmark.js` compares the current leaf with the 7.10.0 engine loaded from commit `d08d55a`. Fixed seeds cover variable intake, exact and noisy weights, misaligned intake, missing days, fluid steps, six weekly updates under positive and negative equation bias, and systematic under-reporting. It reports raw-estimate errors separately from planned-target errors, including rejected cases. Most generators use the same 7700 kcal/kg assumption as the engine; additional 5500/9500 cases expose that simplification. These are mathematical regression checks, not clinical validation.

The misaligned-intake case produces a 150 kcal unsupported target increase in 7.10 and zero in 8.0. In the two synthetic ±600 kcal equation-bias series, sixth-week target error falls from 450 to 150 kcal. The tradeoffs are retained: incomplete-intake abstention can leave a larger baseline error; one noise seed and a density-mismatch case are worse in the new model; consistent 400 kcal food omission yields a sixth-week target error of −300 kcal in 8.0 versus −150 in 7.10. Those omitted-food observations are identical to an accurately logged person with lower expenditure. No calculation using only those inputs can tell them apart. Stronger adaptation is therefore not a general guarantee of greater accuracy.

Run `node qa/calibration-benchmark.js` to regenerate JSON and Markdown in the temporary output directory, or set `STRATA_BENCHMARK_OUTPUT` to a review directory. Focused tests also cover duplicate conflicts, outlier endpoints, date boundaries, stale evidence, repeated-window stability, stored-target provenance, changing-baseline rate limits, recent-weight review, and legacy invariance. Full release-gate outcomes belong in [release readiness](release-readiness.md).

## Calculation corrections

Training duration retains exact planned seconds for calorie accounting. Optional recorded-set targets above the current repetition or hold-time ceiling are withheld for review instead of silently exceeding the time budget. Below-range repeat targets remain available, and a valid load progression that resets repetitions inside the range is unchanged. Bench-supported bodyweight exercises use the same load classification as the workout logger so their recorded sets can inform comparable targets. These changes correct bookkeeping and evidence handling; they do not establish individual physiological accuracy.
