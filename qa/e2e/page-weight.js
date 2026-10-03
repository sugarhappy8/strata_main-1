"use strict";

// What a signed-out visitor's browser downloads, and when: the photo frame for its screen, the homepage's exercise
// catalog only once the preview or rankings are needed, and Plan's full catalog only for its first setup guide.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const ROOT = join(__dirname, "..", "..");
const WAIT_MS = 10_000;
let app,
  browser,
  baseUrl,
  runtimeDir,
  logs = "";

async function startApp() {
  runtimeDir = mkdtempSync(join(tmpdir(), "strata-page-weight-e2e-"));
  app = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      NODE_ENV: "test",
      TZ: "UTC",
      TRUST_PROXY: "false",
      SECURE_COOKIES: "false",
      ADMIN_EMAIL: "",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtimeDir,
      EMAIL_VERIFICATION_ENABLED: "false",
      PADDLE_CHECKOUT_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseUrl = await new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`Page weight server timed out.\n${logs}`)),
      WAIT_MS,
    );
    for (const stream of [app.stdout, app.stderr])
      stream.on("data", (chunk) => {
        logs = (logs + chunk.toString()).slice(-16_384);
        const match = logs.match(/Strata running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          done(match[1]);
        }
      });
    app.once("exit", () => fail(new Error(`Page weight server exited.\n${logs}`)));
  });
}
async function cleanup() {
  try {
    await browser?.close();
  } finally {
    if (app && app.exitCode === null) {
      await new Promise((done) => {
        app.once("exit", done);
        app.kill("SIGTERM");
        setTimeout(() => app.kill("SIGKILL"), 1500).unref();
      });
    }
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  }
}
async function visitor(options) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    serviceWorkers: "block",
    reducedMotion: "reduce",
    ...options,
  });
  context.setDefaultTimeout(WAIT_MS);
  await context.route(/^https:\/\//, (route) => route.abort());
  const page = await context.newPage(),
    requested = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === baseUrl) requested.push(url.pathname);
  });
  const count = (path) => requested.filter((entry) => entry === path).length;
  const images = () => requested.filter((entry) => entry.startsWith("/images/"));
  return { context, page, requested, count, images };
}
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true };

test("each page downloads only what its visitor needs", { timeout: 90_000 }, async (t) => {
  try {
    await startApp();
    const launchOptions = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
      launchOptions.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    browser = await chromium.launch(launchOptions);

    await t.test("a phone gets the phone photo and the catalog once it heads down", async () => {
      const { context, page, count, images } = await visitor(phone);
      await page.goto("/", { waitUntil: "load" });
      await page.waitForLoadState("networkidle");
      assert.deepEqual(images(), ["/images/hero-training-960.avif"]);
      assert.equal(count("/exercises.json"), 0, "reading the hero downloads no exercise catalog");
      assert.equal(await page.locator("#quickPreviewSubmit").isDisabled(), true);
      const catalog = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/exercises.json",
      );
      await page.mouse.wheel(0, 400);
      assert.equal((await catalog).status(), 200);
      await page.waitForFunction(
        () => !globalThis.document.querySelector("#quickPreviewSubmit").disabled,
      );
      await page.locator("#rankings").scrollIntoViewIfNeeded();
      await page.locator("#exerciseList [data-detail]").first().waitFor();
      assert.equal(count("/exercises.json"), 1);
      assert.deepEqual(images(), ["/images/hero-training-960.avif"]);
      await context.close();
    });

    await t.test("a desktop gets the wide photo and no catalog at first paint", async () => {
      const { context, page, count, images } = await visitor({
        viewport: { width: 1440, height: 900 },
      });
      await page.goto("/", { waitUntil: "load" });
      await page.waitForLoadState("networkidle");
      assert.deepEqual(images(), ["/images/hero-training-1600.avif"]);
      assert.equal(count("/exercises.json"), 0);
      await context.close();
    });

    await t.test("/rankings opens the rankings with the catalog straight away", async () => {
      const { context, page, count } = await visitor(phone);
      await page.goto("/rankings", { waitUntil: "domcontentloaded" });
      assert.equal(new URL(page.url()).hash, "#rankings");
      await page.locator("#exerciseList [data-detail]").first().waitFor();
      assert.equal(count("/exercises.json"), 1);
      await context.close();
    });

    await t.test("Plan opens on the library and loads guides on demand", async () => {
      const { context, page, count } = await visitor(phone);
      await page.goto("/planner.html", { waitUntil: "domcontentloaded" });
      const guide = page.locator(".library-card [data-guide-exercise]");
      await guide.first().waitFor();
      await page.waitForLoadState("networkidle");
      assert.equal(count("/exercise-library.json"), 1);
      assert.equal(count("/exercises.json"), 0, "Plan's first paint has no guidance text");
      assert.equal(count("/discovery-core.js"), 0);
      await guide.first().click();
      await page.locator("#exerciseGuideDialog").waitFor({ state: "visible" });
      assert.match(await page.locator("#exerciseGuideBody").textContent(), /Technique cues/);
      await page.keyboard.press("Escape");
      await guide.nth(1).click();
      await page.locator("#exerciseGuideDialog").waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      assert.equal(count("/exercises.json"), 1);
      assert.equal(count("/discovery-core.js"), 1);
      await context.close();
    });
  } finally {
    await cleanup();
  }
});
