"use strict";

// Numerical regression benchmark, not a clinical validation or a sample of real users.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const Module = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const Current = require("../src/energy-calibration-core");

const ROOT = resolve(__dirname, ".."),
  REFERENCE = "d08d55a",
  WEEK = "2026-09-14",
  DAY = 86400000;
const OUTPUT = resolve(
  process.env.STRATA_BENCHMARK_OUTPUT || join(tmpdir(), "strata-calibration-benchmark"),
);
const SEEDS = [104729, 130363, 155921, 196613, 262147];
const PROFILE = {
  version: 3,
  age: 30,
  heightCm: 175,
  weightKg: 75,
  bodyFatPercent: null,
  sexForEquation: "male",
  lifestyleActivity: "sedentary",
  goal: "maintenance",
  goalPace: "gentle",
  caloriePattern: "steady",
  workoutDays: ["Monday", "Wednesday", "Friday"],
  macroPreference: null,
};
const add = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const round = (number, places = 2) => Math.round(number * 10 ** places) / 10 ** places;
const sha = (value) => createHash("sha256").update(value).digest("hex");

function legacyEngine() {
  const source = execFileSync("git", ["show", `${REFERENCE}:src/energy-planning-core.js`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  const filename = join(ROOT, "src", "benchmark-reference-energy.cjs"),
    loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(join(ROOT, "src"));
  loaded._compile(source, filename);
  return {
    api: loaded.exports,
    sourceHash: sha(source),
    commit: execFileSync("git", ["rev-parse", REFERENCE], { cwd: ROOT, encoding: "utf8" }).trim(),
  };
}
const legacy = legacyEngine(),
  BASELINE = legacy.api.baselineFor(PROFILE),
  B = BASELINE.targetKcal;
function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
function normal(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, rng()))) * Math.cos(2 * Math.PI * rng());
}

function generate({
  days = 77,
  maintenance = B,
  intake = maintenance,
  reportingBias = 0,
  density = 7700,
  noiseKg = 0,
  resolutionKg = 0,
  seed = SEEDS[0],
  fluid = () => 0,
} = {}) {
  const rng = random(seed),
    start = add(WEEK, -42);
  let energyBalance = 0;
  return Array.from({ length: days }, (_, index) => {
    const actualCalories = Math.round(typeof intake === "function" ? intake(index, rng) : intake),
      trueWeight = PROFILE.weightKg + energyBalance / density,
      measured = trueWeight + noiseKg * normal(rng) + fluid(index),
      morningWeightKg = resolutionKg
        ? Math.round(measured / resolutionKg) * resolutionKg
        : measured;
    const row = {
      date: add(start, index),
      calories: Math.max(0, actualCalories + reportingBias),
      complete: true,
      morningWeightKg,
    };
    energyBalance += actualCalories - maintenance;
    return row;
  });
}
function resultFor(api, data, week, truth, previousWeek) {
  const input = { dailyLogs: data, ...(previousWeek ? { previousWeek } : {}) },
    snapshot = structuredClone(input),
    result = api.calibrateMaintenance(PROFILE, week, input, BASELINE);
  assert.deepEqual(input, snapshot, "A benchmark run must not mutate its evidence");
  assert.ok(Number.isFinite(result.targetKcal));
  const raw = result.observedMaintenanceKcal,
    accepted = result.status === "trend_informed";
  return {
    result,
    record: {
      status: result.status,
      accepted,
      priorState: result.priorState || "none",
      trueMaintenanceKcal: truth,
      baselineKcal: B,
      observedMaintenanceKcal: raw,
      rawErrorKcal: raw == null ? null : round(raw - truth),
      rawAbsoluteErrorKcal: raw == null ? null : round(Math.abs(raw - truth)),
      targetKcal: result.targetKcal,
      targetErrorKcal: round(result.targetKcal - truth),
      targetAbsoluteErrorKcal: round(Math.abs(result.targetKcal - truth)),
      alignedDays: result.interval?.days ?? null,
      evidence: result.evidence,
      quality: result.quality ?? null,
      sensitivity: result.sensitivity ?? null,
      explanation: result.explanation,
    },
  };
}
function snapshotFor(result, weekStart) {
  return {
    weekStart,
    energyModelVersion: Current.MODEL_VERSION,
    nutrition: { maintenance: { targetKcal: result.targetKcal, calibration: result } },
  };
}
function single(id, description, rows, truth = B) {
  const old = resultFor(legacy.api, rows, WEEK, truth),
    current = resultFor(Current, rows, WEEK, truth);
  return {
    id,
    description,
    truthMaintenanceKcal: truth,
    dataFingerprint: sha(JSON.stringify(rows)),
    legacy: old.record,
    current: current.record,
  };
}
function trajectory(id, description, { truth, intake = truth, reportingBias = 0 }) {
  const rows = generate({ maintenance: truth, intake, reportingBias }),
    weeks = [];
  let previousWeek;
  for (let index = 0; index < 6; index++) {
    const week = add(WEEK, index * 7),
      old = resultFor(legacy.api, rows, week, truth),
      current = resultFor(Current, rows, week, truth, previousWeek);
    assert.ok(
      Math.abs(current.result.targetKcal - (previousWeek?.nutrition.maintenance.targetKcal ?? B)) <=
        150,
      "A compatible weekly target cannot jump more than 150 kcal",
    );
    weeks.push({ weekStart: week, legacy: old.record, current: current.record });
    previousWeek = snapshotFor(current.result, week);
  }
  return {
    id,
    description,
    truthMaintenanceKcal: truth,
    reportingBiasKcal: reportingBias,
    dataFingerprint: sha(JSON.stringify(rows)),
    weeks,
  };
}
function summary(records) {
  const finiteRaw = records.filter((row) => row.rawAbsoluteErrorKcal != null),
    accepted = records.filter((row) => row.accepted),
    mean = (values) =>
      values.length ? round(values.reduce((sum, x) => sum + x, 0) / values.length) : null;
  return {
    cases: records.length,
    accepted: accepted.length,
    rejectedOrHeld: records.length - accepted.length,
    rawEstimateAvailable: finiteRaw.length,
    rawMaeKcalAvailable: mean(finiteRaw.map((row) => row.rawAbsoluteErrorKcal)),
    rawMaeKcalAcceptedOnly: mean(accepted.map((row) => row.rawAbsoluteErrorKcal)),
    plannedTargetMaeKcalAll: mean(records.map((row) => row.targetAbsoluteErrorKcal)),
    plannedTargetMaxErrorKcal: Math.max(...records.map((row) => row.targetAbsoluteErrorKcal)),
  };
}

const scenarios = [];
scenarios.push(
  single(
    "complete_constant",
    "Complete noiseless intake and stable weight at the equation baseline.",
    generate({ days: 42 }),
  ),
);
scenarios.push(
  single(
    "alternating_intake_exact",
    "Alternating daily intake ±350 kcal with exact synthetic tissue weights.",
    generate({ days: 42, intake: (i) => B + (i % 2 ? 350 : -350) }),
  ),
);
const variable = generate({ days: 42, intake: (i) => B + (i < 30 ? -400 : 400) });
scenarios.push(
  single(
    "intake_step_exact",
    "A genuine intake change inside the observed interval; expenditure remains constant.",
    variable,
  ),
);
const exactVariable = Current.calibrateMaintenance(
  PROFILE,
  WEEK,
  { dailyLogs: variable },
  BASELINE,
);
assert.ok(
  Math.abs(exactVariable.observedMaintenanceKcal - B) <= 1,
  "Aligned cumulative accounting must recover constant expenditure despite variable intake",
);
for (const seed of SEEDS) {
  const options = {
      days: 42,
      intake: (_, rng) => B + Math.round((rng() - 0.5) * 1000),
      noiseKg: 0.15,
      resolutionKg: 0.1,
      seed,
    },
    rows = generate(options);
  assert.deepEqual(rows, generate(options), "Fixed seed must reproduce synthetic observations");
  scenarios.push(
    single(
      `variable_noise_${seed}`,
      "Variable intake, 0.15 kg Gaussian measurement noise and 0.1 kg diary rounding.",
      rows,
    ),
  );
}

const misaligned = generate({ days: 42 });
for (let index = 36; index < 42; index++) misaligned[index].morningWeightKg = null;
const alignedControl = structuredClone(misaligned);
for (let index = 35; index < 42; index++) misaligned[index].calories += 1200;
const misalignment = single(
  "intake_outside_weights",
  "Later logged intake rises after the final morning weight; true expenditure stays at baseline.",
  misaligned,
);
const invariant = Current.calibrateMaintenance(
  PROFILE,
  WEEK,
  { dailyLogs: alignedControl },
  BASELINE,
);
assert.equal(
  misalignment.current.observedMaintenanceKcal,
  invariant.observedMaintenanceKcal,
  "Intake on/after the final morning cannot change its preceding energy estimate",
);
assert.equal(
  misalignment.current.targetKcal,
  invariant.targetKcal,
  "Unobserved later intake must not shift the planned target",
);
scenarios.push(misalignment);

const incomplete = generate({ days: 42, maintenance: B + 350 });
for (let index = 7; index < 42; index += 10) incomplete[index].complete = false;
const missing = single(
  "missing_intake_days",
  "Four incomplete intake days break all recent qualifying contiguous intervals; true expenditure is 350 kcal above baseline.",
  incomplete,
  B + 350,
);
assert.equal(missing.current.accepted, false);
assert.equal(missing.current.targetKcal, B, "Gaps must not create an unearned adjustment");
scenarios.push(missing);
for (const [label, at] of [
  ["earlier_fluid_step", 21],
  ["recent_fluid_step", 31],
])
  scenarios.push(
    single(
      label,
      `A 2 kg non-tissue scale drop at day ${at}; food and true expenditure remain unchanged.`,
      generate({ days: 42, fluid: (index) => (index >= at ? -2 : 0) }),
    ),
  );
scenarios.push(
  single(
    "noisy_weights",
    "Alternating ±1.2 kg scale noise with no genuine expenditure change.",
    generate({ days: 42, fluid: (index) => (index % 2 ? 1.2 : -1.2) }),
  ),
);
for (const row of scenarios.filter(
  (item) => item.id.includes("fluid_step") || item.id === "noisy_weights",
))
  assert.equal(
    row.current.targetKcal,
    B,
    "Non-tissue scale movement must not create a target adjustment",
  );
for (const density of [5500, 9500])
  scenarios.push(
    single(
      `density_${density}`,
      `Synthetic tissue density ${density} kcal/kg differs from both engines' 7700 assumption; actual intake is 200 kcal below expenditure.`,
      generate({ days: 42, density, intake: B - 200 }),
    ),
  );

const trajectories = [
  trajectory(
    "positive_equation_bias",
    "True stable expenditure is 600 kcal above the equation baseline.",
    { truth: B + 600 },
  ),
  trajectory(
    "negative_equation_bias",
    "True stable expenditure is 600 kcal below the equation baseline.",
    { truth: B - 600 },
  ),
  trajectory(
    "systematic_underreport",
    "True stable expenditure equals baseline, but 400 kcal/day is consistently omitted from the supposedly complete log.",
    { truth: B, reportingBias: -400 },
  ),
  trajectory(
    "identical_logs_accurate_lower_intake",
    "Identical recorded observations to systematic_underreport, but actual expenditure and accurate intake are 400 kcal below baseline.",
    { truth: B - 400 },
  ),
];
for (const [index, direction] of [
  [0, 1],
  [1, -1],
])
  assert.ok(
    (trajectories[index].weeks.at(-1).current.targetKcal - B) * direction > 150,
    "Sustained evidence must be able to move beyond the original ±150 baseline cap",
  );
const underreport = trajectories[2],
  equivalent = trajectories[3];
assert.equal(
  underreport.dataFingerprint,
  equivalent.dataFingerprint,
  "The identifiability demonstration must have exactly equal recorded data",
);
assert.deepEqual(
  underreport.weeks.map((row) => row.current.targetKcal),
  equivalent.weeks.map((row) => row.current.targetKcal),
  "Identical evidence cannot reveal an unobserved reporting bias",
);

const control = generate({ days: 42 }),
  before = Current.calibrateMaintenance(PROFILE, WEEK, { dailyLogs: control }, BASELINE);
const outside = [
  ...control,
  { date: WEEK, calories: 20000, complete: true, morningWeightKg: 200 },
  { date: add(WEEK, -43), calories: 20000, complete: true, morningWeightKg: 200 },
];
assert.deepEqual(
  Current.calibrateMaintenance(PROFILE, WEEK, { dailyLogs: outside }, BASELINE),
  before,
  "Current-week and out-of-window data must be inert",
);
const previous = snapshotFor(
  Current.calibrateMaintenance(
    PROFILE,
    WEEK,
    { dailyLogs: generate({ days: 42, maintenance: B + 600 }) },
    BASELINE,
  ),
  WEEK,
);
const repeated = Current.calibrateMaintenance(
  PROFILE,
  add(WEEK, 7),
  { dailyLogs: generate({ days: 42, maintenance: B + 600 }), previousWeek: previous },
  BASELINE,
);
assert.equal(repeated.priorState, "held");
assert.equal(
  repeated.targetKcal,
  previous.nutrition.maintenance.targetKcal,
  "Replaying an old window cannot ratchet the target",
);
const boundarySnapshot = snapshotFor(
  {
    modelVersion: Current.MODEL_VERSION,
    baselineKcal: B,
    targetKcal: 3275,
    status: "trend_informed",
    lastAcceptedEvidenceEnd: add(WEEK, -8),
  },
  add(WEEK, -7),
);
const boundaryChecks = [B, 2600, 2200].map((baselineKcal) => {
  const result = Current.calibrateMaintenance(
    PROFILE,
    WEEK,
    { previousWeek: boundarySnapshot },
    { ...BASELINE, targetKcal: baselineKcal },
  );
  assert.equal(result.priorState, "held");
  assert.ok(
    Math.abs(result.targetKcal - 3275) <= 150,
    "A changed baseline must not invalidate a saved target or bypass the weekly limit",
  );
  if (baselineKcal === 2600)
    assert.ok(
      result.targetKcal >= 3125,
      "A 25 kcal baseline change cannot cause a 675 kcal target drop",
    );
  return {
    baselineKcal,
    previousTargetKcal: 3275,
    targetKcal: result.targetKcal,
    weeklyChangeKcal: result.weeklyChangeKcal,
    boundReconciliation: result.boundReconciliation,
  };
});

const limitations = [
  "These are deterministic synthetic scenarios, not real-user data, a clinical validation, or evidence of guaranteed individual accuracy.",
  "Most generators use 7700 kcal/kg, the same simplifying assumption as both engines. Exact recovery demonstrates bookkeeping correctness under that assumption, not physiological validity. Density 5500/9500 scenarios expose that limitation.",
  "True expenditure is held constant. No adaptation, changing activity, tissue composition, illness, menstrual cycle, medication effect or real dietary adherence model is simulated; the fluid-step cases are deliberately simple.",
  "This benchmark isolates calibration using the same fixed EER baseline. It does not benchmark the new recent-weight anchor, complete nutrition targets, macros, meal estimates, or training prescriptions.",
  "The old engine intentionally reads 21 days and the new engine 42 days. Both receive the same available records and enforce their own windows. Early fluid changes can be excluded by the old window while the new engine conservatively rejects them.",
  "Raw-estimate error is reported even when an engine rejects that estimate. Planned-target error is reported separately and includes intentional shrinkage, rate limits, holds and equation bias. Rejected estimates are not counted as accurate measurements.",
  "Systematic intake under-reporting is not identifiable from these inputs. Stronger adaptation can increase target error when complete-looking intake is wrong; the report includes that adverse case and an observationally identical honest-log case.",
  "Scenario averages are descriptive for this fixed collection, not a representative population, statistical confidence interval, or a prediction of user outcomes. No aggregate winning percentage is claimed.",
];
const totals = {
  singleWindow: {
    legacy: summary(scenarios.map((row) => row.legacy)),
    current: summary(scenarios.map((row) => row.current)),
  },
  sixthWeek: {
    legacy: summary(trajectories.map((row) => row.weeks.at(-1).legacy)),
    current: summary(trajectories.map((row) => row.weeks.at(-1).current)),
  },
};
const report = {
  benchmarkVersion: 2,
  reference: {
    commit: legacy.commit,
    model: legacy.api.MODEL_VERSION,
    sourceHash: legacy.sourceHash,
  },
  current: {
    model: Current.MODEL_VERSION,
    sourceHash: sha(readFileSync(join(ROOT, "src/energy-calibration-core.js"), "utf8")),
  },
  runtime: process.version,
  firstWeek: WEEK,
  seeds: SEEDS,
  profile: PROFILE,
  baselineKcal: B,
  scenarios,
  trajectories,
  boundaryChecks,
  summary: totals,
  regressionAssertions: {
    passed: true,
    checks: [
      "variable-intake cumulative accounting",
      "post-weight intake invariance",
      "missing-intake abstention",
      "non-tissue scale movement abstention",
      "weekly change limit",
      "gradual adjustment beyond baseline cap",
      "identical-log non-identifiability",
      "excluded-date invariance",
      "old-window replay holds",
      "changed-baseline target continuity",
      "seed reproducibility",
      "input immutability",
    ],
  },
  limitations,
};
report.resultsFingerprint = sha(
  JSON.stringify({ scenarios, trajectories, boundaryChecks, totals }),
);

const metric = (value) => (value == null ? "—" : String(value)),
  outcome = (row) => (row.accepted ? "used" : row.priorState === "held" ? "held" : "withheld");
const lines = [
  "# STRATA 8.0.0 calibration numerical benchmark",
  "",
  `Reference: 7.10.0 commit \`${legacy.commit}\`; current model: \`${Current.MODEL_VERSION}\`.`,
  `Fixed equation baseline: ${B} kcal/day. First evaluated Monday: ${WEEK}. Seeds: ${SEEDS.join(", ")}.`,
  `Results fingerprint: \`${report.resultsFingerprint}\`.`,
  "",
  "This comparison separates the intake-and-weight estimate from the deliberately gradual planning target. It is a mathematical regression benchmark, not clinical validation.",
  "",
  "## Single-window scenarios",
  "",
  "Signed errors are estimate minus known synthetic expenditure, in kcal/day. Raw errors remain visible even when a result was withheld.",
  "",
  "| Scenario | 7.10 raw error | 8.0 raw error | 7.10 target error | 8.0 target error | 7.10 / 8.0 use |",
  "|---|---:|---:|---:|---:|---|",
];
for (const row of scenarios)
  lines.push(
    `|${row.id}|${metric(row.legacy.rawErrorKcal)}|${metric(row.current.rawErrorKcal)}|${row.legacy.targetErrorKcal}|${row.current.targetErrorKcal}|${outcome(row.legacy)} / ${outcome(row.current)}|`,
  );
lines.push(
  "",
  "## Six weekly updates",
  "",
  "| Scenario | Week | 7.10 target | 8.0 target | 7.10 target error | 8.0 target error | 7.10 / 8.0 raw error |",
  "|---|---|---:|---:|---:|---:|---|",
);
for (const series of trajectories)
  for (const row of series.weeks)
    lines.push(
      `|${series.id}|${row.weekStart}|${row.legacy.targetKcal}|${row.current.targetKcal}|${row.legacy.targetErrorKcal}|${row.current.targetErrorKcal}|${metric(row.legacy.rawErrorKcal)} / ${metric(row.current.rawErrorKcal)}|`,
    );
lines.push(
  "",
  "## Baseline continuity regression",
  "",
  "A trusted prior target of 3275 kcal/day was derived using a 2625 kcal/day baseline. These v8 checks change the baseline without new qualifying observations; they test update continuity, not prediction accuracy.",
  "",
  "| New baseline | Saved target | Next target | Weekly change | New baseline bound still being restored |",
  "|---:|---:|---:|---:|---|",
);
for (const row of boundaryChecks)
  lines.push(
    `|${row.baselineKcal}|${row.previousTargetKcal}|${row.targetKcal}|${row.weeklyChangeKcal}|${row.boundReconciliation.required ? "yes" : "no"}|`,
  );
lines.push(
  "",
  "## Descriptive totals",
  "",
  "| Scope / engine|Cases|Used|Withheld/held|Raw estimate available|Raw MAE, available|Raw MAE, used only|Target MAE, all|Maximum target error|",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
);
for (const [scope, engines] of Object.entries(totals))
  for (const [engine, value] of Object.entries(engines))
    lines.push(
      `|${scope} /${engine}|${value.cases}|${value.accepted}|${value.rejectedOrHeld}|${value.rawEstimateAvailable}|${metric(value.rawMaeKcalAvailable)}|${metric(value.rawMaeKcalAcceptedOnly)}|${value.plannedTargetMaeKcalAll}|${value.plannedTargetMaxErrorKcal}|`,
    );
lines.push(
  "",
  "## Interpretation",
  "",
  `The misaligned-intake scenario changed the 7.10 target by ${misalignment.legacy.targetErrorKcal} kcal despite no corresponding weight evidence; 8.0 left it unchanged. Both engines recover some valid cases well.`,
  "",
  `For consistent under-reporting, the sixth-week target error is ${underreport.weeks.at(-1).legacy.targetErrorKcal} kcal for 7.10 and ${underreport.weeks.at(-1).current.targetErrorKcal} kcal for 8.0. The new model cannot identify hidden food and can move further in the wrong direction. Identical recorded data also occur in the honest lower-intake control; no calculation can distinguish those cases without additional information.`,
  "",
  "All meaningful regression assertions passed. The JSON includes each status, evidence count, quality/sensitivity diagnostic and explanation.",
  "",
  "## Scenario definitions",
  "",
);
for (const row of [...scenarios, ...trajectories])
  lines.push(`- **${row.id}:** ${row.description}`);
lines.push("", "## Limitations", "");
for (const item of limitations) lines.push(`- ${item}`);
mkdirSync(OUTPUT, { recursive: true });
writeFileSync(join(OUTPUT, "calibration-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(OUTPUT, "calibration-benchmark.md"), `${lines.join("\n")}\n`);
console.log(
  JSON.stringify(
    {
      output: OUTPUT,
      resultsFingerprint: report.resultsFingerprint,
      assertions: "passed",
      summary: totals,
      underreportSixthWeek: {
        legacyErrorKcal: underreport.weeks.at(-1).legacy.targetErrorKcal,
        currentErrorKcal: underreport.weeks.at(-1).current.targetErrorKcal,
      },
    },
    null,
    2,
  ),
);
