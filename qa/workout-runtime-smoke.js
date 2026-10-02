"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const read = (...parts) => fs.readFileSync(join(ROOT, "public", ...parts), "utf8");
const html = read("pages", "workout.html"),
  sources = [
    "workout-state.js",
    "workout-api.js",
    "workout-calendar.js",
    "workout-progression.js",
    "workout-render.js",
    "workout-context.js",
    "workout-guidance.js",
    "workout-history.js",
    "workout-events.js",
    "devices-core.js",
    "workout-recovery.js",
    "workout.js",
  ].map((name) => [name, read("scripts", name)]),
  catalog = JSON.parse(read("data", "exercises.json"));
const Workout = require(join(ROOT, "public/scripts/workout-core")),
  Discovery = require(join(ROOT, "public/scripts/discovery-core"));
const { progressionForWorkout } = require(join(ROOT, "src/progression"));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

class Element {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = id === "autoRest";
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = { add() {}, remove() {} };
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
  querySelector() {
    return null;
  }
  querySelectorAll(selector) {
    if (this.id !== "sessionEntries" || selector !== "[data-entry]") return [];
    return [...this.innerHTML.matchAll(/<article[^>]+data-entry="([^"]+)"/g)].map((match) => ({
      dataset: { entry: match[1] },
      querySelector: (child) => {
        if (child !== ".memory-target") return null;
        const container = this,
          entryId = match[1];
        return {
          set outerHTML(value) {
            const card = container.innerHTML.indexOf(`data-entry="${entryId}"`),
              start = container.innerHTML.indexOf('<section class="memory-target"', card),
              end = container.innerHTML.indexOf("</section>", start) + 10;
            assert.ok(
              card >= 0 && start >= 0 && end > start,
              "Async target hydration must address a rendered card",
            );
            container.innerHTML =
              container.innerHTML.slice(0, start) + value + container.innerHTML.slice(end);
          },
        };
      },
    }));
  }
  focus() {}
  scrollIntoView() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    for (const handler of this.listeners.close || []) handler();
  }
}

const elements = new Map(ids.map((id) => [id, new Element(id)]));
elements.get("restDuration").value = "90";
const first = catalog.find(
  (item) => item.equipment === "Barbell / Smith" && !/seconds|sec|min/i.test(item.reps),
);
const second = catalog.find(
  (item) =>
    item.id !== first.id && item.equipment !== "Bodyweight" && !/seconds|sec|min/i.test(item.reps),
);
const plan = {
  version: 1,
  restDay: "Sunday",
  restDays: ["Sunday"],
  days: Object.fromEntries(
    Workout.DAYS.map((day) => [
      day,
      day === "Monday"
        ? [
            { instanceId: "runtime-first", exerciseId: first.id, sets: 2, reps: "8–12" },
            { instanceId: "runtime-second", exerciseId: second.id, sets: 1, reps: "8–12" },
          ]
        : [],
    ]),
  ),
};
const past = Workout.createWorkout(plan, "Monday", catalog, Date.now() - 604800000);
past.id = "runtime-history";
past.status = "completed";
past.completedAt = past.startedAt + 1000;
past.elapsedSeconds = 1;
past.entries[0].sets = [10, 9].map((reps) => ({
  reps,
  weight: 42.5,
  seconds: null,
  completed: true,
  effort: null,
}));
const history = [Workout.summary(past)];
const progressionRequests = [];
const storage = new Map();
// A finished device draft whose title is member text with every markup character in it.
const hostileTitle = '<b>"Tom & Jerry"</b>',
  draft = JSON.parse(JSON.stringify(past));
draft.id = "runtime-draft";
draft.title = hostileTitle;
storage.set(
  `${Workout.draftPrefix("account:runtime-user")}runtime-context:runtime-draft`,
  JSON.stringify({
    ownerId: "account:runtime-user",
    contextId: "runtime-context",
    workout: draft,
    dirty: true,
    savedAt: Date.now(),
  }),
);
const previewDetails = new Element("planPreviewDetails"),
  document = {
    visibilityState: "visible",
    body: new Element("body"),
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => (selector === ".plan-preview-details" ? previewDetails : null),
    addEventListener() {},
  };
const location = {
  search: "?day=Monday",
  hash: "",
  href: "http://strata.test/workout.html?day=Monday",
  reload() {},
};
const context = {
  console,
  document,
  location,
  history: { replaceState() {} },
  URL,
  URLSearchParams,
  AbortController,
  Blob,
  globalThis: null,
  StrataWorkout: Workout,
  StrataDiscovery: Discovery,
  crypto: { randomUUID: () => `runtime-${Math.random().toString(16).slice(2)}` },
  localStorage: {
    get length() {
      return storage.size;
    },
    key: (index) => [...storage.keys()][index] || null,
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  fetch: async (path) => {
    if (path === "/api/me")
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: { id: "runtime-user", name: "Runtime", discovery: { active: true } },
          csrfToken: "runtime-csrf",
        }),
      };
    if (path === "/exercises.json") return { ok: true, status: 200, json: async () => catalog };
    if (path === "/api/plan")
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan,
          planUpdatedAt: 100,
          user: { id: "runtime-user" },
          csrfToken: "runtime-csrf",
        }),
      };
    if (String(path).startsWith("/api/workouts?"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ workouts: history, hasMore: false, csrfToken: "runtime-csrf" }),
      };
    if (path === "/api/workouts/runtime-history/progression") {
      progressionRequests.push(path);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          progression: progressionForWorkout(past, [], null),
          csrfToken: "runtime-csrf",
        }),
      };
    }
    throw new Error(`Unexpected runtime request: ${path}`);
  },
  window: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
  setTimeout: () => 1,
  clearTimeout() {},
  setInterval: () => 1,
  confirm: () => true,
};
context.globalThis = context;
context.window.document = document;
context.window.location = location;
vm.createContext(context);
vm.runInContext(read("scripts", "html.js"), context, { filename: "html.js" }); // Every page loads it first.
for (const [name, source] of sources) vm.runInContext(source, context, { filename: name });

(async () => {
  for (let index = 0; index < 8 && !elements.get("trainingRoom").hidden; index++)
    await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.match(elements.get("planPreview").innerHTML, /runtime-first|Setup, cues/);
  const recoveryList = elements.get("recoveryList").innerHTML;
  assert.ok(
    recoveryList.includes("<strong>&lt;b&gt;&quot;Tom &amp; Jerry&quot;&lt;/b&gt;</strong>"),
    "a device draft's title is escaped exactly once",
  );
  assert.doesNotMatch(recoveryList, /&amp;(?:lt|gt|quot|amp|#39);/);
  assert.match(recoveryList, /Review &amp; recover<\/button>/);
  assert.equal(
    elements.get("calendarWeekly").hidden,
    false,
    "a plan with a training day offers weekly calendar reminders",
  );
  assert.match(
    decodeURIComponent(elements.get("calendarWeeklyLink").href),
    /^data:text\/calendar;charset=utf-8,BEGIN:VCALENDAR[\s\S]*RRULE:FREQ=WEEKLY;BYDAY=MO[\s\S]*END:VCALENDAR/,
  );
  assert.match(
    elements.get("calendarWeeklySummary").textContent,
    /^Monday at .+, every week\. Re-download after you change your plan\.$/,
  );
  const startHandlers = elements.get("startWorkout").listeners.click || [];
  assert.equal(startHandlers.length, 1);
  startHandlers[0]();
  assert.match(elements.get("sessionEntries").innerHTML, /Checking the next target/);
  for (
    let index = 0;
    index < 8 && elements.get("sessionEntries").innerHTML.includes("Checking the next target");
    index++
  )
    await new Promise(setImmediate);
  const markup = elements.get("sessionEntries").innerHTML;
  assert.match(markup, /Previous performance/);
  assert.match(markup, /data-use-last/);
  assert.match(markup, /data-apply-target/);
  assert.deepEqual(progressionRequests, ["/api/workouts/runtime-history/progression"]);
  assert.match(markup, /Repeat this target/);
  assert.match(markup, /42\.5 kg/);
  assert.doesNotMatch(markup, /Checking the next target/);
  assert.match(markup, /data-add-set/);
  assert.match(markup, /data-duplicate-set/);
  assert.match(markup, /data-remove-set/);
  assert.match(markup, /data-entry-note/);
  assert.match(markup, /Effort \(optional\)/);
  assert.match(markup, /More options/);
  assert.match(markup, /Warm-ups &amp; plate calculator/);
  assert.match(markup, /data-calc-warmup/);
  assert.match(markup, /data-calc-plates/);
  assert.match(markup, /Complete set/);
  assert.match(markup, /data-toggle-superset/);
  assert.match(markup, /data-open-swap/);
  assert.match(html, /No workout or Plan changes until/);
  assert.match(html, /Approve Plan &amp; workout change/);
  console.log(
    "Workout Memory runtime smoke passed: explicit memory, logging, calculator, superset, and replacement controls rendered.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
