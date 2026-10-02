// @ts-check
"use strict";

const { createHash } = require("node:crypto");
const { DAYS, EXERCISES, sanitizePlan } = require("./plans");
const { progressionForWorkout, formatKey } = require("./progression");

const EXERCISE_BY_ID = new Map(EXERCISES.map((exercise) => [exercise.id, exercise]));

/** @typedef {Record<string,any>} AnyRecord */
/** @typedef {{difficulty:number,energy:number,comfort:number,enjoyment:number,updatedAt?:number}} CheckIn */

/** @param {string} message @param {number} [status] @param {string} [code] */
function trainingError(message, status = 400, code = "INVALID_TRAINING_REQUEST") {
  return Object.assign(new Error(message), { status, code });
}
/** @param {unknown} value @param {string} label @returns {AnyRecord} */
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw trainingError(`${label} must be an object.`);
  return value;
}
/** @param {unknown} value @param {number} min @param {number} max @param {string} label @returns {number} */
function integer(value, min, max, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw trainingError(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
/** @param {unknown} value @param {number} min @param {number} max @param {string} label @returns {string} */
function text(value, min, max, label) {
  if (typeof value !== "string") throw trainingError(`${label} is invalid.`);
  const clean = value.trim().replace(/[ \t]+/g, " ");
  if (clean.length < min || clean.length > max || /[\u0000-\u001f\u007f]/.test(clean))
    throw trainingError(`${label} must be between ${min} and ${max} characters.`);
  return clean;
}
/** @param {unknown} value @returns {string} */
function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw trainingError("Training block start date must use YYYY-MM-DD.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    parsed.getUTCFullYear() < 1900 ||
    parsed.getUTCFullYear() > 2200
  )
    throw trainingError("Training block start date is invalid.");
  return value;
}

/** @param {unknown} value @returns {CheckIn} */
function sanitizeCheckIn(value) {
  const input = object(value, "Check-in");
  return {
    difficulty: integer(input.difficulty, 1, 5, "Difficulty"),
    energy: integer(input.energy, 1, 5, "Energy"),
    comfort: integer(input.comfort, 1, 5, "Comfort"),
    enjoyment: integer(input.enjoyment, 1, 5, "Enjoyment"),
  };
}

/** @param {number} weeks @param {number|null} lightWeek */
function defaultMilestones(weeks, lightWeek) {
  const milestones = [{ week: 1, label: "Establish a repeatable baseline" }];
  if (lightWeek && lightWeek !== 1 && lightWeek !== weeks)
    milestones.push({ week: lightWeek, label: "Use the planned lighter week" });
  if (weeks > 1)
    milestones.push({
      week: weeks,
      label:
        lightWeek === weeks
          ? "Use the lighter week, then review results"
          : "Review results and choose the next block",
    });
  return milestones;
}

/** @param {unknown} value */
function sanitizeTrainingBlock(value) {
  const input = object(value, "Training block"),
    weeks = integer(input.weeks, 4, 8, "Block length");
  if (input.version !== undefined && input.version !== 1)
    throw trainingError("Training block version is unsupported.");
  const currentWeek = integer(input.currentWeek ?? 1, 1, weeks, "Current week");
  const lightWeek =
    input.lightWeek == null ? null : integer(input.lightWeek, 2, weeks, "Lighter week");
  const goals = ["hypertrophy", "strength", "balanced", "time-efficient", "consistency"];
  const rules = ["reps-then-load", "reps-only", "time"];
  if (!goals.includes(input.goal)) throw trainingError("Training block goal is invalid.");
  if (!rules.includes(input.progressionRule)) throw trainingError("Progression rule is invalid.");
  if (!["active", "completed"].includes(input.status))
    throw trainingError("Training block status is invalid.");
  if (input.status === "completed" && currentWeek !== weeks)
    throw trainingError("Move to the final week before completing this training block.");
  const rawMilestones = input.milestones ?? defaultMilestones(weeks, lightWeek);
  if (!Array.isArray(rawMilestones) || rawMilestones.length < 1 || rawMilestones.length > 8)
    throw trainingError("Add between 1 and 8 block milestones.");
  const seen = new Set();
  const milestones = rawMilestones
    .map((entry) => {
      const milestone = object(entry, "Milestone"),
        week = integer(milestone.week, 1, weeks, "Milestone week");
      if (seen.has(week)) throw trainingError("Each milestone must use a different week.");
      seen.add(week);
      return { week, label: text(milestone.label, 1, 80, "Milestone label") };
    })
    .sort((a, b) => a.week - b.week);
  return {
    version: 1,
    title: text(input.title, 1, 80, "Training block title"),
    goal: input.goal,
    weeks,
    currentWeek,
    lightWeek,
    startDate: date(input.startDate),
    status: input.status,
    progressionRule: input.progressionRule,
    milestones,
  };
}

/** @param {AnyRecord|null|undefined} row */
function checkInPayload(row) {
  if (!row) return null;
  return {
    workoutId: String(row.workout_id),
    difficulty: Number(row.difficulty),
    energy: Number(row.energy),
    comfort: Number(row.comfort),
    enjoyment: Number(row.enjoyment),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
/** @param {AnyRecord|null|undefined} row */
function blockPayload(row) {
  if (!row) return null;
  try {
    return {
      ...sanitizeTrainingBlock(JSON.parse(String(row.block_json))),
      revision: Number(row.revision),
      updatedAt: Number(row.updated_at),
    };
  } catch {
    return null;
  }
}
/** @param {AnyRecord|null|undefined} row */
function adaptationPayload(row) {
  if (!row) return null;
  try {
    const stored = object(JSON.parse(String(row.adaptation_json)), "Adaptation");
    return {
      id: String(row.id),
      sourceWorkoutId: String(row.workout_id),
      status: String(row.status),
      kind: String(stored.kind),
      title: String(stored.title),
      explanation: String(stored.explanation),
      change: stored.change,
      requiresApproval: true,
      expectedPlanUpdatedAt: Number(row.plan_updated_at),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
    };
  } catch {
    return null;
  }
}
/** @param {AnyRecord|null|undefined} row @returns {AnyRecord|null} */
function workoutFromRow(row) {
  if (!row) return null;
  try {
    return JSON.parse(String(row.workout_json));
  } catch {
    return null;
  }
}
/** @param {AnyRecord} row @returns {AnyRecord|null} */
function summaryFromRow(row) {
  try {
    return JSON.parse(String(row.summary_json));
  } catch {
    return null;
  }
}
/** @param {string} userId @param {string} workoutId */
function adaptationId(userId, workoutId) {
  return `adapt_${createHash("sha256").update(`${userId}\0${workoutId}`).digest("hex").slice(0, 24)}`;
}

/** @param {{workout:AnyRecord,plan:AnyRecord,planUpdatedAt:number,checkIn:CheckIn}} input */
function adaptationForFeedback({ workout, plan, planUpdatedAt, checkIn }) {
  let signal = "";
  if (checkIn.comfort <= 2) signal = `You marked comfort ${checkIn.comfort}/5`;
  else if (checkIn.difficulty >= 5) signal = `You marked difficulty ${checkIn.difficulty}/5`;
  else if (checkIn.energy <= 2) signal = `You marked energy ${checkIn.energy}/5`;
  if (!signal) return null;
  const exerciseIds = new Set(
    workout.entries
      .filter((/** @type {AnyRecord} */ entry) =>
        entry.sets.some((/** @type {AnyRecord} */ set) => set.completed),
      )
      .map((/** @type {AnyRecord} */ entry) => entry.exerciseId),
  );
  const orderedDays = DAYS.includes(workout.planDay)
    ? [workout.planDay, ...DAYS.filter((day) => day !== workout.planDay)]
    : DAYS;
  for (const day of orderedDays) {
    const index = plan.days[day].findIndex(
      (/** @type {AnyRecord} */ item) => exerciseIds.has(item.exerciseId) && item.sets > 1,
    );
    if (index < 0) continue;
    const item = plan.days[day][index];
    const name = EXERCISE_BY_ID.get(item.exerciseId)?.name || item.exerciseId;
    return {
      kind: "reduce_sets",
      title: `Reduce one set of ${name}`,
      explanation: `${signal}. This optional change reduces the next planned dose; it does not diagnose recovery or injury.`,
      change: {
        day,
        instanceId: item.instanceId,
        exerciseId: item.exerciseId,
        fromSets: item.sets,
        toSets: item.sets - 1,
      },
      expectedPlanUpdatedAt: planUpdatedAt,
      checkInUpdatedAt: Number.isSafeInteger(checkIn.updatedAt) ? checkIn.updatedAt : null,
    };
  }
  return null;
}

/** @param {unknown} value @param {unknown} adaptation */
function planWithAdaptation(value, adaptation) {
  const current = sanitizePlan(value),
    stored = object(adaptation, "Adaptation"),
    change = object(stored.change, "Adaptation change");
  const day = String(change.day || "");
  if (stored.kind !== "reduce_sets" || !DAYS.includes(day))
    throw trainingError("Stored training change is invalid.");
  const instanceId = text(change.instanceId, 6, 100, "Plan item"),
    exerciseId = text(change.exerciseId, 1, 80, "Exercise"),
    fromSets = integer(change.fromSets, 2, 10, "Current sets"),
    toSets = integer(change.toSets, 1, 9, "Proposed sets");
  if (!EXERCISE_BY_ID.has(exerciseId) || toSets !== fromSets - 1)
    throw trainingError("Stored training change is invalid.");
  const items = current.days[day] || [],
    index = items.findIndex(
      (item) => item.instanceId === instanceId && item.exerciseId === exerciseId,
    ),
    item = items[index];
  if (!item || item.sets !== fromSets)
    throw trainingError("The planned exercise no longer matches this proposal.");
  const next = JSON.parse(JSON.stringify(current));
  next.days[day][index] = { ...item, sets: toSets };
  return sanitizePlan(next);
}

/**
 * @param {import("./domain-types").TrainingServiceDependencies} dependencies
 * @returns {import("./domain-types").TrainingService}
 */
function createTrainingService({
  store,
  auth,
  requireAccess,
  trustedOrigin,
  rateAllowed,
  http,
  events = null,
}) {
  if (
    !store ||
    !auth ||
    typeof requireAccess !== "function" ||
    typeof trustedOrigin !== "function" ||
    typeof rateAllowed !== "function" ||
    !http
  )
    throw new TypeError(
      "Training service requires storage, access guards, rate limiting, and HTTP helpers.",
    );
  const { json, bodyJson } = http;
  /** @param {string} userId @param {string} id */
  async function completedWorkout(userId, id) {
    const workout = workoutFromRow(await store.workout(userId, id));
    if (!workout) throw trainingError("Workout not found.", 404, "WORKOUT_NOT_FOUND");
    if (workout.status !== "completed")
      throw trainingError(
        "Finish this workout before adding a check-in or progression target.",
        409,
        "WORKOUT_NOT_COMPLETED",
      );
    return workout;
  }
  /** Resolve the newest full prior workout for each format, including sources beyond the first history page.
   * @param {string} userId @param {AnyRecord} workout */
  async function previousWorkouts(userId, workout) {
    const pending = new Set(
        workout.entries.map((/** @type {AnyRecord} */ entry) => formatKey(entry)),
      ),
      seen = new Set(),
      history = /** @type {AnyRecord[]} */ ([]);
    let offset = 0,
      exhausted = false;
    while (pending.size && offset < 5000 && !exhausted) {
      const rows = await store.workouts(userId, 100, offset);
      offset += rows.length;
      exhausted = rows.length < 100;
      for (const row of rows) {
        const summary = summaryFromRow(row),
          id =
            typeof summary?.id === "string"
              ? summary.id
              : typeof row.id === "string"
                ? row.id
                : null;
        // An unidentifiable row cannot safely be skipped for an older success.
        if (!id) return { history, limited: false };
        if (seen.has(id) || id === workout.id) continue;
        seen.add(id);
        const validIndex =
          Array.isArray(summary?.exerciseSummaries) &&
          summary.exerciseSummaries.length > 0 &&
          summary.exerciseSummaries.every(
            (/** @type {AnyRecord} */ entry) =>
              entry &&
              typeof entry === "object" &&
              typeof entry.exerciseId === "string" &&
              ["reps", "timed"].includes(entry.measurement) &&
              ["external", "bodyweight", "assisted"].includes(entry.loadType) &&
              ["kg", "lb"].includes(entry.unit),
          );
        let previous = null;
        const usableSummary =
          summary &&
          Number.isSafeInteger(summary.startedAt) &&
          typeof summary.date === "string" &&
          ["active", "completed"].includes(summary.status);
        if (!validIndex || !usableSummary)
          previous = workoutFromRow(await store.workout(userId, id));
        const source = usableSummary ? summary : previous;
        if (!source) return { history, limited: false };
        if (
          source.status !== "completed" ||
          Number(source.startedAt) >= Number(workout.startedAt) ||
          String(source.date) >= String(workout.date)
        )
          continue;
        const index = validIndex ? summary.exerciseSummaries : previous?.entries;
        if (
          !Array.isArray(index) ||
          !index.length ||
          index.some(
            (/** @type {AnyRecord} */ entry) =>
              !entry ||
              typeof entry !== "object" ||
              typeof entry.exerciseId !== "string" ||
              !["reps", "timed"].includes(entry.measurement) ||
              !["external", "bodyweight", "assisted"].includes(entry.loadType) ||
              !["kg", "lb"].includes(entry.unit),
          )
        )
          return { history, limited: false };
        const formats = index
          .filter((/** @type {AnyRecord} */ entry) => entry && typeof entry === "object")
          .map((/** @type {AnyRecord} */ entry) => formatKey(entry))
          .filter((/** @type {string} */ key) => pending.has(key));
        if (!formats.length) continue;
        if (!previous) previous = workoutFromRow(await store.workout(userId, id));
        // Only this row's newly resolved formats may contribute evidence. Otherwise
        // loading an older workout for B could revive stale A after A's source vanished.
        if (previous && previous.id === id && Array.isArray(previous.entries))
          history.push({
            ...previous,
            entries: previous.entries.filter(
              (/** @type {AnyRecord} */ entry) =>
                entry && typeof entry === "object" && formats.includes(formatKey(entry)),
            ),
          });
        formats.forEach((/** @type {string} */ key) => pending.delete(key));
      }
    }
    return { history, limited: pending.size > 0 && !exhausted };
  }
  /** @param {string} userId @param {AnyRecord} workout @param {CheckIn|null} [checkIn] */
  async function progression(userId, workout, checkIn = null) {
    const [{ history, limited }, blockRow] = await Promise.all([
      previousWorkouts(userId, workout),
      store.trainingBlock(userId),
    ]);
    const block = blockPayload(blockRow),
      activeBlock = block?.status === "active" ? block : null;
    const result = progressionForWorkout(
      workout,
      history,
      checkIn,
      activeBlock?.progressionRule,
      Boolean(activeBlock && activeBlock.lightWeek === activeBlock.currentWeek),
    );
    return {
      ...result,
      historyLimited: limited,
      suggestions: result.suggestions.map((suggestion) =>
        limited
          ? {
              ...suggestion,
              explanation: `${suggestion.explanation} Only the 5,000 most recent saved sessions were checked.`,
            }
          : suggestion,
      ),
    };
  }
  /** @param {string} userId */
  async function latestProgression(userId) {
    const rows = await store.workouts(userId, 100, 0);
    const latest = rows.map(summaryFromRow).find((summary) => summary?.status === "completed");
    if (!latest) return null;
    const workout = workoutFromRow(await store.workout(userId, String(latest.id)));
    if (!workout) return null;
    const checkIn = checkInPayload(await store.workoutCheckIn(userId, workout.id));
    return progression(userId, workout, checkIn);
  }
  /** @param {string} userId @param {AnyRecord} workout @param {CheckIn} checkIn @param {number} now */
  async function maybeCreateAdaptation(userId, workout, checkIn, now) {
    const planRow = await store.plan(userId);
    if (!planRow) return null;
    const checkInUpdatedAt = Number(checkIn.updatedAt);
    if (!Number.isSafeInteger(checkInUpdatedAt) || checkInUpdatedAt < 1) return null;
    let plan;
    try {
      plan = sanitizePlan(JSON.parse(String(planRow.plan_json)));
    } catch {
      return null;
    }
    const planUpdatedAt = Number(planRow.updated_at),
      proposal = adaptationForFeedback({ workout, plan, planUpdatedAt, checkIn });
    if (!proposal) return null;
    const id = adaptationId(userId, workout.id);
    return adaptationPayload(
      await store.upsertTrainingAdaptation({
        userId,
        id,
        workoutId: workout.id,
        adaptationJson: JSON.stringify(proposal),
        planUpdatedAt,
        createdAt: now,
        checkInUpdatedAt,
      }),
    );
  }
  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").SessionRow} session */
  function validMutation(req, session) {
    if (!trustedOrigin(req))
      throw trainingError(
        "Training security check failed. Refresh and try again.",
        403,
        "TRAINING_ORIGIN_REQUIRED",
      );
    if (!auth.validCsrf(req, session))
      throw trainingError("Security check failed. Refresh and try again.", 403, "INVALID_CSRF");
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || "")))
      throw trainingError("Training updates must use JSON.", 415, "JSON_REQUIRED");
  }
  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {import("./domain-types").SessionRow} session @param {string} id */
  async function resolveAdaptation(req, res, session, id) {
    const input = object(await bodyJson(req), "Request"),
      decision = input.decision;
    if (!["accept", "dismiss"].includes(decision))
      throw trainingError("Choose accept or dismiss.", 400, "INVALID_ADAPTATION_DECISION");
    const current = await store.trainingAdaptation(session.id, id);
    if (!current) throw trainingError("Training proposal not found.", 404, "ADAPTATION_NOT_FOUND");
    if (current.status !== "pending")
      throw trainingError(
        "This training proposal was already resolved.",
        409,
        "ADAPTATION_RESOLVED",
      );
    const now = Date.now();
    if (decision === "dismiss") {
      const dismissed = adaptationPayload(
        await store.dismissTrainingAdaptation(session.id, id, now),
      );
      if (!dismissed)
        throw trainingError(
          "This training proposal changed. Refresh and try again.",
          409,
          "ADAPTATION_CHANGED",
        );
      json(res, 200, { adaptation: dismissed, planUpdatedAt: null });
      return;
    }
    const expectedPlanUpdatedAt = integer(
      input.expectedPlanUpdatedAt,
      1,
      Number.MAX_SAFE_INTEGER,
      "Expected plan version",
    );
    let stored;
    try {
      stored = object(JSON.parse(String(current.adaptation_json)), "Adaptation");
    } catch {
      throw trainingError(
        "This training proposal is unavailable. Dismiss it and continue with your current plan.",
        409,
        "ADAPTATION_UNAVAILABLE",
      );
    }
    if (
      expectedPlanUpdatedAt !== Number(current.plan_updated_at) ||
      expectedPlanUpdatedAt !== Number(stored.expectedPlanUpdatedAt)
    )
      throw trainingError(
        "Your plan changed after this proposal. Review the latest plan before applying it.",
        409,
        "PLAN_CHANGED",
      );
    const expectedCheckInUpdatedAt = Number(stored.checkInUpdatedAt);
    if (!Number.isSafeInteger(expectedCheckInUpdatedAt) || expectedCheckInUpdatedAt < 1)
      throw trainingError(
        "This training proposal is unavailable. Dismiss it and continue with your current plan.",
        409,
        "ADAPTATION_UNAVAILABLE",
      );
    const latestCheckIn = await store.workoutCheckIn(session.id, String(current.workout_id));
    if (!latestCheckIn || Number(latestCheckIn.updated_at) !== expectedCheckInUpdatedAt)
      throw trainingError(
        "Your check-in changed after this proposal. Review or dismiss the proposal before continuing.",
        409,
        "CHECK_IN_CHANGED",
      );
    const planRow = await store.plan(session.id);
    if (!planRow || Number(planRow.updated_at) !== expectedPlanUpdatedAt)
      throw trainingError(
        "Your plan changed after this proposal. Review the latest plan before applying it.",
        409,
        "PLAN_CHANGED",
      );
    let proposedPlan;
    try {
      proposedPlan = planWithAdaptation(JSON.parse(String(planRow.plan_json)), stored);
    } catch {
      throw trainingError(
        "This training proposal no longer matches your plan. Dismiss it and continue with the current plan.",
        409,
        "ADAPTATION_UNAVAILABLE",
      );
    }
    const accepted = await store.acceptTrainingAdaptation({
      userId: session.id,
      id,
      planJson: JSON.stringify(proposedPlan),
      expectedPlanUpdatedAt,
      expectedCheckInUpdatedAt,
      resolvedAt: now,
    });
    if (!accepted)
      throw trainingError(
        "Your plan or proposal changed. Refresh before applying it.",
        409,
        "ADAPTATION_CHANGED",
      );
    await events?.emit("plan.updated", {
      userId: session.id,
      plan: proposedPlan,
      updatedAt: Number(accepted.plan.updated_at),
      source: "system",
      detail: "adaptation",
    });
    json(res, 200, {
      adaptation: adaptationPayload(accepted.adaptation),
      plan: proposedPlan,
      planUpdatedAt: Number(accepted.plan.updated_at),
    });
  }
  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {URL} url */
  async function handleApi(req, res, url) {
    const checkInMatch = url.pathname.match(/^\/api\/workouts\/([A-Za-z0-9_-]{1,100})\/check-in$/);
    const progressionMatch = url.pathname.match(
      /^\/api\/workouts\/([A-Za-z0-9_-]{1,100})\/progression$/,
    );
    const adaptationMatch = url.pathname.match(
      /^\/api\/training\/adaptations\/([A-Za-z0-9_-]{1,100})$/,
    );
    const recognized = Boolean(
      checkInMatch ||
      progressionMatch ||
      adaptationMatch ||
      [
        "/api/training",
        "/api/training-block",
        "/api/training/progression/latest",
        "/api/training/adaptations/latest",
      ].includes(url.pathname),
    );
    if (!recognized) return false;
    const session = await requireAccess(req, res);
    if (!session) return true;
    try {
      const allowed = checkInMatch
        ? ["GET", "POST"]
        : progressionMatch
          ? ["GET"]
          : adaptationMatch
            ? ["POST"]
            : url.pathname === "/api/training-block"
              ? ["GET", "PUT"]
              : ["GET"];
      if (!allowed.includes(String(req.method))) {
        json(res, 405, { error: "Method not allowed." }, { Allow: allowed.join(", ") });
        return true;
      }
      const write = req.method !== "GET";
      if (
        !(await rateAllowed(
          req,
          `identity:training:${write ? "write" : "read"}:${session.id}`,
          write ? 120 : 240,
          60000,
        ))
      )
        throw trainingError(
          "Too many training requests. Wait a moment and retry.",
          429,
          "TRAINING_RATE_LIMIT",
        );
      if (write) validMutation(req, session);
      if (checkInMatch) {
        const workout = await completedWorkout(session.id, String(checkInMatch[1]));
        if (req.method === "POST") {
          const input = object(await bodyJson(req), "Request"),
            checkIn = sanitizeCheckIn(input.checkIn),
            now = Date.now();
          const saved = checkInPayload(
            await store.upsertWorkoutCheckIn({
              userId: session.id,
              workoutId: workout.id,
              ...checkIn,
              createdAt: now,
              updatedAt: now,
            }),
          );
          if (!saved)
            throw trainingError(
              "Workout changed before the check-in could be saved.",
              409,
              "WORKOUT_CHANGED",
            );
          const adaptation = await maybeCreateAdaptation(session.id, workout, saved, now);
          if (!adaptation)
            await store.dismissTrainingAdaptation(
              session.id,
              adaptationId(session.id, workout.id),
              now,
              saved.updatedAt,
            );
          json(res, 200, {
            checkIn: saved,
            progression: await progression(session.id, workout, saved),
            adaptation,
            csrfToken: session.csrf_token,
          });
          return true;
        }
        const saved = checkInPayload(await store.workoutCheckIn(session.id, workout.id));
        const proposal = await store.trainingAdaptation(
          session.id,
          adaptationId(session.id, workout.id),
        );
        json(res, 200, {
          checkIn: saved,
          progression: await progression(session.id, workout, saved),
          adaptation: proposal?.status === "pending" ? adaptationPayload(proposal) : null,
          csrfToken: session.csrf_token,
        });
        return true;
      }
      if (progressionMatch) {
        const workout = await completedWorkout(session.id, String(progressionMatch[1]));
        const checkIn = checkInPayload(await store.workoutCheckIn(session.id, workout.id));
        json(res, 200, {
          progression: await progression(session.id, workout, checkIn),
          checkIn,
          csrfToken: session.csrf_token,
        });
        return true;
      }
      if (adaptationMatch) {
        await resolveAdaptation(req, res, session, String(adaptationMatch[1]));
        return true;
      }
      if (url.pathname === "/api/training-block") {
        if (req.method === "PUT") {
          const input = object(await bodyJson(req), "Request"),
            expectedRevision = integer(
              input.expectedRevision,
              0,
              Number.MAX_SAFE_INTEGER,
              "Expected block version",
            );
          if (input.expectedUserId !== undefined && input.expectedUserId !== session.id)
            throw trainingError(
              "Your account changed. Reload before saving this training block.",
              409,
              "TRAINING_ACCOUNT_CHANGED",
            );
          const block = sanitizeTrainingBlock(input.block),
            saved = await store.upsertTrainingBlock(
              { userId: session.id, blockJson: JSON.stringify(block), updatedAt: Date.now() },
              expectedRevision,
            );
          if (!saved) {
            json(res, 409, {
              error:
                "This training block changed elsewhere. Review the latest version before saving.",
              code: "TRAINING_BLOCK_CHANGED",
              block: blockPayload(await store.trainingBlock(session.id)),
            });
            return true;
          }
          json(res, 200, {
            block: blockPayload(saved),
            adaptation: adaptationPayload(await store.latestTrainingAdaptation(session.id)),
            csrfToken: session.csrf_token,
          });
          return true;
        }
        json(res, 200, {
          block: blockPayload(await store.trainingBlock(session.id)),
          adaptation: adaptationPayload(await store.latestTrainingAdaptation(session.id)),
          csrfToken: session.csrf_token,
        });
        return true;
      }
      const adaptationRow = await store.latestTrainingAdaptation(session.id),
        adaptation = adaptationPayload(adaptationRow);
      if (url.pathname === "/api/training/adaptations/latest") {
        json(res, 200, { adaptation, csrfToken: session.csrf_token });
        return true;
      }
      if (url.pathname === "/api/training/progression/latest") {
        json(res, 200, {
          progression: await latestProgression(session.id),
          csrfToken: session.csrf_token,
        });
        return true;
      }
      let latest = null;
      if (adaptationRow) {
        const source = workoutFromRow(
          await store.workout(session.id, String(adaptationRow.workout_id)),
        );
        const sourceCheckIn =
          source && checkInPayload(await store.workoutCheckIn(session.id, source.id));
        if (source && sourceCheckIn) latest = await progression(session.id, source, sourceCheckIn);
      }
      if (!latest) latest = await latestProgression(session.id);
      json(res, 200, {
        block: blockPayload(await store.trainingBlock(session.id)),
        progression: latest,
        adaptation,
        csrfToken: session.csrf_token,
      });
    } catch (error) {
      const failure = /** @type {Error&{status?:number,code?:string}} */ (error);
      if (!failure.status) throw error;
      json(res, failure.status, {
        error: failure.message,
        code: failure.code || "INVALID_TRAINING_REQUEST",
      });
    }
    return true;
  }
  return { handleApi };
}

module.exports = {
  adaptationForFeedback,
  createTrainingService,
  planWithAdaptation,
  progressionForWorkout,
  sanitizeCheckIn,
  sanitizeTrainingBlock,
};
