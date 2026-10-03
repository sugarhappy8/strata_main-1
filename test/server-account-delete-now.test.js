"use strict";

// In-app account deletion through the real server (App Review Guideline 5.1.1(v)): POST /api/account/delete/now with
// the account password and DELETE deletes the account immediately, with the same refusals as the emailed link.
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
const PRODUCT = "online.stratafitness.app.plus.monthly";
const ADMIN_EMAIL = "owner@strata-delete.test";
const PASSWORD = "delete-now-password-123";
const DAY = 24 * 60 * 60 * 1000;
const chain = createAppleTestChain();
const BASE = Date.now() + 60_000;
const deliveries = [];
let resend,
  app,
  base,
  runtime,
  appOutput = "",
  appErrors = "",
  address = 0;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address();
      resolve(`http://127.0.0.1:${value.port}`);
    });
  });
}

async function start() {
  resend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    deliveries.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: `email_${deliveries.length}` }));
  });
  const resendBase = await listen(resend);
  mkdirSync(join(ROOT, "test-runtime"), { recursive: true });
  runtime = mkdtempSync(join(ROOT, "test-runtime", "delete-now-"));
  app = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      TRUST_PROXY: "true",
      APP_BASE_URL: "http://127.0.0.1",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtime,
      ADMIN_EMAIL,
      EMAIL_VERIFICATION_ENABLED: "true",
      RESEND_API_KEY: "re_delete_now_fixture_key_123456",
      EMAIL_FROM: "STRATA <accounts@auth.stratafitness.online>",
      EMAIL_REPLY_TO: "stratafitness.official@gmail.com",
      EMAIL_VERIFICATION_SECRET: "delete-now-test-secret-that-is-long-enough-123",
      RESEND_API_BASE: resendBase,
      PADDLE_CHECKOUT_ENABLED: "false",
      PADDLE_CLIENT_TOKEN: "",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "",
      PADDLE_PRODUCT_ID: "",
      PADDLE_PRICE_ID: "",
      APPLE_ROOT_FINGERPRINT: chain.rootFingerprint,
      APPLE_BUNDLE_ID: "",
      APPLE_IAP_PRODUCT_IDS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let settled = false;
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
      appOutput = (appOutput + chunk).slice(-65536);
      const match = appOutput.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
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
  if (resend?.listening) await new Promise((resolve) => resend.close(resolve));
  if (runtime) rmSync(runtime, { recursive: true, force: true });
}

async function request(
  path,
  { method = "GET", body, cookie = "", csrf = "", origin = base, ip } = {},
) {
  address = (address % 240) + 1;
  const headers = { "X-Forwarded-For": ip || `203.0.113.${address}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (origin) headers.Origin = origin;
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
const cookieNamed = (cookies, name) =>
  cookies.map((item) => item.split(";")[0]).find((item) => item.startsWith(`${name}=`)) || "";
const deleteNow = (account, body, options = {}) =>
  request("/api/account/delete/now", {
    method: "POST",
    cookie: account.cookie,
    csrf: account.csrf,
    body,
    ...options,
  });
const database = () => new DatabaseSync(join(runtime, "strata.sqlite"), { timeout: 5000 });
const signedIn = async (account) => {
  const { response, data } = await request("/api/me", { cookie: account.cookie });
  assert.equal(response.status, 200);
  return Boolean(data.user);
};

async function member(
  name,
  email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@delete-now.test`,
) {
  const signup = await request("/api/signup", {
    method: "POST",
    body: { name, email, password: PASSWORD },
  });
  assert.equal(signup.response.status, 202);
  const code = String(deliveries.at(-1)?.text || "").match(/code is ([0-9]{6})\./i)?.[1];
  assert.ok(code);
  const verified = await request("/api/verify-email", {
    method: "POST",
    body: { code },
    cookie: cookieNamed(signup.cookies, "strata_signup"),
  });
  assert.equal(verified.response.status, 201);
  const cookie = cookieNamed(verified.cookies, "strata_session"),
    me = await request("/api/me", { cookie });
  return { cookie, csrf: me.data.csrfToken, id: me.data.user.id, email };
}
async function login(email) {
  const result = await request("/api/login", {
    method: "POST",
    body: { email, password: PASSWORD },
  });
  if (result.response.status !== 200) return { status: result.response.status };
  const cookie = cookieNamed(result.cookies, "strata_session"),
    me = await request("/api/me", { cookie });
  return { status: 200, cookie, csrf: me.data.csrfToken, id: me.data.user.id, email };
}
function rowCount(table, column, value) {
  const db = database();
  try {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(value).count;
  } finally {
    db.close();
  }
}

test.before(start);
test.after(stop);

test("a wrong password, a missing DELETE, a missing CSRF token, or another origin deletes nothing", async () => {
  const account = await member("Careful");
  const noOrigin = await deleteNow(
    account,
    { password: PASSWORD, confirmation: "DELETE" },
    { origin: "" },
  );
  assert.equal(noOrigin.response.status, 403);
  assert.equal(noOrigin.data.code, "ORIGIN_REQUIRED");
  const crossOrigin = await deleteNow(
    account,
    { password: PASSWORD, confirmation: "DELETE" },
    { origin: "https://attacker.example" },
  );
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.data.code, "ORIGIN_REQUIRED");
  const noCsrf = await deleteNow(
    account,
    { password: PASSWORD, confirmation: "DELETE" },
    { csrf: "" },
  );
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.data.code, "INVALID_CSRF");
  const signedOut = await request("/api/account/delete/now", {
    method: "POST",
    body: { password: PASSWORD, confirmation: "DELETE" },
  });
  assert.equal(signedOut.response.status, 401);
  const noConfirmation = await deleteNow(account, { password: PASSWORD, confirmation: "delete" });
  assert.equal(noConfirmation.response.status, 400);
  assert.equal(noConfirmation.data.code, "DELETE_CONFIRMATION_REQUIRED");
  const wrong = await deleteNow(account, {
    password: "not-the-password-123",
    confirmation: "DELETE",
  });
  assert.equal(wrong.response.status, 401);
  assert.deepEqual(wrong.data, {
    error: "That password is incorrect.",
    code: "PASSWORD_INCORRECT",
  });
  assert.deepEqual(wrong.cookies, []);
  assert.equal(
    (await request("/api/account/delete/now", { cookie: account.cookie })).response.status,
    405,
  );
  assert.equal(await signedIn(account), true);
  assert.equal(rowCount("users", "id", account.id), 1);
  assert.equal(
    rowCount("account_action_requests", "user_id", account.id),
    0,
    "a refused attempt leaves no internal deletion action",
  );
});

test("password attempts are limited per account across networks and per network across accounts", async () => {
  const target = await member("Guarded");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(
      (await deleteNow(target, { password: `guess-number-${attempt}-xyz`, confirmation: "DELETE" }))
        .response.status,
      401,
    );
  }
  const blocked = await deleteNow(target, { password: PASSWORD, confirmation: "DELETE" });
  assert.equal(
    blocked.response.status,
    429,
    "a sixth attempt from a fresh network is still refused",
  );
  assert.equal(blocked.data.code, "ACCOUNT_DELETE_RATE_LIMIT");
  assert.equal(blocked.response.headers.get("retry-after"), "900");
  assert.equal(rowCount("users", "id", target.id), 1);

  const ip = "198.51.100.77";
  for (let index = 0; index < 5; index += 1) {
    const prober = await member(`Prober${index}`);
    assert.equal(
      (
        await deleteNow(
          prober,
          { password: "wrong-password-on-shared-network", confirmation: "DELETE" },
          { ip },
        )
      ).response.status,
      401,
    );
  }
  const neighbour = await member("Neighbour");
  const shared = await deleteNow(neighbour, { password: PASSWORD, confirmation: "DELETE" }, { ip });
  assert.equal(shared.response.status, 429, "the network is limited too");
  assert.equal(rowCount("users", "id", neighbour.id), 1);
  assert.equal(
    (
      await deleteNow(
        neighbour,
        { password: PASSWORD, confirmation: "DELETE" },
        { ip: "198.51.100.78" },
      )
    ).response.status,
    200,
  );
});

test("the primary administrator, an unsettled payment, and a live Paddle subscription are refused as on the emailed link", async () => {
  await member("Owner", ADMIN_EMAIL);
  const owner = await login(ADMIN_EMAIL);
  assert.equal(owner.status, 200);
  const protectedOwner = await deleteNow(owner, { password: PASSWORD, confirmation: "DELETE" });
  assert.equal(protectedOwner.response.status, 409);
  assert.equal(protectedOwner.data.code, "ADMIN_ACCOUNT_PROTECTED");
  assert.equal(await signedIn(owner), true);

  const paying = await member("Paying"),
    now = Date.now();
  let db = database();
  try {
    db.prepare(
      "INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,paddle_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run("txn_delete_now_pending", paying.id, "pri_test", "pro_test", "ready", now, now);
  } finally {
    db.close();
  }
  const pending = await deleteNow(paying, { password: PASSWORD, confirmation: "DELETE" });
  assert.equal(pending.response.status, 409);
  assert.equal(pending.data.code, "PURCHASE_PENDING");
  assert.match(pending.data.error, /Nothing was deleted/);

  const subscribed = await member("Subscribed");
  db = database();
  try {
    db.prepare(
      "INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "txn_delete_now_sub",
      subscribed.id,
      "pri_test",
      "pro_test",
      "ctm_test",
      "sub_delete_now",
      "completed",
      now,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO paddle_subscriptions(subscription_id,user_id,transaction_id,customer_id,status,price_id,product_id,current_period_ends_at,event_occurred_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "sub_delete_now",
      subscribed.id,
      "txn_delete_now_sub",
      "ctm_test",
      "active",
      "pri_test",
      "pro_test",
      now + 30 * DAY,
      now,
      now,
      now,
    );
  } finally {
    db.close();
  }
  const inApp = await deleteNow(subscribed, { password: PASSWORD, confirmation: "DELETE" });
  assert.equal(inApp.response.status, 409);
  assert.equal(inApp.data.code, "SUBSCRIPTION_ACTIVE");
  const requested = await request("/api/account/delete/request", {
    method: "POST",
    cookie: subscribed.cookie,
    csrf: subscribed.csrf,
    body: {},
  });
  assert.equal(requested.response.status, 202);
  const token = String(
    deliveries.findLast((item) => item.subject === "Confirm deletion of your STRATA account").text,
  ).match(/#token=([A-Za-z0-9_-]{43})/)[1];
  const emailed = await request("/api/account/delete/complete", {
    method: "POST",
    body: { token, confirmation: "DELETE" },
  });
  assert.equal(emailed.response.status, 409);
  assert.deepEqual(inApp.data, emailed.data, "both paths refuse with the same code and message");
  for (const account of [paying, subscribed]) assert.equal(await signedIn(account), true);
  assert.equal(
    (await request("/api/account/delete/status", { method: "POST", body: { token } })).data.active,
    true,
    "a refused in-app deletion keeps the emailed link usable",
  );
});

test("an App Store subscriber deletes the account in the app: Apple's notice, cookies cleared, and the data gone", async () => {
  const buyer = await member("Buyer");
  const signed = chain.signJws({
    transactionId: "4000000001",
    originalTransactionId: "4000000000",
    webOrderLineItemId: "1",
    bundleId: BUNDLE,
    productId: PRODUCT,
    subscriptionGroupIdentifier: "21500000",
    purchaseDate: BASE - DAY,
    originalPurchaseDate: BASE - DAY,
    expiresDate: BASE + 29 * DAY,
    quantity: 1,
    type: "Auto-Renewable Subscription",
    appAccountToken: buyer.id,
    inAppOwnershipType: "PURCHASED",
    signedDate: BASE - 5000,
    environment: "Sandbox",
    transactionReason: "PURCHASE",
    storefront: "USA",
    price: 2990,
    currency: "USD",
  });
  const bought = await request("/api/billing/apple/transactions", {
    method: "POST",
    cookie: buyer.cookie,
    csrf: buyer.csrf,
    body: { signedTransactions: [signed] },
  });
  assert.equal(bought.response.status, 200, JSON.stringify(bought.data));
  assert.equal(
    (await request("/api/me", { cookie: buyer.cookie })).data.user.discovery.accessType,
    "apple",
  );
  const plan = await request("/api/plan", { cookie: buyer.cookie });
  const saved = await request("/api/plan", {
    method: "PUT",
    cookie: buyer.cookie,
    csrf: buyer.csrf,
    body: { plan: plan.data.plan, expectedPlanUpdatedAt: plan.data.planUpdatedAt },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
  assert.equal(rowCount("plans", "user_id", buyer.id), 1);
  // A second signed-in device, and an emailed link requested earlier, go with the account.
  const otherDevice = await login(buyer.email);
  assert.equal(otherDevice.status, 200);
  assert.equal(
    (
      await request("/api/account/delete/request", {
        method: "POST",
        cookie: buyer.cookie,
        csrf: buyer.csrf,
        body: {},
      })
    ).response.status,
    202,
  );
  const token = String(
    deliveries.findLast((item) => item.subject === "Confirm deletion of your STRATA account").text,
  ).match(/#token=([A-Za-z0-9_-]{43})/)[1];

  const deleted = await deleteNow(buyer, { password: PASSWORD, confirmation: "DELETE" });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.data.ok, true);
  assert.match(
    deleted.data.message,
    /^Your STRATA account was permanently deleted\. .*Apple keeps billing your Apple Account until you cancel it/,
  );
  assert.deepEqual(Object.keys(deleted.data.appleBilling).sort(), ["manageUrl", "message"]);
  assert.equal(deleted.data.appleBilling.manageUrl, "https://apps.apple.com/account/subscriptions");
  const session = deleted.cookies.find((item) => item.startsWith("strata_session=")),
    signup = deleted.cookies.find((item) => item.startsWith("strata_signup="));
  assert.match(session, /^strata_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
  assert.match(signup, /^strata_signup=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);

  assert.equal(await signedIn(buyer), false);
  assert.equal(await signedIn(otherDevice), false);
  assert.equal((await login(buyer.email)).status, 401, "the account can no longer sign in");
  assert.equal(
    (await request("/api/account/delete/status", { method: "POST", body: { token } })).data.active,
    false,
  );
  for (const [table, column] of [
    ["users", "id"],
    ["sessions", "user_id"],
    ["plans", "user_id"],
    ["apple_subscriptions", "user_id"],
    ["account_action_requests", "user_id"],
    ["account_action_deliveries", "user_id"],
    ["signup_verifications", "user_id"],
  ]) {
    assert.equal(
      rowCount(table, column, buyer.id),
      0,
      `${table} keeps nothing for the deleted account`,
    );
  }
  const audit =
    /Auth audit \{"event":"account_deleted","at":"[^"]+","purpose":"account_delete_in_app","email":"b\*+[a-z0-9]@delete-now\.test"\}/;
  for (let wait = 0; wait < 40 && !audit.test(appOutput); wait += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(
    appOutput,
    audit,
    "the deletion is audit-logged like the emailed link, with the address masked",
  );
  assert.doesNotMatch(appOutput, new RegExp(PASSWORD));
});
