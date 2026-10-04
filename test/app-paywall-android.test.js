"use strict";
// The paywall inside the Android app: the same controller and markup as on iPhone, selling through Google Play.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadHtml } = require("./support/browser-html");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const PLAY_PRODUCT = "online.stratafitness.app.plus";
const MONTHLY = {
  id: PLAY_PRODUCT,
  basePlanId: "monthly",
  displayName: "Strata+",
  description: "Strata+",
  displayPrice: "$4.99",
  price: "4.99",
  currencyCode: "USD",
  period: { unit: "month", value: 1 },
};
const YEARLY = {
  ...MONTHLY,
  basePlanId: "yearly",
  displayPrice: "$29.99",
  price: "29.99",
  period: { unit: "year", value: 1 },
};
const USER_ID = "6a8f5e0c-1d2b-4c3a-9e8f-7a6b5c4d3e2f";
const PLAY = {
  active: true,
  productId: PLAY_PRODUCT,
  plan: "yearly",
  expiresAt: Date.parse("2027-10-01T12:00:00Z"),
  autoRenew: true,
  state: "ACTIVE",
  inGracePeriod: false,
  onHold: false,
  paused: false,
  pending: false,
  testPurchase: false,
};
const jsonResponse = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});
// Objects made inside the page's realm compare by value once copied out of it.
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => {
  for (let index = 0; index < 10; index += 1) await new Promise(setImmediate);
};

function paywall({
  user = {
    id: USER_ID,
    discovery: { active: false, accessType: null, apple: null, googlePlay: null },
  },
  native = {},
  server = async () => ({
    status: 200,
    data: {
      discovery: { active: true, accessType: "google", googlePlay: PLAY },
      accepted: ["token-1"],
    },
  }),
  products = [MONTHLY, YEARLY],
} = {}) {
  const calls = [],
    posts = [],
    views = [];
  const plugin = {
    getProducts: async (options) => {
      calls.push(["getProducts", options]);
      return { products };
    },
    purchase: async (options) => {
      calls.push(["purchase", options]);
      return { status: "purchased", purchaseToken: "token-1", productId: PLAY_PRODUCT };
    },
    restore: async () => {
      calls.push(["restore"]);
      return { purchases: [] };
    },
    manageSubscriptions: async () => {
      calls.push(["manageSubscriptions"]);
      return {};
    },
    ...native,
  };
  let currentUser = user;
  const context = {
    URL,
    URLSearchParams,
    Intl,
    Date,
    StrataApp: Object.freeze({ platform: "android", shellVersion: 1 }),
    Capacitor: { Plugins: { StrataNative: plugin } },
  };
  context.globalThis = context;
  vm.createContext(context);
  loadHtml(context);
  // app-mode.js starts itself when StrataApp is set and a document exists; this context has no document.
  for (const file of ["entitlements", "app-mode", "app-paywall"])
    vm.runInContext(read(`public/scripts/${file}.js`), context, { filename: `${file}.js` });
  const billing = context.StrataAppMode.createBilling({
    fetchImpl: async (url, options = {}) => {
      if (url === "/api/me")
        return currentUser
          ? jsonResponse(200, { user: currentUser, csrfToken: "csrf-play" })
          : jsonResponse(200, { user: null });
      assert.equal(url, "/api/billing/google/purchases");
      assert.equal(options.headers["X-CSRF-Token"], "csrf-play");
      const body = JSON.parse(options.body);
      posts.push(body.purchases);
      const result = await server(body.purchases);
      if (result.status === 200 && result.data.discovery && currentUser)
        currentUser = { ...currentUser, discovery: result.data.discovery };
      return jsonResponse(result.status, result.data);
    },
    dispatch: () => {},
    storage: () => null,
    platform: () => "android",
  });
  const controller = context.StrataAppPaywall.createController({
    native: context.StrataAppMode.plugin(),
    billing,
    haptic: () => {},
    onChange: (view) => views.push(view),
  });
  return {
    controller,
    calls,
    posts,
    view: () => views.at(-1),
    html: () => String(context.StrataAppPaywall.bodyHtml(views.at(-1))),
    terms: () => context.StrataAppPaywall.disclosure(views.at(-1).product, views.at(-1).store),
    api: context.StrataAppPaywall,
  };
}

test("on Android the paywall asks Google Play for Strata+'s base plans and offers monthly or yearly", async () => {
  const pay = paywall();
  await pay.controller.load();
  assert.deepEqual(plain(pay.calls[0]), ["getProducts", { productIds: [PLAY_PRODUCT] }]);
  assert.equal(pay.view().store.label, "Google Play");
  assert.deepEqual(
    plain(pay.view().products.map((product) => [product.plan, product.basePlanId])),
    [
      ["monthly", "monthly"],
      ["yearly", "yearly"],
    ],
  );
  assert.equal(pay.view().savings, 50);
  assert.match(pay.html(), /Yearly · save 50%/);
  assert.match(pay.terms(), /auto-renewing monthly subscription at \$4\.99 per month\./);
  assert.match(pay.terms(), /charged to your Google Play account/);
  assert.match(
    pay.terms(),
    /Google Play › Payments &amp; subscriptions › Subscriptions|Google Play › Payments & subscriptions › Subscriptions/,
  );
  assert.doesNotMatch(pay.terms(), /Apple/);
});

test("a purchase carries the STRATA account, is checked by STRATA, and finishes nothing on the phone", async () => {
  const pay = paywall();
  await pay.controller.load();
  pay.controller.choosePlan("yearly");
  assert.equal(await pay.controller.subscribe(), "purchased");
  assert.deepEqual(plain(pay.calls.find((call) => call[0] === "purchase")), [
    "purchase",
    { productId: PLAY_PRODUCT, basePlanId: "yearly", accountId: USER_ID },
  ]);
  assert.deepEqual(plain(pay.posts), [[{ purchaseToken: "token-1", productId: PLAY_PRODUCT }]]);
  assert.equal(pay.view().status, "Welcome to Strata+. Your subscription is active.");
  assert.ok(!pay.calls.some((call) => call[0] === "finishTransaction"));
  assert.match(pay.html(), /Your Google Play subscription renews/);
  assert.match(pay.html(), /data-paywall-action="manage"/);
});

test("pending, cancelled, and refused purchases say so in Google Play's words", async () => {
  const pending = paywall({ native: { purchase: async () => ({ status: "pending" }) } });
  await pending.controller.load();
  assert.equal(await pending.controller.subscribe(), "pending");
  assert.match(pending.view().status, /still being processed by Google Play/);
  assert.deepEqual(pending.posts, []);
  const cancelled = paywall({ native: { purchase: async () => ({ status: "cancelled" }) } });
  await cancelled.controller.load();
  assert.equal(await cancelled.controller.subscribe(), "cancelled");
  assert.deepEqual(cancelled.posts, []);
  for (const [code, words] of [
    ["BILLING_UNAVAILABLE", /Google Play can’t take payments on this device/],
    ["ALREADY_OWNED", /already has Strata\+\. Choose Restore Purchases/],
    ["PRODUCT_NOT_FOUND", /not available from Google Play/],
    ["PURCHASE_FAILED", /^Google Play could not complete the purchase/],
  ]) {
    const failing = paywall({
      native: {
        purchase: async () => {
          throw Object.assign(new Error("no"), { code });
        },
      },
    });
    await failing.controller.load();
    assert.equal(await failing.controller.subscribe(), "failed");
    assert.match(failing.view().status, words, code);
  }
  const mismatch = paywall({
    server: async () => ({
      status: 403,
      data: { error: "x", code: "GOOGLE_PLAY_ACCOUNT_MISMATCH" },
    }),
  });
  await mismatch.controller.load();
  assert.equal(await mismatch.controller.subscribe(), "unconfirmed");
  assert.match(
    mismatch.view().status,
    /This Google Play purchase belongs to a different STRATA account/,
  );
  const unreachable = paywall({
    server: async () => ({ status: 503, data: { error: "x", code: "GOOGLE_PLAY_UNAVAILABLE" } }),
  });
  await unreachable.controller.load();
  await unreachable.controller.subscribe();
  assert.match(unreachable.view().status, /could not reach Google Play.*will not be charged twice/);
});

test("Restore Purchases sends the Google Account's purchases and reports what it found", async () => {
  const empty = paywall();
  await empty.controller.load();
  assert.equal(await empty.controller.restore(), "empty");
  assert.equal(empty.view().status, "No Google Play purchases were found for this Google Account.");
  const found = paywall({
    native: {
      restore: async () => ({
        purchases: [{ purchaseToken: "token-1", productId: PLAY_PRODUCT, acknowledged: true }],
      }),
    },
  });
  await found.controller.load();
  assert.equal(await found.controller.restore(), "restored");
  assert.deepEqual(plain(found.posts), [[{ purchaseToken: "token-1", productId: PLAY_PRODUCT }]]);
  const test = paywall({
    native: {
      restore: async () => ({ purchases: [{ purchaseToken: "token-t", productId: PLAY_PRODUCT }] }),
    },
    server: async () => ({
      status: 200,
      data: {
        discovery: {
          active: false,
          accessType: null,
          googlePlay: { ...PLAY, active: false, testPurchase: true },
        },
        accepted: ["token-t"],
      },
    }),
  });
  await test.controller.load();
  assert.equal(await test.controller.restore(), "inactive");
  assert.equal(
    test.view().status,
    "This was a Google Play test purchase. Test purchases do not unlock Strata+.",
  );
});

test("members see where their Strata+ is billed, and lapsed Google Play subscriptions say why", async () => {
  const owner = paywall({
    user: {
      id: USER_ID,
      discovery: {
        active: true,
        accessType: "google",
        googlePlay: { ...PLAY, inGracePeriod: true },
      },
    },
  });
  await owner.controller.load();
  assert.match(
    owner.html(),
    /billing problem with your Google Account\. Update your payment method in Google Play/,
  );
  await owner.controller.manage();
  assert.ok(owner.calls.some((call) => call[0] === "manageSubscriptions"));
  const iphone = paywall({
    user: { id: USER_ID, discovery: { active: true, accessType: "apple", apple: {} } },
  });
  await iphone.controller.load();
  assert.match(
    iphone.html(),
    /billed by the App Store\. Manage it on the iPhone or iPad you bought it on\./,
  );
  assert.doesNotMatch(iphone.html(), /data-paywall-action="manage"/);
  const held = paywall({
    user: {
      id: USER_ID,
      discovery: {
        active: false,
        accessType: null,
        googlePlay: { ...PLAY, active: false, state: "ON_HOLD", onHold: true },
      },
    },
  });
  await held.controller.load();
  // On hold, Google bills again once it collects the payment: no second purchase is offered.
  assert.match(held.html(), /on hold because Google could not collect a payment/);
  assert.doesNotMatch(held.html(), /data-paywall-action="subscribe"/);
  assert.equal(held.view().status, "");
  // A license tester's purchase that STRATA keeps locked says so, not that it ended.
  const tester = paywall({
    user: {
      id: USER_ID,
      discovery: {
        active: false,
        accessType: null,
        googlePlay: { ...PLAY, active: false, testPurchase: true },
      },
    },
  });
  await tester.controller.load();
  assert.equal(
    tester.view().status,
    "This was a Google Play test purchase. Test purchases do not unlock Strata+.",
  );
  // Without a signed-in Play Store, Google Play's own reason is shown.
  const noPlay = paywall({
    native: {
      getProducts: async () => {
        throw Object.assign(new Error("no"), { code: "BILLING_UNAVAILABLE" });
      },
    },
  });
  await noPlay.controller.load();
  assert.match(noPlay.view().status, /Google Play can’t take payments on this device/);
  await settle();
});
