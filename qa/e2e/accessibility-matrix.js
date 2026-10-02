"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join, resolve: resolvePath } = require("node:path");
const { chromium, firefox, webkit } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;

const ROOT = join(__dirname, "..", ".."),
  RUNTIME_ROOT = join(ROOT, "test-runtime"),
  ALL_ENGINES = { chromium, firefox, webkit };
const requestedEngine = String(process.env.STRATA_E2E_ENGINE || "")
  .trim()
  .toLowerCase();
// Playwright's bundled Firefox cannot map its headless framebuffer from the
// Codex macOS app sandbox. Linux CI still runs the complete three-engine gate;
// an explicit STRATA_E2E_ENGINE=firefox keeps the local diagnostic available.
const defaultEngines =
  process.platform === "darwin" && !process.env.CI ? { chromium, webkit } : ALL_ENGINES;
const ENGINES =
    requestedEngine && ALL_ENGINES[requestedEngine]
      ? { [requestedEngine]: ALL_ENGINES[requestedEngine] }
      : defaultEngines,
  ROUTES = ["/", "/planner.html", "/pricing", "/policies", "/account.html"];
const debug = (message) => {
  if (process.env.STRATA_E2E_DEBUG === "1") process.stderr.write(`[accessibility] ${message}\n`);
};

function startServer(dataDirectory) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      TZ: "UTC",
      STRATA_DATA_DIR: dataDirectory,
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      TRUST_PROXY: "false",
      APP_BASE_URL: "",
      SECURE_COOKIES: "false",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      EMAIL_VERIFICATION_ENABLED: "false",
      EMAIL_VERIFICATION_SECRET: "",
      EMAIL_VERIFICATION_HMAC_SECRET: "",
      EMAIL_FROM: "",
      EMAIL_REPLY_TO: "",
      SUPPORT_EMAIL: "",
      RESEND_API_KEY: "",
      RESEND_API_BASE: "",
      ADMIN_EMAIL: "",
      PADDLE_CHECKOUT_ENABLED: "false",
      PADDLE_ENFORCE_IP_ALLOWLIST: "false",
      PADDLE_CLIENT_TOKEN: "",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "",
      PADDLE_PRODUCT_ID: "",
      PADDLE_PRICE_ID: "",
      PADDLE_API_BASE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "",
      settled = false;
    const timer = setTimeout(
      () => finish(new Error("Accessibility server startup timed out.")),
      8_000,
    );
    function finish(error, baseUrl) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ child, baseUrl });
    }
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", finish);
    child.once("exit", (code, signal) =>
      finish(
        new Error(`Accessibility server exited before startup (${code ?? signal ?? "unknown"}).`),
      ),
    );
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let timer;
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
  });
}

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

test(
  `${Object.keys(ENGINES).join(", ")} pass focused accessibility, keyboard, and 200% text checks`,
  { timeout: 240_000 },
  async () => {
    mkdirSync(RUNTIME_ROOT, { recursive: true });
    const runtimeDir = mkdtempSync(join(RUNTIME_ROOT, "accessibility-matrix-"));
    let server;
    try {
      server = await startServer(runtimeDir);
      for (const [engineName, engine] of Object.entries(ENGINES)) {
        debug(`${engineName}: launch`);
        const launchOptions = { headless: true, timeout: 20_000 };
        if (engineName === "chromium" && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
          launchOptions.executablePath = resolvePath(
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          );
        const browser = await engine.launch(launchOptions);
        try {
          const context = await browser.newContext({
              viewport: { width: 1280, height: 900 },
              reducedMotion: "reduce",
            }),
            page = await context.newPage();
          context.setDefaultTimeout(15_000);
          page.setDefaultNavigationTimeout(20_000);
          for (const route of ROUTES) {
            debug(`${engineName}: axe ${route}`);
            await page.goto(`${server.baseUrl}${route}`, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(150);
            assert.match(await page.title(), /STRATA/i, `${engineName} ${route} title`);
            const serious = (
              await new AxeBuilder({ page })
                .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
                .analyze()
            ).violations.filter(meaningfulViolation);
            assert.equal(
              serious.length,
              0,
              `${engineName} ${route} serious/critical axe violations:\n${violationSummary(serious)}`,
            );
          }

          debug(`${engineName}: keyboard`);
          await page.goto(`${server.baseUrl}/`, { waitUntil: "domcontentloaded" });
          await page.keyboard.press(engineName === "webkit" ? "Alt+Tab" : "Tab");
          assert.equal(
            await page
              .locator(".skip-link")
              .evaluate((node) => node === globalThis.document.activeElement),
            true,
            `${engineName} homepage starts with its skip link`,
          );
          await page.keyboard.press("Enter");
          assert.equal(
            await page
              .locator("#preview")
              .evaluate(
                (node) =>
                  node === globalThis.document.activeElement ||
                  node.contains(globalThis.document.activeElement),
              ),
            true,
            `${engineName} skip link reaches its named content`,
          );

          debug(`${engineName}: copy-day`);
          await page.goto(`${server.baseUrl}/planner.html`, { waitUntil: "domcontentloaded" });
          await page.locator("[data-quick-add]").first().waitFor({ state: "visible" });
          await page.locator("[data-quick-add]").first().click();
          await page.waitForFunction(
            () => globalThis.document.querySelector("#saveStatus")?.textContent === "Saved",
          );
          await page.locator("#planInsights > summary").click();
          assert.equal(
            await page.locator("#planInsights").evaluate((node) => node.open),
            true,
            `${engineName} expands Plan Evidence before using its copy controls`,
          );
          await page.locator("#copySourceDay").selectOption("Monday");
          await page.locator("#copyTargetDay").selectOption("Tuesday");
          await page.locator("#previewCopyDay").click();
          await page.locator("#copyDayDialog").waitFor({ state: "visible" });
          assert.match(
            await page.locator("#copyDayPreview").textContent(),
            /Destination now[\s\S]*After approval[\s\S]*New copies/,
          );
          assert.equal(
            await page
              .locator("#copyDayDialogTitle")
              .evaluate((node) => node === globalThis.document.activeElement),
            true,
            `${engineName} copy preview receives focus`,
          );
          await page.locator("#confirmCopyDay").check();
          await page.locator("#applyCopyDay").click();
          await page.waitForFunction(
            () => globalThis.document.querySelector("#saveStatus")?.textContent === "Saved",
          );
          assert.equal(
            await page.locator('[data-day="Tuesday"] [data-instance-id]').count(),
            1,
            `${engineName} applies only the reviewed day copy`,
          );

          for (const route of ["/", "/planner.html", "/pricing", "/account.html"]) {
            debug(`${engineName}: zoom ${route}`);
            await page.goto(`${server.baseUrl}${route}`, { waitUntil: "domcontentloaded" });
            await page.addStyleTag({ content: "html{font-size:200%!important}" });
            await page.waitForTimeout(100);
            const dimensions = await page.evaluate(() => ({
              documentClient: globalThis.document.documentElement.clientWidth,
              documentScroll: globalThis.document.documentElement.scrollWidth,
              bodyClient: globalThis.document.body.clientWidth,
              bodyScroll: globalThis.document.body.scrollWidth,
              bodyRect: globalThis.document.body.getBoundingClientRect().width,
            }));
            debug(`${engineName}: zoom dimensions ${JSON.stringify(dimensions)}`);
            const overflow = Math.max(0, dimensions.bodyScroll - dimensions.bodyClient);
            if (overflow > 1 && process.env.STRATA_E2E_DEBUG === "1") {
              const withoutPseudo = await page.evaluate(() => {
                const style = globalThis.document.createElement("style");
                style.textContent = "*::before,*::after{display:none!important}";
                globalThis.document.head.append(style);
                const result = {
                  bodyClient: globalThis.document.body.clientWidth,
                  bodyScroll: globalThis.document.body.scrollWidth,
                };
                style.remove();
                return result;
              });
              debug(`${engineName}: zoom without pseudo ${JSON.stringify(withoutPseudo)}`);
              const wideDetails = await page
                .locator(
                  "main,.rankings-section,.container,.rankings-shell,.ranking-main,.filter-bar,.select-wrap,.select-wrap select",
                )
                .evaluateAll((nodes) =>
                  nodes
                    .filter((node) => node.scrollWidth > node.clientWidth + 1)
                    .map((node) => ({
                      node: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${node.className ? `.${String(node.className).trim().replace(/\s+/g, ".")}` : ""}`,
                      client: node.clientWidth,
                      scroll: node.scrollWidth,
                      rect: node.getBoundingClientRect().width,
                      overflow: globalThis.getComputedStyle(node).overflowX,
                    })),
                );
              debug(`${engineName}: wide nodes ${JSON.stringify(wideDetails)}`);
            }
            const overflowSources =
              overflow > 1
                ? await page.locator("body *").evaluateAll((nodes) => {
                    const width = globalThis.document.documentElement.clientWidth,
                      label = (node) =>
                        `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${node.classList.length ? `.${[...node.classList].join(".")}` : ""}`;
                    const outside = nodes.filter((node) => {
                      const style = globalThis.getComputedStyle(node),
                        rect = node.getBoundingClientRect();
                      return (
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        rect.width > 0 &&
                        (rect.right > width + 1 || rect.left < -1)
                      );
                    });
                    const internallyWide = nodes.filter((node) => {
                      const style = globalThis.getComputedStyle(node);
                      return (
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        style.overflowX === "visible" &&
                        node.scrollWidth > node.clientWidth + 1
                      );
                    });
                    return [...new Set([...outside, ...internallyWide].slice(0, 8).map(label))];
                  })
                : [];
            assert.ok(
              overflow <= 1,
              `${engineName} ${route} overflows by ${overflow}px at 200% root text size (${overflowSources.join(", ") || "unknown source"})`,
            );
            const clippedControls = await page
              .locator("button,a,input,select,textarea")
              .evaluateAll((nodes) =>
                nodes
                  .filter((node) => {
                    const style = globalThis.getComputedStyle(node),
                      rect = node.getBoundingClientRect();
                    if (
                      rect.width < 1 ||
                      rect.height < 1 ||
                      style.visibility === "hidden" ||
                      style.display === "none"
                    )
                      return false;
                    return (
                      style.overflowY === "hidden" && node.scrollHeight > node.clientHeight + 2
                    );
                  })
                  .map((node) =>
                    (node.getAttribute("aria-label") || node.textContent || node.tagName)
                      .trim()
                      .slice(0, 80),
                  ),
              );
            assert.deepEqual(
              clippedControls,
              [],
              `${engineName} ${route} clips controls at 200% text: ${clippedControls.join(", ")}`,
            );
          }
          await context.close();
          debug(`${engineName}: complete`);
        } finally {
          await browser.close();
        }
      }
    } finally {
      await stopServer(server?.child);
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  },
);
