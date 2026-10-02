"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

const PROJECT_ROOT = join(__dirname, "..");
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHLY_PLAN_TARGETS = [
  "chest",
  "back",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "legs",
  "glutes",
  "calves",
  "core",
];
const EXERCISES = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "public", "data", "exercises.json"), "utf8"),
);
const EXERCISE_IDS = new Set(EXERCISES.map((exercise) => exercise.id));
const EXERCISE_BY_ID = new Map(EXERCISES.map((exercise) => [exercise.id, exercise]));
const EQUIPMENT = [...new Set(EXERCISES.map((exercise) => exercise.equipment))];

function cleanText(value, max) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function defaultPlan() {
  return {
    version: 1,
    restDay: "Sunday",
    restDays: ["Sunday"],
    days: Object.fromEntries(DAYS.map((day) => [day, []])),
  };
}

function defaultPreferences() {
  return {
    version: 1,
    goal: "hypertrophy",
    level: "Intermediate",
    days: 4,
    equipment: [...EQUIPMENT],
    preferences: ["stable", "long-range"],
    limitations: [],
  };
}

function planStats(plan) {
  const planCount = DAYS.reduce((sum, day) => sum + plan.days[day].length, 0);
  const workoutDays = DAYS.filter((day) => plan.days[day].length > 0).length;
  return { planCount, workoutDays };
}

function cleanChoiceList(value, allowed, max = 20) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => cleanText(item, 60))
        .filter((item) => allowed.includes(item)),
    ),
  ].slice(0, max);
}

function sanitizePreferences(input) {
  if (!input || typeof input !== "object")
    throw Object.assign(new Error("Invalid preference profile."), { status: 400 });
  const goals = ["hypertrophy", "strength", "balanced", "time-efficient"],
    levels = ["Beginner", "Intermediate", "Advanced"];
  const preferenceOptions = ["stable", "long-range", "simple-setup", "compound", "isolation"];
  const limitationOptions = [
    "no-overhead",
    "no-deep-knee",
    "no-unsupported-hinge",
    "no-floor",
    "no-unilateral",
  ];
  const equipment = cleanChoiceList(input.equipment, EQUIPMENT);
  if (!equipment.length)
    throw Object.assign(new Error("Select at least one available equipment type."), {
      status: 400,
    });
  return {
    version: 1,
    goal: goals.includes(input.goal) ? input.goal : "hypertrophy",
    level: levels.includes(input.level) ? input.level : "Intermediate",
    days: Math.max(1, Math.min(7, Math.round(Number(input.days) || 4))),
    equipment,
    preferences: cleanChoiceList(input.preferences, preferenceOptions),
    limitations: cleanChoiceList(input.limitations, limitationOptions),
  };
}

function sanitizeRating(input) {
  const output = {};
  for (const key of ["comfort", "pump", "enjoyment", "stability", "setup", "overall"]) {
    const value = Number(input?.[key]);
    if (!Number.isInteger(value) || value < 1 || value > 5)
      throw Object.assign(new Error("Every rating must be a whole number from 1 to 5."), {
        status: 400,
      });
    output[key] = value;
  }
  return output;
}

function sanitizePlan(input, { repair = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("Invalid plan."), { status: 400 });
  }
  const inputDays =
    input.days && typeof input.days === "object" && !Array.isArray(input.days) ? input.days : null;
  if (!inputDays && !repair) throw Object.assign(new Error("Invalid plan."), { status: 400 });
  const rawRest = Object.hasOwn(input, "restDays")
    ? input.restDays
    : input.restDay === null
      ? []
      : DAYS.includes(input.restDay)
        ? [input.restDay]
        : repair
          ? ["Sunday"]
          : null;
  if (
    (!Array.isArray(rawRest) ||
      rawRest.length > 7 ||
      rawRest.some((day) => !DAYS.includes(day)) ||
      new Set(rawRest).size !== rawRest.length) &&
    !repair
  )
    throw Object.assign(new Error("Choose valid, unique rest days."), { status: 400 });
  const restDays = DAYS.filter((day) => Array.isArray(rawRest) && rawRest.includes(day));
  if (
    !repair &&
    Object.hasOwn(input, "restDays") &&
    Object.hasOwn(input, "restDay") &&
    input.restDay !== (restDays[0] ?? null)
  )
    throw Object.assign(
      new Error("Rest-day fields do not match. Reload your plan before saving."),
      { status: 400 },
    );
  const output = { ...defaultPlan(), restDays, restDay: restDays[0] ?? null };
  const instanceIds = new Set();
  let total = 0;
  for (const day of DAYS) {
    const source = inputDays?.[day];
    if (!Array.isArray(source) && !repair)
      throw Object.assign(new Error(`Exercises for ${day} must be a list.`), { status: 400 });
    const items = Array.isArray(source) ? source : [];
    if (items.length > 30 && !repair)
      throw Object.assign(new Error(`${day} can contain at most 30 exercises.`), { status: 400 });
    output.days[day] = items
      .slice(0, 30)
      .map((item) => {
        const exerciseId = cleanText(item?.exerciseId, 80);
        if (!EXERCISE_IDS.has(exerciseId)) {
          if (!repair)
            throw Object.assign(new Error("Plan contains an unknown exercise."), { status: 400 });
          return null;
        }
        const requestedId = String(item?.instanceId || "");
        let instanceId = requestedId;
        if (!/^[a-zA-Z0-9_-]{6,100}$/.test(requestedId) || instanceIds.has(requestedId)) {
          do {
            instanceId = randomUUID();
          } while (instanceIds.has(instanceId));
        }
        instanceIds.add(instanceId);
        let sets = Number(item?.sets);
        if (!Number.isInteger(sets) || sets < 1 || sets > 10) {
          if (!repair)
            throw Object.assign(new Error("Sets must be a whole number from 1 to 10."), {
              status: 400,
            });
          sets = Number.isFinite(sets) ? Math.max(1, Math.min(10, Math.round(sets))) : 3;
        }
        total += 1;
        return { instanceId, exerciseId, sets, reps: cleanText(item.reps, 20) || "8–12" };
      })
      .filter(Boolean);
  }
  if (total > 140) throw Object.assign(new Error("Plan is too large."), { status: 400 });
  if (output.restDays.some((day) => output.days[day].length)) {
    if (!repair)
      throw Object.assign(new Error("Rest days must not contain exercises."), { status: 400 });
    output.restDays = output.restDays.filter((day) => !output.days[day].length);
    output.restDay = output.restDays[0] ?? null;
  }
  return output;
}

function expectedPlanRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(
      new Error("Your plan version is missing or invalid. Refresh and try again."),
      { status: 400, code: "PLAN_VERSION_REQUIRED" },
    );
  }
  return value;
}

function monthlyPlanError(message) {
  return Object.assign(new Error(message), { status: 400, code: "INVALID_MONTHLY_PLAN" });
}

function monthlyPlanObject(value, message = "Invalid monthly plan.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw monthlyPlanError(message);
  return value;
}

function exactMonthlyKeys(value, expected, message) {
  const keys = Object.keys(monthlyPlanObject(value, message)).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index]))
    throw monthlyPlanError(message);
}

function monthlyPlanText(value, max, label, { required = true } = {}) {
  if (typeof value !== "string") throw monthlyPlanError(`${label} is invalid.`);
  const text = value.trim();
  if ((required && !text) || text.length > max)
    throw monthlyPlanError(
      `${label} must be ${required ? "between 1 and " : "at most "}${max} characters.`,
    );
  return text;
}

function monthlyPlanDate(value) {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))
    throw monthlyPlanError("Choose a valid start date.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value ||
    date.getUTCFullYear() < 1900 ||
    date.getUTCFullYear() > 2200
  )
    throw monthlyPlanError("Choose a valid start date between 1900 and 2200.");
  return date;
}

function exerciseMatchesMonthlyTarget(exercise, target) {
  const group = String(exercise?.group || "").toLowerCase(),
    sub = String(exercise?.sub || "").toLowerCase();
  if (target === "biceps")
    return group === "arms" && (sub.includes("biceps") || sub.includes("brachialis"));
  if (target === "triceps") return group === "arms" && sub.includes("triceps");
  if (target === "forearms") return group === "arms" && sub.includes("forearm");
  return group === target;
}

function validateMonthlyExercises(items, targets, context, { minimumPerTarget = 0 } = {}) {
  const ids = items.map((item) => item.exerciseId);
  if (new Set(ids).size !== ids.length)
    throw monthlyPlanError(`${context} contains a repeated exercise.`);
  for (const item of items) {
    const exercise = EXERCISE_BY_ID.get(item.exerciseId);
    if (!targets.some((target) => exerciseMatchesMonthlyTarget(exercise, target)))
      throw monthlyPlanError(`${context} contains an exercise outside its selected muscle groups.`);
  }
  for (const target of targets) {
    const count = items.filter((item) =>
      exerciseMatchesMonthlyTarget(EXERCISE_BY_ID.get(item.exerciseId), target),
    ).length;
    if (count < minimumPerTarget)
      throw monthlyPlanError(
        `${context} needs ${minimumPerTarget} ${target} exercise${minimumPerTarget === 1 ? "" : "s"}.`,
      );
  }
}

function monthlyPlanExercise(input, context) {
  exactMonthlyKeys(
    input,
    ["exerciseId", "sets", "reps"],
    `${context} contains an invalid exercise.`,
  );
  const exerciseId = monthlyPlanText(input.exerciseId, 80, "Exercise ID");
  if (!EXERCISE_IDS.has(exerciseId))
    throw monthlyPlanError(`${context} contains an unknown exercise.`);
  const sets = Number(input.sets);
  if (!Number.isInteger(sets) || sets < 1 || sets > 10)
    throw monthlyPlanError(`${context} sets must be a whole number from 1 to 10.`);
  const reps = monthlyPlanText(input.reps, 20, `${context} reps`);
  return { exerciseId, sets, reps };
}

function monthlyPlanTargets(input, { rest, context }) {
  if (!Array.isArray(input)) throw monthlyPlanError(`${context} targets must be a list.`);
  if (input.length > 4) throw monthlyPlanError(`${context} can use at most four muscle groups.`);
  const targets = input.map((target) => monthlyPlanText(target, 20, `${context} muscle group`));
  if (
    new Set(targets).size !== targets.length ||
    targets.some((target) => !MONTHLY_PLAN_TARGETS.includes(target))
  ) {
    throw monthlyPlanError(`${context} contains an invalid or repeated muscle group.`);
  }
  if (rest && targets.length)
    throw monthlyPlanError(`${context} cannot contain muscle groups on a rest day.`);
  if (!rest && !targets.length)
    throw monthlyPlanError(`${context} needs at least one muscle group or must be marked as rest.`);
  return targets;
}

function sameMonthlyTargets(actual, expected) {
  return actual.length === expected.length && actual.every((target) => expected.includes(target));
}

function sanitizeMonthlyPlan(input, { generatedAt = Date.now() } = {}) {
  monthlyPlanObject(input, "Invalid monthly plan.");
  const inputKeys = Object.keys(input);
  const requiredKeys = [
    "version",
    "title",
    "source",
    "startDate",
    "exercisesPerTarget",
    "schedule",
    "days",
  ];
  if (
    requiredKeys.some((key) => !inputKeys.includes(key)) ||
    inputKeys.some((key) => ![...requiredKeys, "generatedAt"].includes(key))
  ) {
    throw monthlyPlanError("Invalid monthly plan.");
  }
  if (input.version !== 1) throw monthlyPlanError("Unsupported monthly plan version.");
  const title = monthlyPlanText(input.title, 80, "Plan title");
  if (!["weekly", "muscle-schedule"].includes(input.source))
    throw monthlyPlanError("Choose a valid monthly-plan source.");
  const startDate = monthlyPlanText(input.startDate, 10, "Start date");
  const start = monthlyPlanDate(startDate);
  const exercisesPerTarget = Number(input.exercisesPerTarget);
  if (!Number.isInteger(exercisesPerTarget) || exercisesPerTarget < 1 || exercisesPerTarget > 3) {
    throw monthlyPlanError("Exercises per muscle group must be a whole number from 1 to 3.");
  }

  const inputSchedule = monthlyPlanObject(input.schedule, "Monthly plan schedule is invalid.");
  exactMonthlyKeys(
    inputSchedule,
    DAYS,
    "Monthly plan schedule must include Monday through Sunday.",
  );
  const schedule = {};
  for (const day of DAYS) {
    const entry = inputSchedule[day];
    exactMonthlyKeys(entry, ["rest", "targets", "sourceItems"], `${day} schedule is invalid.`);
    if (typeof entry.rest !== "boolean") throw monthlyPlanError(`${day} rest setting is invalid.`);
    const targets = monthlyPlanTargets(entry.targets, { rest: entry.rest, context: day });
    if (!Array.isArray(entry.sourceItems) || entry.sourceItems.length > 12)
      throw monthlyPlanError(`${day} can contain at most 12 source exercises.`);
    const sourceItems = entry.sourceItems.map((item) =>
      monthlyPlanExercise(item, `${day} source plan`),
    );
    if (entry.rest && sourceItems.length)
      throw monthlyPlanError(`${day} cannot contain source exercises on a rest day.`);
    validateMonthlyExercises(sourceItems, targets, `${day} source plan`);
    schedule[day] = { rest: entry.rest, targets, sourceItems };
  }
  if (!DAYS.some((day) => schedule[day].rest))
    throw monthlyPlanError("Choose at least one rest day.");
  if (!DAYS.some((day) => !schedule[day].rest))
    throw monthlyPlanError("Choose at least one training day.");

  if (!Array.isArray(input.days) || input.days.length !== 31)
    throw monthlyPlanError("A monthly plan must contain exactly 31 days.");
  const days = input.days.map((entry, index) => {
    const context = `Day ${index + 1}`;
    exactMonthlyKeys(
      entry,
      ["dayNumber", "date", "weekday", "rest", "targets", "exercises"],
      `${context} is invalid.`,
    );
    if (entry.dayNumber !== index + 1)
      throw monthlyPlanError(`${context} has an invalid day number.`);
    const expectedDate = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
    const expectedDateText = expectedDate.toISOString().slice(0, 10);
    if (entry.date !== expectedDateText)
      throw monthlyPlanError(`${context} date must follow the selected start date.`);
    const expectedWeekday = DAYS[(expectedDate.getUTCDay() + 6) % 7];
    if (entry.weekday !== expectedWeekday)
      throw monthlyPlanError(`${context} has an invalid weekday.`);
    if (typeof entry.rest !== "boolean" || entry.rest !== schedule[expectedWeekday].rest)
      throw monthlyPlanError(`${context} does not match the weekly rest schedule.`);
    const targets = monthlyPlanTargets(entry.targets, { rest: entry.rest, context });
    if (!sameMonthlyTargets(targets, schedule[expectedWeekday].targets))
      throw monthlyPlanError(`${context} does not match the weekly muscle-group schedule.`);
    if (!Array.isArray(entry.exercises) || entry.exercises.length > 12)
      throw monthlyPlanError(`${context} can contain at most 12 exercises.`);
    const exercises = entry.exercises.map((item) => monthlyPlanExercise(item, context));
    if (entry.rest && exercises.length)
      throw monthlyPlanError(`${context} cannot contain exercises on a rest day.`);
    if (!entry.rest)
      validateMonthlyExercises(exercises, targets, context, {
        minimumPerTarget: exercisesPerTarget,
      });
    return {
      dayNumber: index + 1,
      date: expectedDateText,
      weekday: expectedWeekday,
      rest: entry.rest,
      targets: schedule[expectedWeekday].targets,
      exercises,
    };
  });

  const stampedAt = Number(generatedAt);
  if (!Number.isSafeInteger(stampedAt) || stampedAt <= 0)
    throw monthlyPlanError("Monthly plan timestamp is invalid.");
  return {
    version: 1,
    title,
    source: input.source,
    startDate,
    exercisesPerTarget,
    schedule,
    days,
    generatedAt: stampedAt,
  };
}

module.exports = {
  DAYS,
  EXERCISES,
  EXERCISE_IDS,
  EQUIPMENT,
  cleanText,
  defaultPlan,
  defaultPreferences,
  planStats,
  sanitizePreferences,
  sanitizeRating,
  sanitizePlan,
  expectedPlanRevision,
  sanitizeMonthlyPlan,
};
