// @ts-check
"use strict";

const { EQUIPMENT, defaultPreferences, sanitizePreferences } = require("./plans");

/**
 * The Athlete Profile is one vocabulary over two stored records. The free
 * `preferences` row holds the ranking lens (goal, level, days, equipment,
 * exercise preferences, limitations). The Strata+ `coaching_profiles` row
 * holds the same training facts under coaching names plus body, energy,
 * schedule, and food fields. When both exist, the coaching profile is the
 * owner of the shared training facts and the preferences row mirrors them;
 * saving either side keeps the other in step so no screen can disagree.
 */
const GOAL_TO_TRAINING_GOAL = Object.freeze({
  hypertrophy: "hypertrophy",
  strength: "strength",
  balanced: "balanced",
  "time-efficient": "balanced",
});
const LEVEL_TO_EXPERIENCE = Object.freeze({
  Beginner: "beginner",
  Intermediate: "intermediate",
  Advanced: "advanced",
});
const EXPERIENCE_TO_LEVEL = Object.freeze({
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
});

/** @param {{goal:string,level:string,equipment:string[],limitations:string[]}} preferences */
function trainingFromPreferences(preferences) {
  return {
    trainingGoal: GOAL_TO_TRAINING_GOAL[preferences.goal] || "balanced",
    experience: LEVEL_TO_EXPERIENCE[preferences.level] || "intermediate",
    availableEquipment: EQUIPMENT.filter((item) => preferences.equipment.includes(item)),
    movementLimitations: [...preferences.limitations],
  };
}

/**
 * @param {{trainingGoal?:string,experience:string,workoutDays:string[],availableEquipment:string[],movementLimitations:string[]}} profile
 * @param {ReturnType<typeof defaultPreferences>} current
 */
function preferencesFromCoaching(profile, current) {
  const trainingGoal = profile.trainingGoal || "balanced";
  // "time-efficient" has no coaching counterpart; keep it when it already means "balanced" here.
  const goal = GOAL_TO_TRAINING_GOAL[current.goal] === trainingGoal ? current.goal : trainingGoal;
  return sanitizePreferences({
    ...current,
    goal,
    level: EXPERIENCE_TO_LEVEL[profile.experience] || current.level,
    days: profile.workoutDays.length,
    equipment: profile.availableEquipment.length ? profile.availableEquipment : [...EQUIPMENT],
    limitations: [...profile.movementLimitations],
  });
}

/**
 * One read model for every client. `training` always answers; `body`,
 * `energy`, `schedule`, and `food` answer only when a coaching profile exists.
 * @param {{preferences:ReturnType<typeof defaultPreferences>,coachingProfile:Record<string,any>|null}} input
 */
function composeAthleteProfile({ preferences, coachingProfile }) {
  const coaching = coachingProfile || null;
  const training = coaching
    ? {
        source: "coaching",
        goal: coaching.trainingGoal || "balanced",
        experience: coaching.experience,
        workoutDays: [...coaching.workoutDays],
        daysPerWeek: coaching.workoutDays.length,
        sessionMinutes: coaching.sessionMinutes,
        equipment: coaching.availableEquipment.length
          ? [...coaching.availableEquipment]
          : [...EQUIPMENT],
        limitations: [...coaching.movementLimitations],
        exercisePreferences: [...preferences.preferences],
        usualExercises: (coaching.usualExercises || []).map(
          (/** @type {Record<string,unknown>} */ item) => ({ ...item }),
        ),
      }
    : {
        source: "preferences",
        goal: GOAL_TO_TRAINING_GOAL[preferences.goal] || "balanced",
        experience: LEVEL_TO_EXPERIENCE[preferences.level] || "intermediate",
        workoutDays: null,
        daysPerWeek: preferences.days,
        sessionMinutes: null,
        equipment: [...preferences.equipment],
        limitations: [...preferences.limitations],
        exercisePreferences: [...preferences.preferences],
        usualExercises: [],
      };
  return {
    version: 1,
    training,
    rankingLens: { ...preferences },
    body: coaching
      ? {
          measurementSystem: coaching.measurementSystem,
          preferredLoadUnit: coaching.preferredLoadUnit,
          age: coaching.age,
          heightCm: coaching.heightCm,
          weightKg: coaching.weightKg,
          bodyFatPercent: coaching.bodyFatPercent,
          sexForEquation: coaching.sexForEquation,
        }
      : null,
    energy: coaching
      ? {
          goal: coaching.goal,
          goalPace: coaching.goalPace,
          dailyMovement: coaching.dailyMovement ?? null,
          additionalActivityMinutesPerWeek: coaching.additionalActivityMinutesPerWeek ?? null,
          additionalActivityIntensity: coaching.additionalActivityIntensity ?? null,
          caloriePattern: coaching.caloriePattern,
          flexibleDay: coaching.flexibleDay,
          macroPreference: coaching.macroPreference,
        }
      : null,
    food: coaching?.mealPreferences || null,
    timeZone: coaching?.timeZone || null,
    coachingRevision: coaching ? Number(coaching.revision) || 0 : 0,
  };
}

/**
 * Keeps the two stored records in step. Listens on the event bus so routes
 * never learn about each other; `now` is injectable for tests.
 * @param {{store:{preferences:(userId:string)=>Promise<any>,upsertPreferences:(userId:string,json:string,updatedAt:number)=>Promise<unknown>,coachingProfile:(userId:string)=>Promise<any>,upsertCoachingProfile:(userId:string,json:string,updatedAt:number,expectedRevision:number)=>Promise<any>},now?:()=>number,logger?:{warn?:Function}|null}} dependencies
 */
function createAthleteProfileSync({ store, now = Date.now, logger = null }) {
  if (!store) throw new TypeError("Athlete profile sync requires the store.");
  /** @param {string} userId */
  async function currentPreferences(userId) {
    const row = await store.preferences(userId);
    if (!row) return { preferences: defaultPreferences(), storedJson: null };
    try {
      return {
        preferences: sanitizePreferences(JSON.parse(String(row.preferences_json))),
        storedJson: String(row.preferences_json),
      };
    } catch {
      return { preferences: defaultPreferences(), storedJson: String(row.preferences_json) };
    }
  }
  /** Preferences changed: mirror the training facts into an existing coaching profile. @param {{userId:string,preferences:any}} payload */
  async function afterPreferencesSaved({ userId, preferences }) {
    const row = await store.coachingProfile(userId);
    if (!row) return { updated: false, reason: "no-coaching-profile" };
    let stored;
    try {
      stored = JSON.parse(String(row.profile_json));
    } catch {
      logger?.warn?.("athlete_profile.coaching_unreadable", { userId });
      return { updated: false, reason: "unreadable" };
    }
    const next = { ...stored, ...trainingFromPreferences(preferences) };
    if (JSON.stringify(next) === JSON.stringify(stored))
      return { updated: false, reason: "unchanged" };
    const saved = await store.upsertCoachingProfile(
      userId,
      JSON.stringify(next),
      now(),
      Number(row.revision),
    );
    return { updated: Boolean(saved), reason: saved ? "synced" : "revision-changed" };
  }
  /** Coaching profile changed: mirror the training facts into the preferences row. @param {{userId:string,profile:any}} payload */
  async function afterCoachingProfileSaved({ userId, profile }) {
    const current = await currentPreferences(userId);
    const next = preferencesFromCoaching(profile, current.preferences),
      nextJson = JSON.stringify(next);
    if (nextJson === JSON.stringify(current.preferences) && current.storedJson !== null)
      return { updated: false, reason: "unchanged" };
    await store.upsertPreferences(userId, nextJson, now());
    return { updated: true, reason: "synced" };
  }
  /** @param {{on:(name:string,handler:(payload:any)=>unknown,key?:string)=>unknown}} events */
  function subscribe(events) {
    events.on("preferences.saved", afterPreferencesSaved, "athlete_profile.preferences");
    events.on("coaching.profile_saved", afterCoachingProfileSaved, "athlete_profile.coaching");
  }
  /** @param {string} userId @param {Record<string,any>|null} coachingProfile */
  async function read(userId, coachingProfile) {
    return composeAthleteProfile({
      preferences: (await currentPreferences(userId)).preferences,
      coachingProfile,
    });
  }
  return Object.freeze({ afterPreferencesSaved, afterCoachingProfileSaved, subscribe, read });
}

module.exports = {
  GOAL_TO_TRAINING_GOAL,
  LEVEL_TO_EXPERIENCE,
  EXPERIENCE_TO_LEVEL,
  composeAthleteProfile,
  createAthleteProfileSync,
  preferencesFromCoaching,
  trainingFromPreferences,
};
