"use strict";

const test = require("node:test");
const { frontendBudget, lineCount } = require("./support/size-budget");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const Logic = require("../public/scripts/planner-logic");
const PlannerState = require("../public/scripts/planner-state");
const PlannerApi = require("../public/scripts/planner-api");
const PlannerRender = require("../public/scripts/planner-render");
const PlannerConflicts = require("../public/scripts/planner-conflicts");
const PlannerTemplates = require("../public/scripts/planner-templates");
const PlannerActivation = require("../public/scripts/planner-activation");
const PlannerEvents = require("../public/scripts/planner-events");
const ROOT = join(__dirname, "..");

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function plan() {
  const value = Logic.emptyPlan();
  value.days.Monday.push({ instanceId: "first", exerciseId: "bench-press", sets: 3, reps: "8–12" });
  return value;
}

test("planner pure logic validates, filters, counts, and describes the selected-day handoff", () => {
  const value = plan(),
    validated = Logic.validateWeekPlan(value, new Set(["bench-press"]));
  assert.notEqual(validated, value);
  assert.equal(Logic.planMovementCount(value), 1);
  assert.equal(Logic.isEmptyPlan(value), false);
  assert.equal(Logic.isEmptyPlan(Logic.emptyPlan()), true);
  assert.equal(Logic.isDefaultPlan(Logic.emptyPlan()), true);
  assert.equal(Logic.isDefaultPlan(value), false);
  const emptyWithoutRecovery = Logic.emptyPlan();
  Logic.updateRestDays(emptyWithoutRecovery, []);
  assert.equal(
    Logic.isDefaultPlan(emptyWithoutRecovery),
    false,
    "reset remains available when only recovery markers differ from the default",
  );
  assert.deepEqual(Logic.selectedDayHandoff(value, "Monday"), {
    day: "Monday",
    count: 1,
    addLabel: "Add to Monday",
    viewLabel: "View Monday · 1 exercise",
  });
  assert.deepEqual(
    Logic.filterExercises(
      [
        { name: "Row", sub: "Back", equipment: "Cable", group: "back", score: 70 },
        { name: "Pulldown", sub: "Lats", equipment: "Cable", group: "back", score: 90 },
        { name: "Press", sub: "Chest", equipment: "Barbell", group: "chest", score: 99 },
      ],
      { group: "back", query: "cable" },
    ).map((item) => item.name),
    ["Pulldown", "Row"],
  );
  assert.throws(
    () => Logic.validateWeekPlan({ ...value, restDay: "Friday" }, new Set(["bench-press"])),
    /conflicting rest-day/i,
  );
  assert.equal(
    Logic.saveErrorMessage({ code: "NETWORK_ERROR" }),
    "STRATA is offline. Your changes are still unsaved; check your connection and retry.",
  );
});

test("planner state keeps destination choices scoped and rejects a stored rest day", () => {
  const storage = new MemoryStorage(),
    value = plan(),
    state = PlannerState.createState({ desktopPageSize: 24 });
  assert.equal(state.libraryLimit, 24);
  assert.equal(
    PlannerState.writeSelectedDay(storage, { guest: false, userId: "member/1" }, value, "Friday"),
    true,
  );
  assert.equal(
    PlannerState.readSelectedDay(storage, { guest: false, userId: "member/1" }, value),
    "Friday",
  );
  assert.equal(
    PlannerState.readSelectedDay(storage, { guest: true }, value),
    "Monday",
    "guest and account selections cannot leak into each other",
  );
  Logic.updateRestDays(value, ["Friday"]);
  assert.equal(
    PlannerState.readSelectedDay(storage, { guest: false, userId: "member/1" }, value),
    "Monday",
    "a newly marked recovery day cannot remain the add target",
  );
});

test("planner guidance requires a fresh entitlement and schedules boundaries, periodic checks, and retries", () => {
  const now = 1_800_000_000_000,
    state = PlannerState.createState(),
    trialExpiry = now + 10 * 60 * 1000;
  state.user = {
    id: "member-1",
    discovery: {
      active: true,
      accessType: "grant",
      adminGrant: { active: true, expiresAt: trialExpiry },
    },
  };
  state.entitlementStatus = "checking";
  assert.equal(
    PlannerState.hasConfirmedPlusAccess(state, now),
    false,
    "a foreground recheck must hide Plus guidance immediately",
  );
  state.entitlementStatus = "ready";
  assert.equal(PlannerState.hasConfirmedPlusAccess(state, now), true);
  assert.equal(
    PlannerState.hasConfirmedPlusAccess(state, trialExpiry),
    false,
    "the client must fail closed at the known expiry even before a delayed timer runs",
  );
  assert.equal(PlannerState.entitlementBoundary(state.user), trialExpiry);
  assert.equal(PlannerState.entitlementRefreshDelay(state.user, now), 10 * 60 * 1000 + 50);
  state.user.discovery.adminGrant.expiresAt = undefined;
  assert.equal(
    PlannerState.hasConfirmedPlusAccess(state, now),
    false,
    "malformed timed access must fail closed instead of becoming lifetime access",
  );

  state.user = {
    id: "member-1",
    discovery: {
      active: true,
      accessType: "paid",
      subscription: {
        active: true,
        currentPeriodEndsAt: now + 90_000,
        scheduledChange: { action: "cancel", effectiveAt: now + 60_000 },
      },
    },
  };
  assert.equal(
    PlannerState.entitlementBoundary(state.user),
    now + 60_000,
    "a scheduled cancellation is the earliest known entitlement boundary",
  );
  assert.equal(PlannerState.entitlementRefreshDelay(state.user, now), 60_050);
  state.user.discovery.subscription = null;
  assert.equal(
    PlannerState.entitlementBoundary(state.user),
    0,
    "grandfathered access has no invented client expiry",
  );
  assert.equal(
    PlannerState.entitlementRefreshDelay(state.user, now),
    PlannerState.ENTITLEMENT_RECHECK_MAX_DELAY,
    "boundaryless access must still refresh periodically so manual revocation cannot remain stale",
  );
  state.entitlementStatus = "unavailable";
  assert.equal(
    PlannerState.hasConfirmedPlusAccess(state, now),
    false,
    "network uncertainty must not retain gated guidance",
  );
  assert.deepEqual(
    [1, 2, 3, 4, 20].map(PlannerState.entitlementRetryDelay),
    [15_000, 60_000, 300_000, 900_000, 900_000],
    "temporary failures must use bounded retry backoff",
  );

  const appleExpiry = now + 20 * 60 * 1000,
    apple = (value) => ({
      id: "member-1",
      capabilities: { "plus.studio": true },
      discovery: {
        active: true,
        accessType: "apple",
        subscription: null,
        apple: {
          active: true,
          productId: "online.stratafitness.app.plus.monthly",
          expiresAt: appleExpiry,
          autoRenew: true,
          inGracePeriod: false,
          environment: "Production",
          revoked: false,
          ...value,
        },
      },
    });
  state.entitlementStatus = "ready";
  state.user = apple({});
  assert.equal(
    PlannerState.entitlementBoundary(state.user),
    appleExpiry,
    "App Store access ends at its verified expiry",
  );
  assert.equal(PlannerState.hasConfirmedPlusAccess(state, now), true);
  assert.equal(PlannerState.hasConfirmedPlusAccess(state, appleExpiry), false);
  assert.equal(
    PlannerState.entitlementRefreshDelay(state.user, now),
    PlannerState.ENTITLEMENT_RECHECK_MAX_DELAY,
    "a later expiry still rechecks within the periodic window",
  );
  state.user = apple({ expiresAt: now + 60_000 });
  assert.equal(PlannerState.entitlementRefreshDelay(state.user, now), 60_050);
  state.user = apple({ inGracePeriod: true, expiresAt: now - 60_000 });
  assert.equal(
    PlannerState.entitlementBoundary(state.user),
    0,
    "Apple's billing grace period has no client-known end",
  );
  assert.equal(PlannerState.hasConfirmedPlusAccess(state, now), true);
  assert.equal(
    PlannerState.entitlementRefreshDelay(state.user, now),
    PlannerState.ENTITLEMENT_RECHECK_MAX_DELAY,
  );
  for (const value of [{ revoked: true }, { active: false }, { expiresAt: null }]) {
    state.user = apple(value);
    assert.equal(PlannerState.hasConfirmedPlusAccess(state, now), false, JSON.stringify(value));
  }
  state.user = {
    ...apple({}),
    discovery: { active: true, accessType: "apple", apple: null, subscription: null },
  };
  assert.equal(
    PlannerState.hasConfirmedPlusAccess(state, now),
    false,
    "a missing App Store summary fails closed instead of reading as lifetime access",
  );
});

test("planner rendering names the destination and safely escapes catalog content", () => {
  const markup = String(
    PlannerRender.libraryMarkup(
      [
        {
          id: "safe-id",
          name: "Press <script>",
          sub: "Chest",
          equipment: "Dumbbell",
          youtube: "https://example.test",
          score: 88,
        },
      ],
      { selectedDay: "Wednesday", visibleLimit: 16, pageSize: 16 },
    ),
  );
  assert.match(markup, />Add to Wednesday<\/button>/);
  assert.match(markup, /aria-label="Add Press &lt;script&gt; to Wednesday"/);
  assert.doesNotMatch(markup, /<\s*script\s*>/);
  const navigation = String(
    PlannerRender.dayNavMarkup(Logic.DAYS, {
      selectedDay: "Wednesday",
      restDays: ["Sunday"],
    }),
  );
  assert.equal((navigation.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(navigation, /Sunday, recovery day/);
  assert.match(
    navigation,
    /data-day-chip="Sunday"[^>]*disabled[^>]*>Sun<small>Rest day<\/small><\/button>/,
    "a rest day is labelled in the picker, not only greyed out",
  );
  assert.doesNotMatch(navigation, /data-day-chip="Monday"[^>]*>Mon<small>/);
});

const HOSTILE = 'Press <b> & "x"',
  HOSTILE_ESCAPED = "Press &lt;b&gt; &amp; &quot;x&quot;",
  DOUBLE_ESCAPED = /&amp;(?:lt|gt|quot|amp|#39);/;

function fakeElements() {
  const elements = new Map();
  return (id) => {
    if (!elements.has(id))
      elements.set(id, {
        id,
        innerHTML: "",
        textContent: "",
        value: "",
        hidden: false,
        disabled: false,
        checked: false,
        dataset: {},
        setAttribute() {},
      });
    return elements.get(id);
  };
}

function hostilePlan() {
  const value = Logic.emptyPlan();
  value.days.Monday.push(
    { instanceId: 'one"<&', exerciseId: "press", sets: 3, reps: '5 <b> & "x"' },
    { instanceId: "two", exerciseId: "press", sets: 2, reps: "8–12" },
  );
  return value;
}

const hostileExercise = {
  id: 'press"<&',
  name: HOSTILE,
  sub: "Chest & <i>",
  equipment: "Cable",
  youtube: "https://example.test/?a=1&b=2",
  score: 88,
};

function hostileSummary(value) {
  return PlannerRender.planConflictSummaryMarkup({
    plan: value,
    days: Logic.DAYS,
    restDays: Logic.restDays(value),
    exerciseById: () => hostileExercise,
    movementCount: Logic.planMovementCount(value),
  });
}

test("planner views escape member and catalog text exactly once", () => {
  const value = hostilePlan();
  const library = String(
    PlannerRender.libraryMarkup([hostileExercise], {
      selectedDay: "Monday",
      visibleLimit: 16,
      pageSize: 16,
    }),
  );
  assert.match(
    library,
    new RegExp(`<h3>${HOSTILE_ESCAPED}</h3><p>Chest &amp; &lt;i&gt; · Cable</p>`),
  );
  assert.match(library, /data-library-id="press&quot;&lt;&amp;"/);
  assert.match(library, /href="https:\/\/example\.test\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(library, DOUBLE_ESCAPED);

  const board = String(
    PlannerRender.weekBoardMarkup({
      plan: value,
      days: Logic.DAYS,
      selectedDay: "Monday",
      restDays: Logic.restDays(value),
      exerciseById: () => hostileExercise,
    }),
  );
  assert.match(board, new RegExp(`<h3 id="scheduled-one&quot;&lt;&amp;">${HOSTILE_ESCAPED}</h3>`));
  assert.match(board, /value="5 &lt;b&gt; &amp; &quot;x&quot;"/);
  assert.match(board, /<option value="Monday" selected>Monday<\/option>/);
  assert.doesNotMatch(board, DOUBLE_ESCAPED);

  const summary = String(hostileSummary(value));
  assert.match(
    summary,
    new RegExp(
      `<li><strong>Monday</strong><p>${HOSTILE_ESCAPED} <span>3 × 5 &lt;b&gt; &amp; &quot;x&quot;</span>, ${HOSTILE_ESCAPED} <span>2 × 8–12</span></p></li>`,
    ),
  );
  assert.match(summary, /<li><strong>Sunday · recovery<\/strong><p>No movements<\/p><\/li>/);
  assert.doesNotMatch(summary, DOUBLE_ESCAPED);

  const overview = String(
    PlannerRender.activationOverviewMarkup({
      candidate: {
        label: HOSTILE,
        profile: {
          goal: "build-muscle",
          availability: ["Monday"],
          minutes: 35,
          equipment: ["Bands & <i>"],
        },
      },
      accountCount: 1,
      deviceCount: 2,
    }),
  );
  assert.match(overview, new RegExp(`<strong>${HOSTILE_ESCAPED}</strong>`));
  assert.match(overview, /<strong>Bands &amp; &lt;i&gt;<\/strong>/);
  assert.doesNotMatch(overview, DOUBLE_ESCAPED);

  assert.match(
    String(PlannerRender.modeNoticeMarkup({ guest: true, oversized: true })),
    /href="\/account\.html\?mode=login&amp;next=planner">Use a synced plan<\/a><p><strong>Large saved draft preserved\.<\/strong>/,
  );
});

test("planner conflict, template and device-week workflows escape stored text exactly once", async () => {
  const value = hostilePlan();
  const conflictEl = fakeElements();
  const conflicts = PlannerConflicts.createController({
    state: {
      guest: false,
      user: { id: "u1" },
      conflictLatest: value,
      conflictDraft: value,
      conflictReview: false,
      recoveredDrafts: [{ key: 'draft"<&', data: { updatedAt: 0, plan: value } }],
      recoverySource: null,
    },
    el: conflictEl,
    storage: new MemoryStorage(),
    planMovementCount: Logic.planMovementCount,
    planConflictSummary: hostileSummary,
  });
  conflicts.renderPlanConflict();
  assert.match(
    conflictEl("latestPlanSummary").innerHTML,
    new RegExp(`<p>${HOSTILE_ESCAPED} <span>`),
  );
  assert.match(
    conflictEl("draftRecoverySelect").innerHTML,
    /^<option value="draft&quot;&lt;&amp;">Draft 1 · /,
  );
  for (const id of ["latestPlanSummary", "localPlanSummary", "draftRecoverySelect"])
    assert.doesNotMatch(conflictEl(id).innerHTML, DOUBLE_ESCAPED, id);

  const storage = new MemoryStorage(),
    key = `${PlannerTemplates.TEMPLATE_PREFIX}guest:id"<&`;
  storage.setItem(
    key,
    JSON.stringify({
      format: "strata-week-template",
      version: 1,
      name: HOSTILE,
      updatedAt: 1,
      plan: value,
    }),
  );
  Object.defineProperty(storage, "length", { get: () => storage.values.size });
  storage.key = (index) => [...storage.values.keys()][index] ?? null;
  const templateEl = fakeElements();
  const templates = PlannerTemplates.createController({
    state: { guest: true },
    el: templateEl,
    storage,
    validateWeekPlan: (input) => input,
    planConflictSummary: hostileSummary,
  });
  templates.renderTemplates();
  assert.equal(
    templateEl("weekTemplateSelect").innerHTML,
    `<option value="">Choose a saved week</option><option value="${PlannerTemplates.TEMPLATE_PREFIX}guest:id&quot;&lt;&amp;">${HOSTILE_ESCAPED}</option>`,
  );
  assert.equal(templates.previewTemplate(value, HOSTILE, key), true);
  assert.equal(templateEl("templatePreviewTitle").textContent, HOSTILE);
  assert.match(
    templateEl("templatePreviewSummary").innerHTML,
    new RegExp(`<p>${HOSTILE_ESCAPED} <span>`),
  );
  assert.doesNotMatch(templateEl("templatePreviewSummary").innerHTML, DOUBLE_ESCAPED);

  const deviceEl = fakeElements();
  const candidate = {
    id: 'device"<&',
    label: HOSTILE,
    plan: value,
    profile: { goal: "build-muscle", availability: ["Monday"], minutes: 35, equipment: ["Cable"] },
  };
  const activation = PlannerActivation.createController({
    state: { guest: false, user: { id: "u1" }, plan: Logic.emptyPlan(), planUpdatedAt: 1 },
    el: deviceEl,
    storage: new MemoryStorage(),
    activation: { deviceCandidates: () => [candidate], shouldOffer: () => true },
    logic: Logic,
    planMovementCount: Logic.planMovementCount,
    validateWeekPlan: (input) => input,
    planConflictSummary: hostileSummary,
    renderActivationOverview: PlannerRender.activationOverviewMarkup,
    focusSoon() {},
  });
  assert.equal(activation.offerDevicePlan(), true);
  assert.equal(
    deviceEl("devicePlanSource").innerHTML,
    `<option value="device&quot;&lt;&amp;">${HOSTILE_ESCAPED} · 2 movements</option>`,
  );
  assert.equal(deviceEl("devicePlanTitle").innerHTML, "Save your <em>week.</em>");
  assert.equal(
    deviceEl("claimDevicePlan").innerHTML,
    'Save week to my account <span aria-hidden="true">→</span>',
  );
  assert.match(
    deviceEl("devicePlanOverview").innerHTML,
    new RegExp(`<strong>${HOSTILE_ESCAPED}</strong>`),
  );
  for (const id of ["devicePlanSource", "devicePlanOverview", "deviceCandidatePlanSummary"])
    assert.doesNotMatch(deviceEl(id).innerHTML, DOUBLE_ESCAPED, id);
});

test("planner API applies identity-bound mutation headers and reports typed failures", async () => {
  const calls = [];
  let verified = 0,
    accountChanged = 0;
  const client = PlannerApi.createClient({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    getSession: () => ({ guest: false, userId: "user-7", csrfToken: "csrf-7" }),
    verifyIdentity: async () => {
      verified += 1;
    },
    onAccountChanged: () => {
      accountChanged += 1;
    },
  });
  await client.request("/api/plan", { method: "PUT", body: "{}" });
  assert.equal(verified, 1);
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.headers["X-Strata-User"], "user-7");
  assert.equal(calls[0].options.headers["X-CSRF-Token"], "csrf-7");

  const changed = PlannerApi.createClient({
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "Changed", code: "ACCOUNT_CHANGED" }),
    }),
    getSession: () => ({ guest: false, userId: "u", csrfToken: "c" }),
    verifyIdentity: async () => {},
    onAccountChanged: () => {
      accountChanged += 1;
    },
  });
  await assert.rejects(
    changed.request("/api/plan"),
    (error) => error.code === "ACCOUNT_CHANGED" && error.status === 409,
  );
  assert.equal(accountChanged, 1);

  const offline = PlannerApi.createClient({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    getSession: () => ({ guest: true }),
  });
  await assert.rejects(offline.request("/api/plan"), (error) => error.code === "NETWORK_ERROR");
  for (const boundary of [PlannerConflicts, PlannerTemplates, PlannerActivation])
    assert.equal(typeof boundary.createController, "function");
  assert.equal(typeof PlannerEvents.bindPlannerEvents, "function");
});

test("planner entrypoint composes bounded modules in dependency order", () => {
  const modules = [
    "entitlements.js",
    "planner-logic.js",
    "planner-state.js",
    "planner-api.js",
    "planner-render.js",
    "planner-conflicts.js",
    "planner-templates.js",
    "planner-activation.js",
    "planner-events.js",
  ];
  const sources = Object.fromEntries(
    modules.map((file) => [file, readFileSync(join(ROOT, "public", "scripts", file), "utf8")]),
  );
  for (const [file, source] of Object.entries(sources))
    assert.ok(
      lineCount(source) <= frontendBudget(file),
      `${file} should stay a focused browser module`,
    );
  assert.match(
    sources["planner-state.js"],
    /require\("\.\/planner-logic"\)/,
    "state may depend on pure planner logic",
  );
  for (const file of [
    "planner-logic.js",
    "planner-api.js",
    "planner-render.js",
    "planner-conflicts.js",
    "planner-templates.js",
    "planner-activation.js",
    "planner-events.js",
  ])
    assert.doesNotMatch(
      sources[file],
      /require\s*\(\s*"\.\/planner-/i,
      `${file} must not create a planner module cycle`,
    );
  const html = readFileSync(join(ROOT, "public", "pages", "planner.html"), "utf8"),
    entry = html.indexOf('src="planner.js');
  assert.ok(entry > 0);
  for (const file of modules)
    assert.ok(
      html.indexOf(`src="/${file}`) > 0 && html.indexOf(`src="/${file}`) < entry,
      `${file} must load before the planner entrypoint`,
    );
  const main = readFileSync(join(ROOT, "public", "scripts", "planner.js"), "utf8");
  assert.ok(
    lineCount(main) <= frontendBudget("planner.js"),
    "planner orchestration should stay focused after workflow extraction",
  );
  for (const globalName of [
    "StrataPlannerConflicts",
    "StrataPlannerTemplates",
    "StrataPlannerActivation",
  ])
    assert.match(
      main,
      new RegExp(`globalThis\\.${globalName}`),
      `entrypoint should explicitly compose ${globalName}`,
    );
  assert.match(
    html,
    /id="resetWeeklyPlan"[^>]*aria-haspopup="dialog"[^>]*aria-controls="resetWeekDialog"/,
  );
  assert.match(
    html,
    /<dialog class="planner-dialog reset-week-dialog"[^>]*aria-labelledby="resetWeekDialogTitle"[^>]*aria-describedby="resetWeekDialogDescription resetWeekImpact"/,
  );
  assert.match(
    main,
    /state\s*\.plan\s*=\s*emptyPlan\s*\(\s*,?\s*\)\s*;\s*state\s*\.selectedDay\s*=\s*STATE\s*\.firstTrainingDay\s*\(\s*state\s*\.plan\s*,?\s*\)/,
    "whole-week reset must reuse the canonical empty plan",
  );
  assert.match(
    sources["planner-events.js"],
    /window\s*\.addEventListener\s*\(\s*"focus"\s*,\s*refreshEntitlement\s*,?\s*\)/,
    "returning to Plan must recheck Strata+ access",
  );
  assert.match(
    main,
    /state\s*\.entitlementStatus\s*=\s*"checking"\s*;\s*renderSummary\s*\(\s*,?\s*\)\s*;\s*renderPlannerModeNotice\s*\(\s*,?\s*\)/,
    "foreground checks must hide entitlement-bound UI before awaiting the network",
  );
});

test("the planner loads exercise guidance once, adds the guide builder only if missing, and retries a failure", async () => {
  const requests = [],
    scripts = [];
  let fail = true,
    builder = false;
  const documentImpl = {
    createElement: () => ({}),
    head: {
      append(script) {
        scripts.push(script.src);
        setImmediate(() => (fail ? script.onerror() : script.onload()));
      },
    },
  };
  const load = PlannerApi.createGuidanceLoader({
    request: async (path) => {
      requests.push(path);
      return [{ id: "squat", cues: ["Brace"] }];
    },
    documentImpl,
    hasBuilder: () => builder,
    catalogPath: "/exercises.json?v=test",
    builderPath: "/discovery-core.js?v=test",
  });
  await assert.rejects(Promise.all([load(), load()]), /could not load/);
  assert.equal(requests.length, 1, "two guides opened together share one request");
  assert.deepEqual(scripts, ["/discovery-core.js?v=test"]);
  fail = false;
  assert.deepEqual(await load(), [{ id: "squat", cues: ["Brace"] }], "a failed load is retried");
  assert.equal(requests.length, 2);
  builder = true;
  await load();
  assert.equal(requests.length, 2, "a loaded catalog is kept");
  assert.equal(scripts.length, 2);
});
