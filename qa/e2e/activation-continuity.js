"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const ROOT = join(__dirname, "..", "..");
const CATALOG = JSON.parse(readFileSync(join(ROOT, "public/data/exercises.json"), "utf8"));
const PASSWORD = "activation-e2e-password-123";
const WAIT_MS = 10_000;
let app,
  browser,
  baseUrl,
  runtimeDir,
  logs = "",
  network = 20;

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
  runtimeDir = mkdtempSync(join(tmpdir(), "strata-activation-e2e-"));
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
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Activation E2E server exited.\n${logs}`);
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Activation E2E server did not become healthy.\n${logs}`);
}
async function cleanup() {
  try {
    await browser?.close();
  } finally {
    if (app && app.exitCode === null) {
      await new Promise((done) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          done();
        };
        app.once("exit", finish);
        app.kill("SIGTERM");
        setTimeout(() => {
          if (!finished) app.kill("SIGKILL");
          finish();
        }, 1500);
      });
    }
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  }
}
async function newContext(options = {}) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    serviceWorkers: "block",
    extraHTTPHeaders: { "X-Forwarded-For": `198.51.100.${network++}` },
    ...options,
  });
  context.setDefaultTimeout(WAIT_MS);
  await context.route(/^https:\/\//, (route) => route.abort());
  return context;
}
async function signup(context, label) {
  const response = await context.request.post("/api/signup", {
    headers: { Origin: baseUrl },
    data: {
      name: `Activation ${label}`,
      email: `activation-${label}@example.test`,
      password: PASSWORD,
    },
  });
  assert.equal(response.status(), 201, await response.text());
  return (await response.json()).user;
}
async function accountPlan(context) {
  const response = await context.request.get("/api/plan");
  assert.equal(response.status(), 200);
  return response.json();
}
function fixtureWeek(instanceId = "account-entry", exerciseIndex = 0) {
  return {
    version: 1,
    restDay: "Sunday",
    restDays: ["Sunday"],
    days: Object.fromEntries(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => [
        day,
        day === "Monday"
          ? [{ instanceId, exerciseId: CATALOG[exerciseIndex].id, sets: 3, reps: "8–12" }]
          : [],
      ]),
    ),
  };
}
async function seedAccount(context, user, plan) {
  const current = await accountPlan(context);
  const response = await context.request.put("/api/plan", {
    headers: { Origin: baseUrl, "X-CSRF-Token": current.csrfToken, "X-Strata-User": user.id },
    data: { plan, expectedPlanUpdatedAt: current.planUpdatedAt, expectedUserId: user.id },
  });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

test(
  "activation continuity uses explicit, revision-safe account choices",
  { timeout: 90_000 },
  async (t) => {
    try {
      await startApp();
      const launchOptions = { headless: true };
      if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
        launchOptions.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
      browser = await chromium.launch(launchOptions);
      await t.test(
        "a homepage week survives account and verification pages, then is claimed explicitly",
        async () => {
          const context = await newContext({
              viewport: { width: 390, height: 844 },
              reducedMotion: "reduce",
            }),
            page = await context.newPage();
          await page.goto("/", { waitUntil: "domcontentloaded" });
          // The exercise library loads once the visitor heads for the preview, as a scroll does.
          await page.locator("#quickPreviewForm").scrollIntoViewIfNeeded();
          await page.locator("#quickPreviewEquipment").waitFor({ state: "visible" });
          await page.waitForFunction(
            () => !globalThis.document.querySelector("#quickPreviewEquipment").disabled,
          );
          await page.selectOption("#quickPreviewDays", "4");
          assert.equal(
            await page.locator('#quickPreviewEquipment option[value="Resistance band"]').count(),
            0,
            "homepage must not offer equipment that cannot produce the complete four-day week",
          );
          await page.selectOption("#quickPreviewGroup", "back");
          assert.equal(
            await page.locator('#quickPreviewEquipment option[value="Bench"]').count(),
            0,
            "every visible equipment choice must support a complete four-day week",
          );
          await page.selectOption("#quickPreviewGroup", "chest");
          await page.selectOption("#quickPreviewGoal", "hypertrophy");
          await page.selectOption("#quickPreviewDays", "4");
          await page.selectOption("#quickPreviewMinutes", "20");
          await page.click("#quickPreviewSubmit");
          await page.locator("#quickWeekPreview").waitFor({ state: "visible" });
          const intent = await page.evaluate(() =>
            JSON.parse(localStorage.getItem("strata_activation_intent_v1")),
          );
          assert.equal(intent.profile.availability.length, 4);
          assert.equal(intent.profile.minutes, 20);
          assert.ok(Object.values(intent.plan.days).flat().length > 0);
          const previewLayout = await page.evaluate(() => ({
            overflow:
              globalThis.document.documentElement.scrollWidth -
              globalThis.document.documentElement.clientWidth,
            actionHeight: globalThis.document
              .querySelector("#quickPreviewContinue")
              .getBoundingClientRect().height,
          }));
          assert.ok(
            previewLayout.overflow <= 1,
            `complete preview overflows a phone viewport by ${previewLayout.overflow}px`,
          );
          assert.ok(previewLayout.actionHeight >= 44);
          assert.equal(
            await page.locator('#quickWeekPreview a[href^="/workout"]').count(),
            0,
            "preview must not expose a training shortcut",
          );
          await page.click("#quickPreviewContinue");
          await page.locator("[data-activation-handoff]").waitFor({ state: "visible" });
          assert.match(
            await page.locator("[data-activation-handoff]").textContent(),
            /week is still here/i,
          );
          await page.goto("/verify-email.html?next=planner", { waitUntil: "domcontentloaded" });
          await page.locator("[data-activation-handoff]").waitFor({ state: "visible" });
          assert.match(
            await page.locator("[data-activation-handoff]").textContent(),
            /4 training days/,
          );
          await page.goto("/account.html?mode=signup&next=planner", {
            waitUntil: "domcontentloaded",
          });
          await page.fill("#signupName", "Activation Journey");
          await page.fill("#signupEmail", "activation-journey@example.test");
          await page.fill("#signupPassword", PASSWORD);
          await page.click("#signupSubmit");
          await page.waitForURL(/\/planner\.html/);
          await page.locator("#devicePlanPanel").waitFor({ state: "visible" });
          assert.equal(
            (await accountPlan(context)).planUpdatedAt,
            0,
            "merely reaching the planner cannot claim the device week",
          );
          assert.equal(
            await page.locator("#compareDevicePlan").isHidden(),
            true,
            "an empty account has no conflicting week to compare",
          );
          assert.equal(await page.locator("#devicePlanConfirmLabel").isHidden(), true);
          assert.match(
            await page.locator("#claimDevicePlan").textContent(),
            /Save week to my account/i,
          );
          const writePromise = page.waitForRequest(
            (request) =>
              new URL(request.url()).pathname === "/api/plan" && request.method() === "PUT",
          );
          await page.click("#claimDevicePlan");
          const write = await writePromise;
          const payload = write.postDataJSON();
          assert.equal(payload.expectedPlanUpdatedAt, 0);
          assert.ok(payload.expectedUserId);
          await page.locator("#devicePlanPanel").waitFor({ state: "hidden" });
          const saved = await accountPlan(context);
          assert.deepEqual(saved.plan, intent.plan);
          const local = await page.evaluate(() => ({
            intent: localStorage.getItem("strata_activation_intent_v1"),
            guest: localStorage.getItem("strata_guest_plan_v1"),
            backups: Object.keys(localStorage).filter((key) =>
              key.startsWith("strata_activation_backup_v1:"),
            ),
          }));
          assert.ok(local.intent, "claiming keeps the source preview as a local recovery copy");
          assert.equal(
            local.guest,
            null,
            "homepage preview does not silently become the editable guest plan",
          );
          assert.equal(local.backups.length, 1);
          await context.close();
        },
      );

      await t.test(
        "keeping the account week performs no write and retains the free device plan",
        async () => {
          const context = await newContext(),
            user = await signup(context, "keep"),
            account = await seedAccount(context, user, fixtureWeek("account-keep", 0));
          const page = await context.newPage();
          const device = fixtureWeek("device-keep", 2);
          await page.addInitScript(
            (plan) => localStorage.setItem("strata_guest_plan_v1", JSON.stringify(plan)),
            device,
          );
          const writes = [];
          page.on("request", (request) => {
            if (new URL(request.url()).pathname === "/api/plan" && request.method() === "PUT")
              writes.push(request);
          });
          await page.goto("/planner.html", { waitUntil: "domcontentloaded" });
          await page.locator("#devicePlanPanel").waitFor({ state: "visible" });
          await page.click("#keepAccountPlan");
          await page.locator("#devicePlanPanel").waitFor({ state: "hidden" });
          assert.equal(writes.length, 0);
          assert.equal((await accountPlan(context)).planUpdatedAt, account.planUpdatedAt);
          assert.deepEqual(
            await page.evaluate(() => JSON.parse(localStorage.getItem("strata_guest_plan_v1"))),
            device,
          );
          assert.equal(
            await page.evaluate(
              () =>
                Object.keys(localStorage).filter((key) =>
                  key.startsWith("strata_activation_backup_v1:"),
                ).length,
            ),
            1,
          );
          await context.close();
        },
      );

      await t.test(
        "a stale claim is rejected after another device changes the account week",
        async () => {
          const context = await newContext(),
            user = await signup(context, "stale"),
            seeded = await seedAccount(context, user, fixtureWeek("account-before", 0));
          const page = await context.newPage(),
            device = fixtureWeek("device-stale", 3);
          await page.addInitScript(
            (plan) => localStorage.setItem("strata_guest_plan_v1", JSON.stringify(plan)),
            device,
          );
          await page.goto("/planner.html", { waitUntil: "domcontentloaded" });
          await page.locator("#devicePlanPanel").waitFor({ state: "visible" });
          const newer = fixtureWeek("account-newer", 4);
          const changed = await seedAccount(context, user, newer);
          assert.ok(changed.planUpdatedAt > seeded.planUpdatedAt);
          await page.click("#compareDevicePlan");
          await page.check("#devicePlanConfirm");
          const responsePromise = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/plan" &&
              response.request().method() === "PUT",
          );
          await page.click("#claimDevicePlan");
          const response = await responsePromise;
          assert.equal(response.status(), 409);
          await page.waitForFunction(
            () => globalThis.document.querySelector("#devicePlanStatus").dataset.state === "error",
          );
          assert.match(
            await page.locator("#devicePlanStatus").textContent(),
            /changed in another tab or device/i,
          );
          assert.deepEqual((await accountPlan(context)).plan, newer);
          await context.close();
        },
      );
    } finally {
      await cleanup();
    }
  },
);
