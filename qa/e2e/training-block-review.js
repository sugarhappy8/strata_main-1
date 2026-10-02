"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { grantStrataPlus } = require("../../test/support/strata-plus-access");

const ROOT = join(__dirname, "..", "..");
const PASSWORD = "training-block-e2e-123";
const CATALOG = JSON.parse(readFileSync(join(ROOT, "public/data/exercises.json"), "utf8"));
let app,
  browser,
  baseUrl,
  runtimeDir,
  logs = "";

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
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  runtimeDir = mkdtempSync(join(tmpdir(), "strata-block-e2e-"));
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [app.stdout, app.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk.toString()).slice(-16_384);
    });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`E2E server exited.\n${logs}`);
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`E2E server did not become healthy.\n${logs}`);
}
async function cleanup() {
  try {
    await browser?.close();
  } finally {
    if (app && app.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(() => {
          app.kill("SIGKILL");
          done();
        }, 2000);
        app.once("exit", () => {
          clearTimeout(timer);
          done();
        });
        app.kill("SIGTERM");
      });
    }
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  }
}
function dateOffset(offset) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
function weeklyPlan() {
  const chest = CATALOG.find((item) => item.group === "chest"),
    back = CATALOG.find((item) => item.group === "back");
  return {
    version: 1,
    restDay: "Sunday",
    days: {
      Monday: [{ instanceId: "block-monday", exerciseId: chest.id, sets: 3, reps: "8–12" }],
      Tuesday: [],
      Wednesday: [{ instanceId: "block-wednesday", exerciseId: back.id, sets: 4, reps: "8–12" }],
      Thursday: [],
      Friday: [],
      Saturday: [],
      Sunday: [],
    },
  };
}

test(
  "training-block review derives time, shows only logged evidence, and confirms every action",
  { timeout: 60_000 },
  async () => {
    const context = await browser.newContext({
        baseURL: baseUrl,
        serviceWorkers: "block",
        timezoneId: "UTC",
        reducedMotion: "reduce",
        viewport: { width: 390, height: 844 },
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const signup = await context.request.post("/api/signup", {
      headers: { Origin: baseUrl },
      data: { name: "Block Review", email: "block-review@example.test", password: PASSWORD },
    });
    assert.equal(signup.status(), 201, await signup.text());
    let account = await (await context.request.get("/api/plan")).json();
    grantStrataPlus(runtimeDir, (await signup.json()).user.id);
    const plan = weeklyPlan(),
      savedPlan = await context.request.put("/api/plan", {
        headers: { Origin: baseUrl, "X-CSRF-Token": account.csrfToken },
        data: { plan, expectedPlanUpdatedAt: account.planUpdatedAt },
      });
    assert.equal(savedPlan.status(), 200, await savedPlan.text());
    account = await (await context.request.get("/api/plan")).json();
    const block = {
      title: "Evidence block",
      goal: "balanced",
      weeks: 6,
      currentWeek: 2,
      lightWeek: null,
      startDate: dateOffset(-7),
      status: "active",
      progressionRule: "reps-then-load",
    };
    const savedBlock = await context.request.put("/api/training-block", {
      headers: { Origin: baseUrl, "X-CSRF-Token": account.csrfToken },
      data: { block, expectedRevision: 0 },
    });
    assert.equal(savedBlock.status(), 200, await savedBlock.text());
    await page.goto("/discover.html#planWorkspace", { waitUntil: "domcontentloaded" });
    await page.locator("#trainingBlockReview").waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector("#trainingBlockWorkoutCount")?.textContent === "0 / 2",
    );
    assert.equal(await page.locator("#trainingBlockCurrentWeek").inputValue(), "2");
    assert.equal(await page.locator("#trainingBlockCurrentWeek").isDisabled(), true);
    const muscleText = await page.locator("#trainingBlockMuscles").textContent();
    assert.match(muscleText, /Chest3planned/);
    assert.match(muscleText, /Back4planned/);
    assert.match(
      await page.locator("#trainingBlockEvidence").textContent(),
      /No comparable improvement or new logged high/,
    );
    assert.equal(await page.locator("#trainingBlockSignals").isHidden(), true);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth -
          globalThis.document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 1, `Training-block review overflows ${width}px by ${overflow}px`);
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => {
      globalThis.document.documentElement.style.fontSize = "200%";
    });
    const zoomOverflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth -
        globalThis.document.documentElement.clientWidth,
    );
    assert.ok(
      zoomOverflow <= 1,
      `Training-block review overflows at 200% text size by ${zoomOverflow}px`,
    );
    await page.evaluate(() => {
      globalThis.document.documentElement.style.fontSize = "";
    });
    const actionHeights = await page
      .locator(".training-block-review-actions button")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    assert.ok(
      actionHeights.every((height) => height >= 44),
      actionHeights.join(", "),
    );
    const beforePlan = (await (await context.request.get("/api/plan")).json()).plan;
    await page.locator("#trainingBlockLighter").focus();
    await page.keyboard.press("Enter");
    await page.locator("#trainingBlockActionDialog").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#trainingBlockActionDialog").textContent(),
      /weekly Plan will not change[\s\S]*Nothing is saved until you confirm/i,
    );
    assert.deepEqual((await (await context.request.get("/api/plan")).json()).plan, beforePlan);
    const saving = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/training-block" &&
        response.request().method() === "PUT",
    );
    await page.locator("#trainingBlockActionConfirm").click();
    const response = await saving;
    assert.equal(response.status(), 200, await response.text());
    assert.equal(response.request().postDataJSON().block.lightWeek, 3);
    assert.deepEqual((await (await context.request.get("/api/plan")).json()).plan, beforePlan);
    await page.locator("#trainingBlockFinish").click();
    await page.locator("#trainingBlockActionDialog").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#trainingBlockActionDescription").textContent(),
      /logged workouts[\s\S]*remain unchanged/i,
    );
    await page.keyboard.press("Escape");
    await page.locator("#trainingBlockActionDialog").waitFor({ state: "hidden" });
    assert.equal(
      await page
        .locator("#trainingBlockFinish")
        .evaluate((node) => node === globalThis.document.activeElement),
      true,
    );
    assert.deepEqual(errors, []);
    await context.close();
  },
);

test.before(async () => {
  await startApp();
  const options = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
    options.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  browser = await chromium.launch(options);
});
test.after(cleanup);
