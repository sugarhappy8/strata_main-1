"use strict";

const test = require("node:test");
const { frontendBudget, lineCount } = require("./support/size-budget");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const W = require("../public/scripts/workout-core");
const State = require("../public/scripts/workout-state");
const Api = require("../public/scripts/workout-api");
const Calendar = require("../public/scripts/workout-calendar");
const Render = require("../public/scripts/workout-render");
const Context = require("../public/scripts/workout-context");
const Guidance = require("../public/scripts/workout-guidance");
const History = require("../public/scripts/workout-history");
const Events = require("../public/scripts/workout-events");

const ROOT = join(__dirname, "..");
const DAYS = W.DAYS;
const emptyWeek = () => ({ version: 1, days: Object.fromEntries(DAYS.map((day) => [day, []])) });

test("workout state accepts explicit day and start deep links without weakening defaults", () => {
  assert.equal(State.deepLinkedDay({ search: "?day=Thursday", hash: "" }, W), "Thursday");
  assert.equal(State.deepLinkedDay({ search: "?start=Friday", hash: "" }, W), "Friday");
  assert.equal(State.deepLinkedDay({ search: "", hash: "#start=Saturday" }, W), "Saturday");
  assert.equal(State.deepLinkedDay({ search: "?day=Funday", hash: "" }, W), W.today());
  const state = State.create(W, { search: "?start=Tuesday", hash: "" });
  assert.equal(state.day, "Tuesday");
  assert.equal(state.workout, null);
  assert.equal(state.dirty, false);
});

test("workout preferences accept only supported rest durations", () => {
  assert.deepEqual(
    State.readPreferences(JSON.stringify({ version: 1, autoRest: false, restDuration: 120 })),
    { autoRest: false, restDuration: 120 },
  );
  assert.deepEqual(
    State.readPreferences(JSON.stringify({ version: 1, autoRest: "yes", restDuration: 17 })),
    {},
  );
  assert.deepEqual(JSON.parse(State.writePreferences(true, 17)), {
    version: 1,
    autoRest: true,
    restDuration: 90,
  });
});

test("weekly calendar file repeats every planned day at the chosen time with an optional reminder", () => {
  const plan = emptyWeek();
  plan.days.Monday = [
    { exerciseId: "squat", sets: 3 },
    { exerciseId: "press", sets: 4 },
  ];
  plan.days.Friday = [{ exerciseId: "row", sets: 1 }];
  const from = new Date(2026, 8, 9, 9),
    schedule = Calendar.weeklySchedule(plan, DAYS, { time: "07:30", alarmMinutes: 15, from });
  assert.deepEqual(schedule.days, ["Monday", "Friday"]);
  assert.equal(schedule.filename, "strata-weekly-training.ics");
  assert.equal(
    decodeURIComponent(schedule.href.replace(/^data:text\/calendar;charset=utf-8,/, "")),
    schedule.ics,
  );
  const lines = schedule.ics.split("\r\n"),
    events = schedule.ics.split("BEGIN:VEVENT").slice(1);
  assert.equal(events.length, 2);
  assert.ok(schedule.ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 75));
  assert.match(
    events[0],
    /UID:strata-weekly-monday@stratafitness\.online\r\nSEQUENCE:\d+\r\nDTSTAMP:\d{8}T\d{6}Z\r\nDTSTART:20260914T073000\r\nDTEND:20260914T083000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\n/,
  );
  assert.match(
    events[0],
    /SUMMARY:STRATA · Monday workout\r\nDESCRIPTION:2 movements · 7 working sets\. Open STRATA to start\.\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Monday workout\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT/,
  );
  assert.match(
    events[1],
    /DTSTART:20260911T073000\r\n.*RRULE:FREQ=WEEKLY;BYDAY=FR\r\n.*DESCRIPTION:1 movement · 1 working set\. Open STRATA to start\./s,
  );
  // A later download keeps each weekday's UID and raises SEQUENCE, so calendar apps update the event.
  const later = Calendar.weeklySchedule(plan, DAYS, {
      time: "07:30",
      from: new Date(2026, 8, 10, 9),
    }),
    sequence = (ics) => Number(/SEQUENCE:(\d+)/.exec(ics)[1]);
  assert.match(later.ics, /UID:strata-weekly-monday@stratafitness\.online/);
  assert.ok(sequence(later.ics) > sequence(schedule.ics));
  // Today counts when it is a planned day; no reminder omits the alarm.
  const today = Calendar.weeklySchedule(plan, DAYS, {
    time: "18:00",
    alarmMinutes: 0,
    from: new Date(2026, 8, 14, 9),
  });
  assert.match(today.ics, /DTSTART:20260914T180000\r\nDTEND:20260914T190000/);
  assert.doesNotMatch(today.ics, /VALARM/);
  assert.equal(Calendar.weeklySchedule(plan, DAYS, { time: "25:00", from }), null);
  assert.equal(Calendar.weeklySchedule(plan, DAYS, { time: "7:30", from }), null);
  assert.equal(Calendar.weeklySchedule(emptyWeek(), DAYS, { from }), null);
});

test("weekly calendar files fold long lines to 75 octets", () => {
  const plan = emptyWeek();
  plan.days.Wednesday = Array.from({ length: 12 }, (_, index) => ({
    exerciseId: `move-${index}`,
    sets: 3,
  }));
  const schedule = Calendar.weeklySchedule(plan, DAYS, { from: new Date(2026, 8, 7, 9) });
  assert.ok(schedule.ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75));
});

test("the iOS app's Calendar sheet gets the same weekly schedule with Calendar's Sunday-first weekday numbers", () => {
  assert.deepEqual(
    DAYS.map((day) => Calendar.calendarWeekday(day, DAYS)),
    [2, 3, 4, 5, 6, 7, 1],
    "Monday is 2 and Sunday is 1",
  );
  assert.equal(Calendar.calendarWeekday("Someday", DAYS), 0);
  const plan = emptyWeek();
  plan.days.Monday = [{ exerciseId: "squat", sets: 3 }];
  plan.days.Wednesday = [{ exerciseId: "row", sets: 2 }];
  plan.days.Sunday = [{ exerciseId: "press", sets: 1 }];
  assert.deepEqual(Calendar.nativeWeekly(plan, DAYS, { time: "07:05", alarmMinutes: 15 }), {
    title: "STRATA workout",
    notes: "Planned training days: Monday, Wednesday, Sunday. Open STRATA to start.",
    weekdays: [2, 4, 1],
    hour: 7,
    minute: 5,
    durationMinutes: 60,
    alarmMinutesBefore: 15,
  });
  assert.deepEqual(
    Calendar.weeklySchedule(plan, DAYS, { time: "07:05" }).days,
    ["Monday", "Wednesday", "Sunday"],
    "the file and the sheet cover the same days",
  );
  assert.equal(
    Calendar.nativeWeekly(plan, DAYS, { time: "18:00", alarmMinutes: 0 }).alarmMinutesBefore,
    null,
    "No reminder adds no alarm",
  );
  assert.equal(
    Calendar.nativeWeekly(plan, DAYS, { time: "23:59", alarmMinutes: 60, durationMinutes: 45 })
      .durationMinutes,
    45,
  );
  const saturday = emptyWeek();
  saturday.days.Saturday = [{ exerciseId: "row", sets: 2 }];
  assert.deepEqual(Calendar.nativeWeekly(saturday, DAYS).weekdays, [7]);
  assert.equal(Calendar.nativeWeekly(plan, DAYS, { time: "7:05" }), null);
  assert.equal(Calendar.nativeWeekly(plan, DAYS, { time: "24:00" }), null);
  assert.equal(Calendar.nativeWeekly(emptyWeek(), DAYS), null);
  assert.equal(Calendar.nativeWeekly(null, DAYS), null);
});

test("in the iOS app a workout keeps the screen awake, schedules its rest alert, and opens Calendar's sheet", () => {
  const main = readFileSync(join(ROOT, "public/scripts/workout.js"), "utf8"),
    events = readFileSync(join(ROOT, "public/scripts/workout-events.js"), "utf8");
  assert.match(
    main,
    /globalThis\s*\.StrataAppMode\s*\?\.createWorkoutBridge\s*\?\.\(\s*\{\s*title\s*:\s*"Rest\s*is\s*over"\s*,\s*body\s*:\s*"Time\s*for\s*your\s*next\s*set\."\s*[;,]?\s*\}\s*,?\s*\)\s*\|\|\s*null/,
  );
  assert.match(
    main,
    /appBridge\s*\.sync\s*\(\s*\{\s*keepAwake\s*:\s*active\s*&&\s*!\s*state\s*\.pageHidden\s*&&\s*document\s*\.visibilityState\s*!==\s*"hidden"\s*,\s*restEndsAt\s*:\s*active\s*\?\s*state\s*\.workout\s*\.restEndsAt\s*:\s*0\s*[;,]?\s*\}\s*,?\s*\)/,
    "only an active workout on screen keeps the screen awake",
  );
  assert.match(
    main,
    /function\s*tick\s*\(\s*,?\s*\)\s*\{\s*\n\s*syncApp\s*\(\s*,?\s*\)\s*;/,
    "every timer tick (pause, reset, finish, replace) reconciles the native state",
  );
  assert.match(
    main,
    /state\s*\.pausedSeconds\s*=\s*null\s*;\s*syncApp\s*\(\s*,?\s*\)\s*;\s*guidance\s*\.reset\s*\(\s*,?\s*\)/,
    "closing a session releases the screen at once",
  );
  assert.equal(
    (main.match(/persistDraft\(\);\s*syncApp\(\);/g) || []).length,
    2,
    "a blocked session or ended access releases the screen and the alert",
  );
  assert.match(
    main,
    /Date\.now\(\)\s*-\s*workout\.restEndsAt\s*<\s*5000\)\s*globalThis\.StrataAppMode\?\.haptic\("success"\)/,
    "a rest ending on screen taps once; a rest that ended long ago does not",
  );
  assert.match(
    main,
    /addWeeklyToCalendar\(options\)\)\?\.added\s*===\s*true\)\s*toast\("Added to your calendar\."\);\s*\}\s*catch\s*\{\s*const link\s*=\s*document\.createElement\("a"\);\s*link\.href\s*=\s*\$\("calendarWeeklyLink"\)\.href;\s*link\.download\s*=/,
    "a refused sheet falls back to the .ics file",
  );
  assert.match(
    events,
    /\$\("calendarWeeklyLink"\)\?\.addEventListener\("click",\s*\(event\)\s*=>\s*\{\s*void actions\.addWeeklyToCalendar\?\.\(event\);\s*\}\)/,
  );
  assert.match(
    events,
    /windowLike\s*\.addEventListener\s*\(\s*"pagehide"\s*,\s*\(\s*,?\s*\)\s*=>\s*\{\s*state\s*\.pageHidden\s*=\s*true\s*;\s*tick\s*\(\s*,?\s*\)\s*;\s*[;,]?\s*\}\s*,?\s*\)/,
  );
  // A rest alert the online page scheduled must not fire after the workout is finished on the offline page.
  const offline = readFileSync(join(ROOT, "public/scripts/workout-offline.js"), "utf8");
  assert.match(
    offline,
    /workout\s*\.restEndsAt\s*=\s*null\s*;\s*const\s*stored\s*=\s*persist\s*\(\s*,?\s*\)\s*;\s*render\s*\(\s*,?\s*\)\s*;\s*globalThis\s*\.StrataAppMode\s*\?\.cancelRestAlert\s*\?\.\(\s*,?\s*\)\s*;/,
    "finishing offline cancels the rest alert",
  );
});

test("workout renderer keeps the training essentials visible and nests configuration under More", () => {
  const catalog = [
    {
      id: "press",
      name: "Standing Press",
      equipment: "Barbell / Smith",
      reps: "8–12",
      group: "Shoulders",
      sub: "Front Delts",
      score: 90,
      metrics: { stability: 8 },
    },
  ];
  const plan = emptyWeek();
  plan.days.Monday = [{ instanceId: "press-one", exerciseId: "press", sets: 2, reps: "8–12" }];
  const workout = W.createWorkout(plan, "Monday", catalog, 1_780_000_000_000),
    state = { catalog, workout, memoryHistory: [], memoryReady: true, memoryError: "" };
  const view = Render.create({ state, workout: W, discovery: null }),
    markup = view.renderEntry(workout.entries[0], 0);
  assert.match(markup, /aria-label="Previous performance"/);
  assert.match(markup, /Complete set/);
  assert.match(markup, /data-actual="weight"/);
  assert.match(markup, /data-actual="reps"/);
  assert.match(markup, /<details class="exercise-more"><summary><span>More options<\/span>/);
  assert.ok(
    markup.indexOf("Complete set") < markup.indexOf("More options"),
    "set logging must precede configuration",
  );
  for (const advanced of ["data-open-swap", "data-format=", "data-entry-note", "data-calc-warmup"])
    assert.ok(
      markup.indexOf(advanced) > markup.indexOf("More options"),
      `${advanced} should stay inside More options`,
    );
  assert.match(markup, /<details class="set-more">/);
  assert.match(markup, /Duplicate set/);
  assert.match(markup, /Remove set/);
});

test("workout API module owns security headers and identity checks", async () => {
  const calls = [],
    state = {
      mode: "account",
      user: { id: "member-1", discovery: { active: true } },
      csrfToken: "csrf-1",
    };
  let identityUpdates = 0;
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    return {
      ok: true,
      status: 200,
      json: async () =>
        path === "/api/me"
          ? { user: { id: "member-1", discovery: { active: true } }, csrfToken: "csrf-2" }
          : { saved: true },
    };
  };
  const client = Api.create({ state, fetchImpl, onIdentity: () => identityUpdates++ });
  await client.request("/api/workouts", { method: "POST", body: "{}" });
  assert.equal(calls[0].options.headers["X-CSRF-Token"], "csrf-1");
  assert.equal(calls[0].options.headers["X-Strata-User"], "member-1");
  await client.assertIdentity();
  assert.equal(state.csrfToken, "csrf-2");
  assert.equal(identityUpdates, 1);
});

test("training guidance keeps labels and explicit targets predictable", () => {
  assert.equal(Guidance.actionLabel("hold_steady"), "Hold Steady");
  assert.equal(Guidance.actionLabel("reduce-load"), "Reduce Load");
  assert.equal(
    Guidance.suggestionTarget({ target: { weight: 42.5, reps: 8 }, unit: "kg" }, String),
    "42.5 kg · 8 reps",
  );
  assert.equal(Guidance.suggestionTarget({ target: {} }, String), "Keep the current logged target");
  assert.equal(typeof Guidance.create, "function");
  assert.equal(typeof History.create, "function");
});

test("workout context exposes exactly one truthful action for each plan state", () => {
  const node = () => ({
    hidden: false,
    disabled: false,
    open: false,
    dataset: {},
    innerHTML: "",
    textContent: "",
    focus() {
      this.focused = true;
    },
  });
  const render = (overrides = {}) => {
    const nodes = Object.fromEntries(
      [
        "startWorkout",
        "resumeWorkout",
        "chooseScheduledDay",
        "openPlannerFromEmpty",
        "editWorkoutWeek",
        "differentWorkout",
        "planBrief",
        "planPreviewDetails",
        "planDay",
        "planDayField",
        "todayLabel",
        "startTitle",
        "planStatus",
        "planPreview",
        "startHint",
        "trainHistoryNotice",
        "trainHistoryMessage",
      ].map((id) => [id, node()]),
    );
    const state = {
      plan: emptyWeek(),
      day: "Sunday",
      workout: null,
      recoveries: [],
      history: [],
      historyBusy: false,
      historyLoaded: true,
      historyLoadError: "",
      blocked: false,
      detailBusy: false,
      catalog: [],
      ...overrides,
    };
    Context.create({
      $: (id) => nodes[id],
      state,
      workout: W,
      view: { planPreview: () => "preview" },
      esc: String,
      openDetail: async () => {},
      recover: async () => {},
    }).render();
    return nodes;
  };

  const noPlan = render();
  assert.equal(noPlan.planStatus.textContent, "You have not built a weekly plan yet.");
  assert.equal(noPlan.openPlannerFromEmpty.hidden, false);
  assert.equal(noPlan.startWorkout.hidden, true);
  assert.equal(noPlan.resumeWorkout.hidden, true);
  assert.equal(noPlan.chooseScheduledDay.hidden, true);
  assert.equal(noPlan.differentWorkout.hidden, true);

  const plan = emptyWeek();
  plan.days.Monday = [{ exerciseId: "press", sets: 3, reps: "8–12" }];
  const emptyDay = render({ plan });
  assert.equal(emptyDay.startTitle.textContent, "Recovery day.");
  assert.match(emptyDay.chooseScheduledDay.innerHTML, /^Go to Monday /);
  assert.equal(emptyDay.planStatus.textContent, "Nothing is scheduled for this day.");
  assert.equal(emptyDay.editWorkoutWeek.hidden, false);
  assert.equal(emptyDay.chooseScheduledDay.hidden, false);
  assert.equal(emptyDay.chooseScheduledDay.dataset.day, "Monday");
  assert.equal(emptyDay.startWorkout.hidden, true);
  assert.equal(emptyDay.differentWorkout.hidden, true);

  const scheduled = render({ plan, day: "Monday" });
  assert.equal(scheduled.planStatus.textContent, "Scheduled in your weekly plan.");
  assert.equal(scheduled.startWorkout.hidden, false);
  assert.match(scheduled.startWorkout.innerHTML, /Start workout/);
  assert.equal(scheduled.differentWorkout.hidden, false);
  assert.equal(scheduled.resumeWorkout.hidden, true);

  const active = {
    id: "active-1",
    title: "Monday workout",
    date: "2026-09-11",
    status: "active",
    entries: [],
  };
  const resumed = render({ plan, day: "Monday", workout: active });
  assert.equal(resumed.resumeWorkout.hidden, false);
  assert.equal(resumed.startWorkout.hidden, true);
  assert.equal(resumed.chooseScheduledDay.hidden, true);
  assert.equal(resumed.openPlannerFromEmpty.hidden, true);
  assert.equal(resumed.differentWorkout.hidden, true);
});

test("workout entry point is a bounded coordinator over dedicated modules", () => {
  const main = readFileSync(join(ROOT, "public/scripts/workout.js"), "utf8"),
    html = readFileSync(join(ROOT, "public/pages/workout.html"), "utf8");
  const ordered = [
    "workout-state.js",
    "workout-api.js",
    "workout-calendar.js",
    "workout-render.js",
    "workout-context.js",
    "workout-guidance.js",
    "workout-history.js",
    "workout-events.js",
    "workout.js",
  ];
  assert.ok(
    lineCount(main) <= frontendBudget("workout.js"),
    `workout.js coordinator is still too large: ${lineCount(main)} lines`,
  );
  for (const [file, globalName] of [
    ["workout-state.js", "StrataWorkoutState"],
    ["workout-api.js", "StrataWorkoutApi"],
    ["workout-calendar.js", "StrataWorkoutCalendar"],
    ["workout-render.js", "StrataWorkoutRender"],
    ["workout-context.js", "StrataWorkoutContext"],
    ["workout-guidance.js", "StrataWorkoutGuidance"],
    ["workout-history.js", "StrataWorkoutHistory"],
    ["workout-events.js", "StrataWorkoutEvents"],
  ]) {
    const source = readFileSync(join(ROOT, "public/scripts", file), "utf8");
    assert.ok(lineCount(source) <= frontendBudget(file), `${file} should remain focused`);
    assert.match(source, new RegExp(globalName));
  }
  for (let index = 1; index < ordered.length; index++)
    assert.ok(
      html.indexOf(`/${ordered[index - 1]}`) < html.indexOf(`/${ordered[index]}`),
      `${ordered[index - 1]} must load before ${ordered[index]}`,
    );
  assert.match(main, /S\s*\.create\s*\(\s*W\s*,\s*location\s*,?\s*\)/);
  assert.match(main, /A\.create\(/);
  assert.match(main, /R\.create\(/);
  assert.match(main, /T\.create\(/);
  assert.match(main, /Q\.create\(/);
  assert.match(main, /H\.create\(/);
  assert.match(main, /E\.bind\(/);
  assert.equal(typeof Context.create, "function");
  assert.equal(typeof Events.bind, "function");
});
