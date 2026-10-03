"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { loadHtml } = require("./support/browser-html");

const html = fs.readFileSync(require.resolve("../public/pages/account.html"), "utf8");
const script = fs.readFileSync(require.resolve("../public/scripts/account.js"), "utf8");
const moduleScripts = [
  "devices-core",
  "entitlements",
  "account-logic",
  "account-state",
  "account-api",
  "account-render",
  "account-events",
  "account-devices",
  "account-delete-dialog",
].map((name) => ({
  name,
  source: fs.readFileSync(require.resolve(`../public/scripts/${name}.js`), "utf8"),
}));

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
  contains(name) {
    return this.values.has(name);
  }
  toggle(name, force = !this.values.has(name)) {
    if (force) this.values.add(name);
    else this.values.delete(name);
    return force;
  }
}

class Element {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.disabled = false;
    this.href = "";
    this.max = 1;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new ClassList();
    this.values = {};
    this.focused = false;
  }
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }
  async emit(type, event = {}) {
    for (const handler of this.listeners[type] || []) await handler(event);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  focus() {
    this.focused = true;
  }
  scrollIntoView() {
    this.scrolled = true;
  }
  prepend(node) {
    this.prepended = node;
  }
  appendChild(node) {
    this.appended = node;
  }
  click() {
    this.clicked = true;
  }
  remove() {
    this.removed = true;
  }
  querySelector(selector) {
    return selector === "span" ? this.statusText : null;
  }
  // <dialog>: the app's web view has showModal; closing fires "close" as a browser does.
  showModal() {
    this.open = true;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    void this.emit("close");
  }
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null,
    },
    json: async () => data,
  };
}
function exportResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        ({
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="strata-account-export-2026-09-08.json"',
          "x-strata-export": "account-v1",
        })[name.toLowerCase()] || null,
    },
    blob: async () => new Blob([JSON.stringify(data)], { type: "application/json" }),
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createPage({ search = "", route, app = null }) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const elements = new Map(ids.map((id) => [id, new Element(id)]));
  elements.get("accountLoading").hidden = true;
  elements.get("signedInCard").hidden = true;
  elements.get("signupMessage").hidden = true;
  elements.get("loginMessage").hidden = true;
  const authGrid = new Element("authGrid"),
    body = new Element("body"),
    navigations = [],
    requests = [],
    replaced = [],
    reloads = [],
    downloads = [],
    objectUrls = [],
    windowListeners = {},
    documentListeners = {};
  const location = {
    search,
    href: `http://strata.test/account.html${search}`,
    assign: (path) => navigations.push(path),
    replace: (path) => navigations.push(path),
    reload: () => reloads.push(true),
  };
  const document = {
    body,
    hidden: false,
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => (selector === ".auth-grid" ? authGrid : null),
    createElement: (tag) => {
      const node = new Element(tag);
      node.click = () => downloads.push({ href: node.href, download: node.download });
      return node;
    },
    addEventListener: (type, handler) => {
      (documentListeners[type] ||= []).push(handler);
    },
  };
  class BrowserURL extends URL {}
  BrowserURL.createObjectURL = (blob) => {
    const value = `blob:strata-${objectUrls.length + 1}`;
    objectUrls.push({ value, blob });
    return value;
  };
  BrowserURL.revokeObjectURL = () => {};
  class FakeFormData {
    constructor(form) {
      this.values = form.values;
    }
    get(name) {
      return this.values[name] ?? null;
    }
  }
  const context = {
    // A page's long timers (a download's blob lives a minute for the iOS share sheet) must not hold the test process open.
    console,
    document,
    location,
    URL: BrowserURL,
    URLSearchParams,
    FormData: FakeFormData,
    Blob,
    setTimeout: (callback, delay, ...args) => {
      const timer = setTimeout(callback, delay, ...args);
      if (delay >= 1000) timer.unref();
      return timer;
    },
    history: { replaceState: (...args) => replaced.push(args) },
    requestAnimationFrame: (callback) => callback(),
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, handler) => {
      (windowListeners[type] ||= []).push(handler);
    },
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      return route(path, options, requests);
    },
  };
  // Inside the iOS app (app-shell.js and app-mode.js): the shell marker and the native plugin bridge.
  if (app) {
    context.StrataApp = Object.freeze({ platform: "ios", shellVersion: 1 });
    context.StrataAppMode = { plugin: () => app.plugin || null };
  }
  context.globalThis = context;
  vm.createContext(context);
  loadHtml(context);
  for (const moduleScript of moduleScripts)
    vm.runInContext(moduleScript.source, context, { filename: `${moduleScript.name}.js` });
  vm.runInContext(script, context, { filename: "account.js" });
  return {
    document,
    elements,
    requests,
    navigations,
    replaced,
    reloads,
    downloads,
    objectUrls,
    setHidden(value) {
      document.hidden = value === true;
    },
    async emitDocument(type, event = {}) {
      for (const handler of documentListeners[type] || []) await handler(event);
    },
    async emitWindow(type, event = {}) {
      for (const handler of windowListeners[type] || []) await handler(event);
    },
  };
}

async function settle() {
  for (let count = 0; count < 5; count += 1) await new Promise(setImmediate);
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function planFixture(dayCounts = {}) {
  return {
    version: 1,
    restDay: null,
    restDays: [],
    days: Object.fromEntries(
      WEEKDAYS.map((day) => [
        day,
        Array.from({ length: dayCounts[day] || 0 }, (_, index) => ({
          instanceId: `${day.toLowerCase()}-${index}`,
          exerciseId: index % 2 ? "machine-chest-press" : "flat-dumbbell-press",
          sets: index + 2,
          reps: "8–12",
        })),
      ]),
    ),
  };
}
function memberFixture(overrides = {}) {
  return {
    id: "member-1",
    name: "Ari Stone",
    email: "ari@example.test",
    createdAt: 1704067200000,
    planCount: 0,
    workoutDays: 0,
    isAdmin: false,
    discovery: { active: true, accessType: "paid", pendingPurchaseCount: 0 },
    accountDeletion: { pending: false },
    ...overrides,
  };
}
function localKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function thisWeekDate(day) {
  const now = new Date(),
    todayIndex = (now.getDay() + 6) % 7,
    monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - todayIndex, 12);
  return localKey(
    new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + WEEKDAYS.indexOf(day), 12),
  );
}
function workoutFixture(overrides = {}) {
  return {
    id: "workout-1",
    title: "Upper strength",
    planDay: "Monday",
    date: thisWeekDate("Monday"),
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    elapsedSeconds: 1800,
    totalSets: 3,
    completedSets: 3,
    exerciseCount: 1,
    exerciseSummaries: [
      {
        exerciseId: "flat-dumbbell-press",
        measurement: "reps",
        loadType: "external",
        unit: "kg",
        completedSets: 3,
        totalReps: 24,
        maxReps: 8,
        maxWeight: 20,
        volume: 480,
        totalSeconds: 0,
        maxSeconds: null,
      },
    ],
    revision: 1,
    updatedAt: 2,
    ...overrides,
  };
}

test("native forms remain available without the JavaScript enhancement", () => {
  assert.match(html, /<form id="signupForm" action="\/auth\/signup" method="post"/);
  assert.match(html, /<form id="loginForm" action="\/auth\/login" method="post"/);
  assert.match(html, /<section class="account-access" id="accountAccess"[^>]*>/);
  assert.doesNotMatch(
    html,
    /<\s*section\s*class\s*=\s*"account-access"\s*id\s*=\s*"accountAccess"[^>]*hidden/,
  );
  assert.doesNotMatch(html, /accountRetry/);
  assert.doesNotMatch(script, /accountRetry/);
});

test("a persisted account-page restore clears private DOM before reloading the current session", async () => {
  const periodEnd = Date.now() + 30 * 24 * 60 * 60 * 1000,
    user = memberFixture({
      name: "PRIVATE ACCOUNT SENTINEL",
      email: "private-sentinel@example.test",
      planCount: 1,
      workoutDays: 1,
      discovery: {
        active: true,
        accessType: "subscription",
        pendingPurchaseCount: 0,
        subscription: {
          id: "sub-private",
          status: "active",
          active: true,
          pastDue: false,
          scheduledChange: null,
          currentPeriodEndsAt: periodEnd,
        },
      },
    });
  const page = createPage({
    route: async (path) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") return jsonResponse(200, { csrfToken: "private-csrf", user });
      if (path === "/api/plan")
        return jsonResponse(200, {
          csrfToken: "private-csrf",
          user,
          plan: planFixture({ Monday: 1 }),
          planUpdatedAt: 1,
        });
      if (path === "/api/workouts?limit=100&offset=0")
        return jsonResponse(200, {
          csrfToken: "private-csrf",
          hasMore: false,
          workouts: [
            workoutFixture({
              status: "active",
              completedAt: null,
              title: "PRIVATE WORKOUT SENTINEL",
            }),
          ],
        });
      if (path === "/api/account/sessions")
        return jsonResponse(200, {
          userId: user.id,
          sessions: [
            {
              id: "PRIVATE-SESSION-SENTINEL",
              current: true,
              createdAt: 1_700_000_000_000,
              expiresAt: 1_800_000_000_000,
            },
          ],
        });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  assert.match(page.elements.get("signedInIdentity").textContent, /PRIVATE ACCOUNT SENTINEL/);
  await page.emitWindow("pageshow", { persisted: false });
  assert.equal(page.reloads.length, 0);
  await page.emitWindow("pageshow", { persisted: true });
  assert.equal(page.reloads.length, 1);
  assert.equal(page.elements.get("signedInCard").hidden, true);
  assert.equal(page.elements.get("accountLoading").hidden, false);
  const privateDom = [...page.elements.values()]
    .map((node) => `${node.textContent} ${node.innerHTML} ${node.href}`)
    .join(" ");
  assert.doesNotMatch(
    privateDom,
    /PRIVATE\s*ACCOUNT\s*SENTINEL|private-sentinel@example\s*\.test|PRIVATE\s*WORKOUT\s*SENTINEL|PRIVATE-SESSION-SENTINEL|sub-private/,
  );
});

test("Account foreground recheck supersedes a delayed initial identity without exposing it", async () => {
  const stale = deferred(),
    staleUser = memberFixture({
      id: "stale-initial",
      name: "STALE INITIAL ACCOUNT",
      email: "stale-initial@example.test",
    });
  const currentUser = memberFixture({
    id: "current-after-focus",
    name: "CURRENT ACCOUNT",
    email: "current@example.test",
    discovery: { active: false, accessType: null, pendingPurchaseCount: 0 },
  });
  let identityReads = 0;
  const page = createPage({
    route: async (path) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") {
        identityReads += 1;
        return identityReads === 1
          ? stale.promise
          : jsonResponse(200, { csrfToken: "current-csrf", user: currentUser });
      }
      if (path === "/api/plan")
        return jsonResponse(200, {
          csrfToken: "current-csrf",
          user: currentUser,
          plan: planFixture(),
          planUpdatedAt: 0,
        });
      if (path === "/api/account/sessions")
        return jsonResponse(200, { userId: currentUser.id, sessions: [] });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  const focus = page.emitWindow("focus"),
    visibility = page.emitDocument("visibilitychange");
  await Promise.all([focus, visibility]);
  await settle();
  assert.equal(identityReads, 2, "paired foreground events share one fresh identity request");
  assert.match(page.elements.get("signedInIdentity").textContent, /CURRENT ACCOUNT/);
  stale.resolve(jsonResponse(200, { csrfToken: "stale-csrf", user: staleUser }));
  await settle();
  const rendered = [...page.elements.values()]
    .map((node) => `${node.textContent} ${node.innerHTML}`)
    .join(" ");
  assert.doesNotMatch(rendered, /STALE\s*INITIAL\s*ACCOUNT|stale-initial@example\s*\.test/);
  assert.match(rendered, /CURRENT ACCOUNT/);
});

test("ordinary Account foreground restores purge first and reopen only the same user", async () => {
  const original = memberFixture({
    id: "foreground-original",
    name: "FOREGROUND PRIVATE SENTINEL",
    email: "foreground-private@example.test",
    planCount: 1,
    workoutDays: 1,
  });
  for (const scenario of [
    { name: "focus with same account", event: "focus", next: original, reopens: true },
    {
      name: "visibility with changed account",
      event: "visibilitychange",
      next: memberFixture({ id: "foreground-replacement", name: "REPLACEMENT PRIVATE SENTINEL" }),
      reopens: false,
    },
  ]) {
    let identityReads = 0;
    const pending = deferred(),
      page = createPage({
        route: async (path) => {
          if (path === "/api/status") return jsonResponse(200, { persistent: true });
          if (path === "/healthz") return jsonResponse(200, { ok: true });
          if (path === "/api/me") {
            identityReads += 1;
            return identityReads <= 1
              ? jsonResponse(200, { csrfToken: "foreground-one", user: original })
              : pending.promise;
          }
          if (path === "/api/plan")
            return jsonResponse(200, {
              csrfToken: "foreground-two",
              user: original,
              plan: planFixture({ Monday: 1 }),
              planUpdatedAt: 1,
            });
          if (path === "/api/workouts?limit=100&offset=0")
            return jsonResponse(200, {
              csrfToken: "foreground-two",
              hasMore: false,
              workouts: [workoutFixture({ title: "FOREGROUND WORKOUT SENTINEL" })],
            });
          if (path === "/api/account/sessions")
            return jsonResponse(200, {
              userId: original.id,
              sessions: [{ id: "FOREGROUND-SESSION-SENTINEL", current: true }],
            });
          throw new Error(`Unexpected route ${path}`);
        },
      });
    await settle();
    const identityReadsBeforeForeground = identityReads;
    assert.match(
      page.elements.get("signedInIdentity").textContent,
      /FOREGROUND PRIVATE SENTINEL/,
      scenario.name,
    );
    if (scenario.event === "visibilitychange") {
      page.setHidden(true);
      await page.emitDocument("visibilitychange");
      assert.match(
        page.elements.get("signedInIdentity").textContent,
        /FOREGROUND PRIVATE SENTINEL/,
      );
      page.setHidden(false);
    }
    const foreground =
      scenario.event === "focus" ? page.emitWindow("focus") : page.emitDocument("visibilitychange");
    assert.equal(
      page.elements.get("signedInCard").hidden,
      true,
      `${scenario.name} must lock synchronously`,
    );
    assert.equal(page.elements.get("accountLoading").hidden, false, scenario.name);
    const lockedDom = [...page.elements.values()]
      .map((node) => `${node.textContent} ${node.innerHTML} ${node.href}`)
      .join(" ");
    assert.doesNotMatch(
      lockedDom,
      /FOREGROUND\s*PRIVATE\s*SENTINEL|foreground-private@example\s*\.test|FOREGROUND\s*WORKOUT\s*SENTINEL|FOREGROUND-SESSION-SENTINEL/,
      scenario.name,
    );
    await settle();
    assert.equal(identityReads, identityReadsBeforeForeground + 1, scenario.name);
    pending.resolve(jsonResponse(200, { csrfToken: "foreground-two", user: scenario.next }));
    await foreground;
    await settle();
    assert.equal(page.elements.get("signedInCard").hidden, !scenario.reopens, scenario.name);
    if (scenario.reopens)
      assert.match(
        page.elements.get("signedInIdentity").textContent,
        /FOREGROUND PRIVATE SENTINEL/,
        scenario.name,
      );
    else {
      assert.equal(
        page.elements.get("accountLoadingTitle").textContent,
        "Account access changed.",
        scenario.name,
      );
      assert.doesNotMatch(
        [...page.elements.values()]
          .map((node) => `${node.textContent} ${node.innerHTML}`)
          .join(" "),
        /REPLACEMENT\s*PRIVATE\s*SENTINEL/,
        scenario.name,
      );
    }
  }
});

test("delayed private operation responses cannot outlive an account-page invalidation", async () => {
  const user = memberFixture({
    discovery: {
      active: false,
      accessType: null,
      pendingPurchaseCount: 0,
      subscription: {
        id: "sub-private-operation",
        status: "paused",
        active: false,
        pastDue: false,
        scheduledChange: null,
        currentPeriodEndsAt: Date.now() + 86400000,
      },
    },
  });
  const scenarios = [
    {
      name: "export",
      button: "accountExportData",
      path: "/api/account/export",
      response: () => exportResponse({ private: "DELAYED-PRIVATE-EXPORT" }),
    },
    {
      name: "portal",
      button: "accountManageSubscription",
      path: "/api/billing/portal",
      response: () =>
        jsonResponse(200, {
          overviewUrl: "https://customer-portal.paddle.com/cpl_delayed_private",
        }),
    },
    {
      name: "security email",
      button: "accountDeleteRequest",
      path: "/api/account/delete/request",
      response: () => jsonResponse(202, { maskedEmail: "DELAYED-PRIVATE-EMAIL" }),
    },
  ];
  for (const scenario of scenarios) {
    const pending = deferred(),
      page = createPage({
        route: async (path) => {
          if (path === "/api/status") return jsonResponse(200, { persistent: true });
          if (path === "/healthz") return jsonResponse(200, { ok: true });
          if (path === "/api/me") return jsonResponse(200, { csrfToken: "operation-csrf", user });
          if (path === "/api/plan")
            return jsonResponse(200, {
              csrfToken: "operation-csrf",
              user,
              plan: planFixture(),
              planUpdatedAt: 0,
            });
          if (path === "/api/account/sessions")
            return jsonResponse(200, { userId: user.id, sessions: [] });
          if (path === scenario.path) return pending.promise;
          throw new Error(`Unexpected route ${path}`);
        },
      });
    await settle();
    const button = page.elements.get(scenario.button),
      click = button.emit("click", { currentTarget: button });
    await settle();
    assert.equal(
      page.requests.some(({ path }) => path === scenario.path),
      true,
      scenario.name,
    );
    await page.emitWindow("pageshow", { persisted: true });
    pending.resolve(scenario.response());
    await click;
    await settle();
    assert.equal(page.reloads.length, 1, scenario.name);
    assert.deepEqual(page.downloads, [], scenario.name);
    assert.deepEqual(page.navigations, [], scenario.name);
    assert.equal(page.objectUrls.length, 0, scenario.name);
    assert.equal(page.elements.get("accountSecurityStatus").textContent, "", scenario.name);
    assert.equal(page.elements.get("accountDeleteCancel").hidden, true, scenario.name);
    const privateDom = [...page.elements.values()]
      .map((node) => `${node.textContent} ${node.innerHTML} ${node.href}`)
      .join(" ");
    assert.doesNotMatch(privateDom, /DELAYED-PRIVATE|cpl_delayed_private/, scenario.name);
  }
});

test("exports and Paddle portal links require the original account identity immediately before use", async () => {
  const original = memberFixture({
      id: "original-operation-owner",
      discovery: {
        active: false,
        accessType: null,
        pendingPurchaseCount: 0,
        subscription: {
          id: "sub-original",
          status: "paused",
          active: false,
          pastDue: false,
          scheduledChange: null,
          currentPeriodEndsAt: Date.now() + 86400000,
        },
      },
    }),
    changed = memberFixture({ id: "replacement-operation-owner" });
  const scenarios = [
    {
      name: "export",
      button: "accountExportData",
      path: "/api/account/export",
      response: () => exportResponse({ private: "CROSS-ACCOUNT-EXPORT" }),
    },
    {
      name: "portal",
      button: "accountManageSubscription",
      path: "/api/billing/portal",
      response: () =>
        jsonResponse(200, { overviewUrl: "https://customer-portal.paddle.com/cpl_cross_account" }),
    },
  ];
  for (const scenario of scenarios) {
    let identityReads = 0;
    const page = createPage({
      route: async (path) => {
        if (path === "/api/status") return jsonResponse(200, { persistent: true });
        if (path === "/healthz") return jsonResponse(200, { ok: true });
        if (path === "/api/me") {
          identityReads += 1;
          return jsonResponse(200, {
            csrfToken: `identity-${identityReads}`,
            user: identityReads === 1 ? original : changed,
          });
        }
        if (path === "/api/plan")
          return jsonResponse(200, {
            csrfToken: "identity-1",
            user: original,
            plan: planFixture(),
            planUpdatedAt: 0,
          });
        if (path === "/api/account/sessions")
          return jsonResponse(200, { userId: original.id, sessions: [] });
        if (path === scenario.path) return scenario.response();
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await settle();
    const button = page.elements.get(scenario.button);
    await button.emit("click", { currentTarget: button });
    await settle();
    assert.equal(identityReads, 2, scenario.name);
    assert.deepEqual(page.downloads, [], scenario.name);
    assert.deepEqual(page.navigations, [], scenario.name);
    assert.equal(page.objectUrls.length, 0, scenario.name);
    assert.equal(page.elements.get("signedInCard").hidden, true, scenario.name);
    assert.equal(
      page.elements.get("accountLoadingTitle").textContent,
      "Account access changed.",
      scenario.name,
    );
  }
});

test("signed-in session and JSON export controls are accessible and CSRF protected", async () => {
  assert.match(html, /id="accountSessionsTitle"/);
  assert.match(html, /id="accountSessionList"[^>]*aria-label="Active signed-in sessions"/);
  assert.match(html, /id="accountRevokeOtherSessions"[^>]*aria-describedby="accountSessionStatus"/);
  assert.match(html, /id="accountExportData"[^>]*aria-describedby="accountExportStatus"/);
  const user = memberFixture({
      discovery: { active: false, accessType: null, pendingPurchaseCount: 0 },
    }),
    current = {
      id: "session-current",
      current: true,
      createdAt: 1_700_000_000_000,
      expiresAt: 1_800_000_000_000,
    },
    other = {
      id: "session-other",
      current: false,
      createdAt: 1_710_000_000_000,
      expiresAt: 1_810_000_000_000,
    };
  let identityReads = 0;
  const page = createPage({
    route: async (path, options) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") {
        identityReads += 1;
        return jsonResponse(200, {
          csrfToken: identityReads === 1 ? "csrf-self-service" : "csrf-plan-rotated",
          user,
        });
      }
      if (path === "/api/plan")
        return jsonResponse(200, {
          csrfToken: "csrf-plan-rotated",
          user,
          plan: planFixture(),
          planUpdatedAt: 0,
        });
      if (path === "/api/account/sessions" && (!options.method || options.method === "GET"))
        return jsonResponse(200, { userId: user.id, sessions: [current, other], otherCount: 1 });
      if (path === "/api/account/sessions/revoke-others")
        return jsonResponse(200, { ok: true, revoked: 1, sessions: [current], otherCount: 0 });
      if (path === "/api/account/export")
        return exportResponse({
          format: "strata-account-export",
          schemaVersion: 1,
          exportedAt: "2026-09-08T00:00:00.000Z",
          account: { id: user.id },
        });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  assert.match(page.elements.get("accountSessionList").innerHTML, /This session/);
  assert.match(
    page.elements.get("accountSessionList").innerHTML,
    /data-revoke-session="session-other"/,
  );
  assert.equal(page.elements.get("accountRevokeOtherSessions").disabled, false);
  await page.elements
    .get("accountRevokeOtherSessions")
    .emit("click", { currentTarget: page.elements.get("accountRevokeOtherSessions") });
  await settle();
  const revoke = page.requests.find(({ path }) => path === "/api/account/sessions/revoke-others");
  assert.equal(revoke.options.headers["X-CSRF-Token"], "csrf-self-service");
  assert.equal(revoke.options.body, "{}");
  assert.match(page.elements.get("accountSessionStatus").textContent, /1 other session/);
  await page.elements
    .get("accountExportData")
    .emit("click", { currentTarget: page.elements.get("accountExportData") });
  await settle();
  const exported = page.requests.find(({ path }) => path === "/api/account/export");
  assert.equal(exported.options.method, "POST");
  assert.equal(exported.options.headers["X-CSRF-Token"], "csrf-plan-rotated");
  assert.deepEqual(page.downloads, [
    { href: "blob:strata-1", download: "strata-account-export-2026-09-08.json" },
  ]);
  assert.equal(page.objectUrls.length, 1);
  assert.match(page.elements.get("accountExportStatus").textContent, /downloaded/i);
});

test("a visitor's 200 { user: null } and an older server's 401 both open the forms, on load and on return", async () => {
  const user = memberFixture({ id: "returning-member", name: "RETURNING MEMBER SENTINEL" });
  for (const signedOut of [
    () => jsonResponse(200, { user: null }),
    () => jsonResponse(401, { error: "Not signed in." }),
  ]) {
    const visitor = createPage({
      search: "?mode=login",
      route: async (path) => {
        if (path === "/api/me") return signedOut();
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await settle();
    assert.deepEqual(
      visitor.requests.map(({ path }) => path),
      ["/api/me"],
      "a visitor requests nothing private",
    );
    assert.equal(visitor.elements.get("accountAccess").hidden, false);
    assert.equal(visitor.elements.get("signedInCard").hidden, true);
    assert.equal(visitor.elements.get("loginTitle").focused, true);
    assert.equal(visitor.elements.get("loginMessage").hidden, true, "no session error is shown");

    let identityReads = 0;
    const member = createPage({
      route: async (path) => {
        if (path === "/api/me")
          return ++identityReads === 1
            ? jsonResponse(200, { csrfToken: "member-csrf", user })
            : signedOut();
        if (path === "/api/account/sessions")
          return jsonResponse(200, { userId: user.id, sessions: [] });
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await settle();
    assert.match(member.elements.get("signedInIdentity").textContent, /RETURNING MEMBER SENTINEL/);
    await member.emitWindow("focus");
    await settle();
    assert.equal(identityReads, 2);
    assert.equal(member.elements.get("signedInCard").hidden, true);
    assert.equal(member.elements.get("accountAccess").hidden, false, "signed out, not changed");
    assert.notEqual(
      member.elements.get("accountLoadingTitle").textContent,
      "Account access changed.",
    );
    assert.doesNotMatch(
      [...member.elements.values()]
        .map((node) => `${node.textContent} ${node.innerHTML}`)
        .join(" "),
      /RETURNING\s*MEMBER\s*SENTINEL/,
    );
  }
});

test("explicit account modes bring the requested form into view on every viewport", async () => {
  for (const mode of ["signup", "login"]) {
    const page = createPage({
      search: `?mode=${mode}`,
      route: async (path) => {
        if (path === "/api/status") return jsonResponse(200, { persistent: true });
        if (path === "/healthz") return jsonResponse(200, { ok: true });
        if (path === "/api/me") return jsonResponse(200, { user: null });
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await settle();
    assert.equal(
      page.elements.get(`${mode}Panel`).scrolled,
      true,
      `${mode} panel should scroll into view`,
    );
    assert.equal(
      page.elements.get(`${mode}Title`).focused,
      true,
      `${mode} title should receive focus`,
    );
  }
});

test("login accepts existing password lengths while new passwords keep the stronger minimum", () => {
  const signupPassword = html.match(/<input\b[^>]*id="signupPassword"[^>]*>/)?.[0] || "";
  const loginPassword = html.match(/<input\b[^>]*id="loginPassword"[^>]*>/)?.[0] || "";
  assert.match(signupPassword, /minlength="10"/);
  assert.doesNotMatch(
    loginPassword,
    /minlength\s*=/,
    "login must not reject a valid legacy password in browser validation",
  );
  assert.match(loginPassword, /maxlength="128"/);
});

test("password visibility controls expose state without changing form behavior", async () => {
  assert.match(
    html,
    /id="signupPasswordToggle"[^>]*type="button"[^>]*aria-controls="signupPassword"[^>]*aria-pressed="false"/,
  );
  assert.match(
    html,
    /id="loginPasswordToggle"[^>]*type="button"[^>]*aria-controls="loginPassword"[^>]*aria-pressed="false"/,
  );
  const page = createPage({
    route: async (path) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") return jsonResponse(200, { user: null });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  const input = page.elements.get("signupPassword"),
    button = page.elements.get("signupPasswordToggle");
  await button.emit("click");
  assert.equal(input.type, "text");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.textContent, "Hide");
  await button.emit("click");
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
});

test("auth submit buttons communicate progress and restore after failure", async () => {
  let finishLogin;
  const pendingLogin = new Promise((resolve) => {
    finishLogin = resolve;
  });
  const page = createPage({
    route: async (path) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") return jsonResponse(200, { user: null });
      if (path === "/api/login") return pendingLogin;
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  const form = page.elements.get("loginForm"),
    button = page.elements.get("loginSubmit");
  form.values = { email: "returning@example.test", password: "existing-password" };
  const pending = form.emit("submit", { preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(button.dataset.busy, "true");
  assert.match(button.getAttribute("aria-label"), /signing in/i);
  finishLogin(jsonResponse(401, { error: "Email or password is incorrect." }));
  await pending;
  assert.equal(button.dataset.busy, undefined);
  assert.equal(button.getAttribute("aria-label"), null);
  assert.equal(button.disabled, false);
});

test("a login error stays scoped to the login form", async () => {
  const page = createPage({
    search: "?mode=login&error=Email%20or%20password%20is%20incorrect.",
    route: async (path) => {
      if (path === "/api/me") return jsonResponse(200, { user: null });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  const { elements } = page;
  assert.equal(elements.get("signupSubmit").disabled, false);
  assert.equal(elements.get("loginMessage").hidden, false);
  assert.equal(elements.get("loginMessage").textContent, "Email or password is incorrect.");
});

test("signed-in Profile distinguishes access and billing states", async () => {
  const periodEnd = Date.now() + 30 * 24 * 60 * 60 * 1000,
    cancelAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const subscription = (status, overrides = {}) => ({
    id: `sub-${status}`,
    status,
    active: ["active", "trialing", "past_due"].includes(status),
    pastDue: status === "past_due",
    scheduledChange: null,
    currentPeriodEndsAt: periodEnd,
    ...overrides,
  });
  const cases = [
    {
      name: "active monthly account with a populated week",
      planCount: 6,
      workoutDays: 3,
      discovery: {
        active: true,
        accessType: "subscription",
        pendingPurchaseCount: 0,
        subscription: subscription("active"),
      },
      access: "Active",
      detail: /Monthly · renews/i,
      primary: "Open next workout",
      href: /^\/workout\.html\?day=/,
      discoveryAction: "Open Strata+ studio →",
      billing: /next renewal/i,
      badge: "Active",
      cancel: true,
    },
    {
      name: "active monthly account with a complimentary grant",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: true,
        accessType: "paid",
        pendingPurchaseCount: 0,
        adminGrant: { active: true, startedAt: Date.now(), expiresAt: cancelAt, revokedAt: null },
        subscription: subscription("active"),
      },
      access: "Complimentary",
      detail: /Until /i,
      grantMessage: /monthly subscription remains separate/i,
      primary: "Build your week",
      href: /^\/onboarding\.html$/,
      discoveryAction: "Open Strata+ studio →",
      billing: /next renewal/i,
      badge: "Active",
      cancel: true,
    },
    {
      name: "complimentary grant without paid billing",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: true,
        accessType: "grant",
        pendingPurchaseCount: 0,
        adminGrant: { active: true, startedAt: Date.now(), expiresAt: null, revokedAt: null },
        subscription: null,
      },
      access: "Complimentary",
      detail: /Until revoked/i,
      grantMessage: /did not create a paid subscription/i,
      grantMessageNot: /manage it below/i,
      primary: "Build your week",
      href: /^\/onboarding\.html$/,
      discoveryAction: "Open Strata+ studio →",
      billing: null,
    },
    {
      name: "grandfathered lifetime account with a complimentary grant",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: true,
        accessType: "paid",
        pendingPurchaseCount: 0,
        adminGrant: { active: true, startedAt: Date.now(), expiresAt: cancelAt, revokedAt: null },
        subscription: null,
      },
      access: "Complimentary",
      detail: /Until /i,
      grantMessage: /grandfathered lifetime access remains separate/i,
      primary: "Build your week",
      href: /^\/onboarding\.html$/,
      discoveryAction: "Open Strata+ studio →",
      billing: /prior lifetime purchase remains active/i,
      badge: "Grandfathered",
      manage: false,
    },
    {
      name: "grandfathered lifetime account",
      planCount: 0,
      workoutDays: 0,
      discovery: { active: true, accessType: "paid", pendingPurchaseCount: 0, subscription: null },
      access: "Lifetime",
      detail: /grandfathered · no renewal/i,
      primary: "Build your week",
      href: /^\/onboarding\.html$/,
      discoveryAction: "Open Strata+ studio →",
      billing: /prior lifetime purchase remains active/i,
      badge: "Grandfathered",
      manage: false,
    },
    {
      name: "scheduled cancellation",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: true,
        accessType: "subscription",
        pendingPurchaseCount: 0,
        subscription: subscription("active", {
          scheduledChange: { action: "cancel", effectiveAt: cancelAt },
        }),
      },
      access: "Canceling",
      detail: /Access through/i,
      primary: "Build your week",
      href: /^\/onboarding\.html$/,
      discoveryAction: "Open Strata+ studio →",
      billing: /Cancellation takes effect/i,
      badge: "Canceling",
      cancel: false,
    },
    {
      name: "scheduled pause",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: true,
        accessType: "subscription",
        pendingPurchaseCount: 0,
        subscription: subscription("active", {
          scheduledChange: { action: "pause", effectiveAt: cancelAt },
        }),
      },
      access: "Pausing",
      detail: /Access through/i,
      primary: "Build your week",
      href: /^\/onboarding\.html$/,
      discoveryAction: "Open Strata+ studio →",
      billing: /subscription pauses/i,
      badge: "Pausing",
      cancel: true,
    },
    {
      name: "past-due subscription",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: true,
        accessType: "subscription",
        pendingPurchaseCount: 0,
        subscription: subscription("past_due"),
      },
      access: "Past due",
      detail: /Update payment method/i,
      primary: "Build your week",
      href: /^\/onboarding\.html$/,
      discoveryAction: "Open Strata+ studio →",
      billing: /could not collect/i,
      badge: "Past due",
      update: true,
      cancel: true,
    },
    {
      name: "expired cached subscription",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: false,
        accessType: null,
        pendingPurchaseCount: 0,
        subscription: subscription("active", {
          active: false,
          currentPeriodEndsAt: Date.now() - 1,
        }),
      },
      access: "Inactive",
      detail: /Paid access inactive/i,
      primary: "Build your week",
      href: /^\/planner\.html$/,
      discoveryAction: "Manage Strata+ billing →",
      billing: /last verified billing period/i,
      badge: "Inactive",
      cancel: true,
    },
    {
      name: "paused subscription",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: false,
        accessType: null,
        pendingPurchaseCount: 0,
        subscription: subscription("paused"),
      },
      access: "Paused",
      detail: /Paid access inactive/i,
      primary: "Build your week",
      href: /^\/planner\.html$/,
      discoveryAction: "Manage Strata+ billing →",
      billing: /subscription is paused/i,
      badge: "Paused",
      cancel: true,
    },
    {
      name: "canceled subscription",
      planCount: 0,
      workoutDays: 0,
      discovery: {
        active: false,
        accessType: null,
        pendingPurchaseCount: 0,
        subscription: subscription("canceled"),
      },
      access: "Canceled",
      detail: /No future renewals/i,
      primary: "Build your week",
      href: /^\/planner\.html$/,
      discoveryAction: "Restart Strata+ →",
      billing: /no future renewals/i,
      badge: "Canceled",
      cancel: false,
    },
    {
      name: "pending purchase without a week",
      planCount: 0,
      workoutDays: 0,
      discovery: { active: false, accessType: null, pendingPurchaseCount: 1 },
      access: "Pending",
      detail: /checkout needs attention/i,
      primary: "Build your week",
      href: /^\/planner\.html$/,
      discoveryAction: "Check Strata+ subscription →",
      billing: null,
    },
    {
      name: "free account with a populated week",
      planCount: 2,
      workoutDays: 2,
      discovery: { active: false, accessType: null, pendingPurchaseCount: 0 },
      access: "Free",
      detail: /rankings and plan included/i,
      primary: "Open your week",
      href: /^\/planner\.html$/,
      discoveryAction: "Unlock Strata+ →",
      billing: null,
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    const dayCounts =
      fixture.planCount === 6
        ? { Monday: 2, Wednesday: 2, Friday: 2 }
        : fixture.planCount === 2
          ? { Tuesday: 1, Thursday: 1 }
          : {};
    const user = {
      id: `member-${index}`,
      name: "Ari",
      email: "ari@example.test",
      createdAt: 1704067200000,
      planCount: fixture.planCount,
      workoutDays: fixture.workoutDays,
      isAdmin: false,
      discovery: fixture.discovery,
      accountDeletion: { pending: false },
    };
    const page = createPage({
      route: async (path) => {
        if (path === "/api/status") return jsonResponse(200, { persistent: true });
        if (path === "/healthz") return jsonResponse(200, { ok: true });
        if (path === "/api/me") return jsonResponse(200, { csrfToken: "csrf-test", user });
        if (path === "/api/plan")
          return jsonResponse(200, {
            csrfToken: "csrf-test",
            user,
            plan: planFixture(dayCounts),
            planUpdatedAt: 10,
          });
        if (path === "/api/workouts?limit=100&offset=0")
          return jsonResponse(200, { workouts: [], hasMore: false, csrfToken: "csrf-test" });
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await settle();
    assert.equal(page.elements.get("signedInCard").hidden, false, fixture.name);
    assert.equal(page.elements.get("accountAccess").hidden, true, fixture.name);
    assert.equal(
      page.elements.get("accountPlanCount").textContent,
      String(fixture.planCount),
      fixture.name,
    );
    assert.equal(
      page.elements.get("accountWorkoutDays").textContent,
      String(fixture.workoutDays),
      fixture.name,
    );
    assert.equal(page.elements.get("accountAccessState").textContent, fixture.access, fixture.name);
    assert.match(
      page.elements.get("accountAccessDetail").textContent,
      fixture.detail,
      fixture.name,
    );
    if (fixture.grantMessage)
      assert.match(
        page.elements.get("accountDiscoveryStatus").textContent,
        fixture.grantMessage,
        fixture.name,
      );
    if (fixture.grantMessageNot)
      assert.doesNotMatch(
        page.elements.get("accountDiscoveryStatus").textContent,
        fixture.grantMessageNot,
        fixture.name,
      );
    assert.match(page.elements.get("accountMemberSince").textContent, /2024/, fixture.name);
    assert.equal(
      page.elements.get("accountDiscoveryAction").textContent,
      fixture.discoveryAction,
      fixture.name,
    );
    assert.equal(
      page.elements.get("accountBilling").hidden,
      fixture.billing === null,
      fixture.name,
    );
    if (fixture.billing) {
      assert.match(
        page.elements.get("accountBillingDetail").textContent,
        fixture.billing,
        fixture.name,
      );
      assert.equal(
        page.elements.get("accountBillingBadge").textContent,
        fixture.badge,
        fixture.name,
      );
      assert.equal(
        page.elements.get("accountManageSubscription").hidden,
        fixture.manage === false,
        fixture.name,
      );
      assert.equal(
        page.elements.get("accountUpdatePayment").hidden,
        fixture.update !== true,
        fixture.name,
      );
      assert.equal(
        page.elements.get("accountCancelSubscription").hidden,
        fixture.cancel !== true,
        fixture.name,
      );
    }
  }
});

test("subscription controls use the CSRF-protected Paddle portal and clear private data when access expires", async () => {
  const user = memberFixture({
    discovery: {
      active: true,
      accessType: "subscription",
      pendingPurchaseCount: 0,
      subscription: {
        id: "sub-active",
        status: "active",
        active: true,
        pastDue: false,
        scheduledChange: null,
        currentPeriodEndsAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      },
    },
  });
  let unsafe = false,
    sessionExpired = false;
  const page = createPage({
    route: async (path, options) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") return jsonResponse(200, { csrfToken: "billing-csrf", user });
      if (path === "/api/plan")
        return jsonResponse(200, {
          csrfToken: "billing-csrf",
          user,
          plan: planFixture({ Monday: 1 }),
          planUpdatedAt: 10,
        });
      if (path === "/api/workouts?limit=100&offset=0")
        return jsonResponse(200, { workouts: [], hasMore: false, csrfToken: "billing-csrf" });
      if (path === "/api/billing/portal") {
        assert.equal(options.method, "POST");
        assert.equal(options.headers["X-CSRF-Token"], "billing-csrf");
        assert.equal(options.body, "{}");
        if (sessionExpired) return jsonResponse(403, { error: "Security check expired." });
        return jsonResponse(200, {
          overviewUrl: unsafe
            ? "https://attacker.test/cpl_bad"
            : "https://customer-portal.paddle.com/cpl_overview",
          cancelUrl: "https://customer-portal.paddle.com/cpl_cancel",
          updatePaymentMethodUrl: "https://customer-portal.paddle.com/cpl_payment",
        });
      }
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  await page.elements
    .get("accountManageSubscription")
    .emit("click", { currentTarget: page.elements.get("accountManageSubscription") });
  await settle();
  await page.elements
    .get("accountCancelSubscription")
    .emit("click", { currentTarget: page.elements.get("accountCancelSubscription") });
  await settle();
  assert.deepEqual(page.navigations, [
    "https://customer-portal.paddle.com/cpl_overview",
    "https://customer-portal.paddle.com/cpl_cancel",
  ]);
  unsafe = true;
  await page.elements
    .get("accountManageSubscription")
    .emit("click", { currentTarget: page.elements.get("accountManageSubscription") });
  await settle();
  assert.equal(page.navigations.length, 2, "an off-origin portal URL must never be opened");
  assert.match(
    page.elements.get("accountBillingStatus").textContent,
    /invalid subscription-management link/i,
  );
  assert.equal(page.elements.get("accountBillingStatus").classList.contains("bad"), true);
  sessionExpired = true;
  await page.elements
    .get("accountManageSubscription")
    .emit("click", { currentTarget: page.elements.get("accountManageSubscription") });
  await settle();
  assert.equal(page.elements.get("signedInCard").hidden, true);
  assert.equal(page.elements.get("accountLoadingTitle").textContent, "Account access changed.");
  assert.equal(page.elements.get("signedInIdentity").textContent, "");
  assert.equal(page.elements.get("accountBillingDetail").textContent, "");
});

test("enhanced signup reports an inline error, recovers, and retries", async () => {
  let signupAttempts = 0;
  const page = createPage({
    route: async (path) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") return jsonResponse(200, { user: null });
      if (path === "/api/signup") {
        signupAttempts += 1;
        return signupAttempts === 1
          ? jsonResponse(409, { error: "An account with that email already exists." })
          : jsonResponse(201, { user: { id: "user-1" } });
      }
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  const form = page.elements.get("signupForm");
  form.values = {
    name: "New Lifter",
    email: "lifter@example.test",
    password: "secure-password-123",
  };
  let prevented = false;
  await form.emit("submit", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  const firstRequest = page.requests.find((request) => request.path === "/api/signup");
  assert.equal(firstRequest.options.method, "POST");
  assert.equal(firstRequest.options.credentials, "same-origin");
  assert.equal(firstRequest.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(firstRequest.options.body), {
    email: "lifter@example.test",
    password: "secure-password-123",
    name: "New Lifter",
  });
  assert.equal(
    page.elements.get("signupMessage").textContent,
    "An account with that email already exists.",
  );
  assert.equal(page.elements.get("loginMessage").hidden, true);
  assert.equal(page.elements.get("signupSubmit").disabled, false);
  await form.emit("input");
  assert.equal(page.elements.get("signupMessage").hidden, true);
  await form.emit("submit", { preventDefault() {} });
  assert.equal(signupAttempts, 2);
  assert.deepEqual(page.navigations, ["/planner.html"]);
});

test("enhanced login uses its own endpoint and keeps failures retryable", async () => {
  const page = createPage({
    search: "?mode=login&next=planner&add=flat-dumbbell-press",
    route: async (path) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") return jsonResponse(200, { user: null });
      if (path === "/api/login")
        return jsonResponse(401, { error: "Email or password is incorrect." });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  const form = page.elements.get("loginForm");
  form.values = { email: "returning@example.test", password: "incorrect-password" };
  await form.emit("submit", { preventDefault() {} });
  const loginRequest = page.requests.find((request) => request.path === "/api/login");
  assert.deepEqual(JSON.parse(loginRequest.options.body), {
    email: "returning@example.test",
    password: "incorrect-password",
  });
  assert.equal(page.elements.get("loginMessage").hidden, false);
  assert.equal(page.elements.get("signupMessage").hidden, true);
  assert.equal(page.elements.get("loginSubmit").disabled, false);
  assert.equal(form.getAttribute("aria-busy"), null);
  assert.deepEqual(page.navigations, []);
});

test("enhanced login and verification preserve only exact workout and onboarding destinations", async () => {
  const destinations = [
    ["workout", "/workout.html"],
    ["/workout.html", "/workout.html"],
    ["onboarding", "/onboarding.html"],
    ["/onboarding.html", "/onboarding.html"],
    ["https://outside.test/workout.html", "/planner.html"],
    ["//outside.test/onboarding.html", "/planner.html"],
    ["/workout.html?day=Monday", "/workout.html?day=Monday"],
    ["/workout.html?day=Funday", "/planner.html"],
    ["/workout.html?day=Monday&next=//outside.test", "/planner.html"],
    ["/workout.html?next=https://outside.test", "/planner.html"],
    ["/onboarding.html/../../outside", "/planner.html"],
  ];
  for (const [requested, destination] of destinations)
    for (const verify of [false, true]) {
      const page = createPage({
        search: `?mode=login&next=${encodeURIComponent(requested)}`,
        route: async (path) => {
          if (path === "/api/status") return jsonResponse(200, { persistent: true });
          if (path === "/healthz") return jsonResponse(200, { ok: true });
          if (path === "/api/me") return jsonResponse(200, { user: null });
          if (path === "/api/login")
            return verify
              ? jsonResponse(202, {
                  verificationRequired: true,
                  purpose: "login",
                  maskedEmail: "r***@example.test",
                })
              : jsonResponse(200, { user: { id: "returning" } });
          throw new Error(`Unexpected route ${path}`);
        },
      });
      await settle();
      assert.equal(page.elements.get("loginNext").value, destination);
      const form = page.elements.get("loginForm");
      form.values = { email: "returning@example.test", password: "existing-password" };
      await form.emit("submit", { preventDefault() {} });
      assert.deepEqual(page.navigations, [
        verify
          ? `/verify-email.html?${new URLSearchParams({ next: destination.includes("?") ? destination : destination.slice(1, -5), purpose: "login" })}`
          : destination,
      ]);
    }
});

function accountRoutes(user, { appleBilling = null } = {}) {
  return async (path) => {
    if (path === "/api/status") return jsonResponse(200, { persistent: true });
    if (path === "/healthz") return jsonResponse(200, { ok: true });
    if (path === "/api/me") return jsonResponse(200, { csrfToken: "app-csrf", user });
    if (path === "/api/plan")
      return jsonResponse(200, {
        csrfToken: "app-csrf",
        user,
        plan: planFixture({ Monday: 1 }),
        planUpdatedAt: 10,
      });
    if (path === "/api/workouts?limit=100&offset=0")
      return jsonResponse(200, { workouts: [], hasMore: false, csrfToken: "app-csrf" });
    if (path === "/api/account/sessions")
      return jsonResponse(200, { userId: user.id, sessions: [] });
    if (path === "/api/account/delete/request")
      return jsonResponse(200, {
        maskedEmail: "a***@example.test",
        ...(appleBilling ? { appleBilling } : {}),
      });
    throw new Error(`Unexpected route ${path}`);
  };
}
const APPLE_DELETION = {
  message:
    "Deleting your STRATA account does not cancel a Strata+ subscription bought through Apple. Apple keeps billing your Apple Account until you cancel it in Settings > Apple ID > Subscriptions.",
  manageUrl: "https://apps.apple.com/account/subscriptions",
};
const APPLE_ACTIVE = {
  active: true,
  productId: "online.stratafitness.app.plus.monthly",
  expiresAt: Date.parse("2026-11-01T12:00:00Z"),
  autoRenew: true,
  inGracePeriod: false,
  environment: "Production",
  revoked: false,
};

test("in the app, an App Store subscriber manages Strata+ on Apple's own sheet", async () => {
  const calls = [],
    user = memberFixture({
      discovery: {
        active: true,
        accessType: "apple",
        pendingPurchaseCount: 0,
        apple: APPLE_ACTIVE,
        subscription: null,
      },
    });
  const page = createPage({
    route: accountRoutes(user),
    app: {
      plugin: {
        manageSubscriptions: async () => {
          calls.push("manage");
          return {};
        },
      },
    },
  });
  await settle();
  assert.equal(page.elements.get("accountBilling").hidden, false);
  assert.equal(
    page.elements.get("accountBillingTitle").textContent,
    "Strata+ through the App Store",
  );
  assert.equal(page.elements.get("accountBillingBadge").textContent, "Active");
  assert.match(
    page.elements.get("accountBillingDetail").textContent,
    /^Billed to your Apple Account through the App Store\. It renews Nov 1, 2026 unless cancelled at least 24 hours before\.$/,
  );
  for (const id of [
    "accountManageSubscription",
    "accountUpdatePayment",
    "accountCancelSubscription",
    "accountBillingWebNote",
  ])
    assert.equal(page.elements.get(id).hidden, true, id);
  assert.equal(page.elements.get("accountManageApple").hidden, false);
  assert.equal(page.elements.get("accountAccessState").textContent, "Active");
  assert.match(
    page.elements.get("accountAccessDetail").textContent,
    /^App Store · renews Nov 1, 2026$/,
  );
  let prevented = false;
  await page.elements.get("accountManageApple").emit("click", {
    preventDefault: () => {
      prevented = true;
    },
  });
  await settle();
  assert.deepEqual(calls, ["manage"]);
  assert.equal(prevented, true, "the app opens Apple's sheet instead of following the link");
  assert.equal(page.elements.get("accountBillingStatus").textContent, "");
  assert.deepEqual(page.navigations, []);
  // An app build without the sheet, or a sheet that fails, goes to Apple's subscriptions page.
  for (const plugin of [
    null,
    {
      manageSubscriptions: async () => {
        throw new Error("unavailable");
      },
    },
  ]) {
    const oldBuild = createPage({ route: accountRoutes(user), app: { plugin } });
    await settle();
    await oldBuild.elements.get("accountManageApple").emit("click", { preventDefault() {} });
    await settle();
    assert.deepEqual(oldBuild.navigations, ["https://apps.apple.com/account/subscriptions"]);
  }
  // Deleting the account names Apple's billing and links to Apple's subscriptions, which open on Apple's sheet in the app.
  const deleting = createPage({
    route: accountRoutes(user, { appleBilling: APPLE_DELETION }),
    app: {
      plugin: {
        manageSubscriptions: async () => {
          calls.push("manage-from-delete");
          return {};
        },
      },
    },
  });
  await settle();
  await deleting.elements
    .get("accountDeleteRequest")
    .emit("click", { currentTarget: deleting.elements.get("accountDeleteRequest") });
  await settle();
  assert.equal(
    deleting.elements.get("accountDeleteDialog").open,
    true,
    "in the app, Delete account opens the in-app dialog",
  );
  await deleting.elements.get("accountDeleteEmail").emit("click");
  await settle();
  assert.equal(deleting.elements.get("accountDeleteDialog").open, false);
  assert.match(
    deleting.elements.get("accountSecurityStatus").textContent,
    /Nothing is deleted until you open it and type DELETE\. Deletion does not cancel a subscription or refund a charge\. Deleting your STRATA account does not cancel a Strata\+ subscription bought through Apple\. Apple keeps billing your Apple Account until you cancel it/,
  );
  assert.equal(deleting.elements.get("accountSecurityAppleLink").hidden, false);
  assert.equal(
    deleting.elements.get("accountSecurityAppleLink").href,
    "https://apps.apple.com/account/subscriptions",
  );
  await deleting.elements.get("accountSecurityAppleLink").emit("click", { preventDefault() {} });
  await settle();
  assert.deepEqual(calls, ["manage", "manage-from-delete"]);
});

test("in the app, Paddle billing is read-only and the deletion copy names the App Store", async () => {
  const user = memberFixture({
    discovery: {
      active: true,
      accessType: "paid",
      pendingPurchaseCount: 0,
      subscription: {
        id: "sub-web",
        status: "past_due",
        active: true,
        pastDue: true,
        scheduledChange: null,
        currentPeriodEndsAt: Date.now() + 86_400_000,
      },
    },
  });
  const page = createPage({ route: accountRoutes(user), app: { plugin: {} } });
  await settle();
  for (const id of [
    "accountManageSubscription",
    "accountUpdatePayment",
    "accountCancelSubscription",
    "accountManageApple",
  ])
    assert.equal(page.elements.get(id).hidden, true, id);
  assert.equal(page.elements.get("accountBillingWebNote").hidden, false);
  assert.doesNotMatch(
    `${page.elements.get("accountBillingDetail").textContent} ${page.elements.get("accountDiscoveryStatus").textContent}`,
    /Paddle/,
  );
  assert.match(
    page.elements.get("accountDiscoveryStatus").textContent,
    /billed on stratafitness\.online/,
  );
  await page.elements
    .get("accountDeleteRequest")
    .emit("click", { currentTarget: page.elements.get("accountDeleteRequest") });
  await settle();
  assert.equal(
    page.elements.get("accountDeleteApple").hidden,
    true,
    "a Paddle subscription is not billed by Apple",
  );
  await page.elements.get("accountDeleteEmail").emit("click");
  await settle();
  assert.match(
    page.elements.get("accountSecurityStatus").textContent,
    /an App Store subscription keeps billing until you cancel it in Settings › Apple Account › Subscriptions\.$/,
  );
  assert.equal(
    page.elements.get("accountSecurityAppleLink").hidden,
    true,
    "no App Store subscription, no Apple link",
  );
  assert.match(
    html,
    /<span class="web-only">Account deletion does not cancel a Paddle subscription[^<]*<\/span><span class="app-only" hidden>[^<]*App Store subscription keeps billing your Apple Account until you cancel it in Settings/,
  );
  const free = createPage({
    route: accountRoutes(
      memberFixture({ discovery: { active: false, accessType: null, pendingPurchaseCount: 0 } }),
    ),
    app: { plugin: {} },
  });
  await settle();
  assert.equal(
    free.elements.get("accountDiscoveryStatus").textContent,
    "The exercise index and weekly planner are free. Strata+ is available as a monthly subscription.",
    "no fixed USD price in the app",
  );
});

test("on the website an App Store subscriber gets Apple's subscriptions link and never Paddle's portal, and Paddle members see no change", async () => {
  const apple = createPage({
    route: accountRoutes(
      memberFixture({
        discovery: {
          active: true,
          accessType: "apple",
          pendingPurchaseCount: 0,
          apple: { ...APPLE_ACTIVE, autoRenew: false },
          subscription: { id: "sub-old", status: "canceled", active: false, scheduledChange: null },
        },
      }),
      { appleBilling: APPLE_DELETION },
    ),
  });
  await settle();
  assert.equal(
    apple.elements.get("accountBillingTitle").textContent,
    "Strata+ through the App Store",
  );
  assert.equal(apple.elements.get("accountBillingBadge").textContent, "Canceling");
  assert.match(
    apple.elements.get("accountBillingDetail").textContent,
    /It ends Nov 1, 2026 and will not renew\. Manage it in Settings › Apple Account › Subscriptions on your iPhone\.$/,
  );
  assert.equal(
    apple.elements.get("accountManageApple").hidden,
    false,
    "a link to Apple's subscriptions page",
  );
  for (const id of [
    "accountManageSubscription",
    "accountUpdatePayment",
    "accountCancelSubscription",
  ])
    assert.equal(
      apple.elements.get(id).hidden,
      true,
      `${id}: an older Paddle subscription is never offered beside App Store access`,
    );
  assert.match(
    html,
    /<a id="accountManageApple" href="https:\/\/apps\.apple\.com\/account\/subscriptions" target="_blank" rel="noopener noreferrer" hidden>Manage subscription/,
  );
  let prevented = false;
  await apple.elements.get("accountManageApple").emit("click", {
    preventDefault: () => {
      prevented = true;
    },
  });
  await settle();
  assert.equal(prevented, false, "the website follows the link itself");
  assert.deepEqual(apple.navigations, []);
  assert.equal(apple.elements.get("accountAccessState").textContent, "Canceling");
  await apple.elements
    .get("accountDeleteRequest")
    .emit("click", { currentTarget: apple.elements.get("accountDeleteRequest") });
  await settle();
  assert.match(
    apple.elements.get("accountSecurityStatus").textContent,
    /Apple keeps billing your Apple Account until you cancel it in Settings > Apple ID > Subscriptions\.$/,
  );
  assert.equal(apple.elements.get("accountSecurityAppleLink").hidden, false);
  const paddle = createPage({
    route: accountRoutes(
      memberFixture({
        discovery: {
          active: true,
          accessType: "paid",
          pendingPurchaseCount: 0,
          subscription: {
            id: "sub-web",
            status: "past_due",
            active: true,
            pastDue: true,
            scheduledChange: null,
            currentPeriodEndsAt: Date.now() + 86_400_000,
          },
        },
      }),
    ),
  });
  await settle();
  assert.equal(paddle.elements.get("accountManageSubscription").hidden, false);
  assert.equal(paddle.elements.get("accountUpdatePayment").hidden, false);
  assert.equal(paddle.elements.get("accountBillingWebNote").hidden, true);
  assert.match(paddle.elements.get("accountBillingDetail").textContent, /Paddle could not collect/);
  await paddle.elements
    .get("accountDeleteRequest")
    .emit("click", { currentTarget: paddle.elements.get("accountDeleteRequest") });
  await settle();
  assert.match(
    paddle.elements.get("accountSecurityStatus").textContent,
    /Deletion does not cancel a Paddle subscription or refund a charge\.$/,
  );
});

test("the in-app deletion dialog is labelled, asks for the current password, and types DELETE without autocorrect", () => {
  assert.match(
    html,
    /<dialog class="account-delete-dialog" id="accountDeleteDialog" aria-labelledby="accountDeleteTitle" aria-describedby="accountDeleteLede">/,
  );
  assert.match(
    html,
    /<label for="accountDeletePassword">[^<]+<\/label>\s*<input id="accountDeletePassword" name="password" type="password" autocomplete="current-password"/,
  );
  assert.match(
    html,
    /<label for="accountDeleteConfirmation">Type DELETE to confirm<\/label>\s*<input id="accountDeleteConfirmation"[^>]*autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"/,
  );
  assert.match(
    html,
    /<p class="account-delete-error" id="accountDeleteError" role="alert" aria-live="assertive"><\/p>/,
  );
  assert.match(
    html,
    /<button class="account-delete-submit" id="accountDeleteSubmit" type="submit" disabled>/,
  );
  assert.match(
    html,
    /<a class="account-delete-manage" id="accountDeleteManage" href="https:\/\/apps\.apple\.com\/account\/subscriptions"/,
  );
});

test("in the app, Delete account deletes the account in a dialog with the password and DELETE, and never sends an email", async () => {
  const calls = [],
    attempts = [],
    user = memberFixture({
      discovery: {
        active: true,
        accessType: "apple",
        pendingPurchaseCount: 0,
        apple: APPLE_ACTIVE,
        subscription: null,
      },
    }),
    base = accountRoutes(user);
  const page = createPage({
    app: {
      plugin: {
        manageSubscriptions: async () => {
          calls.push("manage");
          return {};
        },
      },
    },
    route: async (path, options) => {
      if (path !== "/api/account/delete/now") return base(path);
      const body = JSON.parse(options.body);
      attempts.push({ body, headers: options.headers });
      if (body.password !== "right-password-123")
        return jsonResponse(401, {
          error: "That password is incorrect.",
          code: "PASSWORD_INCORRECT",
        });
      return jsonResponse(200, {
        ok: true,
        message: `Your STRATA account was permanently deleted. ${APPLE_DELETION.message}`,
        appleBilling: APPLE_DELETION,
      });
    },
  });
  await settle();
  const el = (id) => page.elements.get(id);
  await el("accountDeleteRequest").emit("click", { currentTarget: el("accountDeleteRequest") });
  await settle();
  assert.equal(el("accountDeleteDialog").open, true);
  assert.equal(
    el("accountDeleteTitle").focused,
    true,
    "VoiceOver starts at the dialog's title and explanation",
  );
  assert.equal(
    el("accountDeleteApple").hidden,
    false,
    "an App Store subscriber is told Apple keeps billing",
  );
  assert.equal(el("accountDeleteSubmit").disabled, true);
  await el("accountDeleteManage").emit("click", { preventDefault() {} });
  await settle();
  assert.deepEqual(
    calls,
    ["manage"],
    "Manage subscription opens Apple's own sheet from the dialog",
  );

  el("accountDeletePassword").value = "wrong-password-1";
  await el("accountDeletePassword").emit("input");
  el("accountDeleteConfirmation").value = "delete";
  await el("accountDeleteConfirmation").emit("input");
  assert.equal(
    el("accountDeleteSubmit").disabled,
    true,
    "only DELETE, exactly, enables the button",
  );
  el("accountDeleteConfirmation").value = "DELETE";
  await el("accountDeleteConfirmation").emit("input");
  assert.equal(el("accountDeleteSubmit").disabled, false);
  await el("accountDeleteForm").emit("submit", { preventDefault() {} });
  await settle();
  assert.deepEqual(attempts[0].body, { password: "wrong-password-1", confirmation: "DELETE" });
  assert.equal(attempts[0].headers["X-CSRF-Token"], "app-csrf");
  assert.equal(attempts[0].headers["X-Strata-User"], "member-1");
  assert.equal(el("accountDeleteError").textContent, "That password is incorrect.");
  assert.equal(el("accountDeletePassword").value, "");
  assert.equal(el("accountDeletePassword").getAttribute("aria-invalid"), "true");
  assert.equal(el("accountDeletePassword").getAttribute("aria-describedby"), "accountDeleteError");
  assert.equal(el("accountDeletePassword").focused, true);
  assert.equal(el("accountDeleteDialog").open, true);
  assert.equal(el("accountDeleteSubmit").disabled, true);
  assert.deepEqual(page.navigations, []);

  el("accountDeletePassword").value = "right-password-123";
  await el("accountDeletePassword").emit("input");
  assert.equal(el("accountDeleteError").textContent, "", "typing clears the error");
  await el("accountDeleteForm").emit("submit", { preventDefault() {} });
  await settle();
  assert.equal(el("accountDeleteForm").hidden, true);
  assert.equal(el("accountDeleteDone").hidden, false);
  assert.equal(el("accountDeleteDone").focused, true);
  assert.match(
    el("accountDeleteDoneMessage").textContent,
    /^Your STRATA account was permanently deleted\. .*Apple keeps billing your Apple Account/,
  );
  assert.equal(el("accountDeleteDoneManage").hidden, false);
  assert.equal(el("accountDeleteDoneManage").href, "https://apps.apple.com/account/subscriptions");
  assert.equal(el("accountDeletePassword").value, "");
  assert.equal(el("signedInCard").hidden, true, "the deleted account's details leave the page");
  await el("accountDeleteDoneContinue").emit("click");
  el("accountDeleteDialog").close();
  await settle();
  assert.deepEqual(page.navigations, ["/"], "leaves for the signed-out start screen once");
  assert.ok(
    !page.requests.some(({ path }) => path === "/api/account/delete/request"),
    "no email is sent",
  );
});

test("in the app, an account made with Google deletes with DELETE alone and says when to sign in again", async () => {
  const attempts = [],
    user = memberFixture({ signIn: { hasPassword: false, providers: ["google"] } }),
    base = accountRoutes(user);
  let fresh = false;
  const page = createPage({
    app: { plugin: {} },
    route: async (path, options) => {
      if (path !== "/api/account/delete/now") return base(path);
      attempts.push(JSON.parse(options.body));
      return fresh
        ? jsonResponse(200, { ok: true, message: "Your STRATA account was permanently deleted." })
        : jsonResponse(401, { error: "Sign in again.", code: "RECENT_SIGN_IN_REQUIRED" });
    },
  });
  await settle();
  const el = (id) => page.elements.get(id);
  assert.equal(el("accountSignInMethods").textContent, "Signs in with Google.");
  assert.equal(el("accountSignInMethods").hidden, false);
  await el("accountDeleteRequest").emit("click", { currentTarget: el("accountDeleteRequest") });
  await settle();
  assert.equal(el("accountDeletePassword").hidden, true, "there is no STRATA password to ask for");
  assert.equal(el("accountDeleteRecentNote").hidden, false);
  el("accountDeleteConfirmation").value = "DELETE";
  await el("accountDeleteConfirmation").emit("input");
  assert.equal(el("accountDeleteSubmit").disabled, false, "DELETE alone enables the button");
  await el("accountDeleteForm").emit("submit", { preventDefault() {} });
  await settle();
  assert.deepEqual(attempts[0], { confirmation: "DELETE" });
  assert.match(el("accountDeleteError").textContent, /sign out and sign in again with Google/);
  fresh = true;
  await el("accountDeleteForm").emit("submit", { preventDefault() {} });
  await settle();
  assert.equal(el("accountDeleteDone").hidden, false);
});

test("the deletion dialog closes with Escape or Cancel without deleting, holds while deleting, and browsers keep the emailed link", async () => {
  const user = memberFixture(),
    pending = deferred();
  const page = createPage({
    app: { plugin: {} },
    route: async (path) =>
      path === "/api/account/delete/now" ? pending.promise : accountRoutes(user)(path),
  });
  await settle();
  const el = (id) => page.elements.get(id);
  await el("accountDeleteRequest").emit("click", { currentTarget: el("accountDeleteRequest") });
  assert.equal(el("accountDeleteApple").hidden, true, "no App Store subscription, no Apple note");
  el("accountDeletePassword").value = "typed-password";
  el("accountDeleteConfirmation").value = "DELETE";
  let prevented = false;
  await el("accountDeleteDialog").emit("cancel", {
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false, "Escape closes the dialog");
  el("accountDeleteDialog").close();
  await settle();
  assert.equal(el("accountDeletePassword").value, "", "the password does not stay on the page");
  assert.equal(el("accountDeleteRequest").focused, true, "focus returns to Delete account");
  await el("accountDeleteRequest").emit("click", { currentTarget: el("accountDeleteRequest") });
  await el("accountDeleteDismiss").emit("click");
  assert.equal(el("accountDeleteDialog").open, false);
  assert.ok(
    !page.requests.some(({ path }) => path.startsWith("/api/account/delete/")),
    "nothing was requested",
  );

  await el("accountDeleteRequest").emit("click", { currentTarget: el("accountDeleteRequest") });
  el("accountDeletePassword").value = "typed-password";
  el("accountDeleteConfirmation").value = "DELETE";
  await el("accountDeleteConfirmation").emit("input");
  const submitted = el("accountDeleteForm").emit("submit", { preventDefault() {} });
  await settle();
  assert.equal(el("accountDeleteSubmit").dataset.busy, "true");
  assert.equal(el("accountDeleteSubmit").disabled, true);
  prevented = false;
  await el("accountDeleteDialog").emit("cancel", {
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true, "Escape waits for the answer");
  await el("accountDeleteDismiss").emit("click");
  assert.equal(el("accountDeleteDialog").open, true);
  el("accountDeleteDialog").close();
  await settle();
  assert.equal(
    el("accountDeletePassword").value,
    "typed-password",
    "a web view that still forces the dialog closed mid-request keeps the form",
  );
  pending.resolve(
    jsonResponse(409, {
      error:
        "Your Strata+ monthly subscription has not ended. Cancel it from subscription management first. Nothing was deleted.",
      code: "SUBSCRIPTION_ACTIVE",
    }),
  );
  await submitted;
  await settle();
  assert.equal(el("accountDeleteDialog").open, true, "the outcome is shown again");
  assert.equal(
    el("accountDeleteError").textContent,
    "Your Strata+ monthly subscription has not ended. Cancel it from subscription management first. Nothing was deleted.",
  );
  assert.equal(
    el("accountDeletePassword").value,
    "typed-password",
    "a refusal that is not about the password keeps it",
  );
  assert.equal(el("accountDeleteSubmit").dataset.busy, undefined);
  assert.equal(el("accountDeleteSubmit").disabled, false);
  assert.deepEqual(page.navigations, []);

  const browser = createPage({ route: accountRoutes(user) });
  await settle();
  await browser.elements
    .get("accountDeleteRequest")
    .emit("click", { currentTarget: browser.elements.get("accountDeleteRequest") });
  await settle();
  assert.notEqual(
    browser.elements.get("accountDeleteDialog").open,
    true,
    "browsers never open the in-app dialog",
  );
  assert.deepEqual(
    browser.requests
      .filter(({ path }) => path.startsWith("/api/account/delete/"))
      .map(({ path }) => path),
    ["/api/account/delete/request"],
  );
  assert.match(
    browser.elements.get("accountSecurityStatus").textContent,
    /^A deletion confirmation link was sent to a\*\*\*@example\.test\./,
  );
});

test("the tab says Sign in to a visitor and Profile once an account is open", async () => {
  const visitor = createPage({
    route: async (path) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") return jsonResponse(401, { error: "Not signed in." });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  assert.equal(visitor.document.title, "Sign in — STRATA");
  assert.match(
    html,
    /<title>Sign in — STRATA<\/title>/,
    "the page is titled Sign in before any script runs",
  );

  const user = memberFixture({
    discovery: { active: false, accessType: null, pendingPurchaseCount: 0 },
  });
  const member = createPage({
    route: async (path) => {
      if (path === "/api/status") return jsonResponse(200, { persistent: true });
      if (path === "/healthz") return jsonResponse(200, { ok: true });
      if (path === "/api/me") return jsonResponse(200, { csrfToken: "csrf-title", user });
      if (path === "/api/plan")
        return jsonResponse(200, {
          csrfToken: "csrf-title",
          user,
          plan: planFixture(),
          planUpdatedAt: 0,
        });
      if (path === "/api/account/sessions")
        return jsonResponse(200, { userId: user.id, sessions: [], otherCount: 0 });
      throw new Error(`Unexpected route ${path}`);
    },
  });
  await settle();
  assert.equal(member.document.title, "Profile — STRATA");
});
