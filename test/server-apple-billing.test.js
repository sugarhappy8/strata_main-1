"use strict";

// Apple In-App Purchase through the real server: the iOS app's signed transactions, App Store Server Notifications V2,
// /api/me, Strata+ gating, export, deletion, and the sliding session cookie that keeps app members signed in.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createAppleTestChain } = require("./support/apple-test-chain");

const ROOT = join(__dirname, "..");
const BUNDLE = "online.stratafitness.app";
const PRODUCT = "online.stratafitness.app.plus.monthly";
const DAY = 24 * 60 * 60 * 1000;
const chain = createAppleTestChain();
// The test chain's certificates start when they were made; signed dates sit a minute ahead, inside the clock allowance.
const BASE = Date.now() + 60_000;
const deliveries = [];
let resend,
  app,
  base,
  runtime,
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
  runtime = mkdtempSync(join(ROOT, "test-runtime", "apple-billing-"));
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
      EMAIL_VERIFICATION_ENABLED: "true",
      RESEND_API_KEY: "re_apple_billing_fixture_key_123456",
      EMAIL_FROM: "STRATA <accounts@auth.stratafitness.online>",
      EMAIL_REPLY_TO: "stratafitness.official@gmail.com",
      EMAIL_VERIFICATION_SECRET: "apple-billing-test-secret-that-is-long-enough-123",
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
  if (resend?.listening) await new Promise((resolve) => resend.close(resolve));
  if (runtime) rmSync(runtime, { recursive: true, force: true });
}

async function request(path, { method = "GET", body, cookie = "", csrf = "", origin = true } = {}) {
  address = (address % 240) + 1;
  const headers = { "X-Forwarded-For": `203.0.113.${address}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (origin) headers.Origin = base;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
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

async function member(name) {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@apple.test`;
  const signup = await request("/api/signup", {
    method: "POST",
    body: { name, email, password: "apple-billing-password-123" },
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

function transaction(account, overrides = {}) {
  return {
    transactionId: "3000000001",
    originalTransactionId: "3000000000",
    webOrderLineItemId: "1",
    bundleId: BUNDLE,
    productId: PRODUCT,
    subscriptionGroupIdentifier: "21500000",
    purchaseDate: BASE - DAY,
    originalPurchaseDate: BASE - DAY,
    expiresDate: BASE + 29 * DAY,
    quantity: 1,
    type: "Auto-Renewable Subscription",
    appAccountToken: account.id,
    inAppOwnershipType: "PURCHASED",
    signedDate: BASE - 5000,
    environment: "Sandbox",
    transactionReason: "PURCHASE",
    storefront: "USA",
    price: 2990,
    currency: "USD",
    ...overrides,
  };
}
function renewal(overrides = {}) {
  return {
    originalTransactionId: "3000000000",
    autoRenewProductId: PRODUCT,
    productId: PRODUCT,
    autoRenewStatus: 1,
    signedDate: BASE - 5000,
    environment: "Sandbox",
    ...overrides,
  };
}
function notify(type, { subtype, tx, renew, uuid = randomUUID(), signedDate }) {
  return request("/api/billing/apple/notifications", {
    method: "POST",
    origin: false,
    body: {
      signedPayload: chain.signJws({
        notificationType: type,
        ...(subtype ? { subtype } : {}),
        notificationUUID: uuid,
        version: "2.0",
        signedDate,
        data: {
          appAppleId: 1,
          bundleId: BUNDLE,
          bundleVersion: "1",
          environment: "Sandbox",
          signedTransactionInfo: chain.signJws(tx),
          ...(renew ? { signedRenewalInfo: chain.signJws(renew) } : {}),
        },
      }),
    },
  });
}
const purchase = (account, tokens) =>
  request("/api/billing/apple/transactions", {
    method: "POST",
    cookie: account.cookie,
    csrf: account.csrf,
    body: { signedTransactions: tokens },
  });
const discoveryOf = async (account) =>
  (await request("/api/me", { cookie: account.cookie })).data.user.discovery;
const database = () => new DatabaseSync(join(runtime, "strata.sqlite"), { timeout: 5000 });
const tokenHash = (cookie) =>
  createHash("sha256")
    .update(decodeURIComponent(cookie.split("=")[1]))
    .digest("hex");

test.before(start);
test.after(stop);

test("an Apple purchase unlocks Strata+ for the buying account only, and the App Store keeps it current", async () => {
  const buyer = await member("Buyer"),
    other = await member("Other");
  const before = await discoveryOf(buyer);
  assert.equal(before.active, false);
  assert.equal(before.accessType, null);
  assert.equal(before.apple, null);
  assert.equal((await request("/api/discovery", { cookie: buyer.cookie })).response.status, 402);

  // Strata+ is not shared through Family Sharing: the app's post is refused and the notification grants nothing.
  const shared = {
    transactionId: "3000000501",
    originalTransactionId: "3000000500",
    inAppOwnershipType: "FAMILY_SHARED",
  };
  const refusedShare = await purchase(buyer, [chain.signJws(transaction(buyer, shared))]);
  assert.equal(refusedShare.response.status, 422);
  assert.deepEqual(refusedShare.data, {
    error:
      "Strata+ is not shared through Family Sharing. Subscribe with your own Apple Account to unlock it.",
    code: "APPLE_FAMILY_SHARED",
  });
  const sharedNotice = await notify("SUBSCRIBED", {
    tx: transaction(buyer, shared),
    renew: renewal({ originalTransactionId: "3000000500" }),
    signedDate: BASE - 6000,
  });
  assert.equal(sharedNotice.response.status, 200);
  assert.deepEqual(sharedNotice.data, {});
  assert.equal((await discoveryOf(buyer)).active, false);
  assert.equal((await discoveryOf(buyer)).apple, null);
  assert.equal(
    (await request("/api/status")).data.appStoreConfigured,
    undefined,
    "App Store setup is not public",
  );

  const signed = chain.signJws(transaction(buyer));
  assert.equal(
    (
      await request("/api/billing/apple/transactions", {
        method: "POST",
        cookie: buyer.cookie,
        body: { signedTransactions: [signed] },
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await request("/api/billing/apple/transactions", {
        method: "POST",
        body: { signedTransactions: [signed] },
      })
    ).response.status,
    401,
  );
  const tampered = signed.split(".");
  tampered[1] = Buffer.from(
    JSON.stringify(transaction(buyer, { expiresDate: BASE + 999 * DAY })),
  ).toString("base64url");
  for (const [tokens, status, code] of [
    [[tampered.join(".")], 400, "APPLE_SIGNATURE_INVALID"],
    [
      [chain.signJws(transaction(buyer, { productId: "online.stratafitness.app.plus.yearly" }))],
      400,
      "APPLE_TRANSACTION_INVALID",
    ],
    [
      [chain.signJws(transaction(buyer, { bundleId: "com.example.other" }))],
      400,
      "APPLE_TRANSACTION_INVALID",
    ],
    [
      [chain.signJws(transaction(buyer, { appAccountToken: undefined }))],
      400,
      "APPLE_TRANSACTION_INVALID",
    ],
    [[createAppleTestChain().signJws(transaction(buyer))], 400, "APPLE_ROOT_UNTRUSTED"],
    [[chain.signJws(transaction(other))], 403, "APPLE_ACCOUNT_MISMATCH"],
  ]) {
    const rejected = await purchase(buyer, tokens);
    assert.equal(rejected.response.status, status, code);
    assert.equal(rejected.data.code, code);
  }

  const bought = await purchase(buyer, [signed]);
  assert.equal(bought.response.status, 200);
  assert.deepEqual(bought.data.accepted, ["3000000001"]);
  assert.equal(bought.data.discovery.accessType, "apple");
  assert.deepEqual(bought.data.discovery.apple, {
    active: true,
    productId: PRODUCT,
    expiresAt: BASE + 29 * DAY,
    autoRenew: null,
    inGracePeriod: false,
    environment: "Sandbox",
    revoked: false,
  });
  const me = await request("/api/me", { cookie: buyer.cookie });
  assert.equal(me.data.user.discovery.active, true);
  assert.equal(me.data.user.discovery.accessType, "apple");
  assert.equal(me.data.user.capabilities["plus.studio"], true);
  assert.equal((await request("/api/discovery", { cookie: buyer.cookie })).response.status, 200);
  assert.equal((await request("/discover.html", { cookie: buyer.cookie })).response.status, 200);
  assert.equal(
    (await purchase(other, [chain.signJws(transaction(buyer))])).data.code,
    "APPLE_ACCOUNT_MISMATCH",
  );
  const conflict = await purchase(other, [
    chain.signJws(transaction(other, { transactionId: "3000000099" })),
  ]);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.code, "APPLE_PURCHASE_OTHER_ACCOUNT");
  assert.equal((await discoveryOf(other)).active, false);

  const forged = await request("/api/billing/apple/notifications", {
    method: "POST",
    origin: false,
    body: {
      signedPayload: createAppleTestChain().signJws({
        notificationType: "TEST",
        notificationUUID: randomUUID(),
        signedDate: BASE,
      }),
    },
  });
  assert.equal(forged.response.status, 400);
  const testNotification = await request("/api/billing/apple/notifications", {
    method: "POST",
    origin: false,
    body: {
      signedPayload: chain.signJws({
        notificationType: "TEST",
        notificationUUID: randomUUID(),
        signedDate: BASE,
      }),
    },
  });
  assert.equal(testNotification.response.status, 200);
  assert.deepEqual(testNotification.data, {});

  const renewId = randomUUID();
  const renewed = await notify("DID_RENEW", {
    tx: transaction(buyer, {
      transactionId: "3000000002",
      expiresDate: BASE + 59 * DAY,
      signedDate: BASE - 4000,
    }),
    renew: renewal({ signedDate: BASE - 4000 }),
    uuid: renewId,
    signedDate: BASE - 4000,
  });
  assert.equal(renewed.response.status, 200);
  assert.equal((await discoveryOf(buyer)).apple.expiresAt, BASE + 59 * DAY);
  assert.equal((await discoveryOf(buyer)).apple.autoRenew, true);
  assert.equal(
    (
      await notify("DID_RENEW", {
        tx: transaction(buyer, { transactionId: "3000000002", expiresDate: BASE + 59 * DAY }),
        uuid: renewId,
        signedDate: BASE - 4000,
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await notify("DID_CHANGE_RENEWAL_STATUS", {
        subtype: "AUTO_RENEW_DISABLED",
        tx: transaction(buyer),
        renew: renewal({ autoRenewStatus: 0 }),
        signedDate: BASE - 4500,
      })
    ).response.status,
    200,
  );
  assert.equal(
    (await discoveryOf(buyer)).apple.autoRenew,
    true,
    "an older notification must not move state backwards",
  );

  await notify("DID_FAIL_TO_RENEW", {
    subtype: "GRACE_PERIOD",
    tx: transaction(buyer, { transactionId: "3000000002", expiresDate: BASE - 120_000 }),
    renew: renewal({ gracePeriodExpiresDate: BASE + 6 * DAY, isInBillingRetryPeriod: true }),
    signedDate: BASE - 3000,
  });
  let discovery = await discoveryOf(buyer);
  assert.equal(discovery.active, true);
  assert.equal(discovery.apple.inGracePeriod, true);
  assert.equal((await request("/api/discovery", { cookie: buyer.cookie })).response.status, 200);
  await notify("GRACE_PERIOD_EXPIRED", {
    tx: transaction(buyer, { transactionId: "3000000002", expiresDate: BASE - 120_000 }),
    renew: renewal({ isInBillingRetryPeriod: false }),
    signedDate: BASE - 2500,
  });
  discovery = await discoveryOf(buyer);
  assert.equal(discovery.active, false);
  assert.equal(discovery.accessType, null);
  assert.equal(discovery.apple.inGracePeriod, false);
  assert.equal((await request("/api/discovery", { cookie: buyer.cookie })).response.status, 402);

  await notify("DID_RENEW", {
    tx: transaction(buyer, { transactionId: "3000000003", expiresDate: BASE + 30 * DAY }),
    renew: renewal(),
    signedDate: BASE - 2000,
  });
  assert.equal((await discoveryOf(buyer)).active, true);
  await notify("REFUND", {
    tx: transaction(buyer, {
      transactionId: "3000000003",
      expiresDate: BASE + 30 * DAY,
      revocationDate: BASE - 1500,
      revocationReason: 0,
    }),
    signedDate: BASE - 1500,
  });
  discovery = await discoveryOf(buyer);
  assert.equal(discovery.active, false);
  assert.equal(discovery.apple.revoked, true);
  await notify("EXPIRED", {
    subtype: "VOLUNTARY",
    tx: transaction(buyer, {
      transactionId: "3000000003",
      expiresDate: BASE - 120_000,
      revocationDate: BASE - 1500,
      revocationReason: 0,
    }),
    renew: renewal({ autoRenewStatus: 0 }),
    signedDate: BASE - 1200,
  });
  assert.equal((await discoveryOf(buyer)).active, false);
  await notify("REFUND_REVERSED", {
    tx: transaction(buyer, { transactionId: "3000000004", expiresDate: BASE + 30 * DAY }),
    renew: renewal(),
    signedDate: BASE - 1000,
  });
  discovery = await discoveryOf(buyer);
  assert.equal(discovery.active, true);
  assert.equal(discovery.apple.revoked, false);

  const exported = await request("/api/account/export", {
    method: "POST",
    cookie: buyer.cookie,
    csrf: buyer.csrf,
    body: {},
  });
  assert.equal(exported.response.status, 200);
  assert.equal(exported.data.access.appleSubscriptions.length, 1);
  assert.deepEqual(Object.keys(exported.data.access.appleSubscriptions[0]).sort(), [
    "autoRenew",
    "createdAt",
    "environment",
    "expiresAt",
    "gracePeriodExpiresAt",
    "latestTransactionId",
    "originalPurchasedAt",
    "originalTransactionId",
    "productId",
    "purchasedAt",
    "revocationReason",
    "revokedAt",
    "updatedAt",
  ]);
  assert.equal(exported.data.access.appleSubscriptions[0].latestTransactionId, "3000000004");
  assert.doesNotMatch(JSON.stringify(exported.data), /signedTransaction|x5c|appAccountToken/);

  // Deleting the account is never blocked by an Apple subscription; the member is told Apple keeps billing.
  const deletion = await request("/api/account/delete/request", {
    method: "POST",
    cookie: buyer.cookie,
    csrf: buyer.csrf,
    body: {},
  });
  assert.equal(deletion.response.status, 202);
  assert.equal(
    deletion.data.appleBilling.manageUrl,
    "https://apps.apple.com/account/subscriptions",
  );
  const email = deliveries.findLast(
    (item) => item.subject === "Confirm deletion of your STRATA account",
  );
  assert.match(email.text, /Settings > Apple ID > Subscriptions/);
  const token = String(email.text).match(/#token=([A-Za-z0-9_-]{43})/)[1];
  const status = await request("/api/account/delete/status", { method: "POST", body: { token } });
  assert.equal(status.data.active, true);
  assert.match(status.data.appleBilling.message, /Apple keeps billing/);
  const deleted = await request("/api/account/delete/complete", {
    method: "POST",
    body: { token, confirmation: "DELETE" },
  });
  assert.equal(deleted.response.status, 200);
  assert.match(deleted.data.message, /permanently deleted\. .*Apple keeps billing/);
  const db = database();
  try {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM apple_subscriptions WHERE user_id=?").get(buyer.id)
        .count,
      0,
    );
  } finally {
    db.close();
  }
  assert.equal((await request("/api/me", { cookie: buyer.cookie })).response.status, 401);

  // With the old link gone, a renewal for the deleted account is acknowledged and ignored.
  assert.equal(
    (
      await notify("DID_RENEW", {
        tx: transaction(buyer, { transactionId: "3000000005", expiresDate: BASE + 60 * DAY }),
        signedDate: BASE - 500,
      })
    ).response.status,
    200,
  );
});

test("active app sessions slide forward with the same token, capped at 60 days from sign-in", async () => {
  const account = await member("Session");
  const hash = tokenHash(account.cookie),
    now = Date.now();
  const fresh = await request("/api/me", { cookie: account.cookie });
  assert.equal(
    cookieNamed(fresh.cookies, "strata_session"),
    "",
    "a fresh session needs no renewal",
  );

  let db = database();
  try {
    db.prepare("UPDATE sessions SET expires_at=?,created_at=? WHERE token_hash=?").run(
      now + 60 * 60 * 1000,
      now - 6 * DAY,
      hash,
    );
  } finally {
    db.close();
  }
  const renewed = await request("/api/me", { cookie: account.cookie });
  assert.equal(renewed.response.status, 200);
  const cookie = renewed.cookies.find((item) => item.startsWith("strata_session="));
  assert.ok(cookie, "the session cookie is re-sent");
  assert.equal(cookie.split(";")[0], account.cookie, "the token does not change");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge > 7 * 24 * 3600 - 120 && maxAge <= 7 * 24 * 3600, String(maxAge));
  db = database();
  try {
    assert.ok(
      db.prepare("SELECT expires_at FROM sessions WHERE token_hash=?").get(hash).expires_at >
        now + 6 * DAY,
    );
  } finally {
    db.close();
  }
  assert.equal(
    cookieNamed((await request("/api/me", { cookie: account.cookie })).cookies, "strata_session"),
    "",
    "renewal happens once per half-life",
  );

  db = database();
  try {
    db.prepare("UPDATE sessions SET expires_at=?,created_at=? WHERE token_hash=?").run(
      now + 30 * 60 * 1000,
      now - 60 * DAY + 2 * 60 * 60 * 1000,
      hash,
    );
  } finally {
    db.close();
  }
  const capped = (await request("/", { cookie: account.cookie })).cookies.find((item) =>
    item.startsWith("strata_session="),
  );
  const cappedAge = Number(capped?.match(/Max-Age=(\d+)/)?.[1]);
  assert.ok(cappedAge > 2 * 3600 - 120 && cappedAge <= 2 * 3600, String(cappedAge));

  db = database();
  try {
    db.prepare("UPDATE sessions SET expires_at=?,created_at=? WHERE token_hash=?").run(
      now + 30 * 60 * 1000,
      now - 60 * DAY + 30 * 60 * 1000,
      hash,
    );
  } finally {
    db.close();
  }
  assert.equal(
    cookieNamed((await request("/api/me", { cookie: account.cookie })).cookies, "strata_session"),
    "",
    "no renewal past the absolute cap",
  );
  const logout = await request("/api/logout", { method: "POST", cookie: account.cookie, body: {} });
  assert.deepEqual(logout.cookies.filter((item) => item.startsWith("strata_session=")).length, 1);
  assert.match(cookieNamed(logout.cookies, "strata_session"), /^strata_session=$/);
});
