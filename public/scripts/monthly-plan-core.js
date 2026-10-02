(function (root, factory) {
  const discovery =
    typeof module === "object" && module.exports
      ? require("./discovery-core")
      : root.StrataDiscovery;
  const api = factory(discovery);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataMonthlyPlan = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Discovery) {
  "use strict";

  const DAYS = Object.freeze([
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]);
  const TARGETS = Object.freeze([
    Object.freeze({ key: "chest", label: "Chest" }),
    Object.freeze({ key: "back", label: "Back" }),
    Object.freeze({ key: "shoulders", label: "Shoulders" }),
    Object.freeze({ key: "biceps", label: "Biceps" }),
    Object.freeze({ key: "triceps", label: "Triceps" }),
    Object.freeze({ key: "forearms", label: "Forearms" }),
    Object.freeze({ key: "legs", label: "Legs" }),
    Object.freeze({ key: "glutes", label: "Glutes" }),
    Object.freeze({ key: "calves", label: "Calves" }),
    Object.freeze({ key: "core", label: "Core" }),
  ]);
  const TARGET_KEYS = Object.freeze(TARGETS.map(({ key }) => key));
  const TARGET_LABELS = Object.freeze(
    Object.fromEntries(TARGETS.map(({ key, label }) => [key, label])),
  );
  const TARGET_SET = new Set(TARGET_KEYS);
  const MONTH_LENGTH = 31;
  const MAX_TARGETS_PER_DAY = 4;
  const MAX_EXERCISES_PER_DAY = 12;
  const MAX_WEEKLY_ITEMS = 140;
  const MAX_IMPORT_BYTES = 256 * 1024;
  const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function cleanText(value, max) {
    return String(value ?? "")
      .trim()
      .slice(0, max);
  }
  function fail(message) {
    throw new Error(message);
  }

  function parseIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) fail("Choose a valid start date.");
    const year = Number(match[1]),
      month = Number(match[2]),
      day = Number(match[3]);
    if (year < 1900 || year > 2200) fail("Choose a start date between 1900 and 2200.");
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      fail("Choose a valid start date.");
    return date;
  }

  function formatIsoDate(value) {
    const date = value instanceof Date ? value : parseIsoDate(value);
    if (!Number.isFinite(date.getTime())) fail("Choose a valid date.");
    return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function addUtcDays(value, amount) {
    const date = value instanceof Date ? new Date(value.getTime()) : parseIsoDate(value);
    const count = Number(amount);
    if (!Number.isInteger(count)) fail("Day offset must be a whole number.");
    date.setUTCDate(date.getUTCDate() + count);
    return formatIsoDate(date);
  }

  function weekdayForDate(value) {
    const date = value instanceof Date ? value : parseIsoDate(value);
    return DAYS[(date.getUTCDay() + 6) % 7];
  }

  function dateRange(startDate, count = MONTH_LENGTH) {
    const total = Number(count);
    if (!Number.isInteger(total) || total < 1 || total > 366)
      fail("Date range length must be between 1 and 366 days.");
    const start = formatIsoDate(parseIsoDate(startDate));
    return Array.from({ length: total }, (_, index) => addUtcDays(start, index));
  }

  function matchesTarget(exercise, target) {
    if (!isRecord(exercise) || !TARGET_SET.has(target)) return false;
    const group = cleanText(exercise.group, 40).toLowerCase();
    const sub = cleanText(exercise.sub, 80).toLowerCase();
    if (target === "biceps")
      return group === "arms" && (sub.includes("biceps") || sub.includes("brachialis"));
    if (target === "triceps") return group === "arms" && sub.includes("triceps");
    if (target === "forearms") return group === "arms" && sub.includes("forearm");
    return group === target;
  }

  function inferTarget(exercise) {
    if (!isRecord(exercise)) return null;
    return TARGET_KEYS.find((target) => matchesTarget(exercise, target)) || null;
  }

  function exerciseIndex(exercises) {
    return new Map(
      (Array.isArray(exercises) ? exercises : [])
        .filter((exercise) => isRecord(exercise) && exercise.id)
        .map((exercise) => [String(exercise.id), exercise]),
    );
  }

  function normalizedPrescription(
    item,
    { day, index, knownExercises, seenInstanceIds = null } = {},
  ) {
    if (!isRecord(item)) fail(`Exercise ${index + 1} on ${day} is invalid.`);
    const exerciseId = cleanText(item.exerciseId, 80);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(exerciseId))
      fail(`Exercise ${index + 1} on ${day} has an invalid ID.`);
    if (knownExercises?.size && !knownExercises.has(exerciseId))
      fail(`The weekly plan contains an exercise that is not in STRATA's library: ${exerciseId}.`);
    let sets = Number(item.sets);
    if (!Number.isFinite(sets)) sets = 3;
    sets = Math.max(1, Math.min(10, Math.round(sets)));
    const reps = cleanText(item.reps, 20) || "8–12";
    const output = { exerciseId, sets, reps };
    if (seenInstanceIds) {
      const requested = String(item.instanceId || "");
      let instanceId =
        /^[a-zA-Z0-9_-]{6,100}$/.test(requested) && !seenInstanceIds.has(requested)
          ? requested
          : `import-${day.toLowerCase()}-${index + 1}-${exerciseId}`.slice(0, 100);
      let suffix = 2;
      while (seenInstanceIds.has(instanceId))
        instanceId = `${`import-${day.toLowerCase()}-${index + 1}-${exerciseId}`.slice(0, 94)}-${suffix++}`;
      seenInstanceIds.add(instanceId);
      output.instanceId = instanceId;
    }
    return output;
  }

  function normalizeWeeklyPlan(input, exercises = []) {
    if (!isRecord(input)) fail("That file does not contain a valid weekly plan.");
    let source = input;
    if (Object.hasOwn(input, "format") || Object.hasOwn(input, "plan")) {
      if (
        input.format !== "strata-weekly-plan" ||
        Number(input.version) !== 1 ||
        !isRecord(input.plan)
      )
        fail("That file is not a supported STRATA weekly-plan export.");
      source = input.plan;
    }
    if (!isRecord(source) || Number(source.version) !== 1 || !isRecord(source.days))
      fail("That file does not contain a supported weekly plan.");
    const rawRest = Object.hasOwn(source, "restDays")
      ? source.restDays
      : source.restDay === null
        ? []
        : [source.restDay];
    if (
      !Array.isArray(rawRest) ||
      rawRest.length > 7 ||
      rawRest.some((day) => !DAYS.includes(day)) ||
      new Set(rawRest).size !== rawRest.length
    )
      fail("The weekly plan needs valid, unique rest days.");
    const restDays = DAYS.filter((day) => rawRest.includes(day));
    if (
      Object.hasOwn(source, "restDays") &&
      Object.hasOwn(source, "restDay") &&
      source.restDay !== (restDays[0] ?? null)
    )
      fail("The weekly plan's rest-day fields do not match.");
    const knownExercises = exerciseIndex(exercises),
      seenInstanceIds = new Set();
    const output = { version: 1, restDay: restDays[0] ?? null, restDays, days: {} };
    let total = 0;
    for (const day of DAYS) {
      const items = source.days[day];
      if (!Array.isArray(items)) fail(`The weekly plan is missing ${day}.`);
      if (items.length > 30) fail(`${day} contains too many exercises.`);
      output.days[day] = items.map((item, index) =>
        normalizedPrescription(item, { day, index, knownExercises, seenInstanceIds }),
      );
      total += output.days[day].length;
    }
    if (total > MAX_WEEKLY_ITEMS) fail("The weekly plan contains too many exercises.");
    if (restDays.some((day) => output.days[day].length))
      fail("The weekly plan's recovery day must not contain exercises.");
    return output;
  }

  function inputByteLength(value) {
    if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
    return value.length * 2;
  }

  function parseWeeklyPlanFile(input, exercises = []) {
    let parsed = input;
    if (typeof input === "string") {
      if (inputByteLength(input) > MAX_IMPORT_BYTES)
        fail("That weekly-plan file is larger than 256 KB.");
      try {
        parsed = JSON.parse(input.replace(/^\uFEFF/, ""));
      } catch {
        fail("That file is not valid JSON.");
      }
    }
    return normalizeWeeklyPlan(parsed, exercises);
  }

  function scheduleFromWeeklyPlan(plan, exercises = []) {
    const normalized = normalizeWeeklyPlan(plan, exercises),
      knownExercises = exerciseIndex(exercises);
    const schedule = {};
    for (const day of DAYS) {
      const sourceItems = normalized.days[day].map(({ exerciseId, sets, reps }) => ({
        exerciseId,
        sets,
        reps,
      }));
      const targets = [];
      for (const item of sourceItems) {
        const target = inferTarget(knownExercises.get(item.exerciseId));
        if (!target) fail(`STRATA could not identify a muscle group for ${item.exerciseId}.`);
        if (!targets.includes(target)) targets.push(target);
      }
      if (targets.length > MAX_TARGETS_PER_DAY)
        fail(
          `${day} uses more than ${MAX_TARGETS_PER_DAY} muscle groups. Reduce that day before importing it.`,
        );
      schedule[day] = { rest: sourceItems.length === 0, targets, sourceItems };
    }
    return schedule;
  }

  function normalizeSchedule(input, exercises = []) {
    if (!isRecord(input)) fail("Build a weekly schedule before generating the month.");
    const knownExercises = exerciseIndex(exercises),
      output = {};
    for (const day of DAYS) {
      const entry = input[day];
      if (!isRecord(entry) || typeof entry.rest !== "boolean")
        fail(`Choose training or rest for ${day}.`);
      if (entry.rest) {
        output[day] = { rest: true, targets: [], sourceItems: [] };
        continue;
      }
      if (!Array.isArray(entry.targets)) fail(`Choose at least one muscle group for ${day}.`);
      const targets = [];
      for (const value of entry.targets) {
        const target = String(value || "").toLowerCase();
        if (!TARGET_SET.has(target)) fail(`${day} contains an unknown muscle group.`);
        if (!targets.includes(target)) targets.push(target);
      }
      if (!targets.length) fail(`Choose at least one muscle group for ${day}, or mark it as rest.`);
      if (targets.length > MAX_TARGETS_PER_DAY)
        fail(`Choose no more than ${MAX_TARGETS_PER_DAY} muscle groups for ${day}.`);
      const source = entry.sourceItems == null ? [] : entry.sourceItems;
      if (!Array.isArray(source) || source.length > MAX_EXERCISES_PER_DAY)
        fail(`${day} contains too many imported exercises.`);
      const used = new Set(),
        sourceItems = [];
      for (let index = 0; index < source.length; index++) {
        const item = normalizedPrescription(source[index], { day, index, knownExercises });
        if (used.has(item.exerciseId)) continue;
        const target = inferTarget(knownExercises.get(item.exerciseId));
        if (target && targets.includes(target)) {
          used.add(item.exerciseId);
          sourceItems.push(item);
        }
      }
      output[day] = { rest: false, targets, sourceItems };
    }
    return output;
  }

  function defaultSets(exercise) {
    const match = String(exercise?.sets || "").match(/\d+/);
    return Math.max(1, Math.min(10, Number(match?.[0] || 3)));
  }

  function checkedPersonalResult(exercise, preferences) {
    if (!preferences) return { eligible: true, match: Number(exercise.score) || 0 };
    try {
      if (typeof Discovery?.personalResult !== "function")
        throw new Error("Eligibility engine unavailable.");
      const result = Discovery.personalResult(exercise, preferences);
      if (typeof result?.eligible !== "boolean" || !Number.isFinite(result.match))
        throw new Error("Invalid eligibility result.");
      return result;
    } catch {
      fail(
        `Could not verify the saved equipment and movement constraints for ${exercise.name || exercise.id}. Review your profile and try again.`,
      );
    }
  }

  function candidatePool(exercises, target, preferences) {
    return exercises
      .filter((exercise) => matchesTarget(exercise, target))
      .map((exercise) => {
        const personal = checkedPersonalResult(exercise, preferences);
        return { exercise, personal };
      })
      .filter(({ personal }) => personal.eligible === true)
      .sort(
        (a, b) =>
          Number(b.personal.match || 0) - Number(a.personal.match || 0) ||
          Number(b.exercise.score || 0) - Number(a.exercise.score || 0) ||
          String(a.exercise.id).localeCompare(String(b.exercise.id)),
      )
      .map(({ exercise }) => exercise);
  }

  function generateMonthPlan(input) {
    if (!isRecord(input)) fail("Monthly plan settings are missing.");
    const exercises = Array.isArray(input.exercises) ? input.exercises : [];
    if (!exercises.length) fail("The exercise library is unavailable.");
    const knownExercises = exerciseIndex(exercises);
    const startDate = formatIsoDate(parseIsoDate(input.startDate));
    const exercisesPerTarget = Number(input.exercisesPerTarget);
    if (!Number.isInteger(exercisesPerTarget) || exercisesPerTarget < 1 || exercisesPerTarget > 3)
      fail("Choose between 1 and 3 exercises per muscle group.");
    const title = cleanText(input.title, 80) || "My 31-Day Plan";
    const schedule = normalizeSchedule(input.schedule, exercises);
    if (!DAYS.some((day) => schedule[day].rest)) fail("Choose at least one rest day.");
    if (!DAYS.some((day) => !schedule[day].rest)) fail("Choose at least one training day.");
    const pools = Object.fromEntries(
      TARGET_KEYS.map((target) => [target, candidatePool(exercises, target, input.preferences)]),
    );
    const occurrences = Object.fromEntries(TARGET_KEYS.map((target) => [target, 0]));
    const days = dateRange(startDate, MONTH_LENGTH).map((date, index) => {
      const weekday = weekdayForDate(date),
        entry = schedule[weekday];
      if (entry.rest)
        return { dayNumber: index + 1, date, weekday, rest: true, targets: [], exercises: [] };
      const selected = [],
        used = new Set();
      for (const item of entry.sourceItems) {
        if (selected.length >= MAX_EXERCISES_PER_DAY) break;
        const exercise = knownExercises.get(item.exerciseId),
          target = inferTarget(exercise);
        if (!exercise || !target || !entry.targets.includes(target) || used.has(item.exerciseId))
          continue;
        if (!checkedPersonalResult(exercise, input.preferences).eligible)
          fail(
            `${weekday}'s imported ${exercise.name || exercise.id} does not match your saved equipment or movement constraints. Edit the imported day or update your profile before generating the month.`,
          );
        used.add(item.exerciseId);
        selected.push({ exerciseId: item.exerciseId, sets: item.sets, reps: item.reps });
      }
      for (const target of entry.targets) {
        const already = selected.filter((item) =>
          matchesTarget(knownExercises.get(item.exerciseId), target),
        ).length;
        const needed = Math.max(0, exercisesPerTarget - already),
          pool = pools[target],
          start = pool.length ? (occurrences[target] * exercisesPerTarget) % pool.length : 0;
        let added = 0;
        for (
          let offset = 0;
          offset < pool.length && added < needed && selected.length < MAX_EXERCISES_PER_DAY;
          offset++
        ) {
          const exercise = pool[(start + offset) % pool.length];
          if (used.has(exercise.id)) continue;
          used.add(exercise.id);
          selected.push({
            exerciseId: String(exercise.id),
            sets: defaultSets(exercise),
            reps: cleanText(exercise.reps, 20) || "8–12",
          });
          added++;
        }
        if (already + added < exercisesPerTarget)
          fail(
            `No eligible ${TARGET_LABELS[target].toLowerCase()} exercises match the saved equipment and movement constraints.`,
          );
        occurrences[target]++;
      }
      return {
        dayNumber: index + 1,
        date,
        weekday,
        rest: false,
        targets: [...entry.targets],
        exercises: selected,
      };
    });
    const result = { version: 1, title, startDate, exercisesPerTarget, schedule, days };
    const generatedAt = cleanText(input.generatedAt, 40);
    if (generatedAt) result.generatedAt = generatedAt;
    return result;
  }

  function displayDate(value) {
    const date = parseIsoDate(value);
    return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  }

  function shareText(plan, exercises = []) {
    if (!isRecord(plan) || !Array.isArray(plan.days) || plan.days.length !== MONTH_LENGTH)
      fail("Generate a complete 31-day plan before sharing it.");
    const knownExercises = exerciseIndex(exercises),
      title = cleanText(plan.title, 80) || "My 31-Day Plan";
    const finalDate = plan.days[MONTH_LENGTH - 1]?.date;
    const lines = [title, `${displayDate(plan.startDate)} – ${displayDate(finalDate)}`, ""];
    for (const [index, day] of plan.days.entries()) {
      const weekday = DAYS.includes(day?.weekday) ? day.weekday : weekdayForDate(day?.date);
      lines.push(
        `Day ${String(index + 1).padStart(2, "0")} · ${weekday} · ${displayDate(day.date)}`,
      );
      if (day.rest) {
        lines.push("Rest and recovery", "");
        continue;
      }
      const labels = (Array.isArray(day.targets) ? day.targets : [])
        .filter((target) => TARGET_SET.has(target))
        .map((target) => TARGET_LABELS[target]);
      if (labels.length) lines.push(labels.join(" + "));
      for (const item of Array.isArray(day.exercises) ? day.exercises : []) {
        const exercise = knownExercises.get(String(item.exerciseId || ""));
        const name =
          exercise?.name ||
          String(item.exerciseId || "Exercise")
            .split("-")
            .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
            .join(" ");
        const rest = exercise?.rest ? ` · ${exercise.rest} rest` : "";
        lines.push(`• ${name} — ${item.sets} × ${item.reps}${rest}`);
      }
      lines.push("");
    }
    lines.push("Created with STRATA · stratafitness.online");
    return lines.join("\n");
  }

  return {
    DAYS,
    TARGETS,
    TARGET_KEYS,
    TARGET_LABELS,
    matchesTarget,
    inferTarget,
    parseIsoDate,
    formatIsoDate,
    addUtcDays,
    weekdayForDate,
    dateRange,
    normalizeWeeklyPlan,
    parseWeeklyPlanFile,
    scheduleFromWeeklyPlan,
    normalizeSchedule,
    generateMonthPlan,
    shareText,
  };
});
