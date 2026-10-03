"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const {
  DELETION_NOTICE,
  MANAGE_SUBSCRIPTIONS_URL,
  RENEWAL_MARGIN_MS,
  createGooglePlayBillingService,
  googlePlayBillingSettings,
  googlePlayPlan,
  googlePlayRowActive,
  googlePlaySubscriptionSummary,
  validateGooglePlaySubscription,
} = require("../src/google-play-billing");
const { RENEWAL_MARGIN_MS: SQL_RENEWAL_MARGIN_MS } = require("../src/google-play-billing-schema");
const { routeHarness } = require("./support/route-harness");
const { KINDS, withStore } = require("./support/store-kinds");

const DAY = 24 * 60 * 60 * 1000;
const PRODUCT = "online.stratafitness.app.plus";
const PURCHASES = new URL("https://stratafitness.online/api/billing/google/purchases");
const NOTIFY_TOKEN = "n".repeat(40);
const NOTIFICATIONS = new URL(
  `https://stratafitness.online/api/billing/google/notifications?token=${NOTIFY_TOKEN}`,
);
const settings = Object.freeze({
  ...googlePlayBillingSettings({ NODE_ENV: "test", GOOGLE_PLAY_NOTIFICATION_TOKEN: NOTIFY_TOKEN }),
  configured: true,
});

/** Google's SubscriptionPurchaseV2, as subscriptionsv2.get returns it. */
function playSubscription({
  state = "ACTIVE",
  expiresAt = Date.now() + 30 * DAY,
  accountId = null,
  basePlanId = "monthly",
  productId = PRODUCT,
  autoRenew = true,
  acknowledged = false,
  test = false,
  linkedPurchaseToken,
} = {}) {
  return {
    kind: "androidpublisher#subscriptionPurchaseV2",
    startTime: new Date(Date.now() - DAY).toISOString(),
    subscriptionState: `SUBSCRIPTION_STATE_${state}`,
    latestOrderId: "GPA.1234-5678-9012-34567",
    acknowledgementState: acknowledged
      ? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
      : "ACKNOWLEDGEMENT_STATE_PENDING",
    ...(accountId
      ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: accountId } }
      : {}),
    ...(test ? { testPurchase: {} } : {}),
    ...(linkedPurchaseToken ? { linkedPurchaseToken } : {}),
    lineItems: [
      {
        productId,
        expiryTime: new Date(expiresAt).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: autoRenew },
        offerDetails: { basePlanId },
      },
    ],
  };
}

/** A Google Play API that answers from a table of tokens and records acknowledgements. */
function fakeApi(answers = {}) {
  const acknowledged = [],
    reads = [];
  return {
    answers,
    acknowledged,
    reads,
    async subscription(packageName, token) {
      reads.push(token);
      assert.equal(packageName, "online.stratafitness.app");
      const answer = answers[token];
      if (answer instanceof Error) throw answer;
      if (!answer)
        throw Object.assign(new Error("unknown"), {
          code: "GOOGLE_PLAY_PURCHASE_INVALID",
          status: 400,
        });
      return typeof answer === "function" ? answer() : answer;
    },
    async acknowledge(packageName, productId, token) {
      acknowledged.push({ productId, token });
    },
  };
}

async function addUser(store, { id = randomUUID(), email, verified = true } = {}) {
  await store.insertUser({
    id,
    name: "Play Member",
    email: email || `${id}@play.test`,
    passwordHash: "hash",
    passwordSalt: "salt",
    createdAt: Date.now(),
    emailVerifiedAt: verified ? Date.now() : null,
  });
  return id;
}

function harness(store, api, overrides = {}) {
  const responses = [],
    logs = [];
  const http = {
    json(res, status, data, headers = {}) {
      responses.push({ status, data, headers });
      res.status = status;
      res.body = data;
    },
  };
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (event, fields) => logs.push({ level, event, fields }),
    ]),
  );
  const auth = { session: null };
  const guards = { rate: true };
  const service = createGooglePlayBillingService({
    store,
    settings,
    api,
    getUserPayload: async (session) => ({
      id: session.id,
      discovery: { googlePlay: await service.subscriptionForUser(session.id, session) },
    }),
    rateAllowed: () => guards.rate,
    http,
    logger,
    ...overrides,
  });
  const routed = routeHarness(service.routes, {
    json: http.json,
    requireSession: async (_req, res) => {
      if (!auth.session) http.json(res, 401, { error: "Sign in required." });
      return auth.session;
    },
    validCsrf: () => true,
    trustedOrigin: () => true,
  });
  async function post(url, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, {
      method: "POST",
      url: url.pathname + url.search,
      headers: { "content-type": "application/json", origin: "https://stratafitness.online" },
    });
    const res = {};
    try {
      await routed.handleApi(req, res, url);
    } catch (error) {
      // As src/server.js answers a thrown {status, code}.
      if (!error.status) throw error;
      http.json(res, error.status, { error: error.message, code: error.code });
    }
    return res;
  }
  return {
    service,
    auth,
    guards,
    logs,
    buy: (tokens) =>
      post(PURCHASES, {
        purchases: tokens.map((purchaseToken) => ({ purchaseToken, productId: PRODUCT })),
      }),
    notify: (payload, url = NOTIFICATIONS) =>
      post(url, {
        message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), messageId: "1" },
        subscription: "projects/strata/subscriptions/play",
      }),
  };
}

const session = (id) => ({ id, email: `${id}@play.test`, email_verified_at: Date.now() });

test("settings default to the STRATA app, check identifiers, and keep test purchases out of production", () => {
  const defaults = googlePlayBillingSettings({ NODE_ENV: "production" });
  assert.equal(defaults.packageName, "online.stratafitness.app");
  assert.deepEqual(defaults.productIds, [PRODUCT]);
  assert.equal(defaults.configured, false);
  assert.equal(defaults.allowTestPurchases, false);
  assert.equal(googlePlayBillingSettings({ NODE_ENV: "test" }).allowTestPurchases, true);
  assert.deepEqual(
    [
      ...googlePlayBillingSettings({ GOOGLE_PLAY_TEST_ACCOUNTS: " Tester@Example.com ,," })
        .testAccounts,
    ],
    ["tester@example.com"],
  );
  assert.throws(() => googlePlayBillingSettings({ GOOGLE_PLAY_PRODUCT_IDS: "Bad Id" }), TypeError);
  assert.throws(() => googlePlayBillingSettings({ GOOGLE_PLAY_PACKAGE_NAME: "nodots" }), TypeError);
  assert.throws(
    () => googlePlayBillingSettings({ GOOGLE_PLAY_NOTIFICATION_TOKEN: "short" }),
    TypeError,
  );
  assert.throws(
    () => googlePlayBillingSettings({ GOOGLE_PLAY_SERVICE_ACCOUNT: "{}" }),
    TypeError,
    "an unusable key fails at boot, not at the first purchase",
  );
});

test("Google's answer is kept only for this app's Strata+ products, with its plan and owner", () => {
  const owner = randomUUID();
  const result = validateGooglePlaySubscription(
    playSubscription({ accountId: owner.toUpperCase(), basePlanId: "yearly", test: true }),
    "token-1",
    settings,
  );
  assert.equal(result.ok, true);
  assert.equal(result.purchase.state, "ACTIVE");
  assert.equal(result.purchase.accountId, owner);
  assert.equal(result.purchase.basePlanId, "yearly");
  assert.equal(result.purchase.testPurchase, true);
  assert.equal(result.purchase.autoRenew, true);
  assert.equal(result.purchase.acknowledged, false);
  assert.equal(result.purchase.latestOrderId, "GPA.1234-5678-9012-34567");
  assert.deepEqual(
    validateGooglePlaySubscription(
      playSubscription({ productId: "other.app.plus" }),
      "t",
      settings,
    ),
    { ok: false, reason: "product" },
  );
  assert.deepEqual(
    validateGooglePlaySubscription(
      { ...playSubscription(), subscriptionState: "SOMETHING" },
      "t",
      settings,
    ),
    { ok: false, reason: "state" },
  );
  assert.equal(
    validateGooglePlaySubscription(playSubscription({ accountId: "not-a-uuid" }), "t", settings)
      .purchase.accountId,
    null,
  );
  assert.equal(googlePlayPlan("yearly"), "yearly");
  assert.equal(googlePlayPlan("annual-2026"), "yearly");
  assert.equal(googlePlayPlan("monthly"), "monthly");
  assert.equal(googlePlayPlan(null), "monthly");
});

test("access follows Google's state, a renewal not yet heard of, and the test-purchase policy", () => {
  const now = Date.now();
  const row = (fields) => ({
    state: "ACTIVE",
    expires_at: now + DAY,
    auto_renew: 1,
    test_purchase: 0,
    ...fields,
  });
  assert.equal(SQL_RENEWAL_MARGIN_MS, RENEWAL_MARGIN_MS, "service and SQL agree on the margin");
  assert.equal(googlePlayRowActive(row({}), now), true);
  assert.equal(googlePlayRowActive(row({ state: "IN_GRACE_PERIOD" }), now), true);
  assert.equal(googlePlayRowActive(row({ state: "CANCELED", auto_renew: 0 }), now), true);
  for (const state of ["ON_HOLD", "PAUSED", "EXPIRED", "PENDING"])
    assert.equal(googlePlayRowActive(row({ state }), now), false, state);
  assert.equal(googlePlayRowActive(row({ expires_at: now - 60_000 }), now), true, "renewal margin");
  assert.equal(
    googlePlayRowActive(row({ expires_at: now - RENEWAL_MARGIN_MS - 1 }), now),
    false,
    "the margin ends",
  );
  assert.equal(googlePlayRowActive(row({ expires_at: now - 60_000, auto_renew: 0 }), now), false);
  assert.equal(
    googlePlayRowActive(row({ state: "CANCELED", expires_at: now - 60_000 }), now),
    false,
    "a canceled subscription ends at its expiry",
  );
  const production = { allowTestPurchases: false, testAccounts: new Set(["tester@play.test"]) };
  const test = row({ test_purchase: 1 });
  assert.equal(googlePlayRowActive(test, now, null, production), false);
  assert.equal(
    googlePlayRowActive(test, now, { email: "Tester@play.test", emailVerified: true }, production),
    true,
  );
  assert.equal(
    googlePlayRowActive(test, now, { email: "tester@play.test", emailVerified: false }, production),
    false,
  );
  const summary = googlePlaySubscriptionSummary(
    [
      {
        ...row({ state: "EXPIRED", expires_at: now - DAY }),
        product_id: PRODUCT,
        base_plan_id: "monthly",
        updated_at: 2,
      },
      {
        ...row({ state: "IN_GRACE_PERIOD" }),
        product_id: PRODUCT,
        base_plan_id: "yearly",
        updated_at: 1,
      },
    ],
    now,
  );
  assert.deepEqual(summary, {
    active: true,
    productId: PRODUCT,
    plan: "yearly",
    expiresAt: now + DAY,
    autoRenew: true,
    state: "IN_GRACE_PERIOD",
    inGracePeriod: true,
    onHold: false,
    paused: false,
    pending: false,
    testPurchase: false,
  });
  assert.equal(googlePlaySubscriptionSummary([], now), null);
});

for (const kind of KINDS) {
  test(`${kind}: a purchase from the app unlocks Strata+ only for the account that bought it`, async () => {
    await withStore(kind, "google-play", async (store) => {
      const member = await addUser(store),
        other = await addUser(store);
      const api = fakeApi({
        "token-1": playSubscription({ accountId: member, basePlanId: "yearly" }),
        "token-other": playSubscription({ accountId: other }),
        "token-unlinked": playSubscription(),
        "token-wrong-product": playSubscription({ accountId: member, productId: "other.plus" }),
      });
      const { auth, buy, guards } = harness(store, api);
      assert.equal((await buy(["token-1"])).status, 401, "sign-in required");
      auth.session = session(member);
      const accepted = await buy(["token-1", "token-1"]);
      assert.equal(accepted.status, 200);
      assert.deepEqual(accepted.body.accepted, ["token-1"]);
      assert.equal(accepted.body.discovery.googlePlay.active, true);
      assert.equal(accepted.body.discovery.googlePlay.plan, "yearly");
      assert.deepEqual(api.acknowledged, [{ productId: PRODUCT, token: "token-1" }]);
      assert.equal(Number((await store.googlePlaySubscription("token-1")).acknowledged), 1);
      assert.equal(await store.hasActiveGooglePlaySubscription(member, Date.now(), settings), true);
      assert.equal(await store.hasActiveGooglePlaySubscription(other, Date.now(), settings), false);

      const refused = async (token) => {
        const res = await buy([token]);
        return [res.status, res.body.code];
      };
      assert.deepEqual(await refused("token-other"), [403, "GOOGLE_PLAY_ACCOUNT_MISMATCH"]);
      assert.deepEqual(await refused("token-unlinked"), [400, "GOOGLE_PLAY_PURCHASE_INVALID"]);
      assert.deepEqual(await refused("token-wrong-product"), [400, "GOOGLE_PLAY_PURCHASE_INVALID"]);
      assert.deepEqual(await refused("token-unknown"), [400, "GOOGLE_PLAY_PURCHASE_INVALID"]);
      assert.equal(await store.googlePlaySubscription("token-other"), null, "nothing stored");
      // The same subscription can't be claimed by another account while it is live.
      auth.session = session(other);
      api.answers["token-1"] = playSubscription({ accountId: other });
      assert.deepEqual(await refused("token-1"), [409, "GOOGLE_PLAY_PURCHASE_OTHER_ACCOUNT"]);
      assert.equal((await store.googlePlaySubscription("token-1")).user_id, member);
      guards.rate = false;
      assert.deepEqual(await refused("token-1"), [429, "GOOGLE_PLAY_RATE_LIMIT"]);
    });
  });

  test(`${kind}: a resubscription without an account id stays with the account it replaced`, async () => {
    await withStore(kind, "google-play", async (store) => {
      const member = await addUser(store);
      const api = fakeApi({
        "token-old": playSubscription({
          accountId: member,
          state: "EXPIRED",
          expiresAt: Date.now() - DAY,
        }),
        "token-new": playSubscription({ linkedPurchaseToken: "token-old", acknowledged: true }),
      });
      const { auth, buy } = harness(store, api);
      auth.session = session(member);
      assert.equal((await buy(["token-old"])).status, 200);
      assert.deepEqual(api.acknowledged, [], "an expired purchase is not acknowledged");
      const res = await buy(["token-new"]);
      assert.equal(res.status, 200);
      assert.equal((await store.googlePlaySubscription("token-new")).user_id, member);
      assert.equal(res.body.discovery.googlePlay.active, true);
    });
  });

  test(`${kind}: test purchases unlock Strata+ in production only for listed, verified accounts`, async () => {
    await withStore(kind, "google-play", async (store) => {
      const tester = await addUser(store, { email: "tester@play.test" }),
        member = await addUser(store);
      const production = { allowTestPurchases: false, testAccounts: new Set(["tester@play.test"]) };
      const api = fakeApi({
        "token-tester": playSubscription({ accountId: tester, test: true }),
        "token-member": playSubscription({ accountId: member, test: true }),
      });
      const { auth, buy } = harness(store, api, { settings: { ...settings, ...production } });
      auth.session = { id: tester, email: "tester@play.test", email_verified_at: Date.now() };
      assert.equal((await buy(["token-tester"])).body.discovery.googlePlay.active, true);
      auth.session = session(member);
      const res = await buy(["token-member"]);
      assert.equal(res.status, 200, "stored, as Google's own record");
      assert.equal(res.body.discovery.googlePlay.active, false);
      assert.equal(res.body.discovery.googlePlay.testPurchase, true);
      assert.equal(
        await store.hasActiveGooglePlaySubscription(tester, Date.now(), production),
        true,
      );
      assert.equal(
        await store.hasActiveGooglePlaySubscription(member, Date.now(), production),
        false,
      );
    });
  });

  test(`${kind}: the refresh re-reads renewals, retries acknowledgements, and leaves settled ones alone`, async () => {
    await withStore(kind, "google-play", async (store) => {
      const member = await addUser(store);
      const soon = Date.now() + 10 * 60 * 1000,
        later = Date.now() + 30 * DAY;
      const api = fakeApi({
        "token-renews": playSubscription({
          accountId: member,
          expiresAt: soon,
          acknowledged: true,
        }),
        "token-done": playSubscription({
          accountId: member,
          state: "EXPIRED",
          expiresAt: Date.now() - DAY,
        }),
        "token-later": playSubscription({
          accountId: member,
          expiresAt: later,
          acknowledged: true,
        }),
      });
      const { auth, buy, service } = harness(store, api);
      auth.session = session(member);
      for (const token of ["token-renews", "token-done", "token-later"])
        assert.equal((await buy([token])).status, 200);
      api.answers["token-renews"] = playSubscription({
        accountId: member,
        expiresAt: later,
        acknowledged: true,
      });
      api.reads.length = 0;
      assert.deepEqual(await service.refreshDue(), { checked: 1, failed: 0 });
      assert.deepEqual(api.reads, ["token-renews"], "only the one near its expiry");
      assert.equal(
        Number((await store.googlePlaySubscription("token-renews")).expires_at),
        Date.parse(new Date(later).toISOString()),
      );
      // An acknowledgement that failed is tried again by the next refresh.
      const failing = fakeApi({
        "token-ack": playSubscription({ accountId: member, expiresAt: later }),
      });
      failing.acknowledge = async () => {
        throw Object.assign(new Error("busy"), { code: "GOOGLE_PLAY_UNAVAILABLE", status: 503 });
      };
      const first = harness(store, failing);
      first.auth.session = session(member);
      assert.equal((await first.buy(["token-ack"])).status, 200, "access does not wait for Google");
      assert.equal(Number((await store.googlePlaySubscription("token-ack")).acknowledged), 0);
      assert.ok(first.logs.some((log) => log.event === "google_play.acknowledge_failed"));
      const retry = harness(
        store,
        fakeApi({ "token-ack": playSubscription({ accountId: member, expiresAt: later }) }),
      );
      assert.deepEqual(await retry.service.refreshDue(), { checked: 1, failed: 0 });
      assert.equal(Number((await store.googlePlaySubscription("token-ack")).acknowledged), 1);
    });
  });

  test(`${kind}: an answer read earlier never replaces one read later`, async () => {
    await withStore(kind, "google-play", async (store) => {
      const member = await addUser(store);
      const write = (checkedAt, state) =>
        store.upsertGooglePlaySubscription({
          purchaseToken: "token-1",
          userId: member,
          productId: PRODUCT,
          basePlanId: "monthly",
          state,
          testPurchase: false,
          linkedPurchaseToken: null,
          latestOrderId: null,
          startedAt: 1,
          expiresAt: Date.now() + DAY,
          autoRenew: true,
          acknowledged: false,
          checkedAt,
          createdAt: 1,
          updatedAt: checkedAt,
        });
      assert.ok(await write(200, "ACTIVE"));
      assert.equal(await write(100, "EXPIRED"), null);
      assert.equal((await store.googlePlaySubscription("token-1")).state, "ACTIVE");
      assert.ok(await write(300, "CANCELED"));
      assert.equal((await store.googlePlaySubscription("token-1")).state, "CANCELED");
    });
  });

  test(`${kind}: Real-time developer notifications need the push token and are answered from Google`, async () => {
    await withStore(kind, "google-play", async (store) => {
      const member = await addUser(store);
      const api = fakeApi({
        "token-1": playSubscription({ accountId: member, acknowledged: true }),
      });
      const { notify, logs } = harness(store, api);
      const change = {
        version: "1.0",
        packageName: "online.stratafitness.app",
        subscriptionNotification: {
          version: "1.0",
          notificationType: 4,
          purchaseToken: "token-1",
          subscriptionId: PRODUCT,
        },
      };
      const wrong = new URL(
        "https://stratafitness.online/api/billing/google/notifications?token=wrong",
      );
      assert.equal((await notify(change, wrong)).status, 403);
      assert.equal(
        (
          await notify(
            change,
            new URL("https://stratafitness.online/api/billing/google/notifications"),
          )
        ).status,
        403,
      );
      assert.equal(await store.googlePlaySubscription("token-1"), null);
      // A purchase the app never reported is linked by the account id Google carries.
      assert.equal((await notify(change)).status, 200);
      assert.equal((await store.googlePlaySubscription("token-1")).user_id, member);
      api.answers["token-1"] = playSubscription({
        accountId: member,
        state: "EXPIRED",
        acknowledged: true,
      });
      assert.equal((await notify(change)).status, 200);
      assert.equal((await store.googlePlaySubscription("token-1")).state, "EXPIRED");
      assert.equal(
        (
          await notify({
            version: "1.0",
            packageName: "online.stratafitness.app",
            testNotification: { version: "1.0" },
          })
        ).status,
        200,
      );
      assert.equal((await notify({ ...change, packageName: "other.app" })).status, 200);
      assert.equal(
        (await notify({ ...change, subscriptionNotification: { purchaseToken: "token-unknown" } }))
          .status,
        200,
      );
      const outcomes = logs
        .filter((log) => log.event === "google_play.notification")
        .map((log) => log.fields.outcome);
      assert.deepEqual(outcomes, [
        "applied",
        "applied",
        "test",
        "ignored:package",
        "ignored:google_play_purchase_invalid",
      ]);
      // Google being unreachable asks Pub/Sub to try again.
      api.answers["token-1"] = Object.assign(new Error("busy"), {
        code: "GOOGLE_PLAY_UNAVAILABLE",
        status: 503,
      });
      assert.equal((await notify(change)).status, 503);
    });
  });

  test(`${kind}: deletion warns while Google Play bills, and nothing is checked before Google Play is set up`, async () => {
    await withStore(kind, "google-play", async (store) => {
      const member = await addUser(store);
      const api = fakeApi({ "token-1": playSubscription({ accountId: member }) });
      const { auth, buy, service } = harness(store, api);
      assert.equal(await service.deletionNotice(member), null);
      auth.session = session(member);
      await buy(["token-1"]);
      assert.deepEqual(await service.deletionNotice(member), {
        message: DELETION_NOTICE,
        manageUrl: MANAGE_SUBSCRIPTIONS_URL,
      });
      const off = harness(store, null, { settings: { ...settings, configured: false } });
      off.auth.session = session(member);
      const res = await off.buy(["token-1"]);
      assert.deepEqual([res.status, res.body.code], [503, "GOOGLE_PLAY_NOT_CONFIGURED"]);
      assert.deepEqual(await off.service.refreshDue(), { checked: 0, failed: 0 });
    });
  });
}
