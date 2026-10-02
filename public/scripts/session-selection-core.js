/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataSessionSelection = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SESSION_SELECTION_MODES = Object.freeze({
    random: Object.freeze({
      label: "Random",
      description:
        "Shuffle eligible exercises while keeping your session focus and movement constraints.",
    }),
    "not-in-week": Object.freeze({
      label: "Not in my week",
      description:
        "Choose only exercises that are absent from every day in your saved weekly plan.",
    }),
    "needs-focus": Object.freeze({
      label: "Needs focus",
      description:
        "Prioritize muscle targets with fewer completed sets in your last 28 days of saved workouts.",
    }),
    preferences: Object.freeze({
      label: "My preferences",
      description:
        "Use your shortlist, your own ratings, and the muscle targets you repeatedly train.",
    }),
  });
  const DAY_MS = 86_400_000;
  const list = (value) => (Array.isArray(value) ? value : []);
  const targetKey = (exercise) => `${exercise.group}:${exercise.sub}`;
  const add = (map, key, value = 1) => map.set(key, (map.get(key) || 0) + value);
  const skipped = (value) =>
    value?.skipped === true || ["skipped", "draft"].includes(value?.status);

  function sessionMuscleTargets(exercises, focus, muscleGroup, focusMatches) {
    return [
      ...new Set(
        list(exercises)
          .filter(
            (exercise) =>
              focusMatches(exercise, focus) &&
              (muscleGroup === "all" || exercise.group === muscleGroup),
          )
          .map((exercise) => exercise.sub)
          .filter(Boolean),
      ),
    ];
  }
  function dateOrdinal(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp / DAY_MS : null;
  }
  function localOrdinal(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime())
      ? Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
      : null;
  }
  function completedRows(workout) {
    if (Array.isArray(workout.exerciseSummaries)) return workout.exerciseSummaries;
    return list(workout.entries)
      .filter((entry) => !skipped(entry))
      .map((entry) => ({
        exerciseId: entry.exerciseId,
        completedSets: list(entry.sets).filter((set) => set?.completed === true && !skipped(set))
          .length,
      }));
  }
  function historyEvidence(exercises, workouts, available, now) {
    const catalog = new Map(exercises.map((exercise) => [exercise.id, exercise])),
      recentSets = new Map(),
      exerciseSessions = new Map(),
      targetSessions = new Map(),
      groupSessions = new Map(),
      seen = new Set();
    const today = localOrdinal(now) ?? localOrdinal(new Date());
    for (const workout of available ? list(workouts) : []) {
      if (!workout || workout.status !== "completed" || skipped(workout)) continue;
      if (workout.id && seen.has(workout.id)) continue;
      if (workout.id) seen.add(workout.id);
      const date = workout.date
        ? dateOrdinal(workout.date)
        : localOrdinal(workout.completedAt ?? workout.startedAt);
      if (date === null || date > today) continue;
      const usedExercises = new Set(),
        usedTargets = new Set(),
        usedGroups = new Set();
      for (const row of completedRows(workout)) {
        const exercise = catalog.get(row?.exerciseId),
          sets = Number(row?.completedSets);
        if (!exercise || skipped(row) || !Number.isSafeInteger(sets) || sets <= 0) continue;
        const target = targetKey(exercise);
        if (date >= today - 27) add(recentSets, target, sets);
        usedExercises.add(exercise.id);
        usedTargets.add(target);
        usedGroups.add(exercise.group);
      }
      usedExercises.forEach((id) => add(exerciseSessions, id));
      usedTargets.forEach((key) => add(targetSessions, key));
      usedGroups.forEach((group) => add(groupSessions, group));
    }
    return { recentSets, exerciseSessions, targetSessions, groupSessions };
  }
  function personalEvidence(exercises, userRatings, shortlist, history) {
    const saved = new Set(list(shortlist)),
      ratings = new Map(),
      targetAffinity = new Map(),
      groupAffinity = new Map();
    for (const exercise of exercises) {
      const raw = typeof userRatings?.get === "function" ? userRatings.get(exercise.id) : null;
      const values = [raw?.overall, raw?.enjoyment]
        .map(Number)
        .filter((value) => Number.isFinite(value) && value >= 1 && value <= 5);
      const rating = values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;
      if (rating !== null) ratings.set(exercise.id, rating);
      const affinity = (saved.has(exercise.id) ? 1 : 0) + (rating !== null ? rating - 3 : 0);
      if (affinity) {
        add(targetAffinity, targetKey(exercise), affinity);
        add(groupAffinity, exercise.group, affinity);
      }
    }
    const score = (exercise) => {
      const rating = ratings.get(exercise.id),
        times = history.exerciseSessions.get(exercise.id) || 0,
        target = targetKey(exercise);
      return (
        (saved.has(exercise.id) ? 100 : 0) +
        (rating === undefined ? 0 : (rating - 3) * 45) +
        (times >= 2 ? Math.min(times, 10) * 9 : 0) +
        (targetAffinity.get(target) || 0) * 12 +
        (groupAffinity.get(exercise.group) || 0) * 3 +
        Math.min(Math.max((history.targetSessions.get(target) || 0) - 1, 0), 10) * 3 +
        Math.min(Math.max((history.groupSessions.get(exercise.group) || 0) - 1, 0), 10)
      );
    };
    const reason = (exercise) => {
      const rating = ratings.get(exercise.id),
        times = history.exerciseSessions.get(exercise.id) || 0,
        target = targetKey(exercise);
      if (rating !== undefined && rating < 3)
        return [
          `your own average overall / enjoyment rating is ${Math.round(rating * 10) / 10}/5`,
          saved.has(exercise.id) ? "saved to your shortlist" : "",
          times >= 2 ? `completed in ${times} of your saved sessions` : "",
        ]
          .filter(Boolean)
          .join("; ");
      if (saved.has(exercise.id)) return "saved to your shortlist";
      if (rating !== undefined && rating > 3)
        return `your own average overall / enjoyment rating is ${Math.round(rating * 10) / 10}/5`;
      if (times >= 2) return `completed in ${times} of your saved sessions`;
      if ((targetAffinity.get(target) || 0) > 0)
        return `matches ${exercise.sub.toLowerCase()} targets you save or rate highly`;
      if ((history.targetSessions.get(target) || 0) >= 2)
        return `matches ${exercise.sub.toLowerCase()} targets you repeatedly train`;
      if ((groupAffinity.get(exercise.group) || 0) > 0)
        return `matches ${exercise.group} exercises you save or rate highly`;
      if ((history.groupSessions.get(exercise.group) || 0) >= 2)
        return `matches the ${exercise.group} group you repeatedly train`;
      return "fits your saved training profile; no stronger personal signal for this session role";
    };
    const hasSignal = (candidates) =>
      candidates.some(
        (exercise) =>
          saved.has(exercise.id) ||
          ratings.has(exercise.id) ||
          targetAffinity.get(targetKey(exercise)) ||
          groupAffinity.get(exercise.group) ||
          history.exerciseSessions.get(exercise.id) >= 2 ||
          history.targetSessions.get(targetKey(exercise)) >= 2 ||
          history.groupSessions.get(exercise.group) >= 2,
      );
    return { score, reason, hasSignal };
  }
  function selectionNote(mode, { weekIds, historyAvailable, hasMore, hasRecent, hasPreferences }) {
    if (mode === "random")
      return "Random choices within your selected focus, equipment, and movement constraints. Build again for another shuffle.";
    if (mode === "not-in-week")
      return weekIds.size
        ? "Every exercise is absent from all seven days of your saved weekly plan."
        : "Your saved weekly plan is empty, so all eligible exercises can be included.";
    const partial = hasMore
      ? " Uses only the loaded workout history; older sessions may be missing."
      : "";
    if (mode === "needs-focus") {
      if (!historyAvailable)
        return "Workout history is unavailable. Using your saved training profile until completed workout data is available.";
      if (!hasRecent)
        return `No completed sets were found for this focus in the last 28 days. Using your saved training profile until there is enough history.${partial}`;
      return `Prioritizes muscle targets with fewer completed sets in the last 28 calendar days, within each session role. Counts describe logged training, not recovery.${partial}`;
    }
    if (!hasPreferences)
      return `No shortlist, own ratings, or repeated completed choices match this focus yet. Using your saved training profile.${historyAvailable ? partial : " Workout history is unavailable."}`;
    return `Uses your shortlist, your own ratings, and repeated completed choices where available.${historyAvailable ? partial : " Workout history is unavailable; using your saved choices and ratings."}`;
  }
  function filteredRoles(candidates, count, muscleGroup, muscleTarget) {
    const groups = [...new Set(candidates.map(({ exercise }) => exercise.group))],
      label = muscleTarget !== "all" ? muscleTarget : muscleGroup;
    return Array.from({ length: count }, (_, index) => ({
      key: `muscle-${index + 1}`,
      label: `${label.charAt(0).toUpperCase() + label.slice(1)} movement ${index + 1}`,
      groups,
      ...(muscleTarget !== "all" ? { include: [muscleTarget.toLowerCase()] } : {}),
    }));
  }
  function buildSession(
    {
      exercises,
      preferences,
      focus = "full",
      minutes = 35,
      selectionMode,
      muscleGroup = "all",
      muscleTarget = "all",
      weeklyPlan = null,
      workouts = [],
      workoutHistoryAvailable = false,
      workoutHistoryHasMore = false,
      userRatings = new Map(),
      shortlist = [],
      now = new Date(),
      random = Math.random,
    } = {},
    core,
  ) {
    const focusConfig = Object.hasOwn(core.SESSION_FOCUSES, focus)
        ? core.SESSION_FOCUSES[focus]
        : null,
      lengthConfig = core.SESSION_LENGTHS[Number(minutes)],
      modeConfig = Object.hasOwn(SESSION_SELECTION_MODES, selectionMode)
        ? SESSION_SELECTION_MODES[selectionMode]
        : null;
    if (!focusConfig)
      throw core.sessionError("Choose a valid session focus.", "INVALID_SESSION_FOCUS");
    if (!lengthConfig)
      throw core.sessionError("Choose 20, 35, or 50 minutes.", "INVALID_SESSION_LENGTH");
    if (!modeConfig)
      throw core.sessionError(
        "Choose Random, Not in my week, Needs focus, or My preferences.",
        "INVALID_SESSION_SELECTION_MODE",
      );
    if (!preferences || typeof preferences !== "object")
      throw core.sessionError(
        "Your saved training profile is unavailable.",
        "INVALID_SESSION_PROFILE",
      );
    const catalog = [
      ...new Map(
        list(exercises)
          .filter((exercise) => exercise?.id)
          .map((exercise) => [exercise.id, exercise]),
      ).values(),
    ];
    const focusPool = catalog.filter((exercise) => core.sessionFocusMatches(exercise, focus));
    if (muscleGroup !== "all" && !focusPool.some((exercise) => exercise.group === muscleGroup))
      throw core.sessionError(
        "Choose a muscle group within your session focus.",
        "INVALID_SESSION_MUSCLE_GROUP",
      );
    if (
      muscleTarget !== "all" &&
      !sessionMuscleTargets(catalog, focus, muscleGroup, core.sessionFocusMatches).includes(
        muscleTarget,
      )
    )
      throw core.sessionError(
        "Choose a muscle target within your selected focus and group.",
        "INVALID_SESSION_MUSCLE_TARGET",
      );
    const weekIds = core.scheduledExerciseIds(weeklyPlan),
      strict = selectionMode === "not-in-week",
      filtered = muscleGroup !== "all" || muscleTarget !== "all";
    if (strict && !core.WEEKDAYS.every((day) => Array.isArray(weeklyPlan?.days?.[day])))
      throw core.sessionError(
        "Your weekly plan is unavailable. Reload it before choosing Not in my week.",
        "SESSION_WEEK_UNAVAILABLE",
      );
    const matchesMuscle = (exercise) =>
      (muscleGroup === "all" || exercise.group === muscleGroup) &&
      (muscleTarget === "all" || exercise.sub === muscleTarget);
    const candidates = focusPool
      .filter(matchesMuscle)
      .map((exercise) => ({ exercise, personal: core.personalResult(exercise, preferences) }))
      .filter(
        ({ exercise, personal }) => personal.eligible && (!strict || !weekIds.has(exercise.id)),
      );
    const focusLabel =
      muscleTarget !== "all"
        ? muscleTarget
        : muscleGroup !== "all"
          ? muscleGroup.charAt(0).toUpperCase() + muscleGroup.slice(1)
          : focusConfig.label;
    const shortage = strict
      ? " Exercises already planned this week are excluded; no repeats were added."
      : "";
    if (candidates.length < lengthConfig.count)
      throw core.sessionError(
        `Only ${candidates.length} eligible ${focusLabel.toLowerCase()} exercise${candidates.length === 1 ? " matches" : "s match"} your selection.${shortage} Choose a shorter session, a broader muscle target, or update your profile.`,
        "SESSION_POOL_TOO_SMALL",
      );
    const roles = filtered
      ? filteredRoles(candidates, lengthConfig.count, muscleGroup, muscleTarget)
      : focusConfig.slots.slice(0, lengthConfig.count);
    const missingRole = roles.find(
      (role) => !candidates.some(({ exercise }) => core.sessionRoleMatches(exercise, role)),
    );
    if (missingRole || !core.sessionRolesAreFeasible(candidates, roles))
      throw core.sessionError(
        `Your selection cannot provide ${missingRole ? `an eligible ${missingRole.label.toLowerCase()} movement` : "enough distinct movements for every session role"}.${shortage} Choose a shorter session, a different focus, or update your profile.`,
        "SESSION_ROLE_UNAVAILABLE",
      );
    const history = historyEvidence(catalog, workouts, workoutHistoryAvailable, now),
      personal = personalEvidence(catalog, userRatings, shortlist, history);
    const hasRecent = candidates.some(
        ({ exercise }) => (history.recentSets.get(targetKey(exercise)) || 0) > 0,
      ),
      hasPreferences = personal.hasSignal(candidates.map(({ exercise }) => exercise));
    const usedIds = new Set(),
      usedGroups = new Map(),
      usedSubs = new Map(),
      items = [];
    if (selectionMode === "random" || strict)
      for (const candidate of candidates) {
        const draw = Number(typeof random === "function" ? random() : Math.random());
        candidate.randomRank = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0;
      }
    for (let index = 0; index < roles.length; index++) {
      const role = roles[index],
        roleCandidates = candidates.filter(
          ({ exercise }) => !usedIds.has(exercise.id) && core.sessionRoleMatches(exercise, role),
        );
      const base = (candidate) =>
        core.sessionCandidateScore(candidate, { role, usedGroups, usedSubs, weekIds: new Set() });
      roleCandidates.sort((a, b) => {
        if (selectionMode === "random" || strict)
          return a.randomRank - b.randomRank || a.exercise.id.localeCompare(b.exercise.id);
        if (selectionMode === "needs-focus" && hasRecent) {
          const difference =
            (history.recentSets.get(targetKey(a.exercise)) || 0) -
            (history.recentSets.get(targetKey(b.exercise)) || 0);
          if (difference) return difference;
        }
        if (selectionMode === "preferences") {
          const difference = personal.score(b.exercise) - personal.score(a.exercise);
          if (difference) return difference;
        }
        return base(b) - base(a) || a.exercise.id.localeCompare(b.exercise.id);
      });
      const selected = roleCandidates.find(({ exercise }) =>
        core.sessionRolesAreFeasible(
          candidates,
          roles.slice(index + 1),
          new Set([...usedIds, exercise.id]),
        ),
      );
      if (!selected)
        throw core.sessionError(
          `The session cannot cover every role with distinct eligible exercises.${shortage}`,
          "SESSION_ROLE_UNAVAILABLE",
        );
      const { exercise } = selected,
        sets = core.sessionSetCount(exercise, lengthConfig.minutes, index),
        reasons = [role.label];
      if (selectionMode === "random")
        reasons.push("randomly selected from eligible movements for this role");
      else if (strict) reasons.push("absent from every day in your saved weekly plan");
      else if (selectionMode === "needs-focus" && hasRecent) {
        const count = history.recentSets.get(targetKey(exercise)) || 0;
        reasons.push(
          `${count} completed set${count === 1 ? "" : "s"} logged for ${exercise.sub.toLowerCase()} in the last 28 days${workoutHistoryHasMore ? " of available history" : ""}`,
        );
      } else if (selectionMode === "preferences") reasons.push(personal.reason(exercise));
      else reasons.push("fits your saved training profile while completed history is limited");
      items.push({
        exercise,
        exerciseId: exercise.id,
        role: role.key,
        roleLabel: role.label,
        sets,
        reps: String(exercise.reps || "8–12"),
        rest: String(exercise.rest || "60–90 s"),
        match: selected.personal.match,
        reasons,
      });
      usedIds.add(exercise.id);
      add(usedGroups, exercise.group);
      add(usedSubs, exercise.sub);
    }
    const workingSets = items.reduce((sum, item) => sum + item.sets, 0);
    return {
      focus,
      focusLabel,
      muscleGroup,
      muscleTarget,
      selectionMode,
      selectionLabel: modeConfig.label,
      selectionNote: selectionNote(selectionMode, {
        weekIds,
        historyAvailable: workoutHistoryAvailable,
        hasMore: workoutHistoryHasMore,
        hasRecent,
        hasPreferences,
      }),
      minutes: lengthConfig.minutes,
      timeLabel: lengthConfig.label,
      estimatedMinutes: lengthConfig.minutes,
      workingSets,
      items,
      summary: `${items.length} movements · ${workingSets} working sets · about ${lengthConfig.minutes} minutes`,
    };
  }

  return { SESSION_SELECTION_MODES, sessionMuscleTargets, buildSession };
});
