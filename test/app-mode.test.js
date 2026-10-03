"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadHtml } = require("./support/browser-html");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const SOURCE = read("public/scripts/app-mode.js");
const CSS = read("public/styles/app-mode.css");

function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

// A page realm with only what app-mode.js touches: enough DOM to watch the chrome appear and react.
function fakeNode(name) {
  const node = {
    name,
    dataset: {},
    attributes: {},
    listeners: {},
    html: [],
    children: [],
    textContent: "",
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value);
    },
    getAttribute(key) {
      return this.attributes[key] ?? null;
    },
    insertAdjacentHTML(position, html) {
      this.html.push({ position, html });
    },
    append(child) {
      this.children.push(child);
    },
    querySelector(selector) {
      return (this.nodes ||= {})[selector] || null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return node;
}

function realm({
  pathname = "/",
  hash = "",
  search = "",
  signedIn = false,
  plugin = null,
  readyState = "loading",
  referrer = "",
  historyLength = 1,
  navigationType = "navigate",
  storage = memoryStorage(),
} = {}) {
  const listeners = {},
    documentListeners = {},
    observers = [],
    replaced = [],
    scrolled = [],
    calls = [];
  const html = { dataset: {} },
    head = fakeNode("head"),
    main = fakeNode("main");
  const document = {
    readyState,
    documentElement: html,
    body: null,
    head,
    referrer,
    addEventListener(type, handler) {
      (documentListeners[type] ||= []).push(handler);
    },
    getElementById(id) {
      return id === "accountButton"
        ? { classList: { contains: (name) => name === "signed-in" && signedIn } }
        : null;
    },
    querySelector(selector) {
      return selector === "main" ? main : null;
    },
    createElement(tag) {
      return fakeNode(tag);
    },
  };
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const location = {
    pathname,
    hash,
    search,
    origin: "https://stratafitness.online",
    replace: (url) => replaced.push(url),
  };
  const window = {
    document,
    location,
    MutationObserver,
    URL,
    URLSearchParams,
    sessionStorage: storage,
    StrataApp: Object.freeze({ platform: "ios", shellVersion: 1 }),
    history: { length: historyLength, back: () => calls.push(["history.back"]) },
    navigation: {
      activation: { navigationType: navigationType === "back_forward" ? "traverse" : "push" },
    },
    performance: { getEntriesByType: () => [{ type: navigationType }] },
    matchMedia: () => ({ matches: false }),
    scrollTo: (options) => scrolled.push(options),
    setTimeout: () => {
      calls.push(["setTimeout"]);
      return 0;
    },
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    dispatchEvent() {},
    CustomEvent: class {},
    fetch: async () => jsonResponse(401, {}),
    Capacitor: plugin
      ? {
          Plugins: { StrataNative: plugin },
          addListener: (name, event, callback) => {
            calls.push(["addListener", name, event]);
            window.transactionUpdated = callback;
            return { remove() {} };
          },
        }
      : undefined,
  };
  window.globalThis = window;
  vm.createContext(window);
  loadHtml(window);
  vm.runInContext(SOURCE, window, { filename: "app-mode.js" });
  return {
    window,
    document,
    html,
    main,
    observers,
    replaced,
    scrolled,
    calls,
    listeners,
    storage,
    insertBody() {
      const body = fakeNode("body");
      body.tabBar = fakeNode("tabbar");
      body.title = fakeNode("title");
      body.back = fakeNode("back");
      const nodes = {
        ".app-tabbar": body.tabBar,
        "[data-app-title]": body.title,
        "[data-app-status]": fakeNode("status"),
      };
      // Like the real DOM, Back only exists when the drawn top bar has one.
      body.querySelector = (selector) =>
        selector === "[data-app-back]"
          ? body.html.some((entry) => entry.html.includes("data-app-back"))
            ? body.back
            : null
          : nodes[selector] || null;
      document.body = body;
      for (const observer of observers) if (!observer.disconnected) observer.callback([]);
      return { body, chrome: body.html.map((entry) => entry.html).join("") };
    },
    ready() {
      document.readyState = "interactive";
      for (const handler of documentListeners.DOMContentLoaded || []) handler();
    },
    emit(type, event) {
      for (const handler of listeners[type] || []) handler(event);
    },
  };
}

test("screens map every page to its tab, title, and Back target", () => {
  const { window } = realm();
  const { resolveScreen } = window.StrataAppMode;
  const pick = (location) => {
    const screen = resolveScreen(location);
    return [screen.id, screen.tab, screen.title, screen.parent, screen.chrome];
  };
  assert.deepEqual(pick({ pathname: "/dashboard" }), [
    "dashboard",
    "dashboard",
    "Dashboard",
    "",
    "tabs",
  ]);
  assert.deepEqual(pick({ pathname: "/workout.html" }), ["train", "train", "Train", "", "tabs"]);
  assert.deepEqual(pick({ pathname: "/account.html" }), [
    "profile",
    "profile",
    "Profile",
    "",
    "tabs",
  ]);
  assert.deepEqual(pick({ pathname: "/planner.html/" }), [
    "planner",
    "dashboard",
    "Weekly plan",
    "",
    "tabs",
  ]);
  assert.deepEqual(pick({ pathname: "/terms" }), [
    "terms",
    "profile",
    "Terms",
    "/policies",
    "tabs",
  ]);
  assert.deepEqual(
    pick({ pathname: "/pricing", search: "?reason=recovery" }),
    ["pricing", "recovery", "Strata+", "", "tabs"],
    "the Recovery tab's paywall is that tab's root",
  );
  assert.deepEqual(pick({ pathname: "/pricing", search: "?reason=ai" }), [
    "pricing",
    "dashboard",
    "Strata+",
    "/discover.html",
    "tabs",
  ]);
  assert.deepEqual(pick({ pathname: "/pricing" }), [
    "pricing",
    "profile",
    "Strata+",
    "/account.html",
    "tabs",
  ]);
  assert.deepEqual(pick({ pathname: "/discover.html", hash: "#recoveryWorkspace" }), [
    "studio",
    "recovery",
    "Recovery",
    "",
    "tabs",
  ]);
  assert.deepEqual(pick({ pathname: "/discover.html", hash: "#exerciseExplorer" }), [
    "studio",
    "rankings",
    "Rankings",
    "",
    "tabs",
  ]);
  assert.deepEqual(pick({ pathname: "/discover.html", hash: "#progressWorkspace" }), [
    "studio",
    "dashboard",
    "Strata+",
    "",
    "tabs",
  ]);
  assert.equal(resolveScreen({ pathname: "/", hash: "#rankings" }).view, "rankings");
  assert.equal(resolveScreen({ pathname: "/", hash: "#preview" }).view, "preview");
  assert.equal(resolveScreen({ pathname: "/", hash: "#top" }).view, "start");
  for (const pathname of ["/offline.html", "/workout-offline.html", "/admin"])
    assert.equal(resolveScreen({ pathname }).chrome, "none", pathname);
});

test("the tab bar marks the current section, keeps studio panels in place, and has five labelled targets", () => {
  const { window } = realm();
  const { resolveScreen, tabBarHtml, topBarHtml } = window.StrataAppMode;
  const train = String(tabBarHtml(resolveScreen({ pathname: "/workout.html" })));
  assert.equal((train.match(/class="app-tab"/g) || []).length, 5);
  assert.deepEqual(
    [...train.matchAll(/data-app-tab="(\w+)"/g)].map((match) => match[1]),
    ["rankings", "dashboard", "train", "recovery", "profile"],
  );
  assert.deepEqual(
    [...train.matchAll(/data-app-tab="(\w+)"[^>]*aria-current="page"/g)].map((match) => match[1]),
    ["train"],
  );
  assert.match(
    train,
    /href="\/rankings"[\s\S]*href="\/dashboard"[\s\S]*href="\/workout\.html"[\s\S]*href="\/recovery"[\s\S]*href="\/account\.html"/,
  );
  assert.match(train, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(train, /data-section/);
  const studio = String(
    tabBarHtml(resolveScreen({ pathname: "/discover.html", hash: "#recoveryWorkspace" })),
  );
  assert.match(studio, /href="#exerciseExplorer" data-app-tab="rankings" data-section="rankings"/);
  assert.match(
    studio,
    /href="#recoveryWorkspace" data-app-tab="recovery" data-section="recovery" aria-current="page"/,
  );
  assert.match(studio, /data-app-tab="dashboard" data-section="week"/);
  assert.match(
    String(topBarHtml(resolveScreen({ pathname: "/privacy" }))),
    /<a class="app-back" href="\/policies" data-app-back>[\s\S]*Back<\/span><\/a><p class="app-title" data-app-title>Privacy<\/p>/,
  );
  assert.doesNotMatch(String(topBarHtml(resolveScreen({ pathname: "/dashboard" }))), /app-back/);
  // 44pt+ targets, safe areas, no live blur, and the bars stay put through view transitions.
  assert.match(
    CSS,
    /\.app-tab\s*\{\s*[^}]*min-width\s*:\s*44px\s*;\s*[^}]*min-height\s*:\s*var\s*\(\s*--app-tabbar-h\s*,?\s*\)/,
  );
  assert.match(CSS, /--app-tabbar-h\s*:\s*56px\s*;/);
  assert.match(CSS, /\.app-back\s*\{\s*[^}]*min-width\s*:\s*44px\s*;\s*min-height\s*:\s*44px\s*;/);
  assert.match(
    CSS,
    /\.app-tabbar\s*\{\s*[^}]*padding\s*:\s*0\s*max\s*\(\s*4px\s*,\s*env\s*\(\s*safe-area-inset-right\s*,?\s*\)\s*,?\s*\)\s*env\s*\(\s*safe-area-inset-bottom\s*,?\s*\)/,
  );
  assert.doesNotMatch(CSS.match(/\.app-tabbar \{[^}]*\}/)[0], /backdrop-filter/);
  assert.match(
    CSS,
    /:\s*root\s*\[\s*data-app\s*=\s*"ios"\s*,?\s*\]\s*\.app-tabbar\s*\{\s*view-transition-name\s*:\s*app-tabbar\s*;\s*[;,]?\s*\}/,
  );
  assert.match(
    CSS,
    /:\s*:\s*view-transition-old\s*\(\s*app-tabbar\s*,?\s*\)\s*\{\s*display\s*:\s*none\s*;\s*[;,]?\s*\}/,
  );
});

test("the app hides website chrome, blur, and reveals, and moves with transform and opacity only", () => {
  assert.match(CSS, /@view-transition\s*\{\s*navigation\s*:\s*auto\s*;\s*[;,]?\s*\}/);
  assert.match(
    CSS,
    /:\s*root\s*\[\s*data-app-chrome\s*=\s*"tabs"\s*,?\s*\]\s*body\s*>\s*header\s*:\s*not\s*\(\.app-topbar\s*,?\s*\)\s*,\s*\n\s*:\s*root\s*\[\s*data-app-chrome\s*=\s*"tabs"\s*,?\s*\]\s*body\s*>\s*nav\s*\.mobile-public-nav\s*,\s*\n\s*:\s*root\s*\[\s*data-app\s*=\s*"ios"\s*,?\s*\]\s*body\s*>\s*footer\s*,\s*\n\s*:\s*root\s*\[\s*data-app\s*=\s*"ios"\s*,?\s*\]\s*\.skip-link\s*,\s*\n\s*:\s*root\s*\[\s*data-app\s*=\s*"ios"\s*,?\s*\]\s*\.strata-scroll-progress\s*\{\s*display\s*:\s*none\s*!\s*important\s*;\s*[;,]?\s*\}/,
  );
  assert.match(CSS, /backdrop-filter\s*:\s*none\s*!\s*important\s*;/);
  assert.match(CSS, /-webkit-tap-highlight-color\s*:\s*transparent\s*;/);
  assert.match(
    CSS,
    /:\s*root\s*\[\s*data-app\s*=\s*"ios"\s*,?\s*\]\s*:\s*is\s*\(\s*a\s*,\s*img\s*,?\s*\)\s*\{\s*-webkit-touch-callout\s*:\s*none\s*;\s*[;,]?\s*\}/,
  );
  assert.match(
    CSS,
    /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*,?\s*\)\s*\{\s*\n\s*:\s*:\s*view-transition-group\s*\(\s*\*\s*,?\s*\)\s*,\s*:\s*:\s*view-transition-old\s*\(\s*\*\s*,?\s*\)\s*,\s*:\s*:\s*view-transition-new\s*\(\s*\*\s*,?\s*\)\s*\{\s*animation\s*:\s*none\s*!\s*important\s*;\s*[;,]?\s*\}/,
  );
  const keyframes = [...CSS.matchAll(/@keyframes [\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)];
  assert.ok(keyframes.length > 0, "the app's keyframes are found");
  for (const frames of keyframes)
    assert.doesNotMatch(
      frames[1].replace(/(?:transform|opacity)\s*:[^;]*;/g, ""),
      /:/,
      `keyframes animate only transform and opacity: ${frames[0]}`,
    );
  // Text and form fields stay selectable; only controls and chrome opt out.
  const unselectable = CSS.match(
    /:root\[data-app="ios"\]\s*:is\(([^)]*(?:\([^)]*\))?[^)]*)\)\s*\{\s*-webkit-user-select:\s*none;\s*user-select:\s*none;?\s*\}/,
  )[1];
  assert.doesNotMatch(unselectable, /\b(?:input|textarea|select|p|main|body)\b/);
  assert.match(
    read("public/scripts/motion.js"),
    /if \(window\.StrataApp \|\| !window\.matchMedia/,
    "no scroll reveals or scroll progress in the app",
  );
});

test("in the app the chrome is drawn the moment <body> exists, with the current tab and title", () => {
  const page = realm({ pathname: "/workout.html" });
  assert.equal(page.html.dataset.appChrome, "tabs");
  assert.equal(page.html.dataset.appScreen, "train");
  assert.equal(page.observers.length, 1, "waits for the body before drawing");
  const { body, chrome } = page.insertBody();
  assert.equal(page.observers[0].disconnected, true);
  assert.match(
    chrome,
    /^<header class="app-topbar">[\s\S]*Train[\s\S]*<\/header><nav class="app-tabbar" aria-label="Primary navigation">/,
  );
  assert.match(chrome, /data-app-tab="train"[^>]*aria-current="page"/);
  page.ready();
  assert.deepEqual(
    body.children,
    [body.tabBar],
    "the tab bar moves after the content for screen readers",
  );
  assert.equal(page.observers.length, 1);
  const plain = realm({ pathname: "/offline.html" });
  assert.equal(plain.html.dataset.appChrome, "none");
  assert.equal(plain.observers.length, 0);
});

test("tab taps give a selection haptic, mark the transition, and scroll the current tab to the top", () => {
  const haptics = [];
  const page = realm({
    pathname: "/workout.html",
    plugin: {
      haptic: async (options) => {
        haptics.push(options.style);
      },
    },
  });
  const { body } = page.insertBody();
  const tab = (id, current) => ({
    dataset: { appTab: id },
    getAttribute: (name) =>
      name === "aria-current" ? (current ? "page" : null) : name === "href" ? `/${id}` : null,
  });
  const click = (target) => {
    let prevented = false;
    for (const handler of body.tabBar.listeners.click)
      handler({
        target: { closest: () => target },
        preventDefault: () => {
          prevented = true;
        },
      });
    return prevented;
  };
  assert.equal(click(tab("train", true)), true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.scrolled)), [{ top: 0, behavior: "smooth" }]);
  assert.equal(page.storage.values.get(page.window.StrataAppMode.NAV_KEY), undefined);
  assert.equal(click(tab("dashboard", false)), false);
  assert.equal(page.storage.values.get(page.window.StrataAppMode.NAV_KEY), "tab");
  assert.deepEqual(haptics, ["selection", "selection"]);
  // The next page reads the mark once: tab switches cross-fade, swipe-back is left to the web view.
  page.emit("pagereveal", {
    viewTransition: { skipTransition: () => assert.fail("a tab switch keeps its transition") },
  });
  assert.equal(page.html.dataset.appNav, "tab");
  let skipped = false;
  const back = realm({ pathname: "/account.html", navigationType: "back_forward" });
  back.emit("pagereveal", {
    viewTransition: {
      skipTransition: () => {
        skipped = true;
      },
    },
  });
  assert.equal(skipped, true);
  assert.equal(back.html.dataset.appNav, "push");
});

test("Back returns through history when the app came from STRATA, and to the parent screen otherwise", () => {
  const inside = realm({
    pathname: "/terms",
    referrer: "https://stratafitness.online/policies",
    historyLength: 3,
  });
  const { body } = inside.insertBody();
  let prevented = false;
  for (const handler of body.back.listeners.click)
    handler({
      preventDefault: () => {
        prevented = true;
      },
    });
  assert.equal(prevented, true);
  assert.deepEqual(inside.calls.filter((call) => call[0] === "history.back").length, 1);
  assert.equal(inside.storage.values.get(inside.window.StrataAppMode.NAV_KEY), "back");
  const cold = realm({ pathname: "/terms", referrer: "", historyLength: 1 });
  const coldBody = cold.insertBody().body;
  prevented = false;
  for (const handler of coldBody.back.listeners.click)
    handler({
      preventDefault: () => {
        prevented = true;
      },
    });
  assert.equal(prevented, false, "the link's own href, the parent screen, is followed");
});

test("the app opens members on Dashboard and everyone else on a welcome screen, never the marketing homepage", () => {
  const member = realm({ pathname: "/", signedIn: true });
  member.insertBody();
  member.ready();
  assert.deepEqual(member.replaced, ["/dashboard"]);
  assert.equal(member.storage.values.get(member.window.StrataAppMode.NAV_KEY), "tab");
  const visitor = realm({ pathname: "/" });
  visitor.insertBody();
  visitor.ready();
  assert.deepEqual(visitor.replaced, []);
  assert.equal(visitor.html.dataset.appHome, "welcome");
  assert.match(
    visitor.main.html[0].html,
    /class="app-welcome"[\s\S]*href="\/account\.html\?mode=signup"[\s\S]*href="\/account\.html\?mode=login"[\s\S]*href="\/#rankings"[\s\S]*href="\/#preview"/,
  );
  visitor.window.location.hash = "#rankings";
  visitor.emit("hashchange");
  assert.equal(visitor.html.dataset.appHome, "rankings");
  const rankings = realm({ pathname: "/", hash: "#rankings", signedIn: true });
  rankings.insertBody();
  rankings.ready();
  assert.deepEqual(rankings.replaced, [], "a member's Rankings tab stays on the rankings");
  assert.equal(rankings.html.dataset.appHome, "rankings");
  assert.match(
    CSS,
    /:\s*root\s*\[\s*data-app-screen\s*=\s*"home"\s*,?\s*\]\s*\.home-page\s*main\s*>\s*section\s*\{\s*display\s*:\s*none\s*!\s*important\s*;\s*[;,]?\s*\}/,
  );
  assert.match(CSS, /:root\[data-app-home="rankings"\] \.home-page main > #rankings/);
  assert.match(
    CSS,
    /:root:is\(\[data-app-home="start"\],\s*\[data-app-home="welcome"\]\)\s*:is\(\.app-topbar,\s*\.app-tabbar\)\s*\{\s*display:\s*none !important;?\s*\}/,
  );
});

test("Profile keeps Strata+, support, and legal pages one tap away", () => {
  const page = realm({ pathname: "/account.html" });
  page.insertBody();
  const accountPage = fakeNode("accountPage");
  page.document.getElementById = (id) => (id === "accountPage" ? accountPage : null);
  page.document.querySelector = (selector) =>
    selector === "body > footer > span" ? { textContent: "About STRATA · Build 9.6.0" } : null;
  page.ready();
  const more = accountPage.html[0].html;
  for (const href of ["/pricing", "/contact", "/policies", "/terms", "/privacy"])
    assert.match(more, new RegExp(`href="${href}"`));
  assert.match(more, /About STRATA · Build 9\.6\.0/);
});

test("on /pricing the app loads its App Store paywall, and the website never loads Paddle there", () => {
  const page = realm({ pathname: "/pricing" });
  page.insertBody();
  page.ready();
  assert.equal(page.document.head.children.length, 1);
  assert.equal(page.document.head.children[0].src, "/app-paywall.js?v=9.6.0");
  const pricing = read("public/scripts/pricing.js");
  assert.match(
    pricing,
    /\(\s*\(\s*,?\s*\)\s*=>\s*\{\s*\n\s*\/\/\s*Inside\s*the\s*iOS\s*app[^\n]*\n\s*if\s*\(\s*globalThis\s*\.StrataApp\s*,?\s*\)\s*return\s*;/,
  );
  assert.match(
    pricing,
    /function\s*loadPaddle\s*\(\s*,?\s*\)\s*\{\s*\n\s*if\s*\(\s*globalThis\s*\.StrataApp\s*,?\s*\)\s*return\s*Promise\s*\.reject/,
  );
  assert.doesNotMatch(read("public/pages/pricing.html"), /cdn\s*\.paddle\s*\.com/);
});

test("printing in the app uses the native print sheet, and a missing plugin says so", async () => {
  const printed = [];
  const page = realm({
    plugin: {
      print: async (options) => {
        printed.push(options);
        return {};
      },
    },
  });
  assert.equal(await page.window.StrataAppMode.print({ jobName: "Plan" }), true);
  assert.deepEqual(printed, [{ jobName: "Plan" }]);
  assert.equal(await realm().window.StrataAppMode.print(), false);
  assert.doesNotThrow(
    () => realm().window.StrataAppMode.haptic("success"),
    "haptics without the plugin do nothing",
  );
  assert.match(
    read("public/scripts/discover.js"),
    /if\s*\(globalThis\.StrataApp\)\s*\{\s*try\s*\{\s*if\s*\(\s*!\(?await globalThis\.StrataAppMode\?\.print\?\.\(/,
  );
  assert.match(
    read("public/scripts/workout-events.js"),
    /if\s*\(\s*set\s*\.completed\s*,?\s*\)\s*globalThis\s*\.StrataAppMode\s*\?\.haptic\s*\(\s*"light"\s*,?\s*\)/,
  );
  assert.match(
    read("public/scripts/workout-events.js"),
    /signal\s*\(\s*"workout_completed"\s*,?\s*\)\s*;\s*globalThis\s*\.StrataAppMode\s*\?\.haptic\s*\(\s*"success"\s*,?\s*\)/,
  );
});

test("native extras forward to the app when its build has them and stay neutral when it does not", async () => {
  const calls = [],
    record = (name, result) => async (options) => {
      calls.push([name, options]);
      if (result instanceof Error) throw result;
      return result;
    };
  const plugin = {
    keepAwake: record("keepAwake", {}),
    scheduleRestAlert: record("scheduleRestAlert", { scheduled: true, permission: "authorized" }),
    cancelRestAlert: record("cancelRestAlert", undefined),
    addWeeklyToCalendar: record("addWeeklyToCalendar", { added: true }),
    info: record("info", {
      appVersion: "1.2",
      build: "34",
      iosVersion: "18.0",
      canMakePayments: true,
    }),
  };
  const app = realm({ plugin }).window.StrataAppMode;
  assert.equal(app.has("keepAwake"), true);
  assert.equal(app.has("print"), false);
  assert.equal(app.has("toString"), false);
  assert.equal(await app.keepAwake(true), true);
  assert.equal(await app.keepAwake("yes"), true);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        await app.scheduleRestAlert({
          endsAt: "1800000090000",
          title: "Rest is over",
          body: "Time for your next set.",
        }),
      ),
    ),
    { scheduled: true, permission: "authorized" },
  );
  assert.equal(
    await app.cancelRestAlert(),
    true,
    "a method that resolves with nothing still counts as done",
  );
  const options = {
    title: "STRATA workout",
    notes: "Planned days: Monday",
    weekdays: [2],
    hour: 18,
    minute: 0,
    durationMinutes: 60,
    alarmMinutesBefore: null,
  };
  assert.equal((await app.addWeeklyToCalendar(options)).added, true);
  assert.equal((await app.info()).appVersion, "1.2");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["keepAwake", { enabled: true }],
    ["keepAwake", { enabled: false }],
    [
      "scheduleRestAlert",
      { endsAt: 1800000090000, title: "Rest is over", body: "Time for your next set." },
    ],
    ["cancelRestAlert", {}],
    ["addWeeklyToCalendar", options],
    ["info", {}],
  ]);

  // A native refusal: the niceties shrug it off, the calendar sheet reports it so the page can fall back to .ics.
  const refused = new Error("permission_denied"),
    failing = realm({
      plugin: {
        keepAwake: record("keepAwake", refused),
        scheduleRestAlert: record("scheduleRestAlert", refused),
        cancelRestAlert: () => {
          throw refused;
        },
        info: record("info", refused),
        addWeeklyToCalendar: record("addWeeklyToCalendar", refused),
      },
    }).window.StrataAppMode;
  assert.equal(await failing.keepAwake(true), false);
  assert.equal(await failing.scheduleRestAlert({ endsAt: 1 }), null);
  assert.equal(await failing.cancelRestAlert(), false);
  assert.equal(await failing.info(), null);
  await assert.rejects(failing.addWeeklyToCalendar(options), /permission_denied/);

  // An older app build (no such methods) and a page with no plugin at all resolve to neutral results.
  for (const older of [
    realm({ plugin: { haptic: async () => ({}) } }).window.StrataAppMode,
    realm().window.StrataAppMode,
  ]) {
    assert.equal(older.has("addWeeklyToCalendar"), false);
    assert.equal(await older.keepAwake(true), false);
    assert.equal(await older.scheduleRestAlert({ endsAt: Date.now() + 60_000 }), null);
    assert.equal(await older.cancelRestAlert(), false);
    assert.equal(await older.addWeeklyToCalendar(options), null);
    assert.equal(await older.info(), null);
  }
});

test("the workout bridge calls the app only when the wanted screen and rest-alert state changes", async () => {
  const calls = [],
    plugin = Object.fromEntries(
      ["keepAwake", "scheduleRestAlert", "cancelRestAlert"].map((name) => [
        name,
        async (options) => {
          calls.push([name, options]);
          return {};
        },
      ]),
    );
  const bridge = realm({ plugin }).window.StrataAppMode.createWorkoutBridge({
    title: "Rest is over",
    body: "Time for your next set.",
  });
  const now = 1_800_000_000_000,
    step = (state) => {
      bridge.sync({ now, ...state });
      return JSON.parse(JSON.stringify(calls.splice(0)));
    };
  assert.deepEqual(step({}), [], "nothing is asked for before a workout opens");
  assert.deepEqual(step({ keepAwake: true }), [["keepAwake", { enabled: true }]]);
  assert.deepEqual(step({ keepAwake: true }), [], "repeated reports change nothing");
  assert.deepEqual(step({ keepAwake: true, restEndsAt: now + 90_000 }), [
    [
      "scheduleRestAlert",
      { endsAt: now + 90_000, title: "Rest is over", body: "Time for your next set." },
    ],
  ]);
  assert.deepEqual(step({ keepAwake: true, restEndsAt: now + 90_000 }), []);
  assert.deepEqual(
    step({ keepAwake: true, restEndsAt: now + 60_000 }),
    [
      [
        "scheduleRestAlert",
        { endsAt: now + 60_000, title: "Rest is over", body: "Time for your next set." },
      ],
    ],
    "a new rest replaces the alert",
  );
  assert.deepEqual(
    step({ keepAwake: true, restEndsAt: null }),
    [["cancelRestAlert", {}]],
    "pausing or resetting cancels it",
  );
  assert.deepEqual(step({ keepAwake: true, restEndsAt: null }), []);
  step({ keepAwake: true, restEndsAt: now + 1000 });
  assert.deepEqual(
    step({ keepAwake: true, restEndsAt: now + 1000, now: now + 1000 }),
    [],
    "a rest that ran out keeps its alert, which fires (or was delivered) on its own",
  );
  assert.deepEqual(step({ keepAwake: true, restEndsAt: now - 5000 }), []);
  step({ keepAwake: true, restEndsAt: now + 30_000 });
  assert.deepEqual(
    step({ keepAwake: false, restEndsAt: now + 30_000 }),
    [["keepAwake", { enabled: false }]],
    "a hidden page lets the screen sleep but keeps the alert for the background",
  );
  assert.deepEqual(
    step({ keepAwake: false, restEndsAt: 0 }),
    [["cancelRestAlert", {}]],
    "a finished workout cancels the alert",
  );
  step({ keepAwake: true, restEndsAt: now + 30_000 });
  assert.deepEqual(
    step({ keepAwake: true, restEndsAt: now - 1 }),
    [["cancelRestAlert", {}]],
    "a different, already-past rest is a replaced rest",
  );
  // The app lets the screen sleep in the background; the first report after the page was suspended asks again.
  bridge.sync({ now, keepAwake: true });
  calls.splice(0);
  bridge.sync({ now: now + 1000, keepAwake: true });
  assert.deepEqual(calls.splice(0), [], "steady reports stay quiet");
  bridge.sync({ now: now + 61_000, keepAwake: true });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.splice(0))), [["keepAwake", { enabled: true }]]);
  bridge.sync({ now: now + 200_000, keepAwake: false });
  bridge.sync({ now: now + 400_000, keepAwake: false });
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.splice(0))),
    [["keepAwake", { enabled: false }]],
    "a sleeping screen is never re-asked",
  );
  assert.doesNotThrow(
    () =>
      realm()
        .window.StrataAppMode.createWorkoutBridge()
        .sync({ keepAwake: true, restEndsAt: Date.now() + 60_000 }),
    "an app build without the plugin ignores the bridge",
  );
});

test("Profile names the app build when the app can say", async () => {
  const page = realm({
    pathname: "/account.html",
    plugin: {
      info: async () => ({
        appVersion: "1.2",
        build: "34",
        iosVersion: "18.0",
        canMakePayments: true,
      }),
    },
  });
  page.insertBody();
  const accountPage = fakeNode("accountPage"),
    line = { textContent: "About STRATA · Build 9.6.0" };
  page.document.getElementById = (id) => (id === "accountPage" ? accountPage : null);
  page.document.querySelector = (selector) =>
    selector === "body > footer > span"
      ? { textContent: "About STRATA · Build 9.6.0" }
      : selector === ".app-more-build"
        ? line
        : null;
  page.ready();
  for (let index = 0; index < 5; index += 1) await new Promise(setImmediate);
  assert.equal(line.textContent, "About STRATA · Build 9.6.0 · App 1.2 (34)");
});

test("downloads keep their file for a minute, so the app's share sheet can still read it, and the app says where it goes", () => {
  const files = [
    "account.js",
    "workout.js",
    "workout-offline.js",
    "discover.js",
    "planner.js",
    "onboarding.js",
  ].map((file) => [file, read(`public/scripts/${file}`)]);
  for (const [file, source] of files) {
    const revokes = [...source.matchAll(/revokeObjectURL\(([^)]*)\)/g)];
    assert.ok(revokes.length > 0, `${file} creates a download`);
    for (const match of revokes) {
      const at = source.lastIndexOf("setTimeout(", match.index),
        delay = /^setTimeout\(\(\)\s*=>\s*URL\.revokeObjectURL\([^)]*\),\s*(\d[\d_]*)\)/.exec(
          source.slice(at),
        );
      assert.ok(
        delay && Number(delay[1].replaceAll("_", "")) >= 60_000,
        `${file} revokes a download URL after at least a minute: ${source.slice(at, match.index + 40)}`,
      );
    }
  }
  const copy = Object.fromEntries(files);
  assert.match(
    copy["account.js"],
    /globalThis\s*\.StrataApp\s*\?\s*"Your\s*JSON\s*export\s*is\s*ready\.\s*Choose\s*where\s*to\s*save\s*it\."\s*:\s*"Your\s*JSON\s*export\s*was\s*downloaded\."/,
  );
  assert.match(
    copy["planner.js"],
    /globalThis\s*\.StrataApp\s*\?\s*"Weekly\s*plan\s*ready\.\s*Choose\s*where\s*to\s*save\s*it\.\s*Import\s*it\s*from\s*Week\s*templates\s*or\s*in\s*Strata\s*\+\."\s*:\s*"Weekly\s*plan\s*downloaded\./,
  );
  assert.match(
    copy["discover.js"],
    /globalThis\s*\.StrataApp\s*\?\s*"Plan\s*file\s*ready\.\s*Choose\s*where\s*to\s*save\s*it\."\s*:\s*"Share\s*file\s*downloaded\."/,
  );
  assert.match(
    copy["discover.js"],
    /globalThis\s*\.StrataApp\s*\?\s*"Sharing\s*was\s*unavailable\s*,\s*so\s*your\s*plan\s*is\s*ready\s*as\s*a\s*file\.\s*Choose\s*where\s*to\s*save\s*it\."\s*:\s*"Sharing\s*was\s*unavailable\s*,\s*so\s*a\s*plan\s*file\s*was\s*downloaded\."/,
  );
  // Each "downloaded" message is the browser branch of a ternary whose app branch comes first.
  for (const [file, source] of files)
    for (const copy of source.matchAll(/was downloaded|[^"]downloaded\./g))
      assert.match(
        source.slice(Math.max(0, copy.index - 400), copy.index),
        /globalThis\.StrataApp\s*\?[^?]*$/,
        `${file}: "downloaded" copy has an app version`,
      );
});

function billingRealm({ routes, plugin = {} }) {
  const context = { URL, URLSearchParams, Capacitor: { Plugins: { StrataNative: plugin } } };
  context.globalThis = context;
  vm.createContext(context);
  loadHtml(context);
  vm.runInContext(SOURCE, context, { filename: "app-mode.js" });
  const requests = [],
    events = [],
    storage = memoryStorage();
  const billing = context.StrataAppMode.createBilling({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const route = routes.shift();
      assert.ok(route, `unexpected ${url}`);
      return route(url, options);
    },
    dispatch: (name, detail) => events.push([name, detail]),
    storage: () => storage,
  });
  return { billing, requests, events, storage, context };
}
const ME =
  (id = "5f2d0c41-8d7e-4a3f-9b61-0a2b3c4d5e6f", csrf = "csrf-1") =>
  async () =>
    jsonResponse(200, { user: { id }, csrfToken: csrf });

test("signed transactions go to STRATA with the session's CSRF token, in batches the server accepts", async () => {
  const signed = Array.from({ length: 23 }, (_, index) => `jws-${index}`);
  const { billing, requests, events } = billingRealm({
    routes: [
      ME(),
      async (url, options) => {
        assert.deepEqual(JSON.parse(options.body).signedTransactions, signed.slice(0, 20));
        return jsonResponse(200, {
          discovery: { active: true, accessType: "apple" },
          accepted: ["1", "2"],
        });
      },
      async (url, options) => {
        assert.deepEqual(JSON.parse(options.body).signedTransactions, signed.slice(20));
        return jsonResponse(200, {
          discovery: { active: true, accessType: "apple", apple: { active: true } },
          accepted: [3],
        });
      },
    ],
  });
  const result = await billing.submit([...signed, "jws-0", "", null]);
  assert.deepEqual([...result.accepted], ["1", "2", "3"]);
  assert.deepEqual(result.discovery, {
    active: true,
    accessType: "apple",
    apple: { active: true },
  });
  const post = requests[1];
  assert.equal(post.url, "/api/billing/apple/transactions");
  assert.equal(post.options.method, "POST");
  assert.equal(post.options.credentials, "same-origin");
  assert.equal(post.options.headers["X-CSRF-Token"], "csrf-1");
  assert.equal(post.options.headers["X-Strata-User"], "5f2d0c41-8d7e-4a3f-9b61-0a2b3c4d5e6f");
  assert.equal(post.options.headers["Content-Type"], "application/json");
  assert.equal(
    JSON.stringify(events),
    JSON.stringify([["strata:app-billing", { discovery: result.discovery }]]),
  );
});

test("a stale CSRF token is refreshed once, and a signed-out page sends nothing", async () => {
  const stale = billingRealm({
    routes: [
      ME("u", "old"),
      async () => jsonResponse(403, { error: "Security", code: "INVALID_CSRF" }),
      ME("u", "new"),
      async (url, options) => {
        assert.equal(options.headers["X-CSRF-Token"], "new");
        return jsonResponse(200, { discovery: null, accepted: ["9"] });
      },
    ],
  });
  assert.deepEqual([...(await stale.billing.submit(["jws"])).accepted], ["9"]);
  // A visitor's /api/me is 200 { user: null }; an older server answered 401. Both are signed out, and neither is
  // kept, so the next read asks STRATA again and sees a sign-in.
  for (const answer of [
    async () => jsonResponse(200, { user: null }),
    async () => jsonResponse(401, { error: "Not signed in." }),
  ]) {
    const signedOut = billingRealm({ routes: [answer, answer] });
    await assert.rejects(
      signedOut.billing.submit(["jws"]),
      (error) => error.code === "SIGN_IN_REQUIRED" && error.status === 401,
    );
    assert.equal(signedOut.requests.length, 1);
    assert.equal(
      JSON.stringify(await signedOut.billing.account()),
      JSON.stringify({ user: null, csrfToken: "" }),
    );
    assert.equal(signedOut.requests.length, 2);
  }
});

test("a StoreKit update is finished only after STRATA accepted it; anything else stays for StoreKit to redeliver", async () => {
  const finished = [],
    plugin = {
      finishTransaction: async ({ transactionId }) => {
        finished.push(transactionId);
        return {};
      },
    };
  const accepted = billingRealm({
    plugin,
    routes: [
      ME(),
      async () => jsonResponse(200, { discovery: { active: true }, accepted: ["700"] }),
    ],
  });
  assert.equal(
    await accepted.billing.handleUpdate({ transactionId: "700", signedTransaction: "jws-renewal" }),
    true,
  );
  assert.deepEqual(finished, ["700"]);
  for (const [name, route] of [
    [
      "mismatch",
      async () => jsonResponse(403, { error: "Other account", code: "APPLE_ACCOUNT_MISMATCH" }),
    ],
    [
      "other account",
      async () =>
        jsonResponse(409, { error: "Linked elsewhere", code: "APPLE_PURCHASE_OTHER_ACCOUNT" }),
    ],
    [
      "invalid",
      async () => jsonResponse(400, { error: "Invalid", code: "APPLE_SIGNATURE_INVALID" }),
    ],
    [
      "not listed",
      async () => jsonResponse(200, { discovery: { active: true }, accepted: ["other"] }),
    ],
    [
      "offline",
      async () => {
        throw new TypeError("Load failed");
      },
    ],
  ]) {
    const rejected = billingRealm({ plugin, routes: [ME(), route] });
    assert.equal(
      await rejected.billing.handleUpdate({ transactionId: "701", signedTransaction: "jws" }),
      false,
      name,
    );
  }
  const signedOut = billingRealm({ plugin, routes: [async () => jsonResponse(401, {})] });
  assert.equal(
    await signedOut.billing.handleUpdate({ transactionId: "702", signedTransaction: "jws" }),
    false,
  );
  assert.equal(
    await signedOut.billing.handleUpdate({ transactionId: "", signedTransaction: "jws" }),
    false,
  );
  assert.deepEqual(finished, ["700"]);
});

test("current entitlements sync once per launch for signed-in members", async () => {
  let reads = 0;
  const plugin = {
    currentEntitlements: async () => {
      reads += 1;
      return { signedTransactions: ["jws-current"] };
    },
  };
  const realmOne = billingRealm({
    plugin,
    routes: [
      ME(),
      async (url, options) => {
        assert.deepEqual(JSON.parse(options.body), { signedTransactions: ["jws-current"] });
        return jsonResponse(200, { discovery: { active: true }, accepted: ["1"] });
      },
    ],
  });
  assert.equal(await realmOne.billing.syncEntitlements(), "synced");
  assert.equal(
    await realmOne.billing.syncEntitlements(),
    "skipped",
    "the launch flag stops a second sync",
  );
  assert.equal(reads, 1);
  assert.equal(realmOne.storage.values.get(realmOne.context.StrataAppMode.SYNC_KEY), "1");
  const signedOut = billingRealm({ plugin, routes: [async () => jsonResponse(401, {})] });
  assert.equal(await signedOut.billing.syncEntitlements(), "signed-out");
  assert.equal(signedOut.storage.values.size, 0, "a later signed-in page still syncs");
  const offline = billingRealm({
    plugin,
    routes: [
      ME(),
      async () => {
        throw new TypeError("offline");
      },
    ],
  });
  assert.equal(await offline.billing.syncEntitlements(), "rejected");
  assert.equal(offline.storage.values.size, 0, "a network failure retries on the next page");
  const empty = billingRealm({
    plugin: { currentEntitlements: async () => ({ signedTransactions: [] }) },
    routes: [ME()],
  });
  assert.equal(await empty.billing.syncEntitlements(), "empty");
  const oldBuild = billingRealm({ plugin: {}, routes: [] });
  assert.equal(await oldBuild.billing.syncEntitlements(), "skipped");
});

test("on every page in the app, transaction updates are posted and finished, and entitlements sync after load", async () => {
  const finished = [];
  const page = realm({
    pathname: "/dashboard",
    readyState: "loading",
    plugin: {
      finishTransaction: async ({ transactionId }) => {
        finished.push(transactionId);
        return {};
      },
      currentEntitlements: async () => ({ signedTransactions: [] }),
    },
  });
  const posts = [];
  page.window.fetch = async (url, options) => {
    if (url === "/api/me") return jsonResponse(200, { user: { id: "u-1" }, csrfToken: "c" });
    posts.push(JSON.parse(options.body));
    return jsonResponse(200, { discovery: { active: true }, accepted: ["55"] });
  };
  page.insertBody();
  page.ready();
  assert.ok(
    page.calls.some(
      (call) =>
        call[0] === "addListener" && call[1] === "StrataNative" && call[2] === "transactionUpdated",
    ),
  );
  page.emit("load");
  assert.ok(page.calls.some((call) => call[0] === "setTimeout"));
  page.window.transactionUpdated({ transactionId: "55", signedTransaction: "jws-55" });
  for (let index = 0; index < 10; index += 1) await new Promise(setImmediate);
  assert.deepEqual(posts, [{ signedTransactions: ["jws-55"] }]);
  assert.deepEqual(finished, ["55"]);
});
