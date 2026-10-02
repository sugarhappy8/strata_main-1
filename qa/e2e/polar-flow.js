"use strict";

// The Polar Loop journey in a real browser against a local stand-in for Polar's OAuth and AccessLink
// endpoints: consent, connect, first import, Recovery, the lighter session on Train, and disconnect.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { grantStrataPlus } = require("../../test/support/strata-plus-access");
const AxeBuilder = require("@axe-core/playwright").default;

const ROOT = join(__dirname, "..", "..");
const WAIT_MS = 15_000,
  DAY = 24 * 60 * 60 * 1000,
  PASSWORD = "synthetic-polar-e2e-123";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
let app,
  polar,
  browser,
  baseUrl,
  runtimeDir,
  logs = "";
const pageErrors = [];

const isoDate = (time) => new Date(time).toISOString().slice(0, 10);
function meaningfulViolation(violation) {
  return ["serious", "critical"].includes(violation.impact);
}
function violationSummary(violations) {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
    )
    .join("\n");
}

/** Polar V4 side: one member whose last night had a poor Nightly Recharge. */
function startPolar() {
  const state = { tokens: [], deleteCalls: 0 };
  const nights = () =>
    Array.from({ length: 28 }, (_, index) => {
      const age = 27 - index,
        wave = Math.sin(index / 3);
      return {
        date: isoDate(Date.now() - age * DAY),
        status: age === 0 ? 2 : [4, 5, 4, 3, 5, 6, 4][index % 7],
        hrv: age === 0 ? 44 : Math.round(56 + wave * 5),
        hr: age === 0 ? 57 : Math.round(52 - wave * 2),
      };
    });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://polar.test");
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    if (url.pathname === "/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("state", url.searchParams.get("state"));
      back.searchParams.set("code", "e2e-code");
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/oauth/token") {
      state.tokens.push(new URLSearchParams(body).get("code"));
      return send(200, {
        access_token: "e2e-token",
        refresh_token: "e2e-refresh",
        token_type: "bearer",
        expires_in: 43200,
        scope: "sleep:read nightly_recharge:read continuous_samples:read training_sessions:read",
      });
    }
    if (req.headers.authorization !== "Bearer e2e-token") return send(401, {});
    if (req.method === "DELETE") state.deleteCalls += 1;
    if (url.pathname === "/v4/data/sleeps") {
      if (!url.searchParams.has("features"))
        return send(200, { nightSleeps: nights().map((night) => ({ sleepDate: night.date })) });
      const sleepDate = url.searchParams.get("from");
      return send(200, {
        nightSleeps: [
          {
            sleepDate,
            sleepResult: {
              hypnogram: {
                sleepStart: `${sleepDate}T00:00:00Z`,
                sleepEnd: `${sleepDate}T07:08:20Z`,
              },
            },
            sleepScore: { sleepScore: 80, scoreRate: 3 },
            sleepEvaluation: {
              asleepDuration: "25700s",
              phaseDurations: { light: "14400s", deep: "5200s", rem: "6100s", unknown: "0s" },
              interruptions: { totalDuration: "900s" },
            },
          },
        ],
      });
    }
    if (url.pathname === "/v4/data/nightly-recharge-results")
      return send(200, {
        nightlyRechargeResults: {
          nightlyRechargeResults: nights().map((night) => ({
            sleepResultDate: night.date,
            recoveryIndicator: night.status,
            ansStatus: night.status <= 2 ? -4.2 : 1,
            ansRate: night.status <= 2 ? 2 : 3,
            meanNightlyRecoveryRri: Math.round(60000 / night.hr),
            meanNightlyRecoveryRmssd: night.hrv,
            meanNightlyRecoveryRespirationInterval: 4225,
          })),
        },
      });
    if (url.pathname === "/v4/data/continuous-samples") {
      const from = Date.parse(`${url.searchParams.get("from")}T00:00:00Z`),
        to = Date.parse(`${url.searchParams.get("to")}T00:00:00Z`),
        heartRateSamplesPerDay = [];
      for (let time = from; time < to; time += DAY)
        heartRateSamplesPerDay.push({
          date: isoDate(time),
          samples: [
            { heartRate: 49, offsetMillis: 10800000 },
            { heartRate: 50, offsetMillis: 11100000 },
            { heartRate: 51, offsetMillis: 11400000 },
            { heartRate: 128, offsetMillis: 64800000 },
          ],
        });
      return send(200, { continuousSamples: { heartRateSamplesPerDay } });
    }
    if (url.pathname === "/v4/data/training-sessions/list")
      return send(200, { trainingSessions: [] });
    send(404, {});
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}
async function unusedPort() {
  const server = http.createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return port;
}
async function startApp() {
  polar = await startPolar();
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  runtimeDir = mkdtempSync(join(tmpdir(), "strata-polar-e2e-"));
  app = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      TZ: "UTC",
      TRUST_PROXY: "true",
      SECURE_COOKIES: "false",
      ADMIN_EMAIL: "",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtimeDir,
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      EMAIL_VERIFICATION_ENABLED: "false",
      PADDLE_CHECKOUT_ENABLED: "false",
      APP_BASE_URL: baseUrl,
      POLAR_CLIENT_ID: "e2e-client",
      POLAR_CLIENT_SECRET: "e2e-secret",
      DEVICE_TOKEN_KEY: randomBytes(32).toString("base64"),
      DEVICE_SYNC_INTERVAL_MS: "300",
      POLAR_AUTH_URL: `${polar.url}/oauth/authorize`,
      POLAR_TOKEN_URL: `${polar.url}/oauth/token`,
      POLAR_API_URL: `${polar.url}/v4/data`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [app.stdout, app.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk.toString()).slice(-16_384);
    });
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Polar E2E server exited.\n${logs}`);
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {
      /* Still starting. */
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Polar E2E server did not become healthy.\n${logs}`);
}
async function cleanup() {
  try {
    await browser?.close();
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      await new Promise((done) => {
        let forceTimer;
        app.once("exit", () => {
          clearTimeout(forceTimer);
          done();
        });
        app.kill("SIGTERM");
        forceTimer = setTimeout(() => {
          try {
            app.kill("SIGKILL");
          } catch {
            /* Already gone. */
          }
          done();
        }, 2000);
      });
    }
    await new Promise((done) => (polar ? polar.server.close(() => done()) : done()));
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  }
}
async function newContext(options = {}) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    serviceWorkers: "block",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    ...options,
  });
  context.setDefaultTimeout(WAIT_MS);
  await context.route(/^https:\/\//, (route) => route.abort());
  return context;
}
async function openPage(context) {
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  return page;
}
async function axe(page, label) {
  const serious = (
    await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()
  ).violations.filter(meaningfulViolation);
  assert.equal(
    serious.length,
    0,
    `${label} serious/critical axe violations:\n${violationSummary(serious)}`,
  );
}

test.before(async () => {
  await startApp();
  const options = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
    options.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  browser = await chromium.launch(options);
});
test.after(cleanup);

test(
  "a Strata+ member connects their own Polar, sees recovery, trains lighter, and disconnects",
  { timeout: 180_000 },
  async () => {
    const context = await newContext({ viewport: { width: 1280, height: 900 } });
    const signup = await context.request.post("/api/signup", {
      headers: { Origin: baseUrl },
      data: { name: "Polar Member", email: "polar-e2e@example.test", password: PASSWORD },
    });
    assert.equal(signup.status(), 201, await signup.text());
    const csrf = (await (await context.request.get("/api/me")).json()).csrfToken;
    grantStrataPlus(runtimeDir, (await signup.json()).user.id);
    const today = DAYS[(new Date().getUTCDay() + 6) % 7];
    const plan = {
      version: 1,
      restDay: null,
      restDays: [],
      days: Object.fromEntries(
        DAYS.map((day) => [
          day,
          day === today
            ? [
                { instanceId: "polar-a", exerciseId: "flat-dumbbell-press", sets: 4, reps: "8–10" },
                {
                  instanceId: "polar-b",
                  exerciseId: "machine-chest-press",
                  sets: 3,
                  reps: "10–12",
                },
              ]
            : [],
        ]),
      ),
    };
    assert.equal(
      (
        await context.request.put("/api/plan", {
          headers: { Origin: baseUrl, "X-CSRF-Token": csrf },
          data: { plan, expectedPlanUpdatedAt: 0 },
        })
      ).status(),
      200,
    );

    const page = await openPage(context);
    await page.goto("/account.html#connectedDevices", { waitUntil: "domcontentloaded" });
    const card = page.locator("#connectedDevices");
    await card.waitFor({ state: "visible" });
    assert.equal(await card.getAttribute("data-state"), "disconnected");
    await axe(page, "Account with the Polar card");
    await page.click("#devicesConnect");
    await page.locator("#devicesConsent").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#devicesContinue").isDisabled(),
      true,
      "consent is required before Polar opens",
    );
    assert.equal(
      await page.evaluate(() => globalThis.document.activeElement?.id),
      "devicesConsentTitle",
    );
    await page.check("#devicesConsentCheck");
    await Promise.all([
      page.waitForURL(/\/account\.html#connectedDevices$/),
      page.click("#devicesContinue"),
    ]);
    await page.waitForFunction(
      () => globalThis.document.querySelector("#connectedDevices")?.dataset.state === "active",
      null,
      { timeout: 30_000 },
    );
    assert.deepEqual(polar.state.tokens, ["e2e-code"]);
    assert.equal(await page.locator("#devicesSuggestions").isChecked(), true);
    assert.equal(
      new URL(page.url()).searchParams.has("devices"),
      false,
      "the Polar return marker is removed from the address",
    );

    await page.goto("/discover.html", { waitUntil: "domcontentloaded" });
    await page.locator("#todayRecovery").waitFor({ state: "visible" });
    assert.equal(await page.locator("#todayRecoveryTitle").textContent(), "Poor recovery");
    await page.click('.destination-link[data-feature-target="recovery"]');
    await page.locator("#recoveryResults").waitFor({ state: "visible" });
    assert.equal(await page.locator("#recoveryToday .recovery-metric").count(), 4);
    assert.match(await page.locator("#recoveryToday").textContent(), /Nightly Recharge\s*Poor/);
    assert.equal(await page.locator("#recoveryCharts figure").count(), 4);
    assert.equal(await page.locator("#recoveryWeekly tbody tr").count(), 4);
    await page.click('[data-recovery-weeks="8"]');
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-recovery-weeks="8"]')
          ?.getAttribute("aria-pressed") === "true",
    );
    assert.equal(await page.locator("#recoveryWeekly tbody tr").count(), 8);
    await axe(page, "Strata+ Recovery");

    const phone = await newContext({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
      storageState: await context.storageState(),
    });
    const small = await openPage(phone);
    await small.goto("/discover.html#recoveryWorkspace", { waitUntil: "domcontentloaded" });
    await small.locator("#recoveryResults").waitFor({ state: "visible" });
    const layout = await small.evaluate(() => ({
      overflow: globalThis.document.documentElement.scrollWidth - globalThis.innerWidth,
      clipped: [...globalThis.document.querySelectorAll(".destination-link span")]
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => node.textContent),
      destinations: globalThis.document.querySelectorAll(".destination-link").length,
    }));
    assert.ok(layout.overflow <= 1, `Recovery overflows 360px by ${layout.overflow}px`);
    assert.deepEqual(layout.clipped, [], "every destination label fits on a narrow phone");
    assert.equal(layout.destinations, 4);
    await phone.close();

    await page.goto("/workout.html", { waitUntil: "domcontentloaded" });
    await page.locator("#deviceRecovery").waitFor({ state: "visible" });
    assert.match(await page.locator("#deviceRecovery").textContent(), /Polar recovery: Poor/);
    await page.click("#startLighterWorkout");
    await page.locator("#sessionPanel").waitFor({ state: "visible" });
    assert.match(await page.locator("#sessionDate").textContent(), /Lighter session/);
    assert.equal(
      await page.locator("#progressCount").textContent(),
      "0 / 5 sets",
      "one set fewer per exercise: 3 + 2",
    );
    await page.waitForFunction(
      () => globalThis.document.querySelector("#saveStatus")?.dataset.state === "saved",
      null,
      { timeout: 30_000 },
    );
    const saved = await (await context.request.get("/api/workouts?limit=5&offset=0")).json();
    assert.equal(saved.workouts[0].adjustment, "recovery");
    const plannedSets = (await (await context.request.get("/api/plan")).json()).plan.days[
      today
    ].map((item) => item.sets);
    assert.deepEqual(plannedSets, [4, 3], "the weekly plan never changes");

    await page.goto("/account.html#connectedDevices", { waitUntil: "domcontentloaded" });
    await card.waitFor({ state: "visible" });
    await page.click("#devicesDisconnect");
    await page.locator("#devicesDisconnectDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    assert.equal(await card.getAttribute("data-state"), "active", "Escape keeps Polar connected");
    await page.click("#devicesDisconnect");
    await page.click('#devicesDisconnectDialog button[value="disconnect"]');
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector("#connectedDevices")?.dataset.state === "disconnected",
    );
    assert.equal(
      polar.state.deleteCalls,
      0,
      "V4 disconnect is local because Polar has no deregistration endpoint",
    );
    const after = await (await context.request.get("/api/wellness/today")).json();
    assert.equal(after.connected, false);
    await context.close();
    assert.deepEqual(pageErrors, []);
  },
);
