"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHmac } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");
const DAY_MS = 24 * 60 * 60 * 1000;
const { chromium } = require("playwright");

const PROJECT_ROOT = join(__dirname, "..", "..");
const PRODUCT_ID = "pro_01m1ky8j916ybyacs836dxbz8x";
const PRICE_ID = "pri_01monthlyfixture00000000000000";
const CLIENT_TOKEN = "live_e2e_browser_token_1234567890";
const API_KEY = "pdl_live_apikey_e2e_123456789012345678901234567890";
const WEBHOOK_SECRET = "pdl_ntfset_e2e_12345678901234567890";
const EMAIL_SECRET = "e2e-email-secret-123456789012345678901234567890";
const OLD_PASSWORD = "old-e2e-password-123";
const NEW_PASSWORD = "new-e2e-password-456";
const WAIT_MS = 10_000;
// The planner is ready once its shell stops being busy without a problem. It says nothing about saving until
// there is a change, so "Saved" means a change was saved, not that the page loaded.
function plannerReady(page) {
  return page.waitForFunction(() => {
    const doc = globalThis.document;
    return (
      doc.querySelector("#plannerShell")?.getAttribute("aria-busy") === "false" &&
      !doc.querySelector(".planner-header .header-center.error")
    );
  });
}

let app;
let appBaseUrl = "";
let appLogs = "";
let browser;
let provider;
let providerBaseUrl = "";
let runtimeDir = "";
let transactionSequence = 0;
let eventSequence = 0;
let browserContextSequence = 0;
const emailMessages = [];
const providerErrors = [];
const paddleTransactions = new Map();

function listen(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolvePromise(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}

async function requestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Fake-provider request exceeded 256 KiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function handleProviderRequest(req, res) {
  const url = new URL(req.url, "http://provider.test");
  const raw = await requestBody(req);
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {}

  if (req.method === "POST" && url.pathname === "/emails") {
    assert.ok(body && typeof body === "object", "Resend request must contain JSON.");
    emailMessages.push({ ...body, receivedAt: Date.now() });
    sendJson(res, 200, { id: `email_${String(emailMessages.length).padStart(6, "0")}` });
    return;
  }

  if (req.method === "POST" && url.pathname === "/transactions") {
    transactionSequence += 1;
    const id = `txn_${String(transactionSequence).padStart(26, "0")}`;
    const now = new Date().toISOString();
    const transaction = {
      id,
      status: "ready",
      customer_id: null,
      subscription_id: null,
      collection_mode: "automatic",
      origin: "api",
      created_at: now,
      updated_at: now,
      custom_data: body?.custom_data || null,
      items: [
        {
          quantity: Number(body?.items?.[0]?.quantity || 0),
          price: {
            id: body?.items?.[0]?.price_id || null,
            product_id: PRODUCT_ID,
            billing_cycle: { interval: "month", frequency: 1 },
            unit_price: { amount: "299", currency_code: "USD" },
          },
        },
      ],
    };
    paddleTransactions.set(id, transaction);
    sendJson(res, 201, { data: transaction });
    return;
  }

  const transactionId = url.pathname.match(/^\/transactions\/(txn_[a-z0-9]{26})$/)?.[1];
  if (req.method === "GET" && transactionId) {
    const transaction = paddleTransactions.get(transactionId);
    sendJson(
      res,
      transaction ? 200 : 404,
      transaction ? { data: transaction } : { error: { detail: "not found" } },
    );
    return;
  }

  sendJson(res, 404, { error: { detail: "not found" } });
}

async function startProvider() {
  provider = http.createServer((req, res) => {
    void handleProviderRequest(req, res).catch((error) => {
      providerErrors.push(error.stack || error.message);
      if (!res.headersSent) sendJson(res, 500, { error: { detail: "fake provider failed" } });
      else res.end();
    });
  });
  providerBaseUrl = `http://127.0.0.1:${await listen(provider)}`;
}

async function startApp() {
  const port = await unusedPort();
  appBaseUrl = `http://127.0.0.1:${port}`;
  runtimeDir = mkdtempSync(join(tmpdir(), "strata-high-risk-e2e-"));
  app = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
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
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "false",
      EMAIL_VERIFICATION_ENABLED: "true",
      EMAIL_VERIFICATION_SECRET: EMAIL_SECRET,
      EMAIL_FROM: "STRATA E2E <e2e@example.test>",
      EMAIL_REPLY_TO: "support@example.test",
      SUPPORT_EMAIL: "",
      APP_BASE_URL: appBaseUrl,
      RESEND_API_KEY: "re_e2e_123456789012345678901234567890",
      RESEND_API_BASE: providerBaseUrl,
      PADDLE_CHECKOUT_ENABLED: "true",
      PADDLE_PRODUCT_ID: PRODUCT_ID,
      PADDLE_PRICE_ID: PRICE_ID,
      PADDLE_CLIENT_TOKEN: CLIENT_TOKEN,
      PADDLE_API_KEY: API_KEY,
      PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PADDLE_API_BASE: providerBaseUrl,
      PADDLE_ENFORCE_IP_ALLOWLIST: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (chunk) => {
    appLogs = (appLogs + chunk.toString()).slice(-16_384);
  });
  app.stderr.on("data", (chunk) => {
    appLogs = (appLogs + chunk.toString()).slice(-16_384);
  });

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`STRATA exited during E2E startup.\n${appLogs}`);
    try {
      const response = await fetch(`${appBaseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`STRATA did not become healthy for E2E tests.\n${appLogs}`);
}

async function stopApp() {
  const child = app;
  app = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise) => {
    let softTimer,
      hardTimer,
      settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      child.off("exit", finish);
      resolvePromise();
    };
    child.once("exit", finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    softTimer = setTimeout(() => {
      hardTimer = setTimeout(finish, 2_000);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        finish();
      }
    }, 2_000);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

async function cleanupResources() {
  const errors = [];
  try {
    await browser?.close();
  } catch (error) {
    errors.push(error);
  } finally {
    browser = undefined;
    try {
      await stopApp();
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await closeServer(provider);
      } catch (error) {
        errors.push(error);
      } finally {
        provider = undefined;
        try {
          if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
        runtimeDir = "";
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "E2E cleanup failed.");
}

async function waitForEmail(afterIndex, predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const message = emailMessages.slice(afterIndex).find(predicate);
    if (message) return message;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(
    `Timed out waiting for ${label}. Received subjects: ${
      emailMessages
        .slice(afterIndex)
        .map(({ subject }) => subject)
        .join(", ") || "none"
    }`,
  );
}

function messageForAddress(message, email) {
  return (
    Array.isArray(message?.to) &&
    message.to.map((value) => String(value).toLowerCase()).includes(email.toLowerCase())
  );
}

function verificationCode(message) {
  const code = String(message?.text || "").match(/code is ([0-9]{6})\b/i)?.[1];
  assert.match(code || "", /^[0-9]{6}$/, "Verification email must contain a six-digit code.");
  return code;
}

function accountActionUrl(message, path) {
  const expression = new RegExp(`https?:\\/\\/[^\\s]+\\/${path}#token=[A-Za-z0-9_-]{43}`);
  const actionUrl = String(message?.text || "").match(expression)?.[0];
  assert.ok(actionUrl, `Account email must contain a ${path} fragment URL.`);
  assert.equal(
    new URL(actionUrl).origin,
    appBaseUrl,
    "Account links must target the isolated E2E server.",
  );
  return actionUrl;
}

async function newContext() {
  browserContextSequence += 1;
  const context = await browser.newContext({
    serviceWorkers: "block",
    extraHTTPHeaders: { "X-Forwarded-For": `198.51.100.${browserContextSequence}` },
  });
  context.setDefaultTimeout(WAIT_MS);
  await context.route(
    /^https:\/\/(?:cdn\.paddle\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//,
    (route) => route.abort(),
  );
  return context;
}

function watchPageErrors(page, errors) {
  page.on("pageerror", (error) =>
    errors.push(`${new URL(page.url()).pathname}: ${error.stack || error.message}`),
  );
}

async function goto(page, path) {
  await page.goto(path.startsWith("http") ? path : `${appBaseUrl}${path}`, {
    waitUntil: "domcontentloaded",
  });
}

async function completeVerification(page, email, afterIndex, subjectPattern) {
  const message = await waitForEmail(
    afterIndex,
    (candidate) =>
      messageForAddress(candidate, email) && subjectPattern.test(String(candidate.subject || "")),
    `${subjectPattern} email`,
  );
  await page.locator("#verificationCode").waitFor({ state: "visible" });
  await page.fill("#verificationCode", verificationCode(message));
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/planner.html", { timeout: WAIT_MS }),
    page.click("#verificationSubmit"),
  ]);
  await plannerReady(page);
}

async function createVerifiedAccount({ name, email, password = OLD_PASSWORD, errors }) {
  const context = await newContext();
  const page = await context.newPage();
  watchPageErrors(page, errors);
  await goto(page, "/account.html?mode=signup&next=planner");
  await page.locator("#signupForm").waitFor({ state: "visible" });
  await page.fill("#signupName", name);
  await page.fill("#signupEmail", email);
  await page.fill("#signupPassword", password);
  const emailIndex = emailMessages.length;
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/verify-email.html", { timeout: WAIT_MS }),
    page.click("#signupSubmit"),
  ]);
  await completeVerification(page, email, emailIndex, /STRATA verification code/i);
  return { context, page, email, password, name };
}

async function loginAccount({ email, password, errors }) {
  const context = await newContext();
  const page = await context.newPage();
  watchPageErrors(page, errors);
  await goto(page, "/account.html?mode=login&next=planner");
  await page.locator("#loginForm").waitFor({ state: "visible" });
  await page.fill("#loginEmail", email);
  await page.fill("#loginPassword", password);
  const loginResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/login",
  );
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/planner.html", {
      timeout: WAIT_MS,
      waitUntil: "domcontentloaded",
    }),
    page.click("#loginSubmit"),
  ]);
  assert.equal((await loginResponse).status(), 200);
  await plannerReady(page);
  return { context, page };
}

async function responseStatus(page, path) {
  return page.evaluate(
    async (requestPath) => (await fetch(requestPath, { credentials: "same-origin" })).status,
    path,
  );
}

function completedEvent(transaction, userId) {
  eventSequence += 1;
  const occurredAt = new Date().toISOString();
  return {
    event_id: `evt_${String(eventSequence).padStart(24, "0")}`,
    event_type: "transaction.completed",
    occurred_at: occurredAt,
    notification_id: `ntf_${String(eventSequence).padStart(24, "0")}`,
    data: {
      ...transaction,
      status: "completed",
      customer_id: "ctm_01m1ky8j916ybyacs836dxbz8x",
      subscription_id: `sub_${String(transaction.id).slice(4)}`,
      updated_at: occurredAt,
      custom_data: { ...transaction.custom_data, strata_user_id: userId, strata_version: 1 },
    },
  };
}

function subscriptionEvent(transaction, userId) {
  eventSequence += 1;
  const occurredAt = new Date().toISOString();
  return {
    event_id: `evt_${String(eventSequence).padStart(24, "0")}`,
    event_type: "subscription.created",
    occurred_at: occurredAt,
    notification_id: `ntf_${String(eventSequence).padStart(24, "0")}`,
    data: {
      id: `sub_${String(transaction.id).slice(4)}`,
      status: "active",
      customer_id: "ctm_01m1ky8j916ybyacs836dxbz8x",
      transaction_id: transaction.id,
      collection_mode: "automatic",
      custom_data: { strata_user_id: userId, strata_version: 1 },
      billing_cycle: { interval: "month", frequency: 1 },
      items: [
        {
          quantity: 1,
          recurring: true,
          price: {
            id: PRICE_ID,
            product_id: PRODUCT_ID,
            billing_cycle: { interval: "month", frequency: 1 },
          },
        },
      ],
      scheduled_change: null,
      current_billing_period: {
        starts_at: new Date(Date.now() - DAY_MS).toISOString(),
        ends_at: new Date(Date.now() + 31 * DAY_MS).toISOString(),
      },
      updated_at: occurredAt,
    },
  };
}

function signedWebhook(event) {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}:${raw}`).digest("hex");
  return { raw, signature: `ts=${timestamp};h1=${digest}` };
}

async function sendBrowserWebhook(page, signed) {
  return page.evaluate(async ({ raw, signature }) => {
    const response = await fetch("/api/paddle/webhook", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Paddle-Signature": signature },
      body: raw,
    });
    return { status: response.status, data: await response.json() };
  }, signed);
}

test("security-sensitive browser journeys", { timeout: 120_000 }, async (t) => {
  const pageErrors = [];

  await t.test(
    "login and password recovery revoke sessions and accept only the new password",
    async () => {
      const email = "recovery-e2e@example.test";
      const primary = await createVerifiedAccount({
        name: "Recovery E2E",
        email,
        errors: pageErrors,
      });
      const second = await loginAccount({ email, password: OLD_PASSWORD, errors: pageErrors });

      await goto(primary.page, "/forgot-password");
      await primary.page.locator("#forgotPasswordForm").waitFor({ state: "visible" });
      await primary.page.fill("#recoveryEmail", email);
      const resetEmailIndex = emailMessages.length;
      const resetResponsePromise = primary.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/password-reset/request",
      );
      await primary.page.click("#recoverySubmit");
      assert.equal((await resetResponsePromise).status(), 202);
      await primary.page.locator("#recoverySuccess").waitFor({ state: "visible" });
      const resetMessage = await waitForEmail(
        resetEmailIndex,
        (candidate) =>
          messageForAddress(candidate, email) &&
          /Reset your STRATA password/i.test(String(candidate.subject || "")),
        "password-reset email",
      );

      await goto(primary.page, accountActionUrl(resetMessage, "reset-password"));
      await primary.page.locator("#resetPasswordForm").waitFor({ state: "visible" });
      await primary.page.waitForFunction(
        () =>
          globalThis.document.activeElement === globalThis.document.querySelector("#newPassword"),
      );
      await primary.page.fill("#newPassword", NEW_PASSWORD);
      await primary.page.fill("#confirmPassword", NEW_PASSWORD);
      const resetComplete = primary.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/password-reset/complete",
      );
      await primary.page.click("#resetSubmit");
      assert.equal((await resetComplete).status(), 200);
      await primary.page.locator("#resetSuccess").waitFor({ state: "visible" });
      assert.equal(
        await responseStatus(second.page, "/api/me"),
        401,
        "Password reset must revoke a second browser session.",
      );

      const reloginContext = await newContext();
      const reloginPage = await reloginContext.newPage();
      watchPageErrors(reloginPage, pageErrors);
      await goto(reloginPage, "/account.html?mode=login&next=planner");
      await reloginPage.locator("#loginForm").waitFor({ state: "visible" });
      await reloginPage.fill("#loginEmail", email);
      await reloginPage.fill("#loginPassword", OLD_PASSWORD);
      const rejectedLogin = reloginPage.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/login",
      );
      await reloginPage.click("#loginSubmit");
      assert.equal(
        (await rejectedLogin).status(),
        401,
        "The old password must stop working immediately.",
      );
      await reloginPage.locator("#loginMessage").waitFor({ state: "visible" });
      assert.match((await reloginPage.locator("#loginMessage").textContent()) || "", /incorrect/i);

      await reloginPage.fill("#loginPassword", NEW_PASSWORD);
      const acceptedLogin = reloginPage.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/login",
      );
      await Promise.all([
        reloginPage.waitForURL((url) => url.pathname === "/planner.html", {
          timeout: WAIT_MS,
          waitUntil: "domcontentloaded",
        }),
        reloginPage.click("#loginSubmit"),
      ]);
      assert.equal((await acceptedLogin).status(), 200);
      await plannerReady(reloginPage);
      assert.equal(
        await responseStatus(reloginPage, "/api/me"),
        200,
        "The new password must restore access.",
      );

      await Promise.all([primary.context.close(), second.context.close(), reloginContext.close()]);
    },
  );

  await t.test(
    "plan conflict UI preserves both copies and saves only after explicit review",
    async () => {
      const email = "plan-conflict-e2e@example.test";
      const primary = await createVerifiedAccount({
        name: "Conflict E2E",
        email,
        errors: pageErrors,
      });
      const secondary = await loginAccount({ email, password: OLD_PASSWORD, errors: pageErrors });
      await Promise.all([
        goto(primary.page, "/planner.html"),
        goto(secondary.page, "/planner.html"),
      ]);
      await Promise.all([plannerReady(primary.page), plannerReady(secondary.page)]);

      const primaryButton = primary.page.locator("[data-quick-add]").nth(0);
      const secondaryButton = secondary.page.locator("[data-quick-add]").nth(1);
      const primaryId = await primaryButton.getAttribute("data-quick-add");
      const secondaryId = await secondaryButton.getAttribute("data-quick-add");
      const primaryName = (
        (await primaryButton.locator("xpath=ancestor::article[1]//h3").textContent()) || ""
      ).trim();
      const secondaryName = (
        (await secondaryButton.locator("xpath=ancestor::article[1]//h3").textContent()) || ""
      ).trim();
      assert.ok(
        primaryId && secondaryId && primaryId !== secondaryId,
        "The conflict fixture needs two distinct exercises.",
      );

      const firstSave = primary.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/plan" && response.request().method() === "PUT",
      );
      await primaryButton.click();
      assert.equal((await firstSave).status(), 200);
      await primary.page.waitForFunction(
        () => globalThis.document.querySelector("#saveStatus")?.textContent === "Saved",
      );

      const staleSave = secondary.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/plan" && response.request().method() === "PUT",
      );
      await secondaryButton.click();
      const conflictResponse = await staleSave;
      assert.equal(conflictResponse.status(), 409);
      const conflict = await conflictResponse.json();
      assert.equal(conflict.code, "PLAN_CHANGED");
      await secondary.page.locator("#planConflictPanel").waitFor({ state: "visible" });
      assert.match(
        (await secondary.page.locator("#latestPlanSummary").textContent()) || "",
        new RegExp(primaryName, "i"),
      );
      assert.match(
        (await secondary.page.locator("#localPlanSummary").textContent()) || "",
        new RegExp(secondaryName, "i"),
      );

      await secondary.page.click("#reviewLocalPlan");
      await secondary.page.locator("#retryPlanSave").waitFor({ state: "visible" });
      assert.match(
        (await secondary.page.locator("#retryPlanSave").textContent()) || "",
        /save reviewed changes/i,
      );
      const reviewedSavePromise = secondary.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/plan" && response.request().method() === "PUT",
      );
      await secondary.page.click("#retryPlanSave");
      const reviewedSave = await reviewedSavePromise;
      assert.equal(reviewedSave.status(), 200);
      assert.equal(
        reviewedSave.request().postDataJSON().expectedPlanUpdatedAt,
        conflict.planUpdatedAt,
        "Conflict recovery must bind the explicit overwrite to the newly loaded revision.",
      );
      await secondary.page.locator("#planConflictPanel").waitFor({ state: "hidden" });
      await secondary.page.waitForFunction(
        () => globalThis.document.querySelector("#saveStatus")?.textContent === "Saved",
      );

      const savedPlan = await secondary.page.evaluate(
        async () => await (await fetch("/api/plan", { credentials: "same-origin" })).json(),
      );
      const exerciseIds = Object.values(savedPlan.plan.days)
        .flat()
        .map((item) => item.exerciseId);
      assert.ok(exerciseIds.includes(secondaryId), "The reviewed local plan must be persisted.");
      assert.ok(
        !exerciseIds.includes(primaryId),
        "The latest account copy must not be silently merged into the chosen local copy.",
      );

      await Promise.all([primary.context.close(), secondary.context.close()]);
    },
  );

  await t.test(
    "signed Paddle payment and subscription grant durable browser entitlement and replay is idempotent",
    async () => {
      const email = "payment-e2e@example.test";
      const account = await createVerifiedAccount({
        name: "Payment E2E",
        email,
        errors: pageErrors,
      });
      const unpaidBeforeCheckout = await account.page.evaluate(
        async () => await (await fetch("/api/me", { credentials: "same-origin" })).json(),
      );
      assert.equal(
        unpaidBeforeCheckout.user.discovery.active,
        false,
        "A new account must start without paid entitlement.",
      );
      assert.equal(unpaidBeforeCheckout.user.discovery.accessType, null);
      await goto(account.page, "/discover.html");
      const lockedBeforeCheckout = new URL(account.page.url());
      assert.equal(
        lockedBeforeCheckout.pathname,
        "/pricing",
        "Strata+ must be protected before checkout.",
      );
      assert.equal(lockedBeforeCheckout.searchParams.get("reason"), "discovery-required");
      await goto(account.page, "/planner.html");
      await plannerReady(account.page);

      const checkout = await account.page.evaluate(async () => {
        const me = await (await fetch("/api/me", { credentials: "same-origin" })).json();
        const response = await fetch("/api/billing/checkout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrfToken },
          body: "{}",
        });
        return { status: response.status, data: await response.json(), userId: me.user.id };
      });
      assert.equal(checkout.status, 201);
      assert.match(checkout.data.transactionId, /^txn_[a-z0-9]{26}$/);
      const transaction = paddleTransactions.get(checkout.data.transactionId);
      assert.equal(
        transaction?.custom_data?.strata_user_id,
        checkout.userId,
        "Checkout creation must bind Paddle metadata to the signed-in account.",
      );
      assert.equal(transaction?.custom_data?.strata_version, 1);

      const unpaidAfterCheckout = await account.page.evaluate(
        async () => await (await fetch("/api/me", { credentials: "same-origin" })).json(),
      );
      assert.equal(
        unpaidAfterCheckout.user.discovery.active,
        false,
        "Creating checkout must not grant entitlement before a trusted webhook.",
      );
      assert.equal(unpaidAfterCheckout.user.discovery.accessType, null);
      await goto(account.page, "/discover.html");
      const lockedAfterCheckout = new URL(account.page.url());
      assert.equal(
        lockedAfterCheckout.pathname,
        "/pricing",
        "Strata+ must remain protected while payment is only pending.",
      );
      assert.equal(lockedAfterCheckout.searchParams.get("reason"), "discovery-required");
      await goto(account.page, "/planner.html");
      await plannerReady(account.page);

      const webhook = signedWebhook(completedEvent(transaction, checkout.userId));
      const recorded = await sendBrowserWebhook(account.page, webhook);
      assert.deepEqual(recorded, {
        status: 200,
        data: { ok: true, outcome: "subscription-payment-recorded" },
      });
      const replayed = await sendBrowserWebhook(account.page, webhook);
      assert.deepEqual(replayed, { status: 200, data: { ok: true, outcome: "replayed" } });

      const pending = await account.page.evaluate(
        async () => await (await fetch("/api/me", { credentials: "same-origin" })).json(),
      );
      assert.equal(
        pending.user.discovery.active,
        false,
        "A completed recurring payment must not grant access before the matching subscription snapshot.",
      );
      const subscription = signedWebhook(subscriptionEvent(transaction, checkout.userId));
      const granted = await sendBrowserWebhook(account.page, subscription);
      assert.deepEqual(granted, {
        status: 200,
        data: { ok: true, outcome: "subscription-created" },
      });
      const subscriptionReplay = await sendBrowserWebhook(account.page, subscription);
      assert.deepEqual(subscriptionReplay, {
        status: 200,
        data: { ok: true, outcome: "replayed" },
      });

      const me = await account.page.evaluate(
        async () => await (await fetch("/api/me", { credentials: "same-origin" })).json(),
      );
      assert.equal(me.user.discovery.active, true);
      assert.equal(me.user.discovery.accessType, "paid");
      await goto(account.page, "/discover.html");
      assert.equal(
        new URL(account.page.url()).pathname,
        "/discover.html",
        "A signed webhook must unlock the protected Strata+ page.",
      );
      await account.page.waitForFunction(
        (name) => globalThis.document.querySelector("#userName")?.textContent === name,
        "Payment E2E",
      );
      assert.equal(await account.page.locator("#discoveryLoadError").isHidden(), true);

      await account.context.close();
    },
  );

  await t.test(
    "account deletion requires the emailed one-time link and removes login access",
    async () => {
      const email = "deletion-e2e@example.test";
      const account = await createVerifiedAccount({
        name: "Deletion E2E",
        email,
        errors: pageErrors,
      });
      await goto(account.page, "/account.html");
      await account.page.locator("#signedInCard").waitFor({ state: "visible" });
      const deleteEmailIndex = emailMessages.length;
      const requestPromise = account.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/account/delete/request",
      );
      await account.page.click("#accountDeleteRequest");
      assert.equal((await requestPromise).status(), 202);
      await account.page.waitForFunction(
        () =>
          /nothing is deleted until/i.test(
            globalThis.document.querySelector("#accountSecurityStatus")?.textContent || "",
          ),
        undefined,
        { timeout: WAIT_MS },
      );
      assert.match(
        (await account.page.locator("#accountSecurityStatus").textContent()) || "",
        /nothing is deleted until/i,
      );
      const deletionMessage = await waitForEmail(
        deleteEmailIndex,
        (candidate) =>
          messageForAddress(candidate, email) &&
          /Confirm deletion of your STRATA account/i.test(String(candidate.subject || "")),
        "account-deletion email",
      );
      const deletionUrl = accountActionUrl(deletionMessage, "delete-account");

      await goto(account.page, "/");
      await goto(account.page, deletionUrl);
      await account.page.locator("#deleteAccountForm").waitFor({ state: "visible" });
      await account.page.fill("#deleteConfirmation", "DELETE");
      const deletePromise = account.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/account/delete/complete",
      );
      await account.page.click("#deleteSubmit");
      assert.equal((await deletePromise).status(), 200);
      await account.page.locator("#deleteSuccess").waitFor({ state: "visible" });
      assert.equal(
        await responseStatus(account.page, "/api/me"),
        401,
        "Deleting an account must revoke its browser session.",
      );

      await goto(account.page, "/");
      const replayStatusPromise = account.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/account/delete/status",
      );
      await goto(account.page, deletionUrl);
      const replayStatus = await replayStatusPromise;
      assert.equal(replayStatus.status(), 200);
      assert.equal(
        (await replayStatus.json()).active,
        false,
        "A consumed deletion token must be inactive.",
      );
      await account.page.locator("#deleteUnavailable").waitFor({ state: "visible" });

      const rejectedContext = await newContext();
      const rejectedPage = await rejectedContext.newPage();
      watchPageErrors(rejectedPage, pageErrors);
      await goto(rejectedPage, "/account.html?mode=login&next=planner");
      await rejectedPage.locator("#loginForm").waitFor({ state: "visible" });
      await rejectedPage.fill("#loginEmail", email);
      await rejectedPage.fill("#loginPassword", OLD_PASSWORD);
      const rejectedLogin = rejectedPage.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/login",
      );
      await rejectedPage.click("#loginSubmit");
      assert.equal((await rejectedLogin).status(), 401, "A deleted account must not authenticate.");
      await rejectedPage.locator("#loginMessage").waitFor({ state: "visible" });

      await Promise.all([account.context.close(), rejectedContext.close()]);
    },
  );

  assert.deepEqual(providerErrors, [], `Fake provider errors:\n${providerErrors.join("\n")}`);
  assert.deepEqual(pageErrors, [], `Browser page errors:\n${pageErrors.join("\n")}`);
});

test.before(async () => {
  await startProvider();
  try {
    await startApp();
    const launchOptions = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
      launchOptions.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    try {
      await cleanupResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "E2E setup and cleanup failed.", {
        cause: cleanupError,
      });
    }
    throw error;
  }
});

test.after(cleanupResources);
