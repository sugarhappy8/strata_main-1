"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { join } = require("node:path");

const PROJECT_ROOT = join(__dirname, "..");
const RELEASE = require(join(PROJECT_ROOT, "package.json"));
const BUILD = RELEASE.strataBuild || RELEASE.version;
const CATALOG_URL = `/exercises.json?v=${BUILD}`;
const readPublic = (...parts) => fs.readFileSync(join(PROJECT_ROOT, "public", ...parts), "utf8");
const html = readPublic("pages", "planner.html");
// The stylesheet is compared without layout whitespace, so these checks hold for dense and formatted CSS alike.
const compactCss = (css) =>
  css
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>()])\s*/g, "$1")
    .replace(/;\}/g, "}");
const plannerCss = compactCss(readPublic("styles", "planner.css"));
const exercises = JSON.parse(readPublic("data", "exercises.json"));
const Discovery = require(join(PROJECT_ROOT, "public", "scripts", "discovery-core"));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

class ClassList {
  constructor() {
    this.values = new Set();
  }
  add(...names) {
    names.forEach((name) => this.values.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

let focusedSelector = "";
class Element {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.href = "";
    this.inert = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new ClassList();
    this.parentElement = { classList: new ClassList() };
  }
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {
    focusedSelector = `#${this.id}`;
  }
  querySelector(selector) {
    if (this.id !== "libraryList") return null;
    return {
      focus() {
        focusedSelector = selector;
      },
    };
  }
}

const elements = new Map(ids.map((id) => [id, new Element(id)]));
const documentListeners = {};
const document = {
  visibilityState: "visible",
  getElementById(id) {
    return elements.get(id) || null;
  },
  addEventListener(type, handler) {
    (documentListeners[type] ||= []).push(handler);
  },
  querySelector(selector) {
    return selector.startsWith("#") ? elements.get(selector.slice(1)) || null : null;
  },
  querySelectorAll() {
    return [];
  },
};

const plan = {
  version: 1,
  restDay: "Sunday",
  days: Object.fromEntries(DAYS.map((day) => [day, []])),
};
plan.days.Monday.push({
  instanceId: "runtime-plan-item",
  exerciseId: exercises[0].id,
  sets: 3,
  reps: "8–12",
});
const fetches = [];
const requests = [];
const guestStorageWrites = [];
const storedValues = new Map();
const windowListeners = {};
const context = {
  console,
  document,
  history: { replaceState() {} },
  location: {
    search: "",
    href: "http://strata.test/planner.html",
    origin: "http://strata.test",
    assign() {},
  },
  window: {
    location: { replace() {} },
    matchMedia: () => ({ matches: false }),
    addEventListener(type, handler) {
      (windowListeners[type] ||= []).push(handler);
    },
  },
  localStorage: {
    get length() {
      return storedValues.size;
    },
    key(index) {
      return [...storedValues.keys()][index] || null;
    },
    getItem(key) {
      return storedValues.get(key) || null;
    },
    setItem(key, value) {
      storedValues.set(key, value);
      guestStorageWrites.push({ key, value });
    },
    removeItem(key) {
      storedValues.delete(key);
    },
  },
  fetch: async (path, options = {}) => {
    if (path === "/api/me")
      return { ok: true, json: async () => ({ user: { id: "u1" }, csrfToken: "planner-csrf" }) };
    fetches.push(path);
    requests.push({ path, options });
    if (path === CATALOG_URL) return { ok: true, json: async () => exercises };
    if (path === "/api/plan")
      return {
        ok: true,
        json: async () => ({
          plan,
          user: {
            id: "u1",
            name: "Planner Audit",
            email: "audit@example.test",
            discovery: {
              active: true,
              accessType: "paid",
              trial: { eligible: false, active: false },
            },
          },
          csrfToken: "planner-csrf",
          planUpdatedAt: 1_700_000_000_100,
        }),
      };
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  },
  requestAnimationFrame: (callback) => callback(),
  setTimeout,
  clearTimeout,
  URL,
  URLSearchParams,
};
context.globalThis = context;
context.StrataDiscovery = Discovery;
vm.createContext(context);
vm.runInContext(readPublic("scripts", "html.js"), context, { filename: "html.js" }); // Every page loads it first.
for (const script of [
  "activation-core.js",
  "entitlements.js",
  "planner-logic.js",
  "planner-state.js",
  "planner-api.js",
  "planner-render.js",
  "planner-conflicts.js",
  "planner-templates.js",
  "planner-activation.js",
  "planner-events.js",
]) {
  vm.runInContext(readPublic("scripts", script), context, { filename: script });
}
vm.runInContext(readPublic("scripts", "planner.js"), context, { filename: "planner.js" });

function renderedIds() {
  return [...elements.get("libraryList").innerHTML.matchAll(/data-library-id="([^"]+)"/g)].map(
    (match) => match[1],
  );
}

function clickLoadMore() {
  const target = {
    closest(selector) {
      return selector === "[data-load-more-library]" ? { dataset: {} } : null;
    },
  };
  const event = {
    target,
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  for (const handler of documentListeners.click || []) handler(event);
}

function clickSelectDay(day) {
  const select = { dataset: { selectDay: day, dayChip: day } };
  const target = {
    closest(selector) {
      return selector === "[data-select-day]" ? select : null;
    },
  };
  const event = {
    target,
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  for (const handler of documentListeners.click || []) handler(event);
}

(async () => {
  await new Promise(setImmediate);

  const initialIds = renderedIds();
  const initialMarkup = elements.get("libraryList").innerHTML;
  const dayNavMarkup = elements.get("plannerDayNav").innerHTML;
  assert.equal(initialIds.length, 32, "Desktop planner should initially render 32 library cards");
  assert.equal(
    new Set(initialIds).size,
    32,
    "Initial planner page must not contain duplicate cards",
  );
  assert.match(initialMarkup, /data-load-more-library/, "Expanded catalog should expose Load more");
  assert.match(initialMarkup, /Load 32 more/, "Desktop Load more should reveal the next 32 cards");
  assert.match(
    initialMarkup,
    />Add to Monday<\/button>/,
    "Library actions should name the selected destination day",
  );
  assert.match(
    initialMarkup,
    />Video<\/a>/,
    "Tutorial actions should use a clear text label instead of an unexplained symbol",
  );
  assert.match(
    initialMarkup,
    /data-guide-exercise=/,
    "Every planner movement should expose its catalog-backed setup guide",
  );
  for (const day of DAYS) {
    const chip = dayNavMarkup.match(
      new RegExp(`<button\\b(?=[^>]*data-day-chip="${day}")[^>]*>`),
    )?.[0];
    assert.ok(chip, `${day} must have a quick-add day chip`);
    assert.match(
      chip,
      /\baria-pressed="(?:true|false)"/,
      `${day} day chip must expose its selected state`,
    );
  }
  assert.equal(
    (dayNavMarkup.match(/\baria-pressed="true"/g) || []).length,
    1,
    "Exactly one quick-add day must be selected",
  );
  assert.match(
    html,
    /id="weekBoard"[^>]*aria-describedby="weekScrollHint"/,
    "The horizontal week must expose its scroll instructions",
  );
  const finalMobileStart = plannerCss.lastIndexOf("@media(max-width:760px)"),
    nextMobileRule = plannerCss.indexOf("@media", finalMobileStart + 1);
  const finalMobileRule = plannerCss.slice(
    finalMobileStart,
    nextMobileRule < 0 ? plannerCss.length : nextMobileRule,
  );
  assert.match(
    finalMobileRule,
    /\.library-panel\{[^}]*\btop:auto\b/,
    "The final mobile cascade must cancel the desktop sticky offset",
  );
  assert.doesNotMatch(
    finalMobileRule,
    /\.planner-day-chip\{[^}]*min-width:0/,
    "The final mobile cascade must preserve accessible day-chip targets",
  );
  assert.match(
    plannerCss,
    /@media\(max-width:480px\)\{[^}]*\.library-panel\{[^}]*72svh[^}]*\}\.planner-day-chips\{grid-template-columns:repeat\(4,minmax\(44px,1fr\)\)/,
    "Small screens should expose four full-size day targets per row and enough room to read library results",
  );
  assert.match(
    plannerCss,
    /\.library-list\{[^}]*grid-auto-rows:max-content/,
    "Library rows must grow with wrapped exercise names instead of clipping them",
  );
  assert.match(
    html,
    /id="exportWeeklyPlan"[^>]*>Export week/,
    "Export should use a short, familiar label",
  );
  assert.match(
    html,
    /<a href="\/account\.html">Profile<\/a>/,
    "Signed-in planners reach their account through Profile in the site navigation",
  );
  assert.match(
    html,
    /id="plannerSignIn"[^>]*>Sign in<\/a>/,
    "The guest sign-in link says what it does",
  );
  assert.equal(
    (html.match(/class="planner-workflow"/g) || []).length,
    1,
    "Planner onboarding should be a single compact workflow",
  );
  assert.match(
    html,
    /Build a weekly plan in three steps/,
    "Planner workflow should describe its purpose to assistive technology",
  );
  assert.match(
    plannerCss,
    /\.day-empty::before\s*\{[^}]*content:"\+"/,
    "Empty days should have a visible add cue",
  );
  assert.match(
    elements.get("weekSummary").innerHTML,
    /class="week-readiness ready"/,
    "A valid week should render clear train-ready guidance",
  );
  assert.match(
    elements.get("weekSummary").innerHTML,
    />Review Monday workout/,
    "A signed-in train-ready week should expose one clear review action before the final start",
  );
  assert.match(
    elements.get("weekSummary").innerHTML,
    /class="week-distribution"/,
    "The planner should render its weekly distribution as a deliberate summary graphic",
  );

  clickSelectDay("Tuesday");
  assert.equal(
    vm.runInContext("state.selectedDay", context),
    "Tuesday",
    "Day chips must update the quick-add target",
  );
  assert.match(
    elements.get("libraryList").innerHTML,
    /aria-label="Add [^"]+ to Tuesday"/,
    "Library add controls must announce the selected day",
  );
  assert.match(
    elements.get("libraryList").innerHTML,
    />Add to Tuesday<\/button>/,
    "Visible add copy must keep the destination clear",
  );
  assert.equal(elements.get("mobileAddDestination").textContent, "Add to Tuesday");
  assert.equal(elements.get("mobileWeekLink").textContent, "View Tuesday · 0 exercises");
  assert.equal(
    storedValues.get("strata_planner_selected_day_v1:user-u1"),
    "Tuesday",
    "The selected day should survive a return to the planner",
  );
  assert.equal(elements.has("recommendRest"), false, "Rest recommendations must be removed");
  vm.runInContext("setRestDay('Sunday')", context);
  assert.equal(
    vm.runInContext("restDays().length", context),
    0,
    "The final rest marker can be removed",
  );
  vm.runInContext("setRestDay('Wednesday');setRestDay('Saturday')", context);
  assert.equal(vm.runInContext("restDays().join(',')", context), "Wednesday,Saturday");
  vm.runInContext("setRestDay('Wednesday')", context);
  assert.equal(
    vm.runInContext("restDays().join(',')", context),
    "Saturday",
    "Removing one marker preserves the others",
  );
  vm.runInContext("setRestDay('Saturday');setRestDay('Sunday')", context);

  const focusedRepsInput = {
    dataset: { itemReps: "runtime-plan-item" },
    value: "12–15",
    closest(selector) {
      return selector === "[data-day]" ? { dataset: { day: "Monday" } } : null;
    },
  };
  for (const handler of documentListeners.input || []) handler({ target: focusedRepsInput });
  assert.equal(
    vm.runInContext("state.plan.days.Monday[0].reps", context),
    "12–15",
    "Typing must update plan state before the field blurs",
  );
  vm.runInContext(`state.plan.days.Monday[0].reps='5 <b> & "x"';renderWeek()`, context);
  assert.match(
    elements.get("weekBoard").innerHTML,
    /value="5 &lt;b&gt; &amp; &quot;x&quot;"/,
    "A member's own text reaches the week board escaped",
  );
  assert.doesNotMatch(
    elements.get("weekBoard").innerHTML,
    /&amp;(?:lt|gt|quot|amp|#39);/,
    "Week board text is escaped exactly once",
  );
  vm.runInContext("state.plan.days.Monday[0].reps='12–15';renderWeek()", context);

  clickLoadMore();

  const expandedIds = renderedIds();
  const loadMoreFocused = focusedSelector === '[data-library-index="32"] [data-quick-add]';
  const expandedResultStatus = elements.get("libraryResultStatus").textContent;

  let retrySaveAttempts = 0;
  context.fetch = async (path, options = {}) => {
    if (path === "/api/me")
      return { ok: true, json: async () => ({ user: { id: "u1" }, csrfToken: "planner-csrf" }) };
    if (path === "/api/plan" && options.method === "PUT") {
      retrySaveAttempts += 1;
      if (retrySaveAttempts === 1)
        return { ok: false, status: 503, json: async () => ({ error: "Temporary save failure" }) };
      return { ok: true, json: async () => ({ ok: true, plan, planUpdatedAt: 1_700_000_000_200 }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  vm.runInContext(
    "state.plan.days.Wednesday.push({instanceId:'retry-save-item',exerciseId:state.exercises[2].id,sets:3,reps:'8–12'});state.revision+=1;",
    context,
  );
  assert.equal(
    await vm.runInContext("flushSave()", context),
    false,
    "A failed save must remain unsaved",
  );
  assert.equal(elements.get("retryPlanSave").hidden, false, "A failed save must expose Retry");
  assert.equal(
    elements.get("saveStatus").textContent,
    "Couldn't save — Retry",
    "A failed save must use the shared retry state",
  );
  assert.match(
    elements.get("retryPlanSave").title,
    /could not save right now/i,
    "Retry must explain a temporary server failure",
  );
  await Promise.all(
    (elements.get("retryPlanSave").listeners.click || []).map((handler) =>
      handler({ currentTarget: elements.get("retryPlanSave") }),
    ),
  );
  assert.equal(retrySaveAttempts, 2, "Retry must make one fresh save request");
  assert.equal(
    elements.get("retryPlanSave").hidden,
    true,
    "Retry should hide after the plan saves",
  );
  assert.equal(elements.get("saveStatus").textContent, "Saved");

  const authoritativePlan = JSON.parse(JSON.stringify(plan));
  authoritativePlan.days.Monday[0].reps = "5–7";
  let conflictSaveAttempts = 0;
  const conflictSaveBodies = [];
  context.fetch = async (path, options = {}) => {
    if (path === "/api/me")
      return { ok: true, json: async () => ({ user: { id: "u1" }, csrfToken: "planner-csrf" }) };
    if (path === "/api/plan" && options.method === "PUT") {
      conflictSaveAttempts += 1;
      conflictSaveBodies.push(JSON.parse(options.body));
      if (conflictSaveAttempts === 1)
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Your weekly plan changed in another tab or device.",
            code: "PLAN_CHANGED",
            plan: authoritativePlan,
            planUpdatedAt: 1_700_000_000_300,
          }),
        };
      const submitted = conflictSaveBodies.at(-1);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, plan: submitted.plan, planUpdatedAt: 1_700_000_000_400 }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  vm.runInContext(
    "state.plan.days.Saturday.push({instanceId:'conflicting-local-item',exerciseId:state.exercises[3].id,sets:3,reps:'8–12'});state.revision+=1;",
    context,
  );
  assert.equal(
    await vm.runInContext("flushSave()", context),
    false,
    "A stale save must pause instead of overwriting the newer account plan",
  );
  assert.equal(conflictSaveAttempts, 1, "The dirty plan must reach the conflict response");
  assert.equal(
    vm.runInContext("Boolean(state.conflictDraft)", context),
    true,
    "The conflict response must enter recovery mode",
  );
  assert.equal(
    vm.runInContext("state.plan.days.Monday[0].reps", context),
    "5–7",
    "The planner must display the authoritative account plan after a conflict",
  );
  assert.equal(
    vm.runInContext("state.conflictDraft.days.Saturday[0].instanceId", context),
    "conflicting-local-item",
    "The unsaved local draft must remain recoverable",
  );
  assert.equal(
    vm.runInContext("state.savedRevision<state.revision", context),
    true,
    "Conflict recovery must keep navigation and unload safeguards active",
  );
  assert.equal(
    elements.get("plannerShell").inert,
    true,
    "Editing stays locked while the user considers the newer account copy",
  );
  assert.equal(
    elements.get("planConflictPanel").hidden,
    false,
    "Conflict recovery must expose choices outside the inert planner",
  );
  assert.match(
    elements.get("latestPlanSummary").innerHTML,
    /5–7/,
    "The comparison must show the latest account copy",
  );
  assert.match(
    elements.get("localPlanSummary").innerHTML,
    /conflicting-local-item|movement/i,
    "The comparison must show the unsaved local copy",
  );
  assert.equal(elements.get("retryPlanSave").textContent, "Review my changes");
  await Promise.all(
    (elements.get("reviewLocalPlan").listeners.click || []).map((handler) =>
      handler({ currentTarget: elements.get("reviewLocalPlan") }),
    ),
  );
  assert.equal(vm.runInContext("state.conflictReview", context), true);
  assert.equal(
    vm.runInContext("state.plan.days.Saturday[0].instanceId", context),
    "conflicting-local-item",
    "Review restores the local draft without saving it",
  );
  assert.equal(
    conflictSaveAttempts,
    1,
    "Restoring the draft must not silently retry the overwrite",
  );
  assert.equal(elements.get("retryPlanSave").textContent, "Save reviewed changes");
  assert.equal(
    await vm.runInContext("flushSave()", context),
    false,
    "Navigation-style flushes cannot bypass explicit conflict confirmation",
  );
  assert.equal(conflictSaveAttempts, 1);
  await Promise.all(
    (elements.get("retryPlanSave").listeners.click || []).map((handler) =>
      handler({ currentTarget: elements.get("retryPlanSave") }),
    ),
  );
  assert.equal(conflictSaveAttempts, 2);
  assert.equal(
    JSON.parse(vm.runInContext("JSON.stringify(state.plan)", context)).days.Saturday[0].instanceId,
    "conflicting-local-item",
  );
  assert.equal(
    conflictSaveBodies[1].expectedPlanUpdatedAt,
    1_700_000_000_300,
    "A confirmed recovery is based on the newer account revision",
  );
  assert.equal(
    vm.runInContext("state.planUpdatedAt", context),
    1_700_000_000_400,
    "The confirmed save adopts its new account revision",
  );
  assert.equal(vm.runInContext("state.conflictReview", context), false);
  assert.equal(vm.runInContext("state.conflictLatest", context), null);
  assert.equal(elements.get("planConflictPanel").hidden, true);
  assert.equal(elements.get("retryPlanSave").hidden, true);

  let keepLatestAttempts = 0;
  const nextAuthoritativePlan = JSON.parse(JSON.stringify(authoritativePlan));
  nextAuthoritativePlan.days.Monday[0].reps = "3–5";
  context.fetch = async (path, options = {}) => {
    if (path === "/api/me")
      return { ok: true, json: async () => ({ user: { id: "u1" }, csrfToken: "planner-csrf" }) };
    if (path === "/api/plan" && options.method === "PUT") {
      keepLatestAttempts += 1;
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: "Your weekly plan changed in another tab or device.",
          code: "PLAN_CHANGED",
          plan: nextAuthoritativePlan,
          planUpdatedAt: 1_700_000_000_500,
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  vm.runInContext(
    "state.plan.days.Friday.push({instanceId:'discarded-local-item',exerciseId:state.exercises[4].id,sets:2,reps:'10'});state.revision+=1;",
    context,
  );
  assert.equal(await vm.runInContext("flushSave()", context), false);
  await Promise.all(
    (elements.get("keepLatestPlan").listeners.click || []).map((handler) =>
      handler({ currentTarget: elements.get("keepLatestPlan") }),
    ),
  );
  assert.equal(keepLatestAttempts, 1, "Keeping the account plan must not issue an overwrite");
  assert.equal(vm.runInContext("state.plan.days.Monday[0].reps", context), "3–5");
  assert.equal(
    vm.runInContext("state.plan.days.Friday.length", context),
    0,
    "Keeping latest must discard only the unsaved local copy",
  );
  assert.equal(
    vm.runInContext("state.savedRevision", context),
    vm.runInContext("state.revision", context),
    "Keeping latest must leave the planner clean",
  );
  assert.equal(elements.get("plannerShell").inert, false);
  assert.equal(elements.get("planConflictPanel").hidden, true);

  const planBeforeEntitlementRefresh = vm.runInContext("JSON.stringify(state.plan)", context),
    saveBoundaryBefore = vm.runInContext(
      "[state.revision,state.savedRevision,state.planUpdatedAt]",
      context,
    );
  let resolveEntitlementRefresh;
  context.fetch = async (path) => {
    if (path === "/api/me")
      return new Promise((resolve) => {
        resolveEntitlementRefresh = resolve;
      });
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  vm.runInContext("state.entitlementCheckedAt=0", context);
  for (const handler of windowListeners.focus || []) handler();
  assert.equal(
    vm.runInContext("state.entitlementStatus", context),
    "checking",
    "foregrounding Plan must enter a fail-closed entitlement state before the account response arrives",
  );
  assert.doesNotMatch(
    elements.get("weekSummary").innerHTML,
    /class="week-readiness/,
    "Plus guidance must disappear during an uncertain foreground recheck",
  );
  assert.match(elements.get("plannerModeNotice").innerHTML, /Checking Strata\+ access/);
  resolveEntitlementRefresh({
    ok: true,
    json: async () => ({
      user: { id: "u1", name: "Planner Audit", discovery: { active: false, accessType: null } },
      csrfToken: "fresh-csrf",
    }),
  });
  await vm.runInContext("state.entitlementRefreshPromise", context);
  assert.equal(
    vm.runInContext("state.user.discovery.active", context),
    false,
    "a revoked entitlement must replace the stale Plus snapshot",
  );
  assert.doesNotMatch(elements.get("weekSummary").innerHTML, /class="week-readiness/);
  assert.match(elements.get("plannerModeNotice").innerHTML, /Free synced plan/);
  assert.equal(
    vm.runInContext("JSON.stringify(state.plan)", context),
    planBeforeEntitlementRefresh,
    "entitlement refreshes must not mutate the editable week",
  );
  assert.deepEqual(
    [...vm.runInContext("[state.revision,state.savedRevision,state.planUpdatedAt]", context)],
    [...saveBoundaryBefore],
    "entitlement refreshes must not disturb dirty/save revision boundaries",
  );

  context.fetch = async (path) =>
    path === "/api/me"
      ? {
          ok: true,
          json: async () => ({
            user: {
              id: "u1",
              name: "Planner Audit",
              discovery: {
                active: true,
                accessType: "paid",
                trial: { eligible: false, active: false },
              },
            },
            csrfToken: "restored-csrf",
          }),
        }
      : { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  vm.runInContext("state.entitlementCheckedAt=0", context);
  for (const handler of windowListeners.pageshow || []) handler({ persisted: true });
  await vm.runInContext("state.entitlementRefreshPromise", context);
  assert.match(
    elements.get("weekSummary").innerHTML,
    /class="week-readiness ready"/,
    "a confirmed Plus entitlement should restore guidance after a persisted-page return",
  );
  assert.equal(
    vm.runInContext("state.csrfToken", context),
    "restored-csrf",
    "the safe account refresh should retain the newest CSRF token for later saves",
  );
  assert.equal(
    vm.runInContext("Boolean(state.entitlementTimer)", context),
    true,
    "boundaryless Plus access must retain a bounded periodic refresh",
  );

  context.fetch = async (path) => {
    if (path === "/api/me") throw new Error("offline");
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  vm.runInContext("state.entitlementCheckedAt=0", context);
  for (const handler of windowListeners.focus || []) handler();
  await vm.runInContext("state.entitlementRefreshPromise", context);
  assert.equal(vm.runInContext("state.entitlementStatus", context), "unavailable");
  assert.equal(
    vm.runInContext("state.entitlementFailureCount", context),
    1,
    "the first transient account failure must enter retry backoff",
  );
  assert.equal(
    vm.runInContext("Boolean(state.entitlementTimer)", context),
    true,
    "a transient failure must schedule recovery without waiting for another focus event",
  );
  assert.doesNotMatch(
    elements.get("weekSummary").innerHTML,
    /class="week-readiness/,
    "guidance stays fail-closed during retry backoff",
  );
  context.fetch = async (path) =>
    path === "/api/me"
      ? {
          ok: true,
          json: async () => ({
            user: {
              id: "u1",
              name: "Planner Audit",
              discovery: { active: true, accessType: "paid" },
            },
            csrfToken: "recovered-csrf",
          }),
        }
      : { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  assert.equal(await vm.runInContext("refreshEntitlement({force:true})", context), true);
  assert.equal(
    vm.runInContext("state.entitlementFailureCount", context),
    0,
    "a successful retry must reset backoff",
  );
  assert.match(elements.get("weekSummary").innerHTML, /class="week-readiness ready"/);

  context.fetch = async (path) => {
    if (path === CATALOG_URL) return { ok: true, json: async () => exercises };
    if (path === "/api/plan")
      return { ok: false, status: 401, json: async () => ({ error: "Not signed in." }) };
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  await vm.runInContext("init()", context);
  assert.equal(
    vm.runInContext("state.entitlementTimer", context),
    null,
    "guest fallback must cancel account entitlement timers",
  );
  assert.doesNotMatch(
    elements.get("weekSummary").innerHTML,
    /class="week-readiness/,
    "Free and guest planners must not receive Strata+ plan-guidance cards",
  );
  assert.equal(elements.get("plannerSignIn").hidden, false, "Guest planners see a sign-in link");
  assert.match(
    elements.get("plannerModeNotice").innerHTML,
    /Free device plan[\s\S]*No account required[\s\S]*stays in this browser[\s\S]*Use a synced plan/i,
    "Guest copy must distinguish the browser-local free plan from optional account sync",
  );
  assert.doesNotMatch(
    elements.get("plannerModeNotice").innerHTML,
    /Sign in for cross-device sync/i,
  );
  guestStorageWrites.length = 0;
  vm.runInContext(
    "state.plan.days.Monday.push({instanceId:'guest-save-one',exerciseId:state.exercises[0].id,sets:3,reps:'8–12'});state.revision+=1;",
    context,
  );
  assert.equal(
    await vm.runInContext("flushSave()", context),
    true,
    "A guest edit must save locally",
  );
  vm.runInContext(
    "state.plan.days.Tuesday.push({instanceId:'guest-save-two',exerciseId:state.exercises[1].id,sets:3,reps:'8–12'});state.revision+=1;",
    context,
  );
  assert.equal(
    await vm.runInContext("flushSave()", context),
    true,
    "A second guest edit must not deadlock behind the first save promise",
  );
  assert.equal(guestStorageWrites.length, 2, "Each guest revision must reach local storage");
  assert.equal(
    vm.runInContext("state.savePromise", context),
    null,
    "Guest saves must always release the tracked save promise",
  );
  assert.equal(
    vm.runInContext("state.savedRevision", context),
    vm.runInContext("state.revision", context),
  );

  vm.runInContext("state.navigating=true", context);
  let secondNavigationPrevented = false;
  const navigationLink = {
    href: "http://strata.test/pricing",
    target: "",
    hasAttribute() {
      return false;
    },
  };
  const navigationTarget = {
    closest(selector) {
      return selector === "a[href]" ? navigationLink : null;
    },
  };
  const navigationEvent = {
    target: navigationTarget,
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault() {
      this.defaultPrevented = true;
      secondNavigationPrevented = true;
    },
  };
  for (const handler of documentListeners.click || []) handler(navigationEvent);
  assert.equal(
    secondNavigationPrevented,
    true,
    "A second same-origin navigation must stay blocked while the first save is pending",
  );
  vm.runInContext("state.navigating=false", context);
  const result = {
    catalogFetch: fetches.filter((path) => path === CATALOG_URL).length === 1,
    planFetch:
      requests.filter((request) => request.path === "/api/plan" && !request.options.method)
        .length === 1,
    initialCards: initialIds.length,
    initialLoadMore: true,
    expandedCards: expandedIds.length,
    uniqueExpandedCards: new Set(expandedIds).size,
    firstPagePreserved: initialIds.every((id, index) => expandedIds[index] === id),
    loadMoreStillAvailable: /data-load-more-library/.test(elements.get("libraryList").innerHTML),
    focusedFirstNewCard: loadMoreFocused,
    resultStatus: expandedResultStatus,
  };

  assert.equal(result.catalogFetch, true);
  assert.equal(result.planFetch, true);
  assert.equal(
    result.expandedCards,
    64,
    "One desktop Load more action should render 64 cards total",
  );
  assert.equal(result.uniqueExpandedCards, 64, "Load more must not duplicate library cards");
  assert.equal(
    result.firstPagePreserved,
    true,
    "Load more should preserve the original first page order",
  );
  assert.equal(
    result.loadMoreStillAvailable,
    true,
    "A 320-item library should have more results after 64 cards",
  );
  assert.equal(
    result.focusedFirstNewCard,
    true,
    "Focus should move to the first newly revealed card",
  );
  assert.match(result.resultStatus, /Showing 64 of 320 matching movements\./);
  const preservedPlan = vm.runInContext("copyPlan(state.plan)", context);
  vm.runInContext(
    "state.plan=emptyPlan(); state.plan.days.Monday=Array.from({length:30},(_,i)=>({instanceId:'limit-'+i,exerciseId:state.exercises[0].id,sets:3,reps:'8-12'}));state.plan.days.Tuesday=[{instanceId:'move-limit',exerciseId:state.exercises[1].id,sets:3,reps:'8-12'}];",
    context,
  );
  assert.equal(
    vm.runInContext("addExercise(state.exercises[0].id,'Monday')", context),
    false,
    "31st daily item must be rejected before mutation",
  );
  assert.equal(
    vm.runInContext("moveItem('Tuesday','Monday','move-limit')", context),
    false,
    "moving into a full day must keep the source item",
  );
  assert.equal(vm.runInContext("state.plan.days.Tuesday.length", context), 1);
  const oversized = JSON.parse(JSON.stringify(preservedPlan));
  oversized.days.Monday = Array.from({ length: 41 }, (_, i) => ({
    instanceId: "legacy-" + i,
    exerciseId: exercises[0].id,
    sets: 3,
    reps: "8-12",
  }));
  context.localStorage.getItem = () => JSON.stringify(oversized);
  assert.equal(
    vm.runInContext("guestPlan().days.Monday.length", context),
    41,
    "legacy draft must not silently lose its 41st item on reload",
  );
  vm.runInContext(
    "state.plan=emptyPlan();for(const day of DAYS.slice(0,5))state.plan.days[day]=Array.from({length:28},(_,i)=>({instanceId:day+'-'+i,exerciseId:state.exercises[0].id,sets:3,reps:'8-12'}));",
    context,
  );
  assert.equal(
    vm.runInContext("addExercise(state.exercises[0].id,'Saturday')", context),
    false,
    "141st weekly item must be rejected",
  );
  vm.runInContext("renderLoadError({code:'NETWORK_ERROR',message:'Offline'})", context);
  assert.match(
    elements.get("weekBoard").innerHTML,
    /data-open-guest/,
    "offline account errors must offer an explicit separate guest plan",
  );
  let offlineApiReads = 0;
  context.fetch = async (path) => {
    if (path === CATALOG_URL) return { ok: true, json: async () => exercises };
    offlineApiReads++;
    throw new Error("offline");
  };
  await vm.runInContext("init({guestOnly:true})", context);
  assert.equal(vm.runInContext("state.ready&&state.guest&&!state.user", context), true);
  assert.equal(
    offlineApiReads,
    0,
    "explicit offline guest mode must not depend on an account request",
  );
  // 7.1.0 regression checks exercise real mutation/recovery paths in this VM.
  const run = (source) => vm.runInContext(source, context);
  const snapshot = () => JSON.parse(run("JSON.stringify(state.plan)"));
  const fixture = () => ({
    version: 1,
    restDay: "Sunday",
    days: Object.fromEntries(
      DAYS.map((day) => [
        day,
        day === "Monday"
          ? [{ instanceId: "editing-item", exerciseId: exercises[0].id, sets: 4, reps: "6–8" }]
          : [],
      ]),
    ),
  });
  const reset = ({ guest = true, userId = "u1", plan = fixture(), stamp = 100 } = {}) => {
    context.fixturePlan = plan;
    context.fixtureUserId = userId;
    context.fixtureGuest = guest;
    context.fixtureStamp = stamp;
    run(
      "clearTimeout(state.saveTimer);clearPlanConflict();hideActivationPanel();state.ready=true;state.accountChanged=false;state.guest=fixtureGuest;state.guestRaw=localStorage.getItem(GUEST_PLAN_KEY);state.user=fixtureGuest?null:{id:fixtureUserId,name:'Runtime user'};state.plan=copyPlan(fixturePlan);state.revision=0;state.savedRevision=0;state.planUpdatedAt=fixtureStamp;state.lastSaveError=null;state.savePromise=null;state.undoRemoval=null;state.resetWeekSnapshot=null;state.resetWeekTrigger=null;state.draftKey='';state.draftValue='';state.recoverySource=null;state.recoveredDrafts=[];state.csrfToken='planner-csrf';renderWeek();",
    );
  };
  context.localStorage.getItem = (key) => storedValues.get(key) || null;
  storedValues.clear();
  reset();
  assert.match(html, /id="manageWeekTemplates"/);
  assert.match(
    html,
    /<dialog[^>]+id="replaceExerciseDialog"[^>]+aria-labelledby=/,
    "Replacement must use an accessible modal dialog",
  );
  assert.match(elements.get("weekBoard").innerHTML, /data-replace-item="editing-item"/);
  assert.equal(elements.has("startPlannedWorkout"), false, "Workout starts belong in Strata+");
  assert.equal(run("removeItem('Monday','editing-item')"), true);
  run(
    "state.plan.days.Tuesday.push({instanceId:'newer-edit',exerciseId:state.exercises[1].id,sets:2,reps:'12'});queueSave();",
  );
  assert.equal(
    run("undoLastRemoval()"),
    true,
    "Undo must restore only the removed item, preserving later edits",
  );
  assert.equal(snapshot().days.Monday[0].sets, 4);
  assert.equal(snapshot().days.Tuesday[0].instanceId, "newer-edit");
  assert.equal(await run("flushSave()"), true);
  run("removeItem('Monday','editing-item')");
  await run("flushSave()");
  assert.equal(run("undoLastRemoval()"), true, "Undo must work after autosave has completed");
  await run("flushSave()");
  assert.equal(JSON.parse(storedValues.get("strata_guest_plan_v1")).days.Monday[0].reps, "6–8");
  run(
    "removeItem('Monday','editing-item');state.plan.days.Monday=Array.from({length:30},(_,i)=>({instanceId:'full-'+i,exerciseId:state.exercises[0].id,sets:3,reps:'8'}));",
  );
  assert.equal(
    run("undoLastRemoval()"),
    false,
    "Undo must respect daily capacity without losing its recoverable item",
  );
  assert.equal(run("Boolean(state.undoRemoval)"), true);
  assert.equal(snapshot().days.Monday.length, 30);
  reset();
  run(
    "removeItem('Monday','editing-item');for(const day of DAYS.slice(0,5))state.plan.days[day]=Array.from({length:28},(_,i)=>({instanceId:day+i,exerciseId:state.exercises[0].id,sets:3,reps:'8'}));",
  );
  assert.equal(run("undoLastRemoval()"), false, "Undo must respect weekly capacity");
  reset();
  run("removeItem('Monday','editing-item');updateRestDays(state.plan,['Monday','Sunday'])");
  assert.equal(run("undoLastRemoval()"), true);
  assert.equal(snapshot().days.Monday.length, 1, "Undo restores the actual removed exercise");
  assert.deepEqual(snapshot().restDays, ["Sunday"], "Undo clears only its own rest marker");

  reset();
  const beforeResetPreview = JSON.stringify(snapshot());
  assert.equal(
    elements.get("resetWeeklyPlan").disabled,
    false,
    "A populated week must expose Reset week",
  );
  run("openResetWeek(document.getElementById('resetWeeklyPlan'))");
  assert.equal(elements.get("resetWeekDialog").open, true);
  assert.equal(
    JSON.stringify(snapshot()),
    beforeResetPreview,
    "Opening reset confirmation must not mutate the week",
  );
  run("state.revision+=1");
  assert.equal(
    run("confirmResetWeek()"),
    false,
    "A stale reset confirmation must not clear a newer edit",
  );
  assert.match(elements.get("resetWeekStatus").textContent, /changed/);
  reset();
  run("openResetWeek(document.getElementById('resetWeeklyPlan'))");
  assert.equal(run("confirmResetWeek()"), true);
  assert.equal(run("planMovementCount()"), 0, "Confirmed reset clears every scheduled movement");
  assert.deepEqual(
    snapshot().restDays,
    ["Sunday"],
    "Confirmed reset restores the canonical Sunday recovery marker",
  );
  assert.equal(run("state.selectedDay"), "Monday");
  assert.equal(
    elements.get("resetWeeklyPlan").disabled,
    true,
    "Canonical empty weeks cannot be reset again",
  );
  assert.equal(await run("flushSave()"), true, "Reset uses the normal guest autosave path");
  assert.equal(
    Object.values(JSON.parse(storedValues.get("strata_guest_plan_v1")).days).flat().length,
    0,
  );

  reset();
  for (const value of [[], "broken"]) {
    context.invalidRest = value;
    assert.throws(
      () => run("validateWeekPlan({...state.plan,restDay:'Sunday',restDays:invalidRest})"),
      /rest|Rest/,
    );
  }
  run("updateRestDays(state.plan,['Wednesday','Sunday'])");
  assert.equal(
    run("JSON.stringify(validateWeekPlan(state.plan).restDays)"),
    '["Wednesday","Sunday"]',
  );
  run("updateRestDays(state.plan,[])");
  assert.equal(run("validateWeekPlan(state.plan).restDay"), null);

  reset();
  assert.equal(run("openReplacement('Monday','editing-item')"), true);
  assert.equal(elements.get("replaceExerciseDialog").open, true);
  elements.get("replaceExerciseSearch").value = exercises[1].name;
  run("renderReplacementOptions()");
  assert.match(elements.get("replaceExerciseSelect").innerHTML, new RegExp(exercises[1].id));
  elements.get("replaceExerciseSelect").value = exercises[1].id;
  assert.equal(run("confirmReplacement()"), true);
  assert.equal(snapshot().days.Monday[0].exerciseId, exercises[1].id);
  assert.equal(snapshot().days.Monday[0].sets, 4);
  assert.equal(snapshot().days.Monday[0].reps, "6–8");
  run("openReplacement('Monday','editing-item');state.revision+=1;");
  elements.get("replaceExerciseSelect").value = exercises[2].id;
  assert.equal(
    run("confirmReplacement()"),
    false,
    "Stale replacement dialogs must not mutate a changed week",
  );
  assert.equal(snapshot().days.Monday[0].exerciseId, exercises[1].id);
  assert.match(elements.get("replaceExerciseStatus").textContent, /changed/);

  reset();
  storedValues.clear();
  elements.get("weekTemplateName").value = "My strength week";
  assert.equal(run("saveWeekTemplate()"), true);
  assert.equal(run("weekTemplates().length"), 1);
  assert.equal(
    run("saveWeekTemplate()"),
    false,
    "Duplicate template names must not silently overwrite an earlier template",
  );
  const guestTemplate = run("weekTemplates()[0]");
  reset({ guest: false, userId: "different-user" });
  assert.equal(
    run("weekTemplates().length"),
    0,
    "Account templates must be isolated from guest templates",
  );
  elements.get("weekTemplateName").value = "Private week";
  assert.equal(run("saveWeekTemplate()"), true);
  reset({ guest: false, userId: "u1" });
  assert.equal(run("weekTemplates().length"), 0, "Templates must be scoped to their account");
  reset();
  context.guestTemplate = guestTemplate;
  assert.equal(
    run("previewTemplate(guestTemplate.data.plan,guestTemplate.data.name,guestTemplate.key)"),
    true,
  );
  assert.equal(
    run("useWeekTemplate()"),
    false,
    "Using a template requires explicit replace-current confirmation",
  );
  elements.get("confirmUseTemplate").checked = true;
  run("state.revision+=1");
  assert.equal(
    run("useWeekTemplate()"),
    false,
    "A stale template preview must not replace a changed local week",
  );
  run("previewTemplate(guestTemplate.data.plan,guestTemplate.data.name,guestTemplate.key)");
  elements.get("confirmUseTemplate").checked = true;
  assert.equal(run("useWeekTemplate()"), true);
  assert.notEqual(
    snapshot().days.Monday[0].instanceId,
    "editing-item",
    "Duplicating a week must create fresh scheduled-entry IDs",
  );
  assert.equal(snapshot().days.Monday[0].sets, 4);
  assert.equal(
    run("state.savedRevision<state.revision"),
    true,
    "A copied template must enter the usual save path",
  );
  const portable = { format: "strata-weekly-plan", version: 1, plan: fixture() };
  context.portableFile = {
    name: "portable-week.json",
    size: JSON.stringify(portable).length,
    text: async () => JSON.stringify(portable),
  };
  assert.equal(
    await run("importWeekTemplate(portableFile)"),
    true,
    "Existing weekly exports must import into a reusable preview",
  );
  const beforeBadImport = JSON.stringify(snapshot());
  context.portableFile = { name: "broken.json", size: 5, text: async () => "oops" };
  assert.equal(await run("importWeekTemplate(portableFile)"), false);
  assert.equal(
    JSON.stringify(snapshot()),
    beforeBadImport,
    "Invalid imports must preserve the editable week",
  );
  assert.equal(run("state.templatePreview"), null, "A failed import must clear an older preview");
  const unavailable = fixture();
  unavailable.days.Monday[0].exerciseId = "missing-catalog-item";
  context.unavailable = unavailable;
  assert.equal(
    run("previewTemplate(unavailable,'Unknown exercise')"),
    false,
    "Unknown imported exercises must be rejected visibly, never silently dropped",
  );

  // Guest weeks compare the exact loaded copy before writing. A stale tab
  // keeps its editable/exportable draft and cannot bypass the guard on Retry.
  storedValues.clear();
  const guestBase = JSON.stringify(fixture());
  storedValues.set("strata_guest_plan_v1", guestBase);
  reset();
  const tabOne = fixture();
  tabOne.days.Monday[0].reps = "5";
  context.tabOne = tabOne;
  await run("saveGuestPlan(tabOne,state.guestRaw)");
  run("state.plan.days.Monday[0].reps='15';queueSave()");
  assert.equal(
    await run("flushSave()"),
    false,
    "A stale guest tab must not overwrite another tab's week",
  );
  assert.equal(JSON.parse(storedValues.get("strata_guest_plan_v1")).days.Monday[0].reps, "5");
  assert.equal(
    snapshot().days.Monday[0].reps,
    "15",
    "The rejected guest draft must remain available to export",
  );
  assert.equal(
    run("state.guestRaw"),
    guestBase,
    "Conflict handling must not adopt the newer comparison value",
  );
  assert.equal(
    await run("flushSave()"),
    false,
    "Retry must not silently turn a stale guest write into an overwrite",
  );
  assert.equal(run("state.savedRevision<state.revision"), true);
  assert.match(
    elements.get("plannerModeNotice").innerHTML,
    /Guest save conflict[\s\S]*Export[\s\S]*reload/i,
  );

  // Both simultaneous writers enter the same Web Lock, and comparison occurs
  // inside it. This deterministic mutex models cooperating browser tabs.
  storedValues.set("strata_guest_plan_v1", guestBase);
  reset();
  let lockTail = Promise.resolve();
  const lockNames = [];
  context.navigator = {
    locks: {
      request: async (name, write) => {
        lockNames.push(name);
        const previous = lockTail;
        let unlock;
        lockTail = new Promise((resolve) => {
          unlock = resolve;
        });
        await previous;
        try {
          return write();
        } finally {
          unlock();
        }
      },
    },
  };
  const tabTwo = fixture();
  tabTwo.days.Monday[0].reps = "9";
  context.tabTwo = tabTwo;
  const parallelGuestSaves = await Promise.allSettled([
    run("saveGuestPlan(tabOne,state.guestRaw)"),
    run("saveGuestPlan(tabTwo,state.guestRaw)"),
  ]);
  assert.equal(
    parallelGuestSaves.filter((result) => result.status === "fulfilled").length,
    1,
    "Only one competing writer may save the shared base revision",
  );
  assert.equal(
    parallelGuestSaves.find((result) => result.status === "rejected").reason.code,
    "GUEST_PLAN_CHANGED",
  );
  assert.deepEqual(lockNames, ["strata-guest-week-save", "strata-guest-week-save"]);

  // A queued lock must save its captured revision, not live edits made while
  // it waited. The later revision stays dirty and is saved by the next flush.
  storedValues.set("strata_guest_plan_v1", guestBase);
  reset();
  let releaseGuestLock;
  context.navigator.locks.request = (name, write) =>
    new Promise((resolve, reject) => {
      releaseGuestLock = () => {
        try {
          resolve(write());
        } catch (error) {
          reject(error);
        }
      };
    });
  run("state.plan.days.Monday[0].reps='7';state.revision=1");
  const lockedSave = run("performSave()");
  await new Promise(setImmediate);
  run("state.plan.days.Monday[0].reps='11';state.revision=2");
  releaseGuestLock();
  assert.equal(await lockedSave, true);
  assert.equal(
    JSON.parse(storedValues.get("strata_guest_plan_v1")).days.Monday[0].reps,
    "7",
    "The lock writes the captured plan only",
  );
  assert.equal(
    snapshot().days.Monday[0].reps,
    "11",
    "An old save completion must not replace newer in-memory edits",
  );
  assert.equal(run("state.savedRevision"), 1);
  assert.equal(run("state.revision"), 2);
  context.navigator.locks.request = async (name, write) => write();
  assert.equal(await run("flushSave()"), true);
  assert.equal(JSON.parse(storedValues.get("strata_guest_plan_v1")).days.Monday[0].reps, "11");

  reset();
  const previousGuestRaw = run("state.guestRaw"),
    normalStorageWrite = context.localStorage.setItem;
  context.localStorage.setItem = () => {
    throw new Error("Storage full");
  };
  run("state.plan.days.Monday[0].reps='13';queueSave()");
  assert.equal(
    await run("flushSave()"),
    false,
    "Storage failure must keep a guest revision unsaved",
  );
  assert.equal(
    run("state.guestRaw"),
    previousGuestRaw,
    "A failed storage write must not advance the expected copy",
  );
  assert.equal(run("state.savedRevision<state.revision"), true);
  context.localStorage.setItem = normalStorageWrite;
  assert.equal(
    await run("flushSave()"),
    true,
    "A storage failure should allow a safe retry against the original base",
  );
  assert.equal(JSON.parse(storedValues.get("strata_guest_plan_v1")).days.Monday[0].reps, "13");
  delete context.navigator;

  // A network failure survives reload under only the original account ID.
  storedValues.clear();
  reset({ guest: false });
  let planWrites = 0;
  context.fetch = async (path, options = {}) => {
    if (path === "/api/me")
      return { ok: true, json: async () => ({ user: { id: "u1" }, csrfToken: "planner-csrf" }) };
    if (path === CATALOG_URL) return { ok: true, json: async () => exercises };
    if (path === "/api/plan" && options.method === "PUT") {
      planWrites += 1;
      throw new Error("Offline");
    }
    if (path === "/api/plan")
      return {
        ok: true,
        json: async () => ({
          plan: fixture(),
          user: { id: "u1", name: "Runtime" },
          csrfToken: "planner-csrf",
          planUpdatedAt: 110,
        }),
      };
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  run("state.plan.days.Monday[0].reps='10–12';queueSave()");
  const offlineKey = run("state.draftKey");
  assert.match(offlineKey, /^strata_plan_draft_v1:user-u1:/);
  assert.equal(JSON.parse(storedValues.get(offlineKey)).baseUpdatedAt, 100);
  assert.equal(await run("flushSave()"), false);
  assert.equal(planWrites, 1);
  assert.equal(JSON.parse(storedValues.get(offlineKey)).plan.days.Monday[0].reps, "10–12");
  await run("init()");
  assert.equal(
    planWrites,
    1,
    "Reloading a draft must not save or silently overwrite the server week",
  );
  assert.equal(
    snapshot().days.Monday[0].reps,
    "6–8",
    "The server copy remains displayed until the user chooses recovery",
  );
  assert.equal(run("state.conflictDraft.days.Monday[0].reps"), "10–12");
  assert.equal(elements.get("plannerShell").inert, true);
  assert.equal(await run("flushSave()"), false);
  assert.equal(run("reviewConflictDraft()"), true);
  assert.equal(
    await run("flushSave()"),
    false,
    "Draft recovery needs explicit Save reviewed changes",
  );
  const recoverySourceValue = storedValues.get(offlineKey);
  // Simulate the original tab continuing to edit its own draft. A successful
  // recovery must not delete that tab's newer local snapshot.
  const newerOtherTab = JSON.parse(recoverySourceValue);
  newerOtherTab.plan.days.Monday[0].reps = "15";
  storedValues.set(offlineKey, JSON.stringify(newerOtherTab));
  let recoveryBody;
  context.fetch = async (path, options = {}) => {
    if (path === "/api/me")
      return { ok: true, json: async () => ({ user: { id: "u1" }, csrfToken: "planner-csrf" }) };
    if (path === "/api/plan" && options.method === "PUT") {
      recoveryBody = JSON.parse(options.body);
      assert.equal(options.headers["X-Strata-User"], "u1");
      return { ok: true, json: async () => ({ plan: recoveryBody.plan, planUpdatedAt: 120 }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  assert.equal(await run("flushSave({confirmConflict:true})"), true);
  assert.equal(
    recoveryBody.expectedPlanUpdatedAt,
    110,
    "Recovered saves must use the latest reviewed server revision",
  );
  assert.equal(
    recoveryBody.expectedUserId,
    "u1",
    "Plan writes must also bind the original account ID",
  );
  assert.equal(
    JSON.parse(storedValues.get(offlineKey)).plan.days.Monday[0].reps,
    "15",
    "Saving must not delete another tab's newer draft",
  );
  reset({ guest: false, userId: "u2" });
  assert.equal(
    run("offerRecoveredDraft()"),
    false,
    "Another account's drafts must never be offered",
  );
  reset({ guest: false });
  assert.equal(run("offerRecoveredDraft()"), true);
  assert.equal(run("keepLatestPlan()"), true);
  assert.equal(
    storedValues.has(offlineKey),
    false,
    "An explicitly discarded unchanged snapshot should be removed",
  );

  // Draft writes use separate keys per tab; conflicts clear stale undo state.
  storedValues.clear();
  reset({ guest: false });
  run("removeItem('Monday','editing-item')");
  const firstTabKey = run("state.draftKey");
  reset({ guest: false });
  run("state.plan.days.Monday[0].reps='14';queueSave()");
  assert.notEqual(
    run("state.draftKey"),
    firstTabKey,
    "Two tabs must not overwrite the same draft storage key",
  );
  assert.equal(
    [...storedValues.keys()].filter((key) => key.startsWith("strata_plan_draft_v1:user-u1:"))
      .length,
    2,
  );
  const newerPlan = fixture();
  newerPlan.days.Monday[0].reps = "2–4";
  context.newerPlan = newerPlan;
  await run(
    "recoverPlanConflict({status:409,code:'PLAN_CHANGED',data:{plan:newerPlan,planUpdatedAt:200}},{silent:true})",
  );
  assert.equal(
    run("state.undoRemoval"),
    null,
    "Undo history must not be replayed onto an unrelated newer account week",
  );
  assert.equal(run("undoLastRemoval()"), false);
  assert.equal(snapshot().days.Monday[0].reps, "2–4");
  run("clearTimeout(state.saveTimer)");

  // A first account with no movements gets one explicit save action instead
  // of a fake conflict comparison. Existing account weeks retain that review.
  storedValues.clear();
  const deviceWeek = fixture();
  deviceWeek.days.Monday[0].instanceId = "device-activation";
  storedValues.set("strata_guest_plan_v1", JSON.stringify(deviceWeek));
  reset({ guest: false, plan: JSON.parse(run("JSON.stringify(emptyPlan())")), stamp: 0 });
  assert.equal(run("offerDevicePlan()"), true);
  assert.equal(run("state.activationDirectClaim"), true);
  assert.equal(elements.get("compareDevicePlan").hidden, true);
  assert.equal(elements.get("keepAccountPlan").hidden, true);
  assert.equal(elements.get("devicePlanConfirmLabel").hidden, true);
  assert.equal(elements.get("claimDevicePlan").disabled, false);
  assert.match(elements.get("claimDevicePlan").innerHTML, /Save week to my account/i);
  let activationBody;
  context.fetch = async (path, options = {}) => {
    if (path === "/api/me")
      return { ok: true, json: async () => ({ user: { id: "u1" }, csrfToken: "planner-csrf" }) };
    if (path === "/api/plan" && options.method === "PUT") {
      activationBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ plan: activationBody.plan, planUpdatedAt: 1 }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  assert.equal(
    await run("claimActivationPlan()"),
    true,
    "an empty account can explicitly save without checking a replacement confirmation",
  );
  assert.equal(activationBody.expectedPlanUpdatedAt, 0);
  assert.equal(snapshot().days.Monday.length, 1);

  storedValues.clear();
  storedValues.set("strata_guest_plan_v1", JSON.stringify(deviceWeek));
  reset({ guest: false, plan: fixture(), stamp: 20 });
  assert.equal(run("offerDevicePlan()"), true);
  assert.equal(run("state.activationDirectClaim"), false);
  assert.equal(
    elements.get("compareDevicePlan").hidden,
    false,
    "an existing account week still requires comparison",
  );
  assert.equal(elements.get("keepAccountPlan").hidden, false);
  assert.equal(elements.get("claimDevicePlan").disabled, true);

  // A userless identity response cannot supply a replacement account's CSRF.
  storedValues.clear();
  reset({ guest: false });
  let identity = "u1",
    unexpectedWrites = 0;
  context.fetch = async (path, options = {}) => {
    if (path === "/api/me")
      return {
        ok: true,
        json: async () => ({ user: { id: identity }, csrfToken: `csrf-${identity}` }),
      };
    if (options.method === "PUT" || options.method === "POST") {
      unexpectedWrites += 1;
      return { ok: true, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
  await run("verifyPlannerIdentity()");
  assert.equal(
    run("state.csrfToken"),
    "csrf-u1",
    "Only an identity-bound response can refresh the CSRF token",
  );
  run("state.plan.days.Monday[0].reps='7';queueSave()");
  identity = "u2";
  assert.equal(await run("flushSave()"), false);
  assert.equal(
    unexpectedWrites,
    0,
    "An old account tab must not send its plan under the new account session",
  );
  assert.equal(run("state.user.id"), "u1");
  assert.equal(run("state.accountChanged"), true);
  assert.equal(elements.get("accountChangedNotice").hidden, false);
  assert.equal(elements.get("plannerShell").inert, true);
  assert.match(
    run("state.draftKey"),
    /user-u1:/,
    "Account-change recovery stays scoped to the original owner",
  );
  run(`renderLoadError(new Error('Plan <b> & "x" failed'))`);
  assert.equal(
    elements.get("libraryList").innerHTML,
    '<div class="loading">Plan &lt;b&gt; &amp; &quot;x&quot; failed</div>',
    "A load error is shown as text, escaped exactly once",
  );
  assert.match(
    elements.get("weekBoard").innerHTML,
    /<p>Plan &lt;b&gt; &amp; &quot;x&quot; failed<\/p><button type="button" data-retry-init>/,
    "The week board repeats the load error as escaped text",
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        plannerCapacityGuards: true,
        legacyDraftPreserved: true,
        offlineGuestMode: true,
        removalUndo: true,
        exerciseReplacement: true,
        scopedWeekTemplates: true,
        portableWeekImport: true,
        accountDraftRecovery: true,
        multipleDraftIsolation: true,
        accountSwitchGuard: true,
        guestStaleWriteGuard: true,
        guestLockSnapshots: true,
        guestStorageRetry: true,
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
