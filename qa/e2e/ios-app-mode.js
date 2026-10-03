"use strict";
/* global document, getComputedStyle, innerHeight, innerWidth, PageTransitionEvent, window */

// The website inside the STRATA iOS app: a phone-sized page whose user agent carries "StrataApp/1" and whose
// StrataNative plugin is a recorded mock. Browsers without the token must render and request exactly what they did.
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { extname, join, resolve } = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const ROOT = join(__dirname, "..", ".."),
  ORIGIN = "http://strata-app.test";
const APP_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 StrataApp/1";
const ALIASES = new Map([
  ["/", "index.html"],
  ["/pricing", "pricing.html"],
  ["/dashboard", "dashboard.html"],
  ["/policies", "policies.html"],
  ["/terms", "terms.html"],
  ["/privacy", "privacy.html"],
  ["/contact", "contact.html"],
]);
const USER_ID = "3c9a2f1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const APPLE = {
  active: true,
  productId: "online.stratafitness.app.plus.monthly",
  expiresAt: Date.parse("2026-11-01T12:00:00Z"),
  autoRenew: true,
  inGracePeriod: false,
  environment: "Sandbox",
  revoked: false,
};
const CATALOG = JSON.parse(readFileSync(join(ROOT, "public/data/exercises.json"), "utf8"));
let browser;

function staticAsset(pathname) {
  if (pathname.includes("..")) return null;
  if (pathname === "/exercises.json") return join(ROOT, "public/data/exercises.json");
  if (ALIASES.has(pathname)) return join(ROOT, "public/pages", ALIASES.get(pathname));
  const relative = pathname.replace(/^\//, ""),
    extension = extname(relative),
    folder =
      extension === ".html"
        ? "pages"
        : extension === ".js"
          ? "scripts"
          : extension === ".css"
            ? "styles"
            : "";
  return (
    [
      join(ROOT, "public", relative),
      ...(folder ? [join(ROOT, "public", folder, relative)] : []),
    ].find((candidate) => existsSync(candidate)) || null
  );
}

// Mirrors StrataNative's contract (getProducts, purchase, finishTransaction, restore, currentEntitlements, haptic,
// manageSubscriptions, print, keepAwake, scheduleRestAlert, cancelRestAlert, addWeeklyToCalendar, info,
// transactionUpdated) and records every call on window.__nativeCalls. Setting window.__calendarRefuses makes the
// Calendar sheet reject, as a build without calendar access would.
function installNativeMock() {
  const calls = [];
  window.__nativeCalls = calls;
  const record = (name, result) => async (options) => {
    calls.push([name, options ?? null]);
    return typeof result === "function" ? result(options) : result;
  };
  window.Capacitor = {
    addListener: (plugin, event) => {
      calls.push(["addListener", `${plugin}.${event}`]);
      return { remove: async () => {} };
    },
    Plugins: {
      StrataNative: {
        getProducts: record("getProducts", {
          products: [
            {
              id: "online.stratafitness.app.plus.monthly",
              displayName: "Strata+",
              description: "Monthly",
              displayPrice: "$4.99",
              price: "4.99",
              currencyCode: "USD",
              period: { unit: "month", value: 1 },
            },
          ],
        }),
        purchase: record("purchase", {
          status: "purchased",
          transactionId: "2000000555",
          signedTransaction: "header.payload.signature",
        }),
        finishTransaction: record("finishTransaction", {}),
        restore: record("restore", { signedTransactions: [] }),
        currentEntitlements: record("currentEntitlements", { signedTransactions: [] }),
        manageSubscriptions: record("manageSubscriptions", {}),
        haptic: record("haptic", {}),
        print: record("print", {}),
        keepAwake: record("keepAwake", {}),
        scheduleRestAlert: record("scheduleRestAlert", {
          scheduled: true,
          permission: "authorized",
        }),
        cancelRestAlert: record("cancelRestAlert", {}),
        addWeeklyToCalendar: record("addWeeklyToCalendar", () => {
          if (window.__calendarRefuses)
            throw Object.assign(new Error("Calendar access was denied."), {
              code: "permission_denied",
            });
          return { added: true };
        }),
        info: record("info", {
          appVersion: "1.0",
          build: "1",
          iosVersion: "18.0",
          canMakePayments: true,
        }),
      },
    },
  };
}

async function fixture(
  t,
  {
    app = true,
    signedIn = false,
    discovery = { active: false, accessType: null, apple: null },
    api = null,
  } = {},
) {
  const context = await browser.newContext({
    baseURL: ORIGIN,
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
    ...(app ? { userAgent: APP_UA } : {}),
  });
  t.after(() => context.close());
  context.setDefaultTimeout(10_000);
  if (app) await context.addInitScript(installNativeMock);
  const state = {
    requests: [],
    external: [],
    posts: [],
    errors: [],
    user: signedIn
      ? {
          id: USER_ID,
          name: "Ada Lovelace",
          email: "ada@example.test",
          createdAt: 1704067200000,
          planCount: 1,
          workoutDays: 1,
          discovery,
          capabilities: null,
          accountDeletion: { pending: false },
        }
      : null,
  };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    state.requests.push(url.pathname);
    if (url.origin !== ORIGIN) {
      state.external.push(url.href);
      await route.abort();
      return;
    }
    const json = (value, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/me")
      return state.user
        ? json({ user: state.user, csrfToken: "journey-csrf" })
        : json({ user: null });
    if (url.pathname === "/api/billing/apple/transactions") {
      state.posts.push({
        body: request.postDataJSON(),
        csrf: request.headers()["x-csrf-token"],
        user: request.headers()["x-strata-user"],
      });
      state.user = {
        ...state.user,
        discovery: { active: true, accessType: "apple", apple: APPLE },
      };
      return json({ discovery: state.user.discovery, accepted: ["2000000555"] });
    }
    // A journey's own API answers ({body, status}) come first; anything it leaves is outside the journey.
    const reply = api && url.pathname.startsWith("/api/") ? await api(url, request) : null;
    if (reply) return json(reply.body, reply.status || 200);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not in this journey." }, 404);
    const file = staticAsset(url.pathname);
    if (!file) {
      await route.fulfill({ status: 404, body: "Missing fixture asset" });
      return;
    }
    // The server marks a signed-in homepage's account button; do the same here.
    if (url.pathname === "/" && state.user)
      return route.fulfill({
        contentType: "text/html",
        body: readFileSync(file, "utf8").replace(
          'class="account-button account-link" id="accountButton"',
          'class="account-button account-link signed-in" id="accountButton"',
        ),
      });
    await route.fulfill({ path: file });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => state.errors.push(error.message));
  return { page, state };
}

const layout = () => {
  const visible = (selector) =>
    [...document.querySelectorAll(selector)].some((node) => {
      const style = getComputedStyle(node),
        box = node.getBoundingClientRect();
      return (
        style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0
      );
    });
  const bar = document.querySelector(".app-tabbar"),
    tabs = [...document.querySelectorAll(".app-tab")].map((tab) => {
      const box = tab.getBoundingClientRect();
      return {
        id: tab.dataset.appTab,
        current: tab.getAttribute("aria-current"),
        width: box.width,
        height: box.height,
      };
    });
  return {
    app: document.documentElement.dataset.app || null,
    chrome: document.documentElement.dataset.appChrome || null,
    home: document.documentElement.dataset.appHome || null,
    title: document.querySelector("[data-app-title]")?.textContent || null,
    back: visible(".app-back"),
    tabBar: bar ? visible(".app-tabbar") : false,
    tabBarBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
    viewport: innerHeight,
    tabs,
    tabBarTransition: bar ? getComputedStyle(bar).viewTransitionName : null,
    lastChild: document.body.lastElementChild?.className || null,
    websiteHeader: visible("body > header:not(.app-topbar)"),
    footer: visible("body > footer"),
    mobileNav: visible(".mobile-public-nav"),
    skip: visible(".skip-link"),
    overflow: document.documentElement.scrollWidth - innerWidth,
  };
};

test(
  "inside the app a phone gets one top bar, one tab bar, and no website chrome",
  { timeout: 40_000 },
  async (t) => {
    const { page, state } = await fixture(t);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator(".app-welcome").waitFor({ state: "visible" });
    let view = await page.evaluate(layout);
    assert.equal(view.app, "ios");
    assert.equal(view.home, "welcome");
    assert.equal(view.tabBar, false, "the welcome screen stands alone");
    assert.equal(view.websiteHeader, false);
    assert.equal(view.footer, false);
    assert.equal(view.mobileNav, false);
    assert.equal(await page.locator(".hero").isHidden(), true, "no marketing homepage in the app");
    for (const name of ["Create account", "Sign in"])
      assert.equal(await page.getByRole("link", { name, exact: true }).isVisible(), true, name);

    await page.getByRole("link", { name: /Explore the exercise rankings/ }).click();
    await page.waitForFunction(() => document.documentElement.dataset.appHome === "rankings");
    view = await page.evaluate(layout);
    assert.equal(view.title, "Rankings");
    assert.equal(view.tabBar, true);
    assert.equal(view.back, false);
    assert.deepEqual(
      view.tabs.map((tab) => tab.id),
      ["rankings", "dashboard", "train", "recovery", "profile"],
    );
    assert.deepEqual(
      view.tabs.filter((tab) => tab.current === "page").map((tab) => tab.id),
      ["rankings"],
    );
    assert.ok(
      view.tabs.every((tab) => tab.width >= 44 && tab.height >= 44),
      "44pt+ tab targets",
    );
    assert.equal(view.tabBarBottom, view.viewport, "the tab bar sits on the bottom edge");
    assert.equal(view.tabBarTransition, "app-tabbar");
    assert.equal(view.lastChild, "app-tabbar", "the tab bar follows the content");
    assert.equal(view.websiteHeader, false);
    assert.equal(view.footer, false);
    assert.equal(view.skip, false);
    assert.ok(view.overflow <= 1, `no sideways scroll (${view.overflow}px)`);
    assert.equal(await page.locator("#rankings").isVisible(), true);
    assert.equal(await page.locator("#method").isHidden(), true);

    await page.goto("/terms", { waitUntil: "domcontentloaded" });
    view = await page.evaluate(layout);
    assert.equal(view.title, "Terms");
    assert.equal(view.back, true, "legal pages are child screens");
    assert.deepEqual(
      view.tabs.filter((tab) => tab.current === "page").map((tab) => tab.id),
      ["profile"],
    );
    assert.equal(view.websiteHeader, false);
    assert.equal(view.footer, false);
    await page.goto("/account.html", { waitUntil: "domcontentloaded" });
    await page.locator(".app-more").waitFor({ state: "attached" });
    for (const href of ["/pricing", "/contact", "/policies", "/terms", "/privacy"])
      assert.equal(await page.locator(`.app-more a[href="${href}"]`).count(), 1, href);
    assert.equal(await page.locator('a[href^="/install"]').count(), 0);
    assert.deepEqual(state.external, []);
    assert.deepEqual(state.errors, []);
  },
);

test("in the app a signed-in member opens on Dashboard", { timeout: 30_000 }, async (t) => {
  const { page, state } = await fixture(t, { signedIn: true });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(`${ORIGIN}/dashboard`);
  await page.locator(".app-tabbar").waitFor({ state: "visible" });
  const view = await page.evaluate(layout);
  assert.equal(view.title, "Dashboard");
  assert.deepEqual(
    view.tabs.filter((tab) => tab.current === "page").map((tab) => tab.id),
    ["dashboard"],
  );
  assert.equal(view.footer, false);
  assert.equal(view.websiteHeader, false);
  await page.locator('.app-tab[data-app-tab="dashboard"]').click();
  assert.equal(page.url(), `${ORIGIN}/dashboard`, "tapping the current tab stays put");
  const haptics = await page.evaluate(() =>
    window.__nativeCalls.filter((call) => call[0] === "haptic").map((call) => call[1].style),
  );
  assert.deepEqual(haptics, ["selection"]);
  assert.deepEqual(state.external, []);
  assert.deepEqual(state.errors, []);
});

test(
  "in the app, Strata+ is bought through the App Store and Paddle is never requested",
  { timeout: 40_000 },
  async (t) => {
    const { page, state } = await fixture(t, { signedIn: true });
    await page.goto("/pricing", { waitUntil: "domcontentloaded" });
    const subscribe = page.getByRole("button", { name: "Subscribe", exact: true });
    await subscribe.waitFor({ state: "visible" });
    assert.equal(await page.locator(".app-paywall-price").textContent(), "$4.99per month");
    for (const hidden of ["#purchasePanel", ".hero-facts", ".price-card", ".checkout-note"])
      assert.equal(await page.locator(hidden).first().isHidden(), true, hidden);
    assert.match(
      await page.locator(".app-paywall-terms").textContent(),
      /at least 24 hours before the end of the current period/,
    );
    assert.equal(await page.locator('.app-paywall-links a[href="/terms"]').isVisible(), true);
    assert.equal(await page.locator('.app-paywall-links a[href="/privacy"]').isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Restore Purchases" }).isVisible(), true);

    await subscribe.click();
    await page.getByRole("heading", { name: "You have Strata+" }).waitFor();
    assert.match(await page.locator(".app-paywall-status").textContent(), /Welcome to Strata\+/);
    assert.equal(await page.getByRole("button", { name: "Manage subscription" }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Subscribe", exact: true }).count(), 0);
    assert.deepEqual(state.posts, [
      {
        body: { signedTransactions: ["header.payload.signature"] },
        csrf: "journey-csrf",
        user: USER_ID,
      },
    ]);
    const calls = await page.evaluate(() =>
      window.__nativeCalls.map((call) =>
        call[0] === "haptic" ? `haptic:${call[1].style}` : call[0],
      ),
    );
    const order = ["purchase", "finishTransaction", "haptic:success"].map((name) =>
      calls.indexOf(name),
    );
    assert.ok(
      order.every((index) => index >= 0) && order[0] < order[1] && order[1] < order[2],
      `purchase, then finish after STRATA accepted, then haptic (${calls})`,
    );
    assert.deepEqual(
      await page.evaluate(() => window.__nativeCalls.find((call) => call[0] === "purchase")[1]),
      { productId: "online.stratafitness.app.plus.monthly", appAccountToken: USER_ID },
    );
    assert.ok(calls.includes("addListener"), "StoreKit updates are listened for");
    assert.equal(
      state.external.filter((url) => /paddle/i.test(url)).length,
      0,
      "Paddle is never requested in the app",
    );
    assert.equal(
      state.requests.includes("/api/billing/config"),
      false,
      "Paddle checkout is never prepared",
    );
    assert.deepEqual(state.errors, []);
  },
);

// A Strata+ member's week and workout saves, enough for the Train screen: Monday and Wednesday hold one bodyweight
// movement each, and saved workouts echo back with a new revision.
function workoutApi() {
  const movement = CATALOG.find(
    (item) =>
      item.equipment === "Bodyweight" &&
      !/seconds|sec|min/i.test(item.reps) &&
      !/assisted/i.test(item.name),
  );
  const days = Object.fromEntries(
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => [
      day,
      ["Monday", "Wednesday"].includes(day)
        ? [
            {
              instanceId: `${day.toLowerCase()}-one`,
              exerciseId: movement.id,
              sets: 2,
              reps: movement.reps,
            },
          ]
        : [],
    ]),
  );
  let revision = 0;
  return async (url, request) => {
    if (url.pathname === "/api/plan")
      return {
        body: {
          user: { id: USER_ID },
          plan: { version: 1, restDay: null, restDays: [], days },
          planUpdatedAt: 1,
        },
      };
    if (url.pathname === "/api/workouts" && request.method() === "GET")
      return { body: { workouts: [], hasMore: false } };
    if (
      /^\/api\/workouts(?:\/[^/]+)?$/.test(url.pathname) &&
      ["POST", "PUT"].includes(request.method())
    )
      return {
        body: {
          workout: {
            ...request.postDataJSON().workout,
            revision: ++revision,
            updatedAt: Date.now(),
          },
        },
      };
    return null;
  };
}

test(
  "in the app a workout keeps the screen awake, alerts at the end of a rest, and adds the week to Calendar",
  { timeout: 60_000 },
  async (t) => {
    const { page, state } = await fixture(t, {
      signedIn: true,
      discovery: {
        active: true,
        accessType: "apple",
        apple: APPLE,
        subscription: null,
        adminGrant: { active: false },
      },
      api: workoutApi(),
    });
    const calls = (name) =>
      page.evaluate(
        (wanted) =>
          window.__nativeCalls.filter((call) => call[0] === wanted).map((call) => call[1]),
        name,
      );
    const waitForCalls = (name, count) =>
      page.waitForFunction(
        ([wanted, total]) =>
          window.__nativeCalls.filter((call) => call[0] === wanted).length >= total,
        [name, count],
      );
    const downloads = [];
    page.on("download", (download) => downloads.push(download.suggestedFilename()));
    await page.goto("/workout.html?day=Monday", { waitUntil: "domcontentloaded" });
    const start = page.locator("#startWorkout");
    await start.waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector("#historyList .empty-state")?.textContent?.includes("Loading"),
    );
    assert.deepEqual(
      await calls("keepAwake"),
      [],
      "nothing keeps the screen awake before a workout starts",
    );

    // Calendar reminders open Calendar's own sheet with one event repeating Monday (2) and Wednesday (4).
    await page.locator("#calendarWeekly > summary").click();
    const link = page.locator("#calendarWeeklyLink");
    assert.equal((await link.textContent()).trim(), "Add to Calendar");
    assert.match(
      await page.locator("#calendarWeeklySummary").textContent(),
      /If your plan changes, edit the event in Calendar\.$/,
    );
    await page.locator("#calendarWeeklyTime").fill("07:30");
    await page.locator("#calendarWeeklyTime").dispatchEvent("change");
    await page.locator("#calendarWeeklyAlarm").selectOption("15");
    await link.click();
    await page
      .locator("#workoutToast")
      .filter({ hasText: "Added to your calendar." })
      .waitFor({ state: "visible" });
    const [calendar] = await calls("addWeeklyToCalendar");
    assert.deepEqual(calendar, {
      title: "STRATA workout",
      notes: "Planned training days: Monday, Wednesday. Open STRATA to start.",
      weekdays: [2, 4],
      hour: 7,
      minute: 30,
      durationMinutes: 60,
      alarmMinutesBefore: 15,
    });
    assert.deepEqual(downloads, [], "the sheet replaces the .ics download");
    // A build that cannot reach Calendar falls back to the .ics file.
    await page.evaluate(() => {
      window.__calendarRefuses = true;
    });
    const fallback = page.waitForEvent("download");
    await link.click();
    assert.equal((await fallback).suggestedFilename(), "strata-weekly-training.ics");
    assert.equal((await calls("addWeeklyToCalendar")).length, 2);

    // Starting the workout keeps the screen awake; each rest schedules its alert and pausing or resetting cancels it.
    await start.click();
    await page.locator("#sessionPanel").waitFor({ state: "visible" });
    await waitForCalls("keepAwake", 1);
    assert.deepEqual(await calls("keepAwake"), [{ enabled: true }]);
    const before = Date.now();
    await page.locator("#timerToggle").click();
    await waitForCalls("scheduleRestAlert", 1);
    const [alert] = await calls("scheduleRestAlert");
    assert.equal(alert.title, "Rest is over");
    assert.equal(alert.body, "Time for your next set.");
    assert.ok(
      alert.endsAt >= before + 89_000 && alert.endsAt <= Date.now() + 91_000,
      `the alert lands when the 90-second rest ends (${alert.endsAt - before} ms)`,
    );
    await page.locator("#timerToggle").click();
    await waitForCalls("cancelRestAlert", 1);
    assert.equal((await page.locator("#timerToggle").textContent()).trim(), "Resume");
    await page.locator("#timerToggle").click();
    await waitForCalls("scheduleRestAlert", 2);
    // Leaving the page lets the screen sleep but keeps the alert; coming back keeps the screen awake again.
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await waitForCalls("keepAwake", 2);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await waitForCalls("keepAwake", 3);
    assert.deepEqual(await calls("keepAwake"), [
      { enabled: true },
      { enabled: false },
      { enabled: true },
    ]);
    await page.locator("#timerReset").click();
    await waitForCalls("cancelRestAlert", 2);

    // Logging a set taps lightly and starts the automatic rest, which schedules its alert again.
    const row = page.locator("#sessionEntries [data-set='0']").first();
    await row.locator("input[data-actual='reps']").fill("10");
    await row.locator("[data-complete='0']").click();
    await waitForCalls("scheduleRestAlert", 3);
    assert.ok(
      (await calls("haptic")).some((call) => call.style === "light"),
      "a logged set taps lightly",
    );

    // Finishing taps success, lets the screen sleep, and cancels the pending alert.
    await page.locator("#finishWorkout").click();
    await page.locator("#finishDialog button[value='finish']").click();
    await page.locator("#celebration").waitFor({ state: "visible" });
    await waitForCalls("cancelRestAlert", 3);
    assert.deepEqual(await calls("keepAwake"), [
      { enabled: true },
      { enabled: false },
      { enabled: true },
      { enabled: false },
    ]);
    assert.ok(
      (await calls("haptic")).some((call) => call.style === "success"),
      "finishing taps success",
    );
    const order = await page.evaluate(() =>
      window.__nativeCalls
        .map((call) => call[0])
        .filter((name) => ["keepAwake", "scheduleRestAlert", "cancelRestAlert"].includes(name)),
    );
    assert.deepEqual(order, [
      "keepAwake",
      "scheduleRestAlert",
      "cancelRestAlert",
      "scheduleRestAlert",
      "keepAwake",
      "keepAwake",
      "cancelRestAlert",
      "scheduleRestAlert",
      "keepAwake",
      "cancelRestAlert",
    ]);
    assert.deepEqual(state.external, []);
    assert.deepEqual(state.errors, []);
  },
);

test(
  "in a browser the same Train screen keeps its .ics download and asks nothing of a native app",
  { timeout: 40_000 },
  async (t) => {
    const { page, state } = await fixture(t, {
      app: false,
      signedIn: true,
      discovery: {
        active: true,
        accessType: "grant",
        adminGrant: { active: true, expiresAt: null },
        subscription: null,
        apple: null,
      },
      api: workoutApi(),
    });
    await page.goto("/workout.html?day=Monday", { waitUntil: "domcontentloaded" });
    await page.locator("#startWorkout").waitFor({ state: "visible" });
    await page.locator("#calendarWeekly > summary").click();
    assert.equal(
      (await page.locator("#calendarWeeklyLink").textContent()).trim(),
      "Download calendar file",
    );
    assert.match(
      await page.locator("#calendarWeeklySummary").textContent(),
      /Re-download after you change your plan\.$/,
    );
    const download = page.waitForEvent("download");
    await page.locator("#calendarWeeklyLink").click();
    assert.equal((await download).suggestedFilename(), "strata-weekly-training.ics");
    await page.locator("#startWorkout").click();
    await page.locator("#sessionPanel").waitFor({ state: "visible" });
    await page.locator("#timerToggle").click();
    assert.equal(
      await page.evaluate(() =>
        Boolean(window.StrataApp || window.StrataAppMode || window.Capacitor),
      ),
      false,
    );
    assert.deepEqual(
      state.requests.filter((request) => /app-mode|app-paywall/.test(request)),
      [],
    );
    assert.deepEqual(state.external, []);
    assert.deepEqual(state.errors, []);
  },
);

test(
  "on the website an App Store member sees Strata+ through the App Store, Apple's link, and no Paddle checkout",
  { timeout: 40_000 },
  async (t) => {
    const { page, state } = await fixture(t, {
      app: false,
      signedIn: true,
      discovery: {
        active: true,
        accessType: "apple",
        apple: APPLE,
        subscription: null,
        adminGrant: { active: false },
      },
    });
    await page.goto("/pricing", { waitUntil: "load" });
    await page.locator("#purchaseStatus").filter({ hasText: "through the App Store" }).waitFor();
    assert.match(
      await page.locator("#purchaseStatus").textContent(),
      /^Your Strata\+ is through the App Store and renews on .+\. Apple bills it, so manage or cancel it with your App Store subscriptions\.$/,
    );
    assert.equal(await page.locator("#buyDiscovery").isHidden(), true, "no Paddle checkout");
    const manage = page.locator("#manageSubscription");
    assert.equal(await manage.isVisible(), true);
    assert.equal(await manage.getAttribute("href"), "https://apps.apple.com/account/subscriptions");
    assert.equal(await manage.getAttribute("target"), "_blank");
    await page.goto("/account.html", { waitUntil: "load" });
    await page.locator("#accountBilling").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#accountBillingTitle").textContent(),
      "Strata+ through the App Store",
    );
    const apple = page.getByRole("link", { name: /Manage subscription/ });
    assert.equal(await apple.getAttribute("href"), "https://apps.apple.com/account/subscriptions");
    for (const id of [
      "accountManageSubscription",
      "accountUpdatePayment",
      "accountCancelSubscription",
    ])
      assert.equal(
        await page.locator(`#${id}`).isHidden(),
        true,
        `${id}: never Paddle's portal for an App Store subscription`,
      );
    assert.deepEqual(state.errors, []);
  },
);

// Account deletion inside the app (App Review Guideline 5.1.1(v)): no email round trip. The journey's server refuses
// the first password and accepts the second, then forgets the account.
function deletionApi(state, { appleBilling = null } = {}) {
  state.deletions = [];
  return async (url, request) => {
    if (url.pathname === "/api/account/sessions")
      return { body: { userId: USER_ID, sessions: [] } };
    if (url.pathname === "/api/account/delete/request")
      return {
        status: 202,
        body: { ok: true, maskedEmail: "a***@example.test", expiresAt: Date.now() + 1_800_000 },
      };
    if (url.pathname !== "/api/account/delete/now") return null;
    const body = request.postDataJSON();
    state.deletions.push({
      body,
      csrf: request.headers()["x-csrf-token"],
      user: request.headers()["x-strata-user"],
    });
    if (body.password !== "correct-password-123")
      return {
        status: 401,
        body: { error: "That password is incorrect.", code: "PASSWORD_INCORRECT" },
      };
    state.user = null;
    return {
      body: {
        ok: true,
        message: `Your STRATA account was permanently deleted.${appleBilling ? ` ${appleBilling.message}` : ""}`,
        ...(appleBilling ? { appleBilling } : {}),
      },
    };
  };
}
const APPLE_NOTICE = {
  message:
    "Deleting your STRATA account does not cancel a Strata+ subscription bought through Apple. Apple keeps billing your Apple Account until you cancel it in Settings > Apple ID > Subscriptions.",
  manageUrl: "https://apps.apple.com/account/subscriptions",
};

test(
  "in the app, Delete account deletes the account in place with the password and DELETE, then leaves signed out",
  { timeout: 60_000 },
  async (t) => {
    const holder = {};
    const { page, state } = await fixture(t, {
      signedIn: true,
      discovery: {
        active: true,
        accessType: "apple",
        apple: APPLE,
        subscription: null,
        adminGrant: { active: false },
      },
      api: (url, request) => holder.api(url, request),
    });
    holder.api = deletionApi(state, { appleBilling: APPLE_NOTICE });
    await page.goto("/account.html", { waitUntil: "load" });
    await page.locator("#signedInCard").waitFor({ state: "visible" });
    const opener = page.getByRole("button", { name: "Delete account", exact: true });
    const dialog = page.getByRole("dialog", { name: "Delete your account?" });

    // Escape closes the dialog and focus returns to the button that opened it.
    await opener.click();
    await dialog.waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "accountDeleteTitle",
      "VoiceOver starts at the title",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "accountDeleteRequest");

    await opener.click();
    await dialog.waitFor({ state: "visible" });
    const apple = dialog.locator("#accountDeleteApple");
    assert.equal(await apple.isVisible(), true);
    assert.match(
      await apple.textContent(),
      /does not cancel your App Store subscription\..*Apple keeps billing your Apple Account until you cancel it\./,
    );
    await apple.getByRole("link", { name: "Manage subscription" }).click();
    assert.deepEqual(
      await page.evaluate(
        () => window.__nativeCalls.filter((call) => call[0] === "manageSubscriptions").length,
      ),
      1,
      "Apple's own sheet, from the dialog",
    );
    const submit = dialog.getByRole("button", { name: "Delete account", exact: true });
    assert.equal(await submit.isDisabled(), true);
    const password = dialog.getByLabel("Your STRATA password"),
      confirmation = dialog.getByLabel("Type DELETE to confirm");
    assert.equal(await password.getAttribute("type"), "password");
    assert.equal(await password.getAttribute("autocomplete"), "current-password");
    await password.fill("wrong-password-123");
    await confirmation.fill("delete");
    assert.equal(await submit.isDisabled(), true, "only DELETE, exactly");
    await confirmation.fill("DELETE");
    assert.equal(await submit.isDisabled(), false);
    const sizes = await dialog.evaluate((node) =>
      [...node.querySelectorAll("input,button:not([hidden]),a:not([hidden])")]
        .filter((item) => item.getClientRects().length)
        .map((item) => ({ id: item.id, height: item.getBoundingClientRect().height })),
    );
    for (const { id, height } of sizes)
      assert.ok(height >= 44, `${id} is a 44pt target (${height}px)`);
    const before = await submit.boundingBox();
    await submit.click();
    await dialog
      .locator("#accountDeleteError")
      .filter({ hasText: "That password is incorrect." })
      .waitFor();
    assert.deepEqual(
      await submit.boundingBox(),
      before,
      "the error appears without moving the buttons",
    );
    assert.equal(await password.inputValue(), "");
    assert.equal(await password.getAttribute("aria-invalid"), "true");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "accountDeletePassword");
    assert.equal(page.url(), `${ORIGIN}/account.html`);

    await password.fill("correct-password-123");
    await submit.click();
    const done = dialog.locator("#accountDeleteDone");
    await done.waitFor({ state: "visible" });
    assert.match(
      (await done.textContent()).replace(/\s+/g, " "),
      /Account deleted Your STRATA account was permanently deleted\. .*Apple keeps billing your Apple Account/,
    );
    assert.equal(await done.getByRole("link", { name: "Manage subscription" }).isVisible(), true);
    assert.deepEqual(
      state.deletions.map(({ body }) => body.password),
      ["wrong-password-123", "correct-password-123"],
    );
    assert.ok(
      state.deletions.every(
        ({ body, csrf, user }) =>
          body.confirmation === "DELETE" && csrf === "journey-csrf" && user === USER_ID,
      ),
    );
    // After the notice has been read, the app returns to its signed-out start screen on its own.
    await page.waitForURL(`${ORIGIN}/`, { timeout: 15_000 });
    await page.locator(".app-welcome").waitFor({ state: "visible" });
    assert.equal(
      state.requests.includes("/api/account/delete/request"),
      false,
      "no email round trip",
    );
    assert.deepEqual(state.external, []);
    assert.deepEqual(state.errors, []);
  },
);

test(
  "in a browser, Delete account still emails a deletion link and never opens the in-app dialog",
  { timeout: 40_000 },
  async (t) => {
    const holder = {};
    const { page, state } = await fixture(t, {
      app: false,
      signedIn: true,
      discovery: { active: false, accessType: null, apple: null },
      api: (url, request) => holder.api(url, request),
    });
    holder.api = deletionApi(state);
    await page.goto("/account.html", { waitUntil: "load" });
    await page.locator("#signedInCard").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    await page
      .locator("#accountSecurityStatus")
      .filter({ hasText: "A deletion confirmation link was sent to a***@example.test." })
      .waitFor();
    assert.equal(await page.locator("#accountDeleteDialog").isVisible(), false);
    assert.equal(
      await page.evaluate(() => document.getElementById("accountDeleteDialog").open),
      false,
    );
    assert.equal(state.requests.includes("/api/account/delete/request"), true);
    assert.equal(state.requests.includes("/api/account/delete/now"), false);
    assert.deepEqual(state.errors, []);
  },
);

test(
  "browsers without the app token keep the website exactly as it was",
  { timeout: 40_000 },
  async (t) => {
    const { page, state } = await fixture(t, { app: false });
    for (const path of ["/", "/pricing", "/terms", "/account.html"]) {
      state.requests.length = 0;
      await page.goto(path, { waitUntil: "load" });
      const view = await page.evaluate(layout);
      assert.equal(view.app, null, path);
      assert.equal(view.chrome, null, path);
      assert.equal(view.tabBar, false, path);
      assert.equal(
        await page
          .locator(".app-tabbar, .app-topbar, .app-welcome, .app-paywall, .app-more")
          .count(),
        0,
        path,
      );
      assert.equal(view.websiteHeader, true, `${path} keeps its header`);
      assert.equal(view.footer, true, `${path} keeps its footer`);
      assert.equal(
        await page.evaluate(() => Boolean(window.StrataApp || window.StrataAppMode)),
        false,
        path,
      );
      assert.deepEqual(
        state.requests.filter((request) => /app-mode|app-paywall/.test(request)),
        [],
        `${path} never loads the app's files`,
      );
      // Every request is one the page's own HTML names (plus its API reads and the catalog), as before.
      const html = readFileSync(staticAsset(path), "utf8"),
        named = new Set(
          [...html.matchAll(/(?:src|href)="(\/?[^"?#:]+\.(?:js|css))(?:\?[^"]*)?"/g)].map(
            (match) => `/${match[1].replace(/^\//, "")}`,
          ),
        );
      const unnamed = state.requests.filter(
        (request) => /\.(?:js|css)$/.test(request) && !named.has(request),
      );
      assert.deepEqual(
        unnamed,
        path === "/pricing" ? ["/paddle/v2/paddle.js"] : [],
        `${path} requests only what its HTML names`,
      );
    }
    assert.ok(
      state.external.includes("https://cdn.paddle.com/paddle/v2/paddle.js"),
      "the website still loads Paddle checkout",
    );
    await page.goto("/account.html", { waitUntil: "load" });
    assert.deepEqual(
      await page.evaluate(() =>
        ["web-only", "app-only"].map(
          (name) => getComputedStyle(document.querySelector(`.account-security .${name}`)).display,
        ),
      ),
      ["inline", "none"],
      "the website keeps its own deletion copy",
    );
    assert.deepEqual(state.errors, []);
  },
);

test.before(async () => {
  const options = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
    options.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  browser = await chromium.launch(options);
});
test.after(() => browser?.close());
