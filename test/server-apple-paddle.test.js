"use strict";

// Strata+ is one entitlement however it was paid for. Through the real server with Paddle and the App Store both
// configured: a member whose Strata+ comes from the App Store is never sent to a second (Paddle) payment, and Paddle's
// subscription portal points an App Store subscriber to Apple instead of failing.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createAppleTestChain } = require("./support/apple-test-chain");

const ROOT = join(__dirname, "..");
const BUNDLE = "online.stratafitness.app";
const APPLE_PRODUCT = "online.stratafitness.app.plus.monthly";
const PRODUCT_ID = "pro_01m1ky8j916ybyacs836dxbz8x";
const PRICE_ID = "pri_01monthlyfixture00000000000000";
const DAY = 24 * 60 * 60 * 1000;
const chain = createAppleTestChain();
// The test chain's certificates start when they were made; signed dates sit a minute ahead, inside the clock allowance.
const BASE = Date.now() + 60_000;
const APP_STORE_MANAGED = {
  error:
    "Your Strata+ subscription is managed by the App Store. Manage it in Settings on your iPhone.",
  code: "APP_STORE_MANAGED",
  manageUrl: "https://apps.apple.com/account/subscriptions",
};
const paddleRequests = [];
let paddle,
  app,
  base,
  runtime,
  appErrors = "",
  address = 0,
  sequence = 0;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address();
      resolve(`http://127.0.0.1:${value.port}`);
    });
  });
}

// Just enough of Paddle: creating a checkout transaction and opening a customer portal session.
async function startPaddle() {
  paddle = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    const path = new URL(req.url, "http://paddle.test").pathname;
    paddleRequests.push({ method: req.method, path });
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.method === "POST" && path === "/transactions") {
      sequence += 1;
      const now = new Date().toISOString();
      send(201, {
        data: {
          id: `txn_${String(sequence).padStart(26, "0")}`,
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
              quantity: 1,
              price: {
                id: body?.items?.[0]?.price_id || null,
                product_id: PRODUCT_ID,
                billing_cycle: { interval: "month", frequency: 1 },
                unit_price: { amount: "299", currency_code: "USD" },
              },
            },
          ],
        },
      });
      return;
    }
    const portal = path.match(/^\/customers\/(ctm_[a-z0-9]+)\/portal-sessions$/);
    if (req.method === "POST" && portal) {
      send(201, {
        data: {
          customer_id: portal[1],
          urls: {
            general: { overview: "https://customer-portal.paddle.com/cpl_overviewfixture" },
            subscriptions: [
              {
                id: body?.subscription_ids?.[0],
                cancel_subscription: "https://customer-portal.paddle.com/cpl_cancelfixture",
                update_subscription_payment_method:
                  "https://customer-portal.paddle.com/cpl_paymentfixture",
              },
            ],
          },
        },
      });
      return;
    }
    send(404, { error: { detail: "not found" } });
  });
  return listen(paddle);
}

async function start() {
  const paddleBase = await startPaddle();
  mkdirSync(join(ROOT, "test-runtime"), { recursive: true });
  runtime = mkdtempSync(join(ROOT, "test-runtime", "apple-paddle-"));
  app = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      TRUST_PROXY: "true",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtime,
      EMAIL_VERIFICATION_ENABLED: "",
      RESEND_API_KEY: "",
      PADDLE_PRODUCT_ID: PRODUCT_ID,
      PADDLE_PRICE_ID: PRICE_ID,
      PADDLE_CLIENT_TOKEN: "live_browser_token_for_apple_paddle_test",
      PADDLE_API_KEY: "pdl_live_apikey_01applepaddlefixture00000_fixture_secret_123",
      PADDLE_WEBHOOK_SECRET: "pdl_ntfset_live_apple_paddle_test_secret",
      PADDLE_CHECKOUT_ENABLED: "true",
      PADDLE_ENFORCE_IP_ALLOWLIST: "false",
      PADDLE_API_BASE: paddleBase,
      APPLE_ROOT_FINGERPRINT: chain.rootFingerprint,
      APPLE_BUNDLE_ID: "",
      APPLE_IAP_PRODUCT_IDS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let output = "",
      settled = false;
    const timer = setTimeout(
      () => finish(new Error(`Server startup timed out. ${appErrors}`)),
      5000,
    );
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    app.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    });
    app.stderr.on("data", (chunk) => {
      appErrors = (appErrors + chunk).slice(-8192);
    });
    app.once("exit", (code) =>
      finish(new Error(`Server exited before startup (${code}). ${appErrors}`)),
    );
  });
}

async function stop() {
  if (app && app.exitCode === null)
    await new Promise((resolve) => {
      let timer;
      app.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      app.kill("SIGTERM");
      timer = setTimeout(() => app.kill("SIGKILL"), 2000);
    });
  if (paddle?.listening) await new Promise((resolve) => paddle.close(resolve));
  if (runtime) rmSync(runtime, { recursive: true, force: true });
}

async function request(path, { method = "GET", body, cookie = "", csrf = "", origin = true } = {}) {
  address = (address % 240) + 1;
  const headers = { "X-Forwarded-For": `198.51.100.${address}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (origin) headers.Origin = base;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const type = response.headers.get("content-type") || "";
  return {
    response,
    data: type.includes("json") ? await response.json() : await response.text(),
    cookies: response.headers.getSetCookie(),
  };
}

async function member(name) {
  const signup = await request("/api/signup", {
    method: "POST",
    body: {
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@apple-paddle.test`,
      password: "apple-paddle-password-123",
    },
  });
  assert.equal(signup.response.status, 201);
  const cookie = signup.cookies
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("strata_session="));
  assert.ok(cookie);
  const me = await request("/api/me", { cookie });
  return { cookie, csrf: me.data.csrfToken, id: me.data.user.id };
}

function transaction(account, overrides = {}) {
  return {
    transactionId: "4000000001",
    originalTransactionId: "4000000000",
    bundleId: BUNDLE,
    productId: APPLE_PRODUCT,
    purchaseDate: BASE - DAY,
    originalPurchaseDate: BASE - DAY,
    expiresDate: BASE + 29 * DAY,
    type: "Auto-Renewable Subscription",
    appAccountToken: account.id,
    inAppOwnershipType: "PURCHASED",
    signedDate: BASE - 5000,
    environment: "Sandbox",
    ...overrides,
  };
}
function notify(type, { tx, signedDate }) {
  return request("/api/billing/apple/notifications", {
    method: "POST",
    origin: false,
    body: {
      signedPayload: chain.signJws({
        notificationType: type,
        notificationUUID: randomUUID(),
        version: "2.0",
        signedDate,
        data: {
          bundleId: BUNDLE,
          environment: "Sandbox",
          signedTransactionInfo: chain.signJws(tx),
          signedRenewalInfo: chain.signJws({
            originalTransactionId: tx.originalTransactionId,
            autoRenewStatus: 0,
            signedDate,
            environment: "Sandbox",
          }),
        },
      }),
    },
  });
}
const appleBuy = (account, overrides) =>
  request("/api/billing/apple/transactions", {
    method: "POST",
    cookie: account.cookie,
    csrf: account.csrf,
    body: { signedTransactions: [chain.signJws(transaction(account, overrides))] },
  });
const checkout = (account) =>
  request("/api/billing/checkout", {
    method: "POST",
    cookie: account.cookie,
    csrf: account.csrf,
    body: {},
  });
const portal = (account) =>
  request("/api/billing/portal", {
    method: "POST",
    cookie: account.cookie,
    csrf: account.csrf,
    body: {},
  });
const paddleCalls = (path) =>
  paddleRequests.filter((item) => item.method === "POST" && item.path === path).length;

// A live Paddle subscription, written the way the webhook would have stored it.
function paddleSubscription(account, label) {
  const db = new DatabaseSync(join(runtime, "strata.sqlite"), { timeout: 5000 }),
    now = Date.now();
  const transactionId = `txn_${label.padEnd(26, "0")}`,
    subscriptionId = `sub_${label.padEnd(26, "0")}`;
  try {
    db.prepare(
      "INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'completed',?,?,?)",
    ).run(
      transactionId,
      account.id,
      PRICE_ID,
      PRODUCT_ID,
      "ctm_00000000000000000000000001",
      subscriptionId,
      now - DAY,
      now - DAY,
      now - DAY,
    );
    db.prepare(
      "INSERT INTO paddle_subscriptions(subscription_id,user_id,transaction_id,customer_id,status,price_id,product_id,current_period_ends_at,event_occurred_at,created_at,updated_at) VALUES(?,?,?,?,'active',?,?,?,?,?,?)",
    ).run(
      subscriptionId,
      account.id,
      transactionId,
      "ctm_00000000000000000000000001",
      PRICE_ID,
      PRODUCT_ID,
      now + 30 * DAY,
      now - DAY,
      now - DAY,
      now - DAY,
    );
  } finally {
    db.close();
  }
}

test.before(start);
test.after(stop);

test("the public status does not reveal App Store or Paddle setup", async () => {
  const status = await request("/api/status");
  assert.equal(status.response.status, 200);
  assert.deepEqual(Object.keys(status.data).sort(), ["ok", "version"]);
});

test("a member with Strata+ from the App Store is never sent to a second payment through Paddle", async () => {
  const buyer = await member("AppBuyer");
  assert.equal((await appleBuy(buyer)).response.status, 200);
  assert.equal(
    (await request("/api/me", { cookie: buyer.cookie })).data.user.discovery.accessType,
    "apple",
  );

  const before = paddleCalls("/transactions");
  const refused = await checkout(buyer);
  assert.equal(refused.response.status, 409);
  assert.deepEqual(refused.data, {
    error: "You already have Strata+ through the App Store.",
    code: "ALREADY_ENTITLED_APP_STORE",
  });
  assert.equal(paddleCalls("/transactions"), before, "Paddle is never asked for a checkout");

  // Paddle's portal has nothing to manage; the member is pointed to Apple instead of a generic error.
  const managed = await portal(buyer);
  assert.equal(managed.response.status, 409);
  assert.deepEqual(managed.data, APP_STORE_MANAGED);
  assert.equal(paddleCalls("/customers/ctm_00000000000000000000000001/portal-sessions"), 0);

  // Once App Store access has ended, Paddle checkout opens again; the portal still points to Apple.
  assert.equal(
    (
      await notify("EXPIRED", {
        tx: transaction(buyer, { expiresDate: BASE - 120_000, signedDate: BASE - 1000 }),
        signedDate: BASE - 1000,
      })
    ).response.status,
    200,
  );
  assert.equal(
    (await request("/api/me", { cookie: buyer.cookie })).data.user.discovery.active,
    false,
  );
  const reopened = await checkout(buyer);
  assert.equal(reopened.response.status, 201);
  assert.match(reopened.data.transactionId, /^txn_/);
  assert.equal(paddleCalls("/transactions"), before + 1);
  assert.deepEqual((await portal(buyer)).data, APP_STORE_MANAGED);
});

test("Paddle members keep today's checkout and portal answers", async () => {
  const browser = await member("BrowserOnly");
  const missing = await portal(browser);
  assert.equal(missing.response.status, 404);
  assert.deepEqual(missing.data, {
    error: "No Strata+ monthly subscription was found for this account.",
    code: "SUBSCRIPTION_NOT_FOUND",
  });
  const started = await checkout(browser);
  assert.equal(started.response.status, 201);
  assert.match(started.data.transactionId, /^txn_/);

  const paid = await member("PaddlePaid");
  paddleSubscription(paid, "paddlepaid");
  const entitled = await checkout(paid);
  assert.equal(entitled.response.status, 409);
  assert.deepEqual(entitled.data, {
    error: "Strata+ is already unlocked for this account.",
    code: "ALREADY_ENTITLED",
  });
  const opened = await portal(paid);
  assert.equal(opened.response.status, 200);
  assert.equal(opened.data.subscription.active, true);

  // A Paddle subscriber who also bought in the app still manages the Paddle subscription in Paddle's portal,
  // and checkout names the App Store while that access is active.
  assert.equal(
    (await appleBuy(paid, { transactionId: "4000000101", originalTransactionId: "4000000100" }))
      .response.status,
    200,
  );
  assert.equal((await portal(paid)).response.status, 200);
  assert.equal((await checkout(paid)).data.code, "ALREADY_ENTITLED_APP_STORE");
});
