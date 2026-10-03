"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createHmac } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PROJECT_ROOT = join(__dirname, "..");

const PRODUCT_ID = "pro_01m1ky8j916ybyacs836dxbz8x";
const PRICE_ID = "pri_01monthlyfixture00000000000000";
const PREVIOUS_PRODUCT_ID = "pro_01previousmonthly000000000000";
const PREVIOUS_PRICE_ID = "pri_01previousmonthly0000000000000";
const CLIENT_TOKEN = "live_browser_token_for_server_payment_test";
const API_KEY = "pdl_live_apikey_01serverpaymentfixture0000_fixture_secret_123";
const WEBHOOK_SECRET = "pdl_ntfset_live_server_payment_test_secret";
const DAY_MS = 24 * 60 * 60 * 1000;
const BILLING_CLOCK = Date.now();
const INITIAL_PERIOD_START_AT = new Date(BILLING_CLOCK - DAY_MS).toISOString();
const INITIAL_PERIOD_END_AT = new Date(BILLING_CLOCK + 31 * DAY_MS).toISOString();
const RENEWAL_PERIOD_START_AT = INITIAL_PERIOD_END_AT;
const RENEWAL_PERIOD_END_AT = new Date(BILLING_CLOCK + 62 * DAY_MS).toISOString();

let app;
let fakePaddle;
let runtimeDir;
let BASE;
let PADDLE_BASE;
let transactionSequence = 0;
let malformedCreateResponses = 0;
let createResponseHook = null,
  cancelFailure = false,
  draftRetirementFailure = false;
const paddleRequests = [];
const paddleTransactions = new Map();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function startFakePaddle() {
  fakePaddle = http.createServer(async (req, res) => {
    const raw = await readRequest(req);
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (req.method === "GET" && req.url === "/ips") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { ipv4_cidrs: ["34.232.58.13/32"] } }));
      return;
    }
    paddleRequests.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body,
      raw,
    });
    const requestUrl = new URL(req.url, "http://paddle.test");
    if (req.method === "GET" && requestUrl.pathname === "/transactions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [...paddleTransactions.values()].reverse(),
          meta: { pagination: { has_more: false, next: null } },
        }),
      );
      return;
    }
    const transactionMatch = requestUrl.pathname.match(/^\/transactions\/(txn_[a-z0-9]+)$/);
    if (req.method === "GET" && transactionMatch) {
      const transaction = paddleTransactions.get(transactionMatch[1]);
      res.writeHead(transaction ? 200 : 404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(transaction ? { data: transaction } : { error: { detail: "not found" } }),
      );
      return;
    }
    if (req.method === "PATCH" && transactionMatch) {
      const transaction = paddleTransactions.get(transactionMatch[1]);
      const cancellation =
        transaction &&
        ["ready", "billed"].includes(transaction.status) &&
        body?.status === "canceled" &&
        !cancelFailure;
      const draftRetirement =
        transaction?.status === "draft" &&
        body?.collection_mode === "manual" &&
        body?.billing_details?.enable_checkout === false &&
        body?.custom_data === null &&
        !draftRetirementFailure;
      const allowed = cancellation || draftRetirement;
      if (cancellation) transaction.status = "canceled";
      if (draftRetirement) {
        transaction.collection_mode = "manual";
        transaction.billing_details = body.billing_details;
        transaction.custom_data = null;
        transaction.checkout = null;
      }
      if (allowed) transaction.updated_at = new Date().toISOString();
      res.writeHead(allowed ? 200 : 409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          allowed
            ? { data: transaction }
            : {
                error: {
                  detail: draftRetirementFailure
                    ? "cannot retire current draft"
                    : "cannot cancel current state",
                },
              },
        ),
      );
      return;
    }
    const portalMatch = requestUrl.pathname.match(
      /^\/customers\/(ctm_[a-z0-9]+)\/portal-sessions$/,
    );
    if (req.method === "POST" && portalMatch) {
      const subscriptionId = body?.subscription_ids?.[0];
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            customer_id: portalMatch[1],
            urls: {
              general: { overview: "https://customer-portal.paddle.com/cpl_overviewfixture" },
              subscriptions: [
                {
                  id: subscriptionId,
                  cancel_subscription: "https://customer-portal.paddle.com/cpl_cancelfixture",
                  update_subscription_payment_method:
                    "https://customer-portal.paddle.com/cpl_paymentfixture",
                },
              ],
            },
          },
        }),
      );
      return;
    }
    if (req.method !== "POST" || requestUrl.pathname !== "/transactions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { detail: "not found" } }));
      return;
    }
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
    const createResponse = structuredClone(transaction);
    if (createResponseHook) {
      const hook = createResponseHook;
      createResponseHook = null;
      await hook(transaction);
    }
    res.writeHead(201, { "Content-Type": "application/json" });
    if (malformedCreateResponses > 0) {
      malformedCreateResponses -= 1;
      res.end(JSON.stringify({ data: { id, status: "not-a-paddle-status" } }));
      return;
    }
    res.end(JSON.stringify({ data: createResponse }));
  });
  PADDLE_BASE = await listen(fakePaddle);
}

async function stopHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function startApp() {
  mkdirSync(join(PROJECT_ROOT, "test-runtime"), { recursive: true });
  runtimeDir = mkdtempSync(join(PROJECT_ROOT, "test-runtime", "server-payments-"));
  app = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      ADMIN_EMAIL: "billing-admin@example.test",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      TRUST_PROXY: "true",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtimeDir,
      PADDLE_PRODUCT_ID: PRODUCT_ID,
      PADDLE_PRICE_ID: PRICE_ID,
      PADDLE_CLIENT_TOKEN: CLIENT_TOKEN,
      PADDLE_API_KEY: API_KEY,
      PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PADDLE_CHECKOUT_ENABLED: "true",
      PADDLE_ENFORCE_IP_ALLOWLIST: "true",
      PADDLE_API_BASE: PADDLE_BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  BASE = await new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Server startup timed out. ${errors}`)), 5000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    app.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    });
    app.stderr.on("data", (chunk) => {
      errors = (errors + chunk.toString()).slice(-4096);
    });
    app.once("error", finish);
    app.once("exit", (code, signal) =>
      finish(new Error(`Server exited before startup (${code ?? signal ?? "unknown"}). ${errors}`)),
    );
  });
}

async function stopApp() {
  const child = app;
  app = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      let timer;
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    });
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return {
    response,
    data,
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}

async function signup({ name, email, password }) {
  const result = await request("/api/signup", {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  assert.equal(result.response.status, 201);
  assert.ok(result.cookie.startsWith("strata_session="));
  const me = await request("/api/me", { headers: { Cookie: result.cookie } });
  assert.equal(me.response.status, 200);
  assert.ok(me.data.csrfToken);
  return { cookie: result.cookie, user: me.data.user, csrfToken: me.data.csrfToken };
}

async function checkout(account) {
  return request("/api/billing/checkout", {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      Origin: BASE,
      "X-CSRF-Token": account.csrfToken,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
}

function database(options = {}) {
  // The child server may still be releasing its checkout claim after sending a response.
  // Match its bounded lock wait instead of failing a fixture write on transient contention.
  return new DatabaseSync(join(runtimeDir, "strata.sqlite"), { timeout: 5000, ...options });
}

// The server releases its checkout claim just after it sends the checkout response.
// Fixtures that seed their own claim wait for that release instead of racing it.
async function checkoutClaimReleased(userId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const db = database({ readOnly: true }),
      row = db
        .prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?")
        .get(userId);
    db.close();
    if (!row?.count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("the server did not release its checkout claim");
}

function eventId(label, sequence) {
  const safe = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return `evt_${safe}${String(sequence).padStart(24 - safe.length, "0")}`;
}

function subscriptionId(transactionId) {
  return `sub_${String(transactionId).slice(4)}`;
}

function completedEvent({
  id,
  transactionId,
  userId,
  priceId = PRICE_ID,
  productId = PRODUCT_ID,
  billingCycle = { interval: "month", frequency: 1 },
}) {
  const occurredAt = new Date().toISOString();
  return {
    event_id: id,
    event_type: "transaction.completed",
    occurred_at: occurredAt,
    notification_id: `ntf_${id.slice(4)}`,
    data: {
      id: transactionId,
      status: "completed",
      customer_id: "ctm_00000000000000000000000001",
      subscription_id: subscriptionId(transactionId),
      collection_mode: "automatic",
      origin: "api",
      updated_at: occurredAt,
      custom_data: {
        strata_user_id: userId,
        strata_checkout_id: paddleTransactions.get(transactionId)?.custom_data?.strata_checkout_id,
        strata_version: 1,
      },
      items: [
        {
          quantity: 1,
          price: { id: priceId, product_id: productId, billing_cycle: billingCycle },
        },
      ],
      details: { totals: { subtotal: "299", discount: "299", tax: "0", total: "0" } },
    },
  };
}

function subscriptionEvent({
  id,
  transactionId,
  userId,
  status = "active",
  sequence = 0,
  scheduledChange = null,
  eventType = "subscription.created",
  priceId = PRICE_ID,
  productId = PRODUCT_ID,
  billingCycle = { interval: "month", frequency: 1 },
  customerId = "ctm_00000000000000000000000001",
  periodStartsAt = INITIAL_PERIOD_START_AT,
  periodEndsAt = INITIAL_PERIOD_END_AT,
}) {
  const occurredAt = new Date(Date.now() + sequence * 1_000).toISOString();
  return {
    event_id: id,
    event_type: eventType,
    occurred_at: occurredAt,
    notification_id: `ntf_${id.slice(4)}`,
    data: {
      id: subscriptionId(transactionId),
      status,
      customer_id: customerId,
      ...(eventType === "subscription.created" ? { transaction_id: transactionId } : {}),
      collection_mode: "automatic",
      custom_data: { strata_user_id: userId, strata_version: 1 },
      billing_cycle: billingCycle,
      items: [
        {
          quantity: 1,
          recurring: true,
          price: { id: priceId, product_id: productId, billing_cycle: billingCycle },
        },
      ],
      scheduled_change: scheduledChange,
      current_billing_period: ["active", "trialing", "past_due"].includes(status)
        ? { starts_at: periodStartsAt, ends_at: periodEndsAt }
        : null,
      updated_at: occurredAt,
    },
  };
}

function transactionStatusEvent({ id, transactionId, eventType, status }) {
  const occurredAt = new Date().toISOString();
  return {
    event_id: id,
    event_type: eventType,
    occurred_at: occurredAt,
    notification_id: `ntf_${id.slice(4)}`,
    data: { id: transactionId, status, updated_at: occurredAt },
  };
}

function adjustmentEvent({ id, adjustmentId, transactionId, type, status, sequence }) {
  return {
    event_id: id,
    event_type: sequence % 2 === 0 ? "adjustment.updated" : "adjustment.created",
    occurred_at: new Date(Date.now() + sequence).toISOString(),
    notification_id: `ntf_${id.slice(4)}`,
    data: {
      id: adjustmentId,
      transaction_id: transactionId,
      action: "refund",
      type,
      status,
    },
  };
}

function signedWebhook(event, { signature, source = "34.232.58.13" } = {}) {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}:${raw}`).digest("hex");
  return request("/api/paddle/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Paddle-Signature": `ts=${timestamp};h1=${signature ?? digest}`,
      "X-Forwarded-For": source,
    },
    body: raw,
  });
}

test.before(async () => {
  await startFakePaddle();
  try {
    await startApp();
  } catch (error) {
    await stopHttpServer(fakePaddle);
    throw error;
  }
});

test.after(async () => {
  await stopApp();
  await stopHttpServer(fakePaddle);
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
});

test("live monthly checkout grants, manages, updates, and revokes Strata+ securely", async () => {
  const pricing = await request("/pricing");
  assert.equal(pricing.response.status, 200);
  const csp = pricing.response.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src[^;]*https:\/\/cdn\.paddle\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/\*\.paddle\.com/);
  assert.match(csp, /frame-src[^;]*https:\/\/\*\.paddle\.com/);

  const status = await request("/api/status");
  assert.equal(status.response.status, 200);
  assert.deepEqual(
    Object.keys(status.data).sort(),
    ["ok", "version"],
    "payment and webhook setup is not public",
  );
  const config = await request("/api/billing/config");
  assert.equal(config.response.status, 200);
  assert.deepEqual(config.data, {
    environment: "live",
    enabled: true,
    configured: true,
    productId: PRODUCT_ID,
    priceId: PRICE_ID,
    clientToken: CLIENT_TOKEN,
    price: { amount: "2.99", currency: "USD", interval: "month", frequency: 1 },
  });
  for (const publicValue of [
    pricing.data,
    JSON.stringify(status.data),
    JSON.stringify(config.data),
  ]) {
    assert.doesNotMatch(publicValue, new RegExp(API_KEY));
    assert.doesNotMatch(publicValue, new RegExp(WEBHOOK_SECRET));
    assert.doesNotMatch(publicValue, /PADDLE_API_KEY|PADDLE_WEBHOOK_SECRET/);
  }

  const account = await signup({
    name: "Live Payment Tester",
    email: "live-payments@example.test",
    password: "live-payment-password-123",
  });
  assert.equal(account.user.discovery.active, false);

  const unpaidPage = await request("/discover.html", {
    headers: { Cookie: account.cookie },
    redirect: "manual",
  });
  assert.equal(unpaidPage.response.status, 302);
  assert.equal(unpaidPage.response.headers.get("location"), "/pricing?reason=discovery-required");
  const unpaidApi = await request("/api/discovery", { headers: { Cookie: account.cookie } });
  assert.equal(unpaidApi.response.status, 402);
  assert.equal(unpaidApi.data.code, "DISCOVERY_ACCESS_REQUIRED");
  const plannerPage = await request("/planner.html", { headers: { Cookie: account.cookie } });
  assert.equal(plannerPage.response.status, 200, "the planner remains free for signed-in accounts");
  const plannerApi = await request("/api/plan", { headers: { Cookie: account.cookie } });
  assert.equal(plannerApi.response.status, 200);

  const noCsrf = await request("/api/billing/checkout", {
    method: "POST",
    headers: { Cookie: account.cookie, Origin: BASE, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.data.code, "INVALID_CSRF");
  const wrongCsrf = await request("/api/billing/checkout", {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      Origin: BASE,
      "X-CSRF-Token": "wrong-token",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(wrongCsrf.response.status, 403);
  assert.equal(paddleRequests.length, 0, "invalid CSRF must not call Paddle");

  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);
  assert.match(prepared.data.transactionId, /^txn_[a-z0-9]{26}$/);
  assert.equal(paddleRequests.length, 1);
  const paddleRequest = paddleRequests[0];
  assert.equal(paddleRequest.method, "POST");
  assert.equal(paddleRequest.url, "/transactions");
  assert.equal(paddleRequest.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(paddleRequest.body.collection_mode, "automatic");
  assert.deepEqual(paddleRequest.body.items, [{ price_id: PRICE_ID, quantity: 1 }]);
  assert.equal(paddleRequest.body.custom_data.strata_user_id, account.user.id);
  assert.equal(paddleRequest.body.custom_data.strata_version, 1);
  assert.match(
    paddleRequest.body.custom_data.strata_checkout_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  const reused = await checkout(account);
  assert.equal(reused.response.status, 200);
  assert.equal(reused.data.transactionId, prepared.data.transactionId);
  assert.equal(reused.data.reused, true);
  assert.equal(paddleRequests.length, 1, "a fresh pending transaction should be reused");

  const completion = completedEvent({
    id: eventId("completed", 1),
    transactionId: prepared.data.transactionId,
    userId: account.user.id,
  });
  assert.equal(
    completion.data.details.totals.total,
    "0",
    "fixture exercises a real 100%-discount checkout",
  );
  const rejectedSource = await signedWebhook(completion, { source: "203.0.113.9" });
  assert.equal(rejectedSource.response.status, 403);
  assert.equal(
    (await request("/api/me", { headers: { Cookie: account.cookie } })).data.user.discovery.active,
    false,
  );
  const recorded = await signedWebhook(completion);
  assert.equal(recorded.response.status, 200);
  assert.equal(recorded.data.outcome, "subscription-payment-recorded");
  assert.equal(
    (await request("/api/me", { headers: { Cookie: account.cookie } })).data.user.discovery.active,
    false,
    "the transaction alone cannot grant recurring access",
  );
  const duplicateBarrier = await checkout(account);
  assert.equal(duplicateBarrier.response.status, 409);
  assert.equal(duplicateBarrier.data.code, "CHECKOUT_PENDING_CONFIRMATION");

  const createdSubscription = subscriptionEvent({
    id: eventId("subcreate", 1),
    transactionId: prepared.data.transactionId,
    userId: account.user.id,
    sequence: 1,
  });
  const granted = await signedWebhook(createdSubscription);
  assert.equal(granted.response.status, 200);
  assert.equal(granted.data.outcome, "subscription-created");
  const paidTrial = await request("/api/discovery/trial", {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      Origin: BASE,
      "X-CSRF-Token": account.csrfToken,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(paidTrial.response.status, 404, "there is no free trial route for any account");

  const subscriptionStatus = await request("/api/billing/subscription", {
    headers: { Cookie: account.cookie },
  });
  assert.equal(subscriptionStatus.response.status, 200);
  assert.equal(subscriptionStatus.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(subscriptionStatus.data.subscription, {
    id: subscriptionId(prepared.data.transactionId),
    status: "active",
    active: true,
    pastDue: false,
    scheduledChange: null,
    currentPeriodEndsAt: Date.parse(INITIAL_PERIOD_END_AT),
  });
  {
    const db = database();
    db.prepare(
      "UPDATE paddle_subscriptions SET current_period_ends_at=? WHERE subscription_id=?",
    ).run(Date.now() - 1, subscriptionId(prepared.data.transactionId));
    db.close();
  }
  assert.equal(
    (await request("/api/me", { headers: { Cookie: account.cookie } })).data.user.discovery.active,
    false,
    "an expired cached provider period must fail closed",
  );
  assert.equal(
    (await request("/api/billing/subscription", { headers: { Cookie: account.cookie } })).data
      .subscription.active,
    false,
    "subscription summary must match effective entitlement",
  );
  {
    const db = database();
    db.prepare(
      "UPDATE paddle_subscriptions SET current_period_ends_at=? WHERE subscription_id=?",
    ).run(Date.parse(INITIAL_PERIOD_END_AT), subscriptionId(prepared.data.transactionId));
    db.close();
  }
  const managed = await request("/api/billing/portal", {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      Origin: BASE,
      "X-CSRF-Token": account.csrfToken,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(managed.response.status, 200);
  assert.equal(managed.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(
    {
      overviewUrl: managed.data.overviewUrl,
      cancelUrl: managed.data.cancelUrl,
      updatePaymentMethodUrl: managed.data.updatePaymentMethodUrl,
    },
    {
      overviewUrl: "https://customer-portal.paddle.com/cpl_overviewfixture",
      cancelUrl: "https://customer-portal.paddle.com/cpl_cancelfixture",
      updatePaymentMethodUrl: "https://customer-portal.paddle.com/cpl_paymentfixture",
    },
  );

  const scheduledCancel = await signedWebhook(
    subscriptionEvent({
      id: eventId("subcancel", 2),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
      eventType: "subscription.updated",
      sequence: 2,
      scheduledChange: { action: "cancel", effective_at: INITIAL_PERIOD_END_AT },
    }),
  );
  assert.equal(scheduledCancel.data.outcome, "subscription-updated");
  const scheduledMe = await request("/api/me", { headers: { Cookie: account.cookie } });
  assert.equal(
    scheduledMe.data.user.discovery.active,
    true,
    "cancel-at-period-end remains entitled while Paddle reports active",
  );
  assert.equal(scheduledMe.data.user.discovery.subscription.scheduledChange.action, "cancel");

  const pastDue = await signedWebhook(
    subscriptionEvent({
      id: eventId("subdue", 3),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
      eventType: "subscription.updated",
      status: "past_due",
      sequence: 3,
    }),
  );
  assert.equal(pastDue.data.outcome, "subscription-updated");
  const pastDueMe = await request("/api/me", { headers: { Cookie: account.cookie } });
  assert.equal(pastDueMe.data.user.discovery.active, true);
  assert.equal(pastDueMe.data.user.discovery.subscription.pastDue, true);

  const paused = await signedWebhook(
    subscriptionEvent({
      id: eventId("subpause", 4),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
      eventType: "subscription.updated",
      status: "paused",
      sequence: 4,
    }),
  );
  assert.equal(paused.data.outcome, "subscription-updated");
  assert.equal(
    (await request("/api/me", { headers: { Cookie: account.cookie } })).data.user.discovery.active,
    false,
    "paused subscriptions lose access",
  );
  const pausedReplacement = await checkout(account);
  assert.equal(
    pausedReplacement.response.status,
    409,
    "a paused subscription must be managed instead of duplicated",
  );
  assert.equal(pausedReplacement.data.code, "SUBSCRIPTION_ACTIVE");
  const resumed = await signedWebhook(
    subscriptionEvent({
      id: eventId("subresume", 5),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
      eventType: "subscription.updated",
      sequence: 5,
    }),
  );
  assert.equal(resumed.data.outcome, "subscription-updated");
  const wrongCustomer = await signedWebhook(
    subscriptionEvent({
      id: eventId("subctm", 6),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
      eventType: "subscription.updated",
      sequence: 6,
      customerId: "ctm_00000000000000000000000099",
    }),
  );
  assert.equal(
    wrongCustomer.data.outcome,
    "rejected:customer",
    "subscription updates cannot replace the verified customer link",
  );
  const staleCancel = await signedWebhook(
    subscriptionEvent({
      id: eventId("substale", 6),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
      eventType: "subscription.updated",
      status: "canceled",
      sequence: 3,
    }),
  );
  assert.equal(
    staleCancel.data.outcome,
    "subscription-stale",
    "out-of-order cancellation cannot override newer state",
  );
  assert.equal(
    (await request("/api/me", { headers: { Cookie: account.cookie } })).data.user.discovery.active,
    true,
  );

  const invalidTimestamp = subscriptionEvent({
    id: eventId("subtime", 7),
    transactionId: prepared.data.transactionId,
    userId: account.user.id,
    eventType: "subscription.updated",
    sequence: 7,
  });
  invalidTimestamp.occurred_at = "not-a-provider-timestamp";
  const rejectedTimestamp = await signedWebhook(invalidTimestamp);
  assert.equal(
    rejectedTimestamp.response.status,
    400,
    "malformed ordering data must not advance subscription state",
  );

  const unlocked = await request("/api/discovery", { headers: { Cookie: account.cookie } });
  assert.equal(unlocked.response.status, 200);
  const unlockedPage = await request("/discover.html", {
    headers: { Cookie: account.cookie },
    redirect: "manual",
  });
  assert.equal(unlockedPage.response.status, 200);
  assert.equal(
    (await request("/api/workouts", { headers: { Cookie: account.cookie } })).response.status,
    200,
  );
  for (const page of ["/workout.html", "/onboarding.html"])
    assert.equal(
      (await request(page, { headers: { Cookie: account.cookie }, redirect: "manual" })).response
        .status,
      200,
    );

  const secondDevice = await request("/api/login", {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "live-payments@example.test",
      password: "live-payment-password-123",
    }),
  });
  assert.equal(secondDevice.response.status, 200);
  assert.notEqual(secondDevice.cookie, account.cookie);
  const secondDeviceMe = await request("/api/me", { headers: { Cookie: secondDevice.cookie } });
  assert.equal(secondDeviceMe.response.status, 200);
  assert.equal(
    secondDeviceMe.data.user.discovery.active,
    true,
    "the Turso/SQLite entitlement belongs to the account, not one browser session",
  );
  const secondDeviceDiscovery = await request("/api/discovery", {
    headers: { Cookie: secondDevice.cookie },
  });
  assert.equal(secondDeviceDiscovery.response.status, 200);

  const replay = await signedWebhook(completion);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.outcome, "replayed");
  const replayDatabase = database({ readOnly: true });
  assert.equal(
    replayDatabase
      .prepare("SELECT COUNT(*) AS count FROM paddle_webhook_events WHERE event_id=?")
      .get(completion.event_id).count,
    1,
  );
  assert.equal(
    replayDatabase
      .prepare("SELECT COUNT(*) AS count FROM paddle_purchases WHERE transaction_id=?")
      .get(prepared.data.transactionId).count,
    1,
  );
  assert.equal(
    replayDatabase
      .prepare("SELECT COUNT(*) AS count FROM paddle_subscriptions WHERE subscription_id=?")
      .get(subscriptionId(prepared.data.transactionId)).count,
    1,
  );
  replayDatabase.close();

  const invalidAccount = await signup({
    name: "Invalid Signature Tester",
    email: "invalid-signature@example.test",
    password: "invalid-signature-password-123",
  });
  const invalidPrepared = await checkout(invalidAccount);
  assert.equal(invalidPrepared.response.status, 201);
  const invalidCompletion = completedEvent({
    id: eventId("invalid", 2),
    transactionId: invalidPrepared.data.transactionId,
    userId: invalidAccount.user.id,
  });
  const invalidSignature = await signedWebhook(invalidCompletion, { signature: "0".repeat(64) });
  assert.equal(invalidSignature.response.status, 400);
  const stillLocked = await request("/api/discovery", {
    headers: { Cookie: invalidAccount.cookie },
  });
  assert.equal(
    stillLocked.response.status,
    402,
    "an unverified notification must never grant access",
  );

  const pendingRefund = adjustmentEvent({
    id: eventId("pending", 3),
    adjustmentId: "adj_000000000000000000000003",
    transactionId: prepared.data.transactionId,
    type: "full",
    status: "pending_approval",
    sequence: 3,
  });
  const pendingResult = await signedWebhook(pendingRefund);
  assert.equal(pendingResult.response.status, 200);
  assert.equal(pendingResult.data.outcome, "adjustment-recorded");
  assert.equal(
    (await request("/api/me", { headers: { Cookie: account.cookie } })).data.user.discovery.active,
    true,
  );

  const wrongAdjustmentTransaction = adjustmentEvent({
    id: eventId("adjidentity", 6),
    adjustmentId: pendingRefund.data.id,
    transactionId: invalidPrepared.data.transactionId,
    type: "full",
    status: "approved",
    sequence: 6,
  });
  const wrongAdjustmentResult = await signedWebhook(wrongAdjustmentTransaction);
  assert.equal(wrongAdjustmentResult.response.status, 200);
  assert.equal(wrongAdjustmentResult.data.outcome, "rejected:adjustment-transaction");
  {
    const db = database({ readOnly: true });
    assert.equal(
      db
        .prepare("SELECT transaction_id FROM paddle_adjustments WHERE adjustment_id=?")
        .get(pendingRefund.data.id).transaction_id,
      prepared.data.transactionId,
    );
    assert.equal(
      db
        .prepare("SELECT access_revoked_at FROM paddle_purchases WHERE transaction_id=?")
        .get(invalidPrepared.data.transactionId).access_revoked_at,
      null,
    );
    db.close();
  }

  const partialRefund = adjustmentEvent({
    id: eventId("partial", 4),
    adjustmentId: "adj_000000000000000000000004",
    transactionId: prepared.data.transactionId,
    type: "partial",
    status: "approved",
    sequence: 4,
  });
  const partialResult = await signedWebhook(partialRefund);
  assert.equal(partialResult.response.status, 200);
  assert.equal(partialResult.data.outcome, "adjustment-recorded");
  assert.equal(
    (await request("/api/me", { headers: { Cookie: secondDevice.cookie } })).data.user.discovery
      .active,
    true,
  );

  const fullRefund = adjustmentEvent({
    id: eventId("full", 5),
    adjustmentId: "adj_000000000000000000000005",
    transactionId: prepared.data.transactionId,
    type: "full",
    status: "approved",
    sequence: 5,
  });
  const revoked = await signedWebhook(fullRefund);
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.data.outcome, "revoked");
  const revokedMe = await request("/api/me", { headers: { Cookie: account.cookie } });
  assert.equal(revokedMe.response.status, 200);
  assert.equal(revokedMe.data.user.discovery.active, false);
  const revokedFirstDevice = await request("/api/discovery", {
    headers: { Cookie: account.cookie },
  });
  const revokedSecondDevice = await request("/api/discovery", {
    headers: { Cookie: secondDevice.cookie },
  });
  assert.equal(revokedFirstDevice.response.status, 402);
  assert.equal(revokedSecondDevice.response.status, 402);
  assert.equal(
    (await request("/api/workouts", { headers: { Cookie: account.cookie } })).response.status,
    402,
  );
  for (const page of ["/workout.html", "/onboarding.html"])
    assert.equal(
      (await request(page, { headers: { Cookie: account.cookie }, redirect: "manual" })).response
        .status,
      302,
    );
});

test("a subscription on another catalog loses access until Paddle restores the current price", async () => {
  const account = await signup({
    name: "Catalog Restore",
    email: "catalog-restore@example.test",
    password: "catalog-recovery-password-123",
  });
  const transactionId = `txn_${"s".repeat(26)}`,
    stamp = Date.now();
  {
    const db = database();
    db.prepare(
      "INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,paddle_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(transactionId, account.user.id, PRICE_ID, PRODUCT_ID, "ready", stamp, stamp);
    db.close();
  }
  assert.equal(
    (
      await signedWebhook(
        completedEvent({ id: eventId("restoredone", 20), transactionId, userId: account.user.id }),
      )
    ).data.outcome,
    "subscription-payment-recorded",
  );
  const mismatchedCreated = subscriptionEvent({
    id: eventId("restoremismatch", 21),
    transactionId,
    userId: account.user.id,
    sequence: 21,
    priceId: PREVIOUS_PRICE_ID,
  });
  assert.equal(
    (await signedWebhook(mismatchedCreated)).data.outcome,
    "rejected:catalog",
    "subscription creation must match the linked purchase catalog",
  );
  assert.equal(
    (
      await signedWebhook(
        subscriptionEvent({
          id: eventId("restorecreate", 22),
          transactionId,
          userId: account.user.id,
          sequence: 22,
        }),
      )
    ).data.outcome,
    "subscription-created",
  );
  assert.equal(
    (await request("/api/discovery", { headers: { Cookie: account.cookie } })).response.status,
    200,
  );
  const invalid = subscriptionEvent({
    id: eventId("restoreinvalid", 23),
    transactionId,
    userId: account.user.id,
    eventType: "subscription.updated",
    sequence: 23,
    priceId: PREVIOUS_PRICE_ID,
    productId: PREVIOUS_PRODUCT_ID,
  });
  assert.equal((await signedWebhook(invalid)).data.outcome, "subscription-catalog-changed");
  assert.equal(
    (await request("/api/discovery", { headers: { Cookie: account.cookie } })).response.status,
    402,
  );
  const repaired = subscriptionEvent({
    id: eventId("restorefixed", 24),
    transactionId,
    userId: account.user.id,
    eventType: "subscription.updated",
    sequence: 24,
  });
  assert.equal((await signedWebhook(repaired)).data.outcome, "subscription-updated");
  const db = database({ readOnly: true });
  assert.equal(
    db.prepare("SELECT price_id FROM paddle_purchases WHERE transaction_id=?").get(transactionId)
      .price_id,
    PRICE_ID,
  );
  assert.equal(
    db
      .prepare("SELECT price_id FROM paddle_subscriptions WHERE transaction_id=?")
      .get(transactionId).price_id,
    PRICE_ID,
  );
  db.close();
  assert.equal(
    (await request("/api/discovery", { headers: { Cookie: account.cookie } })).response.status,
    200,
  );
});

test("completed webhook trust boundaries reject mismatches and keep an existing purchase identity immutable", async () => {
  const account = await signup({
    name: "Webhook Boundary Tester",
    email: "webhook-boundaries@example.test",
    password: "webhook-boundary-password-123",
  });
  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);

  const cases = [
    [
      "account",
      (event) => {
        event.data.custom_data.strata_user_id = "another-user";
      },
    ],
    [
      "price",
      (event) => {
        event.data.items[0].price.id = "pri_01wrong00000000000000000000";
      },
    ],
    [
      "product",
      (event) => {
        event.data.items[0].price.product_id = "pro_01wrong00000000000000000000";
      },
    ],
    [
      "origin",
      (event) => {
        event.data.origin = "web";
      },
    ],
    [
      "metadata",
      (event) => {
        event.data.custom_data.strata_version = 2;
      },
    ],
  ];
  let sequence = 20;
  for (const [reason, mutate] of cases) {
    const event = completedEvent({
      id: eventId(`reject${reason}`, sequence++),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
    });
    mutate(event);
    const rejected = await signedWebhook(event);
    assert.equal(rejected.response.status, 200, reason);
    assert.equal(rejected.data.outcome, `rejected:${reason}`, reason);
  }
  assert.equal(
    (await request("/api/discovery", { headers: { Cookie: account.cookie } })).response.status,
    402,
  );

  const valid = completedEvent({
    id: eventId("boundaryvalid", sequence++),
    transactionId: prepared.data.transactionId,
    userId: account.user.id,
  });
  const recorded = await signedWebhook(valid);
  assert.equal(recorded.response.status, 200);
  assert.equal(recorded.data.outcome, "subscription-payment-recorded");
  assert.equal(
    (await request("/api/discovery", { headers: { Cookie: account.cookie } })).response.status,
    402,
    "a completed transaction alone is not entitlement proof",
  );
  const linked = await signedWebhook(
    subscriptionEvent({
      id: eventId("boundsub", sequence++),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
      sequence,
    }),
  );
  assert.equal(linked.data.outcome, "subscription-created");
  assert.equal(
    (await request("/api/discovery", { headers: { Cookie: account.cookie } })).response.status,
    200,
  );
  const replay = await signedWebhook(valid);
  assert.equal(replay.data.outcome, "replayed", "the exact event ID must be processed once");

  const laterCompletion = completedEvent({
    id: eventId("boundarylater", sequence++),
    transactionId: prepared.data.transactionId,
    userId: account.user.id,
  });
  laterCompletion.data.customer_id = "ctm_00000000000000000000000099";
  laterCompletion.data.updated_at = new Date(Date.now() + 60_000).toISOString();
  const alreadyProcessed = await signedWebhook(laterCompletion);
  assert.equal(alreadyProcessed.response.status, 200);
  assert.equal(alreadyProcessed.data.outcome, "rejected:subscription-link");

  const db = database({ readOnly: true });
  const purchase = db
    .prepare("SELECT customer_id,completed_at FROM paddle_purchases WHERE transaction_id=?")
    .get(prepared.data.transactionId);
  const purchaseCount = db
    .prepare("SELECT COUNT(*) AS count FROM paddle_purchases WHERE transaction_id=?")
    .get(prepared.data.transactionId).count;
  const eventCount = db
    .prepare("SELECT COUNT(*) AS count FROM paddle_webhook_events WHERE event_id IN (?,?)")
    .get(valid.event_id, laterCompletion.event_id).count;
  db.close();
  assert.equal(
    purchase.customer_id,
    valid.data.customer_id,
    "a later completion cannot replace the durable customer identity",
  );
  assert.equal(
    purchaseCount,
    1,
    "duplicate and later completion notifications cannot duplicate the purchase ledger",
  );
  assert.equal(
    eventCount,
    2,
    "distinct signed notifications remain auditable even when they describe one transaction",
  );
});

test("an ordered renewal extends access and a later terminal cancellation ends it", async () => {
  const account = await signup({
    name: "Renewal Lifecycle Tester",
    email: "renewal-lifecycle@example.test",
    password: "renewal-lifecycle-password-123",
  });
  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);

  const completed = completedEvent({
    id: eventId("renewpay", 90),
    transactionId: prepared.data.transactionId,
    userId: account.user.id,
  });
  assert.equal((await signedWebhook(completed)).data.outcome, "subscription-payment-recorded");
  assert.equal(
    (
      await signedWebhook(
        subscriptionEvent({
          id: eventId("renewsub", 91),
          transactionId: prepared.data.transactionId,
          userId: account.user.id,
          sequence: 91,
        }),
      )
    ).data.outcome,
    "subscription-created",
  );

  const renewal = subscriptionEvent({
    id: eventId("renewed", 92),
    transactionId: prepared.data.transactionId,
    userId: account.user.id,
    eventType: "subscription.updated",
    sequence: 92,
    periodStartsAt: RENEWAL_PERIOD_START_AT,
    periodEndsAt: RENEWAL_PERIOD_END_AT,
  });
  const renewed = await signedWebhook(renewal);
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.data.outcome, "subscription-updated");
  const renewedStatus = await request("/api/billing/subscription", {
    headers: { Cookie: account.cookie },
  });
  assert.equal(renewedStatus.data.subscription.active, true);
  assert.equal(
    renewedStatus.data.subscription.currentPeriodEndsAt,
    Date.parse(RENEWAL_PERIOD_END_AT),
  );

  const replayedRenewal = await signedWebhook(renewal);
  assert.equal(
    replayedRenewal.data.outcome,
    "replayed",
    "a retried renewal notification must remain idempotent",
  );
  const beforeCancellation = await request("/api/discovery", {
    headers: { Cookie: account.cookie },
  });
  assert.equal(beforeCancellation.response.status, 200);

  const canceled = await signedWebhook(
    subscriptionEvent({
      id: eventId("renewcan", 93),
      transactionId: prepared.data.transactionId,
      userId: account.user.id,
      eventType: "subscription.updated",
      status: "canceled",
      sequence: 93,
    }),
  );
  assert.equal(canceled.response.status, 200);
  assert.equal(canceled.data.outcome, "subscription-updated");
  const canceledStatus = await request("/api/billing/subscription", {
    headers: { Cookie: account.cookie },
  });
  assert.equal(canceledStatus.data.subscription.status, "canceled");
  assert.equal(canceledStatus.data.subscription.active, false);
  assert.equal(
    (await request("/api/discovery", { headers: { Cookie: account.cookie } })).response.status,
    402,
  );

  const db = database({ readOnly: true });
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM paddle_webhook_events WHERE event_id=?")
      .get(renewal.event_id).count,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM paddle_subscriptions WHERE subscription_id=?")
      .get(subscriptionId(prepared.data.transactionId)).count,
    1,
  );
  db.close();
});

test("a member with Strata+ from Apple is not offered a second Paddle subscription", async () => {
  const account = await signup({
    name: "Apple Subscriber",
    email: "apple-subscriber@example.test",
    password: "apple-subscriber-password-123",
  });
  const now = Date.now(),
    db = database();
  try {
    db.prepare(
      "INSERT INTO apple_subscriptions(original_transaction_id,user_id,product_id,environment,latest_transaction_id,purchased_at,original_purchased_at,expires_at,revoked_at,revocation_reason,auto_renew,grace_period_expires_at,last_signed_at,latest_signed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,1,NULL,?,?,?,?)",
    ).run(
      "4000000000",
      account.user.id,
      "online.stratafitness.app.plus.monthly",
      "Production",
      "4000000001",
      now - 1000,
      now - 1000,
      now + 30 * 24 * 60 * 60 * 1000,
      now,
      now,
      now,
      now,
    );
  } finally {
    db.close();
  }
  const before = paddleRequests.length,
    refused = await checkout(account);
  assert.equal(refused.response.status, 409);
  assert.deepEqual(refused.data, {
    error: "You already have Strata+ through the App Store.",
    code: "ALREADY_ENTITLED_APP_STORE",
  });
  assert.equal(paddleRequests.length, before, "no Paddle transaction is created");
  const portal = await request("/api/billing/portal", {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      Origin: BASE,
      "X-CSRF-Token": account.csrfToken,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(portal.response.status, 409);
  assert.equal(portal.data.code, "APP_STORE_MANAGED");
  assert.equal(portal.data.manageUrl, "https://apps.apple.com/account/subscriptions");
  assert.equal(
    paddleRequests.length,
    before,
    "Paddle's portal is not asked about an App Store subscription",
  );
  const me = await request("/api/me", { headers: { Cookie: account.cookie } });
  assert.equal(me.data.user.discovery.accessType, "apple");
  assert.equal(me.data.user.discovery.subscription, null);
});

test("concurrent checkout requests create only one Paddle transaction", async () => {
  const account = await signup({
    name: "Concurrent Checkout Tester",
    email: "concurrent-checkout@example.test",
    password: "concurrent-checkout-password-123",
  });
  const postsBefore = paddleRequests.filter(
    (entry) => entry.method === "POST" && entry.url === "/transactions",
  ).length;
  const results = await Promise.all([checkout(account), checkout(account)]);
  const postsAfter = paddleRequests.filter(
    (entry) => entry.method === "POST" && entry.url === "/transactions",
  ).length;

  assert.equal(
    postsAfter - postsBefore,
    1,
    "parallel requests must be serialized before calling Paddle",
  );
  const created = results.find((result) => result.response.status === 201);
  const concurrent = results.find((result) => result !== created);
  assert.ok(created, "one request should create the checkout");
  assert.ok(
    [200, 409].includes(concurrent.response.status),
    `unexpected concurrent response: ${concurrent.response.status} ${JSON.stringify(concurrent.data)}`,
  );
  if (concurrent.response.status === 200) {
    assert.equal(concurrent.data.reused, true);
    assert.equal(concurrent.data.transactionId, created.data.transactionId);
  } else {
    assert.equal(concurrent.data.code, "CHECKOUT_PREPARING");
  }

  const paymentFailed = await signedWebhook(
    transactionStatusEvent({
      id: eventId("retry", 6),
      transactionId: created.data.transactionId,
      eventType: "transaction.payment_failed",
      status: "ready",
    }),
  );
  assert.equal(paymentFailed.response.status, 200);
  assert.equal(
    paymentFailed.data.outcome,
    "updated",
    "a failed initial subscription payment may leave checkout ready for retry",
  );
  const retry = await checkout(account);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.reused, true);
  assert.equal(retry.data.transactionId, created.data.transactionId);
});

test("checkout retry recovers a transaction after Paddle returns a malformed create response", async () => {
  const account = await signup({
    name: "Interrupted Checkout Tester",
    email: "interrupted-checkout@example.test",
    password: "interrupted-checkout-password-123",
  });
  const postsBefore = paddleRequests.filter(
    (entry) => entry.method === "POST" && entry.url === "/transactions",
  ).length;
  const listsBefore = paddleRequests.filter(
    (entry) => entry.method === "GET" && entry.url.startsWith("/transactions?"),
  ).length;
  malformedCreateResponses = 1;

  const interrupted = await checkout(account);
  assert.equal(interrupted.response.status, 502);
  assert.equal(interrupted.data.code, "PADDLE_INVALID_RESPONSE");

  const createRequests = paddleRequests
    .filter((entry) => entry.method === "POST" && entry.url === "/transactions")
    .slice(postsBefore);
  assert.equal(createRequests.length, 1);
  const createBody = createRequests[0].body;
  assert.equal(createBody.custom_data.strata_user_id, account.user.id);
  assert.match(
    createBody.custom_data.strata_checkout_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const providerTransaction = [...paddleTransactions.values()].find(
    (transaction) =>
      transaction.custom_data?.strata_checkout_id === createBody.custom_data.strata_checkout_id,
  );
  assert.ok(
    providerTransaction,
    "the fake provider should retain the transaction despite its malformed response",
  );

  const recovered = await checkout(account);
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.data.reused, true);
  assert.equal(recovered.data.recovered, true);
  assert.equal(recovered.data.transactionId, providerTransaction.id);
  assert.equal(
    paddleRequests.filter((entry) => entry.method === "POST" && entry.url === "/transactions")
      .length - postsBefore,
    1,
    "recovery must not create a second Paddle transaction",
  );
  const recoveryLists = paddleRequests
    .filter((entry) => entry.method === "GET" && entry.url.startsWith("/transactions?"))
    .slice(listsBefore);
  assert.equal(recoveryLists.length, 1);
  const recoveryUrl = new URL(recoveryLists[0].url, "http://paddle.test");
  assert.equal(recoveryUrl.pathname, "/transactions");
  assert.ok(recoveryUrl.searchParams.get("created_at[GTE]"));
  assert.ok(recoveryUrl.searchParams.get("created_at[LTE]"));
  assert.equal(recoveryUrl.searchParams.get("origin"), "api");
  assert.equal(recoveryUrl.searchParams.get("collection_mode"), "automatic");
  assert.equal(
    recoveryUrl.searchParams.has("subscription_id"),
    false,
    "recovery includes transactions that completed before the retry",
  );
  assert.equal(recoveryUrl.searchParams.get("order_by"), "created_at[ASC]");
});

test("completed checkout recovery reports entitlement only after durable access exists", async () => {
  const entitled = await signup({
    name: "Completed Recovery Tester",
    email: "completed-recovery@example.test",
    password: "completed-recovery-password-123",
  });
  malformedCreateResponses = 1;
  const interruptedEntitled = await checkout(entitled);
  assert.equal(interruptedEntitled.response.status, 502);
  const entitledRemote = [...paddleTransactions.values()].find(
    (transaction) => transaction.custom_data?.strata_user_id === entitled.user.id,
  );
  assert.ok(entitledRemote);
  entitledRemote.status = "completed";
  entitledRemote.customer_id = "ctm_00000000000000000000000002";
  entitledRemote.subscription_id = subscriptionId(entitledRemote.id);
  entitledRemote.updated_at = new Date().toISOString();

  const completedRecovery = await checkout(entitled);
  assert.equal(completedRecovery.response.status, 409);
  assert.equal(completedRecovery.data.code, "CHECKOUT_PENDING_CONFIRMATION");
  assert.equal(
    (await request("/api/me", { headers: { Cookie: entitled.cookie } })).data.user.discovery.active,
    false,
  );
  const linkedRecovery = await signedWebhook(
    subscriptionEvent({
      id: eventId("recoverlink", 80),
      transactionId: entitledRemote.id,
      userId: entitled.user.id,
      sequence: 80,
      customerId: entitledRemote.customer_id,
    }),
  );
  assert.equal(linkedRecovery.data.outcome, "subscription-created");
  assert.equal(
    (await request("/api/me", { headers: { Cookie: entitled.cookie } })).data.user.discovery.active,
    true,
  );

  const revoked = await signup({
    name: "Revoked Recovery Tester",
    email: "revoked-recovery@example.test",
    password: "revoked-recovery-password-123",
  });
  const postsBefore = paddleRequests.filter(
    (entry) => entry.method === "POST" && entry.url === "/transactions",
  ).length;
  malformedCreateResponses = 1;
  const interruptedRevoked = await checkout(revoked);
  assert.equal(interruptedRevoked.response.status, 502);
  const revokedRemote = [...paddleTransactions.values()].find(
    (transaction) => transaction.custom_data?.strata_user_id === revoked.user.id,
  );
  assert.ok(revokedRemote);
  revokedRemote.status = "completed";
  revokedRemote.customer_id = "ctm_00000000000000000000000003";
  revokedRemote.subscription_id = subscriptionId(revokedRemote.id);
  revokedRemote.updated_at = new Date().toISOString();
  const now = Date.now();
  {
    const db = database();
    db.prepare(
      `INSERT INTO paddle_purchases
      (transaction_id,user_id,price_id,product_id,customer_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at)
      VALUES(?,?,?,?,?,'completed',?,?,?, ?,?)`,
    ).run(
      revokedRemote.id,
      revoked.user.id,
      PRICE_ID,
      PRODUCT_ID,
      revokedRemote.customer_id,
      now,
      now,
      "refund",
      now,
      now,
    );
    db.close();
  }

  const awaitingTerminalState = await checkout(revoked);
  assert.equal(awaitingTerminalState.response.status, 409);
  assert.equal(
    awaitingTerminalState.data.code,
    "CHECKOUT_PENDING_CONFIRMATION",
    "a completed recurring transaction cannot be replaced before its subscription state arrives",
  );
  const terminal = await signedWebhook(
    subscriptionEvent({
      id: eventId("recovercancel", 81),
      transactionId: revokedRemote.id,
      userId: revoked.user.id,
      status: "canceled",
      sequence: 81,
      customerId: revokedRemote.customer_id,
    }),
  );
  assert.equal(terminal.data.outcome, "subscription-created");
  const replacement = await checkout(revoked);
  assert.equal(
    replacement.response.status,
    201,
    "a completed but revoked recovery must proceed to a new checkout",
  );
  assert.notEqual(replacement.data.transactionId, revokedRemote.id);
  assert.equal(
    paddleRequests.filter((entry) => entry.method === "POST" && entry.url === "/transactions")
      .length - postsBefore,
    2,
    "the interrupted transaction and its replacement should be the only provider creates",
  );
  assert.equal(
    (await request("/api/me", { headers: { Cookie: revoked.cookie } })).data.user.discovery.active,
    false,
  );
  {
    const db = database({ readOnly: true });
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?")
        .get(revoked.user.id).count,
      0,
    );
    db.close();
  }
});

let paymentAdmin;
async function authenticatedPaymentAdmin() {
  if (paymentAdmin) return paymentAdmin;
  const password = "billing-admin-password-123",
    account = await signup({
      name: "Billing Admin",
      email: "billing-admin@example.test",
      password,
    });
  const db = database();
  db.prepare("UPDATE users SET email_verified_at=? WHERE id=?").run(Date.now(), account.user.id);
  db.prepare(
    "INSERT INTO admin_principal(slot,user_id,configured_email,bound_at) VALUES('primary',?,?,?)",
  ).run(account.user.id, account.user.email, Date.now());
  db.close();
  const loggedIn = await request("/api/login", {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.user.email, password }),
  });
  assert.equal(loggedIn.response.status, 200);
  const me = await request("/api/me", { headers: { Cookie: loggedIn.cookie } });
  const session = await request("/api/admin/session", { headers: { Cookie: loggedIn.cookie } });
  assert.deepEqual(session.data, { admin: true, elevated: true, elevatedUntil: null });
  paymentAdmin = { cookie: loggedIn.cookie, csrf: me.data.csrfToken };
  return paymentAdmin;
}
async function controlPaymentAccount(account, action, revision, grant) {
  const admin = await authenticatedPaymentAdmin();
  return request(`/api/admin/users/${account.user.id}/actions`, {
    method: "POST",
    headers: {
      Cookie: admin.cookie,
      Origin: BASE,
      "Content-Type": "application/json",
      "X-CSRF-Token": admin.csrf,
    },
    body: JSON.stringify({
      action,
      expectedControlsRevision: revision,
      ...(grant ? { grant } : {}),
    }),
  });
}

test("admin closes fresh checkouts and retains holds on provider failure", async () => {
  const account = await signup({
    name: "Close Checkout",
    email: "close-checkout@example.test",
    password: "close-checkout-password-123",
  });
  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);
  const remote = paddleTransactions.get(prepared.data.transactionId);
  cancelFailure = true;
  let closed;
  try {
    closed = await controlPaymentAccount(account, "close-checkouts", 0);
  } finally {
    cancelFailure = false;
  }
  assert.equal(closed.response.status, 503, JSON.stringify(closed.data));
  assert.equal(closed.data.code, "CHECKOUT_CLOSE_INCOMPLETE");
  assert.equal((await checkout(account)).data.code, "CHECKOUT_BLOCKED");
  assert.equal(
    remote.status,
    "ready",
    "failed cancellation must not mark local or provider state canceled",
  );
  const retried = await controlPaymentAccount(account, "close-checkouts", 1);
  assert.equal(retried.response.status, 200, JSON.stringify(retried.data));
  assert.equal(remote.status, "canceled");
  assert.match(retried.data.message, /No unfinished/);
  const enabled = await controlPaymentAccount(account, "enable-checkouts", 2);
  assert.equal(enabled.response.status, 200);
  const next = await checkout(account);
  assert.equal(next.response.status, 201);
  assert.notEqual(next.data.transactionId, prepared.data.transactionId);
});

test("admin retires an interrupted Paddle draft, revokes sessions, and permanently deletes the account", async () => {
  const account = await signup({
    name: "Interrupted Draft",
    email: "interrupted-draft@example.test",
    password: "interrupted-draft-password-123",
  });
  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);
  await checkoutClaimReleased(account.user.id);
  const transactionId = prepared.data.transactionId,
    remote = paddleTransactions.get(transactionId),
    claimId = remote.custom_data.strata_checkout_id;
  remote.status = "draft";
  remote.checkout = { url: `https://checkout.paddle.test/${transactionId}` };
  {
    const db = database(),
      stamp = Date.now();
    db.prepare(
      "UPDATE paddle_purchases SET paddle_status='draft',updated_at=? WHERE transaction_id=?",
    ).run(stamp, transactionId);
    db.prepare(
      "INSERT INTO paddle_checkout_claims(user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(account.user.id, PRICE_ID, claimId, transactionId, stamp + 60_000, stamp, stamp);
    db.close();
  }

  const providerBefore = paddleRequests.length;
  const closed = await controlPaymentAccount(account, "close-checkouts", 0);
  assert.equal(closed.response.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.user.checkoutBlocked, true);
  assert.match(closed.data.message, /No unfinished/);
  const retirement = paddleRequests
    .slice(providerBefore)
    .find((entry) => entry.method === "PATCH" && entry.url === `/transactions/${transactionId}`);
  assert.ok(retirement, "closing payment sessions must retire the account-bound Paddle draft");
  assert.equal(retirement.body.collection_mode, "manual");
  assert.equal(retirement.body.billing_details?.enable_checkout, false);
  assert.equal(retirement.body.custom_data, null);
  assert.equal(
    retirement.body.status,
    undefined,
    "draft retirement is not a draft-to-canceled status transition",
  );
  assert.equal(remote.status, "draft");
  assert.equal(remote.collection_mode, "manual");
  assert.equal(remote.custom_data, null);
  assert.equal(remote.checkout, null);
  {
    const db = database({ readOnly: true });
    const retired = db
      .prepare(
        "SELECT paddle_status,access_revoked_at,revocation_reason FROM paddle_purchases WHERE transaction_id=?",
      )
      .get(transactionId);
    assert.equal(
      retired.paddle_status,
      "draft",
      "the retained Paddle record keeps its truthful provider status",
    );
    assert.ok(
      retired.access_revoked_at,
      "a safely retired remote draft must stop blocking local deletion",
    );
    assert.equal(retired.revocation_reason, "checkout_disabled");
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?")
        .get(account.user.id).count,
      0,
      "draft retirement must release the interrupted checkout claim",
    );
    db.close();
  }

  const revoked = await controlPaymentAccount(account, "revoke-sessions", 1);
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.data));
  assert.match(revoked.data.message, /Signed the account out/);
  assert.equal((await request("/api/me", { headers: { Cookie: account.cookie } })).data.user, null);
  const providerAfterClosure = paddleRequests.length;
  const deleted = await controlPaymentAccount(account, "delete-account", 1);
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.data));
  assert.match(deleted.data.message, /permanently deleted from STRATA/i);
  assert.equal(
    paddleRequests.length,
    providerAfterClosure,
    "deletion must use the completed closure state instead of reconciling the retired draft again",
  );
  {
    const db = database({ readOnly: true });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(account.user.id).count,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=?").get(account.user.id)
        .count,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM paddle_purchases WHERE user_id=?")
        .get(account.user.id).count,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM admin_audit_events WHERE target_user_id=? AND action='revoke-sessions'",
        )
        .get(account.user.id).count,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM admin_audit_events WHERE target_user_id=? AND action='delete-account'",
        )
        .get(account.user.id).count,
      1,
    );
    db.close();
  }
});

test("admin resumes safely when Paddle retirement succeeded before local cleanup", async () => {
  const account = await signup({
    name: "Retirement Retry",
    email: "retirement-retry@example.test",
    password: "retirement-retry-password-123",
  });
  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);
  await checkoutClaimReleased(account.user.id);
  const transactionId = prepared.data.transactionId,
    remote = paddleTransactions.get(transactionId),
    claimId = remote.custom_data.strata_checkout_id,
    stamp = Date.now();
  {
    const db = database();
    db.prepare(
      "UPDATE paddle_purchases SET paddle_status='draft',updated_at=? WHERE transaction_id=?",
    ).run(stamp, transactionId);
    db.prepare(
      "INSERT INTO paddle_checkout_claims(user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(account.user.id, PRICE_ID, claimId, transactionId, stamp + 60_000, stamp, stamp);
    db.close();
  }
  remote.status = "draft";
  remote.collection_mode = "manual";
  remote.billing_details = {
    enable_checkout: false,
    payment_terms: { interval: "day", frequency: 30 },
  };
  remote.custom_data = null;
  remote.checkout = null;
  remote.updated_at = new Date(stamp + 1).toISOString();

  const providerBefore = paddleRequests.length;
  const closed = await controlPaymentAccount(account, "close-checkouts", 0);
  assert.equal(closed.response.status, 200, JSON.stringify(closed.data));
  assert.match(closed.data.message, /No unfinished/);
  const retryCalls = paddleRequests.slice(providerBefore);
  assert.equal(
    retryCalls.filter((entry) => entry.method === "PATCH").length,
    0,
    "an already-retired provider draft must not be patched twice",
  );
  assert.ok(
    retryCalls.some(
      (entry) => entry.method === "GET" && entry.url === `/transactions/${transactionId}`,
    ),
  );
  {
    const db = database({ readOnly: true });
    const purchase = db
      .prepare(
        "SELECT access_revoked_at,revocation_reason FROM paddle_purchases WHERE transaction_id=?",
      )
      .get(transactionId);
    assert.ok(purchase.access_revoked_at);
    assert.equal(purchase.revocation_reason, "checkout_disabled");
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?")
        .get(account.user.id).count,
      0,
    );
    db.close();
  }
  assert.equal((await controlPaymentAccount(account, "delete-account", 1)).response.status, 200);
  const db = database({ readOnly: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(account.user.id).count,
    0,
  );
  db.close();
});

test("admin retires a stored draft from an earlier monthly catalog", async () => {
  const account = await signup({
    name: "Stored Previous Draft",
    email: "stored-previous-draft@example.test",
    password: "stored-previous-draft-password-123",
  });
  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);
  await checkoutClaimReleased(account.user.id);
  const transactionId = prepared.data.transactionId,
    remote = paddleTransactions.get(transactionId),
    stamp = Date.now();
  remote.status = "draft";
  remote.items = [
    {
      quantity: 1,
      price: {
        id: PREVIOUS_PRICE_ID,
        product_id: PREVIOUS_PRODUCT_ID,
        billing_cycle: { interval: "month", frequency: 1 },
      },
    },
  ];
  remote.checkout = { url: `https://checkout.paddle.test/${transactionId}` };
  remote.updated_at = new Date(stamp).toISOString();
  {
    const db = database();
    db.prepare(
      "UPDATE paddle_purchases SET price_id=?,product_id=?,paddle_status='draft',updated_at=? WHERE transaction_id=?",
    ).run(PREVIOUS_PRICE_ID, PREVIOUS_PRODUCT_ID, stamp, transactionId);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?")
        .get(account.user.id).count,
      0,
      "the ordinary recorded-purchase path has no recovery claim",
    );
    db.close();
  }

  const providerBefore = paddleRequests.length;
  const closed = await controlPaymentAccount(account, "close-checkouts", 0);
  assert.equal(closed.response.status, 200, JSON.stringify(closed.data));
  assert.match(closed.data.message, /No unfinished/);
  assert.ok(
    paddleRequests
      .slice(providerBefore)
      .some((entry) => entry.method === "PATCH" && entry.url === `/transactions/${transactionId}`),
  );
  assert.equal(remote.collection_mode, "manual");
  assert.equal(remote.custom_data, null);
  assert.equal(remote.checkout, null);
  {
    const db = database({ readOnly: true }),
      purchase = db
        .prepare(
          "SELECT access_revoked_at,revocation_reason FROM paddle_purchases WHERE transaction_id=?",
        )
        .get(transactionId);
    assert.ok(purchase.access_revoked_at);
    assert.equal(purchase.revocation_reason, "checkout_disabled");
    db.close();
  }
  assert.equal((await controlPaymentAccount(account, "delete-account", 1)).response.status, 200);
  const db = database({ readOnly: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(account.user.id).count,
    0,
  );
  db.close();
});

test("admin retires an unbound interrupted draft after the deployed monthly catalog changes", async () => {
  const account = await signup({
    name: "Previous Catalog Draft",
    email: "previous-catalog-draft@example.test",
    password: "previous-catalog-draft-password-123",
  });
  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);
  await checkoutClaimReleased(account.user.id);
  const transactionId = prepared.data.transactionId,
    remote = paddleTransactions.get(transactionId),
    claimId = "previous_catalog_interrupted",
    stamp = Date.now();
  remote.status = "draft";
  remote.created_at = new Date(stamp).toISOString();
  remote.updated_at = remote.created_at;
  remote.custom_data = {
    strata_user_id: account.user.id,
    strata_checkout_id: claimId,
    strata_version: 1,
  };
  remote.items = [
    {
      quantity: 1,
      price: {
        id: PREVIOUS_PRICE_ID,
        product_id: PREVIOUS_PRODUCT_ID,
        billing_cycle: { interval: "month", frequency: 1 },
      },
    },
  ];
  remote.checkout = { url: `https://checkout.paddle.test/${transactionId}` };
  {
    const db = database();
    db.prepare("DELETE FROM paddle_purchases WHERE transaction_id=?").run(transactionId);
    db.prepare(
      "INSERT INTO paddle_checkout_claims(user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(account.user.id, PREVIOUS_PRICE_ID, claimId, null, stamp + 60_000, stamp, stamp);
    db.close();
  }

  const providerBefore = paddleRequests.length;
  const closed = await controlPaymentAccount(account, "close-checkouts", 0);
  assert.equal(closed.response.status, 200, JSON.stringify(closed.data));
  assert.match(closed.data.message, /No unfinished/);
  const cleanup = paddleRequests.slice(providerBefore);
  assert.ok(
    cleanup.some((entry) => entry.method === "GET" && entry.url.startsWith("/transactions?")),
    "the unbound claim must be recovered by its durable checkout identity",
  );
  assert.ok(
    cleanup.some(
      (entry) => entry.method === "PATCH" && entry.url === `/transactions/${transactionId}`,
    ),
  );
  assert.equal(remote.collection_mode, "manual");
  assert.equal(remote.custom_data, null);
  assert.equal(remote.checkout, null);
  {
    const db = database({ readOnly: true });
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?")
        .get(account.user.id).count,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM paddle_purchases WHERE user_id=?")
        .get(account.user.id).count,
      0,
    );
    db.close();
  }

  assert.equal((await controlPaymentAccount(account, "revoke-sessions", 1)).response.status, 200);
  assert.equal((await controlPaymentAccount(account, "delete-account", 1)).response.status, 200);
  const db = database({ readOnly: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(account.user.id).count,
    0,
  );
  db.close();
});

test("a failed Paddle draft retirement keeps Admin deletion blocked after session revocation", async () => {
  const account = await signup({
    name: "Blocked Draft",
    email: "blocked-draft@example.test",
    password: "blocked-draft-password-123",
  });
  const prepared = await checkout(account);
  assert.equal(prepared.response.status, 201);
  await checkoutClaimReleased(account.user.id);
  const transactionId = prepared.data.transactionId,
    remote = paddleTransactions.get(transactionId),
    claimId = remote.custom_data.strata_checkout_id;
  remote.status = "draft";
  remote.checkout = { url: `https://checkout.paddle.test/${transactionId}` };
  {
    const db = database(),
      stamp = Date.now();
    db.prepare(
      "UPDATE paddle_purchases SET paddle_status='draft',updated_at=? WHERE transaction_id=?",
    ).run(stamp, transactionId);
    db.prepare(
      "INSERT INTO paddle_checkout_claims(user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(account.user.id, PRICE_ID, claimId, transactionId, stamp + 60_000, stamp, stamp);
    db.close();
  }

  draftRetirementFailure = true;
  try {
    const closed = await controlPaymentAccount(account, "close-checkouts", 0);
    assert.equal(closed.response.status, 503, JSON.stringify(closed.data));
    assert.equal(closed.data.code, "CHECKOUT_CLOSE_INCOMPLETE");
    assert.equal(closed.data.user, undefined);
    assert.equal(remote.collection_mode, "automatic");
    assert.notEqual(remote.custom_data, null);
    const revoked = await controlPaymentAccount(account, "revoke-sessions", 1);
    assert.equal(revoked.response.status, 200, JSON.stringify(revoked.data));
    assert.equal(
      (await request("/api/me", { headers: { Cookie: account.cookie } })).data.user,
      null,
    );
    const deleted = await controlPaymentAccount(account, "delete-account", 1);
    assert.notEqual(
      deleted.response.status,
      200,
      "provider retirement failure must never fall through to local account deletion",
    );
  } finally {
    draftRetirementFailure = false;
  }

  {
    const db = database({ readOnly: true }),
      user = db.prepare("SELECT suspended_at FROM users WHERE id=?").get(account.user.id);
    assert.ok(
      user?.suspended_at,
      "the failed deletion must retain the automatically paused account",
    );
    assert.equal(
      db
        .prepare("SELECT paddle_status FROM paddle_purchases WHERE transaction_id=?")
        .get(transactionId).paddle_status,
      "draft",
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?")
        .get(account.user.id).count,
      1,
    );
    assert.ok(
      db
        .prepare("SELECT checkout_blocked_at FROM admin_account_controls WHERE user_id=?")
        .get(account.user.id).checkout_blocked_at,
    );
    db.close();
  }
});

test("a grant or hold during provider creation prevents exposing the in-flight checkout", async () => {
  for (const action of ["grant-plus", "close-checkouts"]) {
    const account = await signup({
      name: "Concurrent Control",
      email: `race-${action}@example.test`,
      password: "concurrent-control-password-123",
    });
    let controlled;
    createResponseHook = async () => {
      controlled = await controlPaymentAccount(
        account,
        action,
        0,
        action === "grant-plus" ? { unit: "days", amount: 30 } : undefined,
      );
    };
    const prepared = await checkout(account);
    assert.equal(controlled.response.status, 200, JSON.stringify(controlled.data));
    assert.equal(prepared.data.transactionId, undefined);
    assert.equal(
      prepared.data.code,
      action === "grant-plus" ? "ALREADY_ENTITLED" : "CHECKOUT_BLOCKED",
    );
    const db = database();
    const remote = [...paddleTransactions.values()].find(
      (t) => t.custom_data?.strata_user_id === account.user.id,
    );
    const purchase = db
      .prepare("SELECT * FROM paddle_purchases WHERE transaction_id=?")
      .get(remote.id);
    if (action === "grant-plus")
      assert.ok(purchase, "accepted provider work remains durably recorded");
    else assert.equal(remote.status, "canceled");
    db.close();
  }
});

test("admin closure records a completed interrupted checkout while the payment hold remains active", async () => {
  const account = await signup({
    name: "Completed During Hold",
    email: "completed-hold@example.test",
    password: "completed-hold-password-123",
  });
  malformedCreateResponses = 1;
  assert.equal((await checkout(account)).response.status, 502);
  const remote = [...paddleTransactions.values()].find(
    (t) => t.custom_data?.strata_user_id === account.user.id,
  );
  remote.status = "completed";
  remote.customer_id = "ctm_00000000000000000000000009";
  remote.subscription_id = subscriptionId(remote.id);
  remote.updated_at = new Date().toISOString();
  const closed = await controlPaymentAccount(account, "close-checkouts", 0);
  assert.equal(closed.response.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.user.checkoutBlocked, true);
  const db = database();
  const purchase = db
    .prepare("SELECT * FROM paddle_purchases WHERE transaction_id=?")
    .get(remote.id);
  assert.equal(purchase.subscription_id, remote.subscription_id);
  assert.ok(purchase.completed_at);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM paddle_checkout_claims WHERE user_id=?")
      .get(account.user.id).n,
    0,
  );
  db.close();
  assert.equal((await checkout(account)).data.code, "CHECKOUT_BLOCKED");
  assert.equal(
    remote.status,
    "completed",
    "settled payment must never be canceled by checkout closure",
  );
});
