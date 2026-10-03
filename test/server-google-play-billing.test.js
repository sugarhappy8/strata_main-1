"use strict";
// Strata+ bought in the Android app, through the real server. A Google Play subscription (written as the purchase
// route stores Google's answer) unlocks Strata+ like any other, is never followed by a second payment through Paddle,
// travels in the member's export without its purchase token, and is named when the member deletes the account.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = join(__dirname, "..");
const PRODUCT_ID = "pro_01m1ky8j916ybyacs836dxbz8x";
const PRICE_ID = "pri_01monthlyfixture00000000000000";
const DAY = 24 * 60 * 60 * 1000;
let paddle,
  app,
  base,
  runtime,
  appErrors = "",
  address = 0;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function start() {
  // Paddle is configured but never reached: every checkout here must stop before it.
  paddle = http.createServer((_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { detail: "Paddle must not be called" } }));
  });
  const paddleBase = await listen(paddle);
  mkdirSync(join(ROOT, "test-runtime"), { recursive: true });
  runtime = mkdtempSync(join(ROOT, "test-runtime", "google-play-"));
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
      PADDLE_CLIENT_TOKEN: "live_browser_token_for_google_play_test",
      PADDLE_API_KEY: "pdl_live_apikey_01googleplayfixture000000_fixture_secret_123",
      PADDLE_WEBHOOK_SECRET: "pdl_ntfset_live_google_play_test_secret",
      PADDLE_CHECKOUT_ENABLED: "true",
      PADDLE_ENFORCE_IP_ALLOWLIST: "false",
      PADDLE_API_BASE: paddleBase,
      GOOGLE_PLAY_SERVICE_ACCOUNT: "",
      GOOGLE_PLAY_NOTIFICATION_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Server startup timed out. ${appErrors}`)),
      5000,
    );
    app.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    app.stderr.on("data", (chunk) => {
      appErrors = (appErrors + chunk).slice(-8192);
    });
    app.once("exit", (code) => reject(new Error(`Server exited (${code}). ${appErrors}`)));
  });
}

async function stop() {
  if (app && app.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(() => app.kill("SIGKILL"), 2000);
      app.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      app.kill("SIGTERM");
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
  const password = "google-play-password-123";
  const signup = await request("/api/signup", {
    method: "POST",
    body: {
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@google-play.test`,
      password,
    },
  });
  assert.equal(signup.response.status, 201);
  const cookie = signup.cookies
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("strata_session="));
  const me = await request("/api/me", { cookie });
  return { cookie, csrf: me.data.csrfToken, id: me.data.user.id, password };
}

// A Google Play subscription, stored as the purchase route stores Google's answer.
function playSubscription(
  account,
  { token = `token-${randomUUID()}`, state = "ACTIVE", basePlanId = "yearly" } = {},
) {
  const db = new DatabaseSync(join(runtime, "strata.sqlite"), { timeout: 5000 }),
    now = Date.now();
  try {
    db.prepare(
      `INSERT INTO google_play_subscriptions(purchase_token,user_id,product_id,base_plan_id,state,test_purchase,
        linked_purchase_token,latest_order_id,started_at,expires_at,auto_renew,acknowledged,checked_at,created_at,updated_at)
       VALUES(?,?,?,?,?,0,NULL,'GPA.0000-0000-0000-00001',?,?,1,1,?,?,?)`,
    ).run(
      token,
      account.id,
      "online.stratafitness.app.plus",
      basePlanId,
      state,
      now - DAY,
      now + 365 * DAY,
      now,
      now,
      now,
    );
  } finally {
    db.close();
  }
  return token;
}

test.before(start);
test.after(stop);

test("a Google Play subscription unlocks Strata+ and never leads to a second payment", async () => {
  const buyer = await member("Pixel");
  playSubscription(buyer);
  const me = await request("/api/me", { cookie: buyer.cookie });
  assert.equal(me.data.user.discovery.active, true);
  assert.equal(me.data.user.discovery.accessType, "google");
  assert.equal(me.data.user.discovery.googlePlay.plan, "yearly");
  assert.equal(me.data.user.discovery.googlePlay.active, true);
  assert.ok(
    me.cookies.some((cookie) => cookie.startsWith("strata_nav=plus")),
    "the Strata+ tabs",
  );
  const workout = await request("/workout.html", { cookie: buyer.cookie });
  assert.equal(workout.response.status, 200, "Strata+ pages open");
  const checkout = await request("/api/billing/checkout", {
    method: "POST",
    cookie: buyer.cookie,
    csrf: buyer.csrf,
    body: {},
  });
  assert.equal(checkout.response.status, 409);
  assert.equal(checkout.data.code, "ALREADY_ENTITLED_GOOGLE_PLAY");
  const portal = await request("/api/billing/portal", {
    method: "POST",
    cookie: buyer.cookie,
    csrf: buyer.csrf,
    body: {},
  });
  assert.deepEqual(portal.data, {
    error:
      "Your Strata+ subscription is managed by Google Play. Manage it in the Play Store on your Android phone.",
    code: "GOOGLE_PLAY_MANAGED",
    manageUrl: "https://play.google.com/store/account/subscriptions",
  });
});

test("an expired Google Play subscription unlocks nothing", async () => {
  const lapsed = await member("Lapsed");
  playSubscription(lapsed, { state: "EXPIRED" });
  const me = await request("/api/me", { cookie: lapsed.cookie });
  assert.equal(me.data.user.discovery.active, false);
  assert.equal(me.data.user.discovery.googlePlay.state, "EXPIRED");
  assert.equal((await request("/workout.html", { cookie: lapsed.cookie })).response.status, 302);
});

test("the purchase and notification routes keep their guards while Google Play is not set up", async () => {
  const buyer = await member("Guarded");
  const body = {
    purchases: [{ purchaseToken: "token-1", productId: "online.stratafitness.app.plus" }],
  };
  const signedOut = await request("/api/billing/google/purchases", { method: "POST", body });
  assert.equal(signedOut.response.status, 401);
  const noCsrf = await request("/api/billing/google/purchases", {
    method: "POST",
    cookie: buyer.cookie,
    body,
  });
  assert.equal(noCsrf.response.status, 403);
  const unset = await request("/api/billing/google/purchases", {
    method: "POST",
    cookie: buyer.cookie,
    csrf: buyer.csrf,
    body,
  });
  assert.equal(unset.response.status, 503);
  assert.equal(unset.data.code, "GOOGLE_PLAY_NOT_CONFIGURED");
  const push = await request("/api/billing/google/notifications?token=anything", {
    method: "POST",
    origin: false,
    body: { message: { data: "" } },
  });
  assert.equal(push.response.status, 403, "no push token is set, so no push is accepted");
});

test("the export carries the subscription without its token, and deletion says Google keeps billing", async () => {
  const leaving = await member("Leaving");
  const token = playSubscription(leaving, { basePlanId: "monthly" });
  const exported = await request("/api/account/export", {
    method: "POST",
    cookie: leaving.cookie,
    csrf: leaving.csrf,
    body: {},
  });
  assert.equal(exported.response.status, 200);
  const text = typeof exported.data === "string" ? exported.data : JSON.stringify(exported.data);
  const data = JSON.parse(text);
  assert.equal(data.access.googlePlaySubscriptions.length, 1);
  assert.equal(data.access.googlePlaySubscriptions[0].orderId, "GPA.0000-0000-0000-00001");
  assert.equal(data.access.googlePlaySubscriptions[0].basePlanId, "monthly");
  assert.ok(!text.includes(token), "the purchase token stays on the server");
  const deleted = await request("/api/account/delete/now", {
    method: "POST",
    cookie: leaving.cookie,
    csrf: leaving.csrf,
    body: { password: leaving.password, confirmation: "DELETE" },
  });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.data));
  assert.equal(
    deleted.data.googlePlayBilling.manageUrl,
    "https://play.google.com/store/account/subscriptions",
  );
  assert.match(deleted.data.message, /Google keeps billing your Google Account/);
  const db = new DatabaseSync(join(runtime, "strata.sqlite"), { timeout: 5000 });
  try {
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM google_play_subscriptions WHERE user_id=?")
        .get(leaving.id).n,
      0,
    );
  } finally {
    db.close();
  }
});
