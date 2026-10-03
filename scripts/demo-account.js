#!/usr/bin/env node
"use strict";

// Creates the investor demo account: a verified STRATA account with a four-day week, four weeks of logged workouts
// with progressing loads and check-ins, and four weeks of sample Polar nights. It writes through the store and the
// same event reactions the server runs, so the Training Log, Daily Snapshots, and plan history fill in too.
//
//   STRATA_DEMO_PASSWORD='a long password' \
//     node --env-file-if-exists=.env scripts/demo-account.js --email demo@stratafitness.online [--name "Alex"]
//
// It only creates a new account, never changes an existing one, and only for an address listed in
// STRATA_INTERNAL_ACCOUNTS, so the demo never counts in the owner's metrics. Writing to Turso needs --yes.
// Strata+ for the demo is a grant the owner gives in Admin → People; this script never grants access itself.

const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { join } = require("node:path");
const { hashPassword, normalizeEmail } = require("../src/auth");
const { sanitizePlan, sanitizePreferences } = require("../src/plans");
const { sanitizeWorkout, summarizeWorkout } = require("../src/workouts");
const { CONSENT_VERSION, devicesSettings } = require("../src/devices");
const { seal } = require("../src/devices-crypto");
const { createEventBus } = require("../src/events");
const { createDataService } = require("../src/data-service");

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 28;
const PROVIDER = "polar";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// exerciseId, sets, reps, starting load (kg), weekly increase (kg)
const WEEK = Object.freeze({
  Monday: {
    title: "Upper A",
    items: [
      ["barbell-bench-press", 3, "6-8", 60, 2.5],
      ["chest-supported-row", 3, "8-10", 26, 2],
      ["barbell-overhead-press", 3, "6-8", 37.5, 1.25],
      ["underhand-lat-pulldown", 3, "10-12", 55, 2.5],
      ["cable-lateral-raise", 3, "12-15", 7.5, 0],
    ],
  },
  Tuesday: {
    title: "Lower A",
    items: [
      ["barbell-back-squat", 3, "5-7", 80, 2.5],
      ["romanian-deadlift", 3, "8-10", 70, 2.5],
      ["leg-press", 3, "10-12", 140, 5],
      ["seated-leg-curl", 3, "10-12", 45, 2.5],
    ],
  },
  Thursday: {
    title: "Upper B",
    items: [
      ["incline-dumbbell-press", 3, "8-10", 24, 2],
      ["barbell-bent-over-row", 3, "8-10", 60, 2.5],
      ["wide-grip-lat-pulldown", 3, "10-12", 52.5, 2.5],
      ["standing-ezbar-curl", 3, "10-12", 30, 0],
      ["overhead-triceps", 2, "10-12", 20, 0],
    ],
  },
  Friday: {
    title: "Lower B",
    items: [
      ["barbell-hip-thrust", 3, "8-10", 90, 5],
      ["leg-extension", 3, "12-15", 50, 2.5],
      ["lying-leg-curl", 3, "10-12", 40, 2.5],
      ["single-leg-leg-press-calf-raise", 3, "12-15", 60, 0],
    ],
  },
});
// A real month has a missed session: the tenth one.
const SKIPPED_SESSION = 9;

/** A small seeded generator, so every demo account shows the same month. @param {number} seed */
function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** @param {number} time */
const isoDate = (time) => new Date(time).toISOString().slice(0, 10);
/** @param {number} time */
const startOfDay = (time) => Math.floor(time / DAY_MS) * DAY_MS;

function demoPreferences() {
  return sanitizePreferences({
    goal: "hypertrophy",
    level: "Intermediate",
    days: 4,
    equipment: ["Barbell / Smith", "Dumbbells", "Cables", "Machine", "Bench"],
    preferences: ["stable", "compound"],
  });
}

function demoPlan() {
  const days = Object.fromEntries(
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => [
      day,
      (WEEK[day]?.items || []).map(([exerciseId, sets, reps], index) => ({
        instanceId: `demo-${day.toLowerCase()}-${index + 1}`,
        exerciseId,
        sets,
        reps,
      })),
    ]),
  );
  return sanitizePlan({
    version: 1,
    restDay: "Wednesday",
    restDays: ["Wednesday", "Saturday", "Sunday"],
    days,
  });
}

/** Completed workouts on the plan's days over the last four weeks, loads rising week by week. @param {number} now */
function demoWorkouts(now) {
  const next = random(98),
    today = startOfDay(now),
    workouts = [];
  let planned = 0;
  for (let daysAgo = HISTORY_DAYS; daysAgo >= 1; daysAgo -= 1) {
    const day = today - daysAgo * DAY_MS,
      name = DAY_NAMES[new Date(day).getUTCDay()],
      session = WEEK[name];
    if (!session || planned++ === SKIPPED_SESSION) continue;
    const week = Math.floor((HISTORY_DAYS - daysAgo) / 7),
      startedAt = day + (17 * 60 + 30 + Math.floor(next() * 40)) * 60 * 1000,
      elapsedSeconds = 3000 + Math.floor(next() * 1200);
    workouts.push(
      sanitizeWorkout(
        {
          id: `demo-${isoDate(day)}`,
          title: session.title,
          planDay: name,
          date: isoDate(day),
          status: "completed",
          startedAt,
          completedAt: startedAt + elapsedSeconds * 1000,
          elapsedSeconds,
          restEndsAt: null,
          entries: session.items.map(([exerciseId, sets, reps, load, step], index) => {
            const [low, high] = String(reps).split("-").map(Number);
            return {
              id: `entry-${index + 1}`,
              exerciseId,
              planInstanceId: `demo-${name.toLowerCase()}-${index + 1}`,
              measurement: "reps",
              loadType: "external",
              unit: "kg",
              prescribedReps: reps,
              sets: Array.from({ length: sets }, (_, set) => ({
                reps: Math.max(low, high - set - Math.floor(next() * 2)),
                weight: load + step * week,
                seconds: null,
                completed: true,
              })),
            };
          }),
        },
        now,
      ),
    );
  }
  return workouts;
}

/** Twenty-eight sample Polar nights ending last night, with one poor night. @param {number} now */
function demoNights(now) {
  const next = random(7),
    today = startOfDay(now),
    nights = [];
  for (let daysAgo = HISTORY_DAYS; daysAgo >= 1; daysAgo -= 1) {
    const morning = today - (daysAgo - 1) * DAY_MS,
      poor = daysAgo === 6,
      asleep = Math.round((poor ? 5.3 : 6.7 + next() * 1.2) * 3600),
      bedtime = morning - (poor ? 50 : 75 + Math.floor(next() * 30)) * 60 * 1000;
    nights.push({
      nightDate: isoDate(morning),
      recoveryStatus: poor ? 2 : 3 + Math.floor(next() * 3),
      ansCharge: Math.round((poor ? -6.2 : -1 + next() * 6) * 10) / 10,
      ansChargeStatus: poor ? 1 : 3 + Math.floor(next() * 2),
      sleepCharge: poor ? 2 : 3 + Math.floor(next() * 2),
      heartRateAvg: Math.round((poor ? 61 : 52 + next() * 5) * 10) / 10,
      hrvAvg: Math.round((poor ? 31 : 46 + next() * 18) * 10) / 10,
      breathingRateAvg: Math.round((poor ? 15.6 : 13.6 + next() * 1.2) * 10) / 10,
      sleepScore: poor ? 58 : Math.round(72 + next() * 16),
      sleepStart: new Date(bedtime).toISOString(),
      sleepEnd: new Date(bedtime + asleep * 1000 + 25 * 60 * 1000).toISOString(),
      asleepSeconds: asleep,
      lightSeconds: Math.round(asleep * 0.52),
      deepSeconds: Math.round(asleep * (poor ? 0.12 : 0.19)),
      remSeconds: Math.round(asleep * (poor ? 0.18 : 0.23)),
      interruptionSeconds: Math.round((poor ? 48 : 12 + next() * 20) * 60),
      updatedAt: now,
    });
  }
  return nights;
}

/** @param {unknown} value */
function emailList(value) {
  return String(value || "")
    .split(",")
    .map((item) => normalizeEmail(item))
    .filter((item) => item.includes("@"));
}

/**
 * Refuses anything that could touch a real member: an existing account (the App Review account included), the
 * owner, or an address the owner has not listed as internal.
 * @param {{store:any,email:string,env:Record<string,string|undefined>}} input
 */
async function checkDemoTarget({ store, email, env }) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error("Give the demo account's email with --email.");
  if (email === normalizeEmail(env.ADMIN_EMAIL || ""))
    throw new Error("The demo account must not be the owner's account.");
  if (!emailList(env.STRATA_INTERNAL_ACCOUNTS).includes(email))
    throw new Error(
      `Add ${email} to STRATA_INTERNAL_ACCOUNTS first, here and on the server, so the demo never counts as a customer.`,
    );
  if (await store.userByEmail(email))
    throw new Error(`An account for ${email} already exists. This script only creates a new one.`);
}

/**
 * @param {{store:any,email:string,name?:string,password:string,env?:Record<string,string|undefined>,now?:number,
 *   logger?:any}} input
 */
async function createDemoAccount({
  store,
  email,
  name = "Alex (demo)",
  password,
  env = {},
  now = Date.now(),
  logger,
}) {
  const address = normalizeEmail(email);
  await checkDemoTarget({ store, email: address, env });
  if (String(password || "").length < 12)
    throw new Error("The demo password needs at least 12 characters.");
  const quiet = logger || { error() {}, warn() {}, info() {} };
  const events = createEventBus({ logger: quiet, outbox: store });
  /** @param {string} userId */
  const getPlan = async (userId) => {
    const row = await store.plan(userId);
    return row ? JSON.parse(row.plan_json) : null;
  };
  createDataService({
    store,
    events,
    getPlan,
    coachingProfile: async () => null,
    http: { json() {} },
    logger: quiet,
  });

  const userId = randomUUID(),
    salt = randomBytes(16).toString("base64"),
    createdAt = startOfDay(now) - (HISTORY_DAYS + 2) * DAY_MS;
  await store.insertUser({
    id: userId,
    name,
    email: address,
    passwordHash: await hashPassword(password, salt),
    passwordSalt: salt,
    createdAt,
    emailVerifiedAt: createdAt,
  });
  const preferences = demoPreferences();
  await store.upsertPreferences(userId, JSON.stringify(preferences), createdAt + 60_000);
  await events.emit("preferences.saved", { userId, preferences });
  const plan = demoPlan(),
    saved = await store.upsertPlan(userId, JSON.stringify(plan), createdAt + 120_000, 0);
  await events.emit("plan.updated", {
    userId,
    plan,
    updatedAt: Number(saved.updated_at),
    source: "system",
    detail: "setup",
  });

  const workouts = demoWorkouts(now);
  for (const [index, workout] of workouts.entries()) {
    const workoutJson = JSON.stringify(workout);
    await store.insertWorkout({
      id: workout.id,
      userId,
      workoutJson,
      summaryJson: JSON.stringify(summarizeWorkout(workout)),
      createHash: createHash("sha256").update(workoutJson).digest("hex"),
      startedAt: workout.startedAt,
      updatedAt: workout.completedAt,
    });
    await events.emit("workout.saved", { userId, workout, created: true });
    await events.emit("workout.completed", { userId, workout });
    if (index % 2 === 0)
      await store.upsertWorkoutCheckIn({
        userId,
        workoutId: workout.id,
        difficulty: 3 + (index % 3 === 0 ? 1 : 0),
        energy: 4,
        comfort: 4,
        enjoyment: 4 + (index % 4 === 0 ? 1 : 0),
        createdAt: workout.completedAt + 60_000,
        updatedAt: workout.completedAt + 60_000,
      });
  }

  // Sample nights need a Polar connection row. Its token is a sealed placeholder and its next sync is a year away,
  // so the sync loop never calls Polar for it.
  const keys = devicesSettings(env).keys || [];
  let nights = [];
  if (keys.length) {
    const owner = { userId, provider: PROVIDER, providerUserId: randomBytes(16).toString("hex") },
      later = now + 365 * DAY_MS;
    await store.upsertDeviceConnection({
      ...owner,
      memberRef: randomBytes(16).toString("hex"),
      tokenSealed: seal(keys, JSON.stringify({ demo: true })),
      tokenExpiresAt: later,
      settingsJson: JSON.stringify({ recoverySuggestions: true }),
      consentVersion: CONSENT_VERSION,
      connectedAt: startOfDay(now) - HISTORY_DAYS * DAY_MS,
      nextSyncAt: later,
      updatedAt: now,
    });
    nights = demoNights(now);
    for (const night of nights) await store.upsertWellnessNight(owner, night);
    await store.recordDeviceSync({
      ...owner,
      status: "active",
      syncedThrough: isoDate(now),
      lastSyncAt: now,
      lastError: null,
      nextSyncAt: later,
      failures: 0,
      updatedAt: now,
    });
    await events.emit("polar.sync.finished", {
      userId,
      provider: PROVIDER,
      from: nights[0].nightDate,
      to: isoDate(now),
    });
  }
  return {
    userId,
    email: address,
    workouts: workouts.length,
    nights: nights.length,
    polar: keys.length > 0,
  };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { email: "", name: undefined, yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") options.yes = true;
    else if (arg === "--email" || arg === "--name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown option ${arg}.`);
  }
  return options;
}

const TURSO_CONFIRMATION =
  "This writes to the Turso database in TURSO_DATABASE_URL. Run again with --yes to continue.";

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  // Connecting to Turso already runs the schema migrations, so the confirmation comes before any connection.
  if (String(env.TURSO_DATABASE_URL || "").trim() && !options.yes)
    throw new Error(TURSO_CONFIRMATION);
  const { createStore } = require("../src/database");
  const store = await createStore(join(__dirname, ".."));
  try {
    if (store.kind === "turso" && !options.yes) throw new Error(TURSO_CONFIRMATION);
    const generated = !env.STRATA_DEMO_PASSWORD,
      password = env.STRATA_DEMO_PASSWORD || randomBytes(12).toString("base64url");
    const result = await createDemoAccount({
      store,
      email: options.email,
      name: options.name,
      password,
      env,
    });
    console.log(`Created the demo account ${result.email} in the ${store.kind} database.`);
    console.log(`  ${result.workouts} completed workouts, ${result.nights} Polar nights.`);
    if (!result.polar) console.log("  No Polar nights: DEVICE_TOKEN_KEY is not set here.");
    if (generated) console.log(`  Password (shown once): ${password}`);
    console.log("  Next: in Admin → People, grant this account Strata+ with no end date.");
  } finally {
    await store.close();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = {
  HISTORY_DAYS,
  checkDemoTarget,
  createDemoAccount,
  demoNights,
  demoPlan,
  demoWorkouts,
  main,
  parseArgs,
};
