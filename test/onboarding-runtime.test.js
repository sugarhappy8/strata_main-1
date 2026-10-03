"use strict";

const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const { join } = require("node:path");
const Activation = require("../public/scripts/activation-core");
const { loadHtml } = require("./support/browser-html");
const ROOT = join(__dirname, ".."),
  GUEST_KEY = "strata_guest_plan_v1";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const emptyWeek = () => ({
  version: 1,
  restDay: "Sunday",
  days: Object.fromEntries(DAYS.map((day) => [day, []])),
});
const previewWeek = emptyWeek();
previewWeek.days.Monday = [
  { instanceId: "preview-one", exerciseId: "bench-press", sets: 3, reps: "8–12" },
];
const savedPreferences = () => ({
  version: 1,
  goal: "strength",
  level: "Intermediate",
  days: 4,
  equipment: ["Barbell"],
  preferences: ["compound"],
  limitations: ["no-floor"],
});
const previewPreferences = () => ({
  version: 1,
  goal: "strength",
  level: "Intermediate",
  days: 1,
  equipment: ["Barbell"],
  preferences: ["compound"],
  limitations: ["no-floor"],
});

async function setup({
  guest = false,
  switchedAccount = false,
  saveStatus = 200,
  accountFailure = false,
  noRandomUUID = false,
  plus = true,
  fresh = false,
  activation = false,
} = {}) {
  const html = fs.readFileSync(join(ROOT, "public/pages/onboarding.html"), "utf8");
  const elements = new Map(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [
      match[1],
      {
        id: match[1],
        value: "",
        disabled: true,
        hidden: false,
        checked: false,
        textContent: "",
        innerHTML: "",
        target: "",
        rel: "",
        focused: false,
        listeners: {},
        options: [],
        dataset: {},
        attributes: {},
        addEventListener(type, listener) {
          this.listeners[type] = listener;
        },
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        focus() {
          this.focused = true;
        },
        after() {},
        remove() {},
      },
    ]),
  );
  elements.get("goal").value = "balanced";
  elements.get("goal").options = ["balanced", "hypertrophy", "strength", "time-efficient"].map(
    (value) => ({ value }),
  );
  elements.get("level").value = "Beginner";
  elements.get("level").options = ["Beginner", "Intermediate", "Advanced"].map((value) => ({
    value,
  }));
  elements.get("minutes").value = "35";
  elements.get("minutes").options = ["20", "35", "50"].map((value) => ({ value }));
  const state = {
    values: new Map(),
    failGuestWrite: false,
    requests: [],
    plus,
    plan: emptyWeek(),
    preferences: savedPreferences(),
    signedOut: "",
  };
  const response = (status, data) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
  const context = {
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: () => [],
      createElement: () => ({}),
    },
    window: {
      StrataOnboarding: {
        DAYS,
        starterProfile: () => ({
          goal: "balanced",
          level: "Beginner",
          equipment: [],
          availability: ["Monday", "Wednesday", "Friday"],
          preferences: ["simple-setup"],
          limitations: [],
          recoveryAdjusted: false,
        }),
        profileFromSaved: (preferences, plan) => ({
          goal: preferences.goal,
          level: preferences.level,
          equipment: preferences.equipment,
          availability: DAYS.filter((day) => plan.days[day].length),
          preferences: preferences.preferences,
          limitations: preferences.limitations,
        }),
        trainingSnapshot: (profile, week) => ({
          trainingDays: profile.availability.length,
          recoveryDays: 7 - profile.availability.length,
          minutes: profile.minutes,
          weeklyMinutes: profile.availability.length * profile.minutes,
          equipmentCount: profile.equipment.length,
          movementCount: week?.sessions?.flatMap((session) => session.items || []).length || 0,
          workingSets: 0,
          ready: Boolean(profile.availability.length && profile.equipment.length),
          message: "Preview choices summarized.",
        }),
        buildWeek: (profile, _exercises, _discovery, makeId) => {
          state.generatedId = makeId();
          state.generatedProfile = profile;
          return { plan: previewWeek, sessions: [], preferences: previewPreferences() };
        },
      },
      StrataDiscovery: {},
    },
    localStorage: {
      getItem: (key) => state.values.get(key) || null,
      setItem(key, value) {
        if (key === GUEST_KEY && state.failGuestWrite) {
          state.failGuestWrite = false;
          throw new Error("Browser storage is temporarily unavailable.");
        }
        state.values.set(key, value);
      },
    },
    navigator: { onLine: true },
    crypto: noRandomUUID ? {} : { randomUUID: () => "preview-one" },
    Blob,
    URL,
    console,
    fetch: async (path, options = {}) => {
      state.requests.push({ path, options });
      if (path.startsWith("/exercises.json"))
        return response(200, [{ id: "bench-press", equipment: "Barbell" }]);
      if (path === "/api/setup" && options.method !== "PUT") {
        if (accountFailure) return response(503, { error: "Account storage unavailable" });
        return guest
          ? response(401, { error: "Sign in required" })
          : response(200, {
              user: { id: "account-a", name: "Setup Account", discovery: { active: state.plus } },
              csrfToken: "csrf-a",
              plan: state.plan,
              planUpdatedAt: fresh ? 0 : 100,
              preferences: state.preferences,
              preferencesUpdatedAt: fresh ? 0 : 90,
            });
      }
      if (path === "/api/me" && state.signedOut === "legacy")
        return response(401, { error: "Not signed in." });
      if (path === "/api/me")
        return guest || state.signedOut
          ? response(200, { user: null })
          : response(200, {
              user: {
                id: switchedAccount ? "account-b" : "account-a",
                discovery: { active: state.plus },
              },
              csrfToken: switchedAccount ? "csrf-b" : "csrf-a",
            });
      if (path === "/api/setup" && options.method === "PUT") {
        if (saveStatus !== 200)
          return response(saveStatus, { error: "Your week changed", code: "PLAN_CHANGED" });
        const input = JSON.parse(options.body);
        state.plan = input.plan;
        state.preferences = input.preferences;
        return response(200, {
          ok: true,
          plan: state.plan,
          planUpdatedAt: 101,
          preferences: state.preferences,
          preferencesUpdatedAt: 101,
        });
      }
      throw new Error(`Unexpected request ${path}`);
    },
  };
  if (activation) {
    context.StrataActivation = Activation;
    Activation.writeIntent(
      context.localStorage,
      {
        source: "homepage",
        profile: {
          goal: "hypertrophy",
          level: "Advanced",
          minutes: 20,
          equipment: ["Barbell"],
          availability: ["Tuesday", "Thursday"],
          preferences: ["compound"],
          limitations: ["no-floor"],
          focusGroup: "back",
        },
        plan: previewWeek,
      },
      123,
    );
  }
  loadHtml(vm.createContext(context));
  vm.runInNewContext(fs.readFileSync(join(ROOT, "public/scripts/onboarding.js"), "utf8"), context, {
    filename: "onboarding.js",
  });
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  const generate = () => elements.get("setupForm").listeners.submit({ preventDefault() {} });
  const save = () => elements.get("saveWeek").listeners.click();
  return { state, elements, generate, save };
}

test("onboarding denies guests and free accounts without changing their plans", async () => {
  for (const options of [{ guest: true }, { plus: false }]) {
    const fixture = await setup(options),
      stored = JSON.stringify(emptyWeek());
    fixture.state.values.set(GUEST_KEY, stored);
    await fixture.generate();
    await fixture.save();
    assert.equal(fixture.elements.get("setupFields").disabled, true);
    assert.equal(fixture.state.generatedId, undefined);
    assert.equal(
      fixture.state.requests.some((request) => request.options.method === "PUT"),
      false,
    );
    assert.equal(fixture.state.values.get(GUEST_KEY), stored);
    assert.equal(fixture.elements.has("offlineSetup"), false);
    assert.equal(fixture.elements.get("setupStatus").attributes.role, "alert");
    assert.equal(fixture.elements.get("setupStatus").dataset.state, "error");
    assert.equal(fixture.elements.get("setupStatus").focused, true);
  }
});

test("onboarding restores a polite success status after an announced error", async () => {
  const fixture = await setup();
  await fixture.generate();
  const setupStatus = fixture.elements.get("setupStatus");
  assert.equal(setupStatus.attributes.role, "status");
  assert.equal(setupStatus.dataset.state, "good");
});

test("onboarding preserves its generated preview and account plan when Strata+ expires", async () => {
  const fixture = await setup();
  await fixture.generate();
  fixture.state.plus = false;
  await fixture.save();
  assert.equal(
    fixture.state.requests.some((request) => request.options.method === "PUT"),
    false,
  );
  assert.equal(fixture.elements.get("saveWeek").disabled, true);
  assert.equal(fixture.elements.get("saveControls").hidden, false);
  assert.match(fixture.elements.get("setupStatus").textContent, /Strata\+/);
  assert.deepEqual(fixture.state.plan, emptyWeek());
});

test("a session that ends before a preview locks setup alike for 200 { user: null } and an older 401", async () => {
  for (const signedOut of ["visitor", "legacy"]) {
    const fixture = await setup();
    fixture.state.signedOut = signedOut;
    await fixture.generate();
    assert.equal(fixture.elements.get("setupFields").disabled, true, signedOut);
    assert.equal(fixture.elements.get("saveWeek").disabled, true, signedOut);
    assert.equal(fixture.elements.get("previewSummary").hidden, true, signedOut);
    assert.equal(fixture.elements.get("saveControls").hidden, true, signedOut);
    assert.equal(fixture.elements.get("setupStatus").textContent, "Not signed in.", signedOut);
    assert.equal(fixture.elements.get("setupStatus").dataset.state, "error", signedOut);
    assert.equal(fixture.state.generatedId, undefined, signedOut);
  }
});

test("onboarding prevents an account A preview from being saved after switching to account B", async () => {
  const fixture = await setup({ switchedAccount: true });
  await fixture.generate();
  await fixture.save();
  assert.equal(
    fixture.state.requests.filter((request) => request.options.method === "PUT").length,
    0,
  );
  assert.match(fixture.elements.get("setupStatus").textContent, /account changed/);
});

test("onboarding sends the original account and revision and preserves its preview on conflict", async () => {
  const fixture = await setup({ saveStatus: 409 });
  await fixture.generate();
  await fixture.save();
  const request = fixture.state.requests.find((item) => item.options.method === "PUT");
  assert.equal(request.options.headers["X-Strata-User"], "account-a");
  assert.equal(request.options.headers["X-CSRF-Token"], "csrf-a");
  assert.equal(JSON.parse(request.options.body).expectedPlanUpdatedAt, 100);
  assert.equal(JSON.parse(request.options.body).expectedPreferencesUpdatedAt, 90);
  assert.deepEqual(JSON.parse(request.options.body).preferences, previewPreferences());
  assert.deepEqual(fixture.state.plan, emptyWeek());
  assert.equal(fixture.elements.get("saveControls").hidden, false);
  assert.match(fixture.elements.get("setupStatus").textContent, /preview is safe here/);
  const plannerAction = fixture.elements.get("openPlanner");
  assert.equal(
    plannerAction.hidden,
    false,
    "a conflict must expose the recovery destination without hiding the preview",
  );
  assert.match(plannerAction.textContent, /Open planner in a new tab/);
  assert.equal(
    plannerAction.target,
    "_blank",
    "the comparison must preserve this tab's generated preview",
  );
  assert.equal(plannerAction.rel, "noopener");
  assert.equal(
    plannerAction.focused,
    true,
    "the recovery action must receive focus after the announced conflict",
  );
});

test("onboarding does not silently enter guest mode when account storage fails", async () => {
  const fixture = await setup({ accountFailure: true });
  assert.equal(fixture.elements.get("setupFields").disabled, true);
  assert.equal(fixture.elements.has("offlineSetup"), false);
  await fixture.generate();
  await fixture.save();
  assert.equal(fixture.state.values.has(GUEST_KEY), false);
  assert.equal(
    fixture.state.requests.filter((request) => request.options.method === "PUT").length,
    0,
  );
});

test("onboarding preview works where crypto.randomUUID is unavailable", async () => {
  const fixture = await setup({ noRandomUUID: true });
  await fixture.generate();
  assert.match(fixture.state.generatedId, /^setup-[a-zA-Z0-9_-]+$/);
  await fixture.save();
  assert.deepEqual(fixture.state.plan, previewWeek);
  assert.equal(fixture.elements.get("savedActions").hidden, false);
  assert.equal(fixture.elements.get("startFirstWorkout").href, "/workout.html?day=Monday");
  assert.equal(fixture.elements.get("startFirstWorkout").focused, true);
  assert.equal(
    fixture.elements.get("connectPolarOptional").hidden,
    false,
    "after saving, Polar is offered as an optional next step",
  );
});

test("fresh Strata+ setup starts with a one-choice quick path and honest starter defaults", async () => {
  const fixture = await setup({ fresh: true });
  assert.equal(fixture.elements.get("starterPath").hidden, false);
  assert.equal(fixture.elements.get("goal").value, "balanced");
  assert.equal(fixture.elements.get("level").value, "Beginner");
  assert.match(fixture.elements.get("dayChoices").innerHTML, /value="Monday" checked/);
  assert.match(fixture.elements.get("dayChoices").innerHTML, /value="Wednesday" checked/);
  assert.match(fixture.elements.get("dayChoices").innerHTML, /value="Friday" checked/);
  assert.doesNotMatch(fixture.elements.get("equipmentChoices").innerHTML, /checked/);
});

test("fresh Strata+ setup restores the homepage profile without saving its week", async () => {
  const fixture = await setup({ fresh: true, activation: true });
  assert.equal(fixture.elements.get("goal").value, "hypertrophy");
  assert.equal(fixture.elements.get("level").value, "Advanced");
  assert.equal(fixture.elements.get("minutes").value, "20");
  assert.match(fixture.elements.get("equipmentChoices").innerHTML, /value="Barbell" checked/);
  assert.match(fixture.elements.get("dayChoices").innerHTML, /value="Tuesday" checked/);
  assert.match(fixture.elements.get("dayChoices").innerHTML, /value="Thursday" checked/);
  assert.match(
    fixture.elements.get("accountMode").textContent,
    /homepage choices survived signup/i,
  );
  assert.equal(
    fixture.state.requests.some((request) => request.options.method === "PUT"),
    false,
    "restoring a preview cannot write to the account",
  );
});

test("onboarding starts from the account profile and describes an existing week as a replacement", async () => {
  const fixture = await setup();
  fixture.state.plan = previewWeek;
  await fixture.elements.get("retrySetup").listeners.click();
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.elements.get("goal").value, "strength");
  assert.equal(fixture.elements.get("level").value, "Intermediate");
  assert.match(fixture.elements.get("equipmentChoices").innerHTML, /value="Barbell" checked/);
  assert.match(fixture.elements.get("dayChoices").innerHTML, /value="Monday" checked/);
  assert.equal(fixture.elements.get("generateWeekLabel").textContent, "Preview a replacement week");
  assert.match(fixture.elements.get("accountMode").textContent, /already have a saved week/i);
});
