"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { HTML_SOURCE, loadHtml } = require("./support/browser-html");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const PRODUCT = {
  id: "online.stratafitness.app.plus.monthly",
  displayName: "Strata+",
  description: "Monthly",
  displayPrice: "4,99 €",
  price: "4.99",
  currencyCode: "EUR",
  period: { unit: "month", value: 1 },
};
const YEARLY = {
  id: "online.stratafitness.app.plus.yearly",
  displayName: "Strata+ Yearly",
  description: "Yearly",
  displayPrice: "29,99 €",
  price: "29.99",
  currencyCode: "EUR",
  period: { unit: "year", value: 1 },
};
const USER_ID = "6a8f5e0c-1d2b-4c3a-9e8f-7a6b5c4d3e2f";
const APPLE = {
  active: true,
  productId: PRODUCT.id,
  expiresAt: Date.parse("2026-11-01T12:00:00Z"),
  autoRenew: true,
  inGracePeriod: false,
  environment: "Sandbox",
  revoked: false,
};
const jsonResponse = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});
const settle = async () => {
  for (let index = 0; index < 10; index += 1) await new Promise(setImmediate);
};

// The real app-mode billing bridge and paywall controller, a mocked StrataNative plugin, and a mocked STRATA server.
function paywall({
  user = { id: USER_ID, discovery: { active: false, accessType: null, apple: null } },
  native = {},
  server,
  reason = "",
  products = [PRODUCT],
  withPlugin = true,
} = {}) {
  const calls = [],
    posts = [],
    haptics = [],
    views = [];
  const plugin = withPlugin
    ? {
        getProducts: async (options) => {
          calls.push(["getProducts", options]);
          return { products };
        },
        purchase: async (options) => {
          calls.push(["purchase", options]);
          return {
            status: "purchased",
            transactionId: "2000000123",
            signedTransaction: "jws.purchase",
          };
        },
        finishTransaction: async (options) => {
          calls.push(["finishTransaction", options]);
          return {};
        },
        restore: async () => {
          calls.push(["restore"]);
          return { signedTransactions: [] };
        },
        manageSubscriptions: async () => {
          calls.push(["manageSubscriptions"]);
          return {};
        },
        ...native,
      }
    : undefined;
  let currentUser = user;
  const context = {
    URL,
    URLSearchParams,
    Intl,
    Date,
    Capacitor: plugin ? { Plugins: { StrataNative: plugin } } : undefined,
  };
  context.globalThis = context;
  vm.createContext(context);
  loadHtml(context);
  for (const file of ["entitlements", "app-mode", "app-paywall"])
    vm.runInContext(read(`public/scripts/${file}.js`), context, { filename: `${file}.js` });
  const billing = context.StrataAppMode.createBilling({
    fetchImpl: async (url, options = {}) => {
      if (url === "/api/me")
        return currentUser
          ? jsonResponse(200, { user: currentUser, csrfToken: "csrf-pay" })
          : jsonResponse(200, { user: null });
      assert.equal(url, "/api/billing/apple/transactions");
      assert.equal(options.headers["X-CSRF-Token"], "csrf-pay");
      const body = JSON.parse(options.body);
      posts.push(body.signedTransactions);
      const result = await server(body.signedTransactions);
      if (result.status === 200 && result.data.discovery && currentUser)
        currentUser = { ...currentUser, discovery: result.data.discovery };
      return jsonResponse(result.status, result.data);
    },
    dispatch: () => {},
    storage: () => null,
  });
  const controller = context.StrataAppPaywall.createController({
    native: context.StrataAppMode.plugin(),
    billing,
    reason,
    haptic: (style) => haptics.push(style),
    onChange: (view) => views.push(view),
  });
  return {
    controller,
    calls,
    posts,
    haptics,
    views,
    view: () => views.at(-1),
    html: () => String(context.StrataAppPaywall.bodyHtml(views.at(-1))),
    api: context.StrataAppPaywall,
  };
}
const accepted =
  (ids = ["2000000123"]) =>
  async () => ({
    status: 200,
    data: { discovery: { active: true, accessType: "apple", apple: APPLE }, accepted: ids },
  });

test("the paywall shows StoreKit's price and period, what Strata+ includes, and the renewal terms", async () => {
  const page = paywall({ server: accepted() });
  await page.controller.load();
  assert.deepEqual(JSON.parse(JSON.stringify(page.calls[0])), [
    "getProducts",
    { productIds: [PRODUCT.id, YEARLY.id] },
  ]);
  const html = page.html();
  assert.match(
    html,
    /<h2 id="appPaywallTitle" tabindex="-1">Unlock Strata\+<\/h2><p class="app-paywall-price"><strong>4,99 €<\/strong><span>per month<\/span><\/p>/,
  );
  assert.match(
    html,
    /data-paywall-action="subscribe">Subscribe<\/button><button class="app-paywall-restore" type="button" data-paywall-action="restore">Restore Purchases<\/button>/,
  );
  assert.doesNotMatch(html, /\$2\.99|USD/, "the price is never hard-coded");
  const terms = page.api.disclosure(PRODUCT);
  assert.match(terms, /auto-renewing monthly subscription at 4,99 € per month/);
  assert.match(terms, /charged to your Apple Account/);
  assert.match(terms, /at least 24 hours before the end of the current period/);
  assert.match(terms, /Settings › Apple Account › Subscriptions/);
  assert.equal(page.api.periodLabel({ unit: "year", value: 1 }), "per year");
  assert.equal(page.api.periodLabel({ unit: "month", value: 3 }), "every 3 months");
  assert.equal(page.api.periodLabel(null), "");
  assert.match(
    String(page.api.benefitsHtml(["<span><strong>Know what’s next.</strong> Overview</span>"])),
    /<ul class="app-paywall-benefits"><li><span><strong>Know what’s next\./,
  );
  const pricing = read("public/pages/pricing.html");
  for (const benefit of ["Know what’s next.", "Remember last time.", "Let Strata AI plan it."])
    assert.ok(pricing.includes(benefit), "the paywall reuses the plan card's own copy");
});

test("with both App Store plans the paywall offers monthly or yearly, like the website, and buys the chosen one", async () => {
  // StoreKit may return the products in any order; the paywall shows monthly first and starts on it.
  const page = paywall({ server: accepted(), products: [YEARLY, PRODUCT] });
  await page.controller.load();
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.view().products.map((product) => [product.plan, product.id]))),
    [
      ["monthly", PRODUCT.id],
      ["yearly", YEARLY.id],
    ],
  );
  assert.equal(page.view().plan, "monthly");
  assert.equal(page.view().savings, 50, "29.99 a year against 12 × 4.99 saves 50%");
  const html = page.html();
  assert.match(html, /<fieldset class="app-plan-choice"><legend>Choose a plan<\/legend>/);
  assert.match(
    html,
    /value="monthly" data-paywall-plan="monthly" checked \/><span><strong>Monthly<\/strong>4,99 € per month<\/span>/,
  );
  assert.match(
    html,
    /value="yearly" data-paywall-plan="yearly" \/><span><strong>Yearly · save 50%<\/strong>29,99 € per year<\/span>/,
  );
  assert.doesNotMatch(html, /app-paywall-price/, "the plan choice carries both prices");
  assert.equal(page.controller.choosePlan("yearly"), "yearly");
  assert.match(page.html(), /data-paywall-plan="yearly" checked/);
  assert.match(
    page.api.disclosure(page.view().product),
    /auto-renewing yearly subscription at 29,99 € per year/,
  );
  assert.equal(
    page.controller.choosePlan("weekly"),
    "monthly",
    "an unknown plan falls back to the first",
  );
  page.controller.choosePlan("yearly");
  assert.equal(await page.controller.subscribe(), "purchased");
  assert.deepEqual(JSON.parse(JSON.stringify(page.calls.find(([name]) => name === "purchase"))), [
    "purchase",
    { productId: YEARLY.id, appAccountToken: USER_ID },
  ]);
  // Prices that do not add up to a real saving show no "save" label; a lone product shows no choice.
  assert.equal(
    page.api.yearlySavings([
      { ...PRODUCT, plan: "monthly" },
      { ...YEARLY, plan: "yearly", price: "58.00" },
    ]),
    0,
  );
  assert.equal(
    page.api.yearlySavings([
      { ...PRODUCT, plan: "monthly" },
      { ...YEARLY, plan: "yearly", currencyCode: "USD" },
    ]),
    0,
    "two currencies cannot be compared",
  );
  const yearlyOnly = paywall({ server: accepted(), products: [YEARLY] });
  await yearlyOnly.controller.load();
  assert.equal(yearlyOnly.view().plan, "yearly");
  assert.match(
    yearlyOnly.html(),
    /<p class="app-paywall-price"><strong>29,99 €<\/strong><span>per year<\/span><\/p>/,
  );
});

test("a paused subscription or blocked payments keep Subscribe off, as on the website", async () => {
  for (const [discovery, message] of [
    [{ subscription: { id: "sub_1", status: "paused", active: false } }, /paused/],
    [{ checkoutBlocked: true }, /turned off for this account/],
  ]) {
    const page = paywall({
      server: accepted(),
      user: {
        id: USER_ID,
        discovery: { active: false, accessType: null, apple: null, ...discovery },
      },
    });
    await page.controller.load();
    const html = page.html();
    assert.doesNotMatch(html, /data-paywall-action="subscribe"/);
    assert.match(html, message);
    assert.equal(await page.controller.subscribe(), "blocked");
    assert.equal(
      page.calls.some(([name]) => name === "purchase"),
      false,
    );
  }
});

test("a purchase carries the STRATA user id, is confirmed by STRATA, then finished, with a success haptic", async () => {
  const page = paywall({ server: accepted() });
  await page.controller.load();
  assert.equal(await page.controller.subscribe(), "purchased");
  assert.deepEqual(JSON.parse(JSON.stringify(page.calls.slice(1))), [
    ["purchase", { productId: PRODUCT.id, appAccountToken: USER_ID }],
    ["finishTransaction", { transactionId: "2000000123" }],
  ]);
  assert.deepEqual(page.posts, [["jws.purchase"]]);
  assert.deepEqual(page.haptics, ["success"]);
  assert.equal(page.view().owned, "apple");
  assert.equal(page.view().tone, "good");
  assert.match(page.view().status, /Welcome to Strata\+/);
  const html = page.html();
  assert.match(html, /You have Strata\+/);
  assert.match(html, /renews Nov 1, 2026/);
  assert.match(html, /data-paywall-action="manage">Manage subscription/);
  assert.doesNotMatch(html, /data-paywall-action\s*=\s*"subscribe"/);
  await page.controller.manage();
  assert.deepEqual(page.calls.at(-1), ["manageSubscriptions"]);
});

test("a purchase STRATA keeps but does not unlock never says welcome, and a test purchase says why", async () => {
  for (const [environment, message] of [
    ["Sandbox", /test purchase\. Test purchases do not unlock Strata\+/],
    ["Production", /Strata\+ is not on yet/],
  ]) {
    const page = paywall({
      server: async () => ({
        status: 200,
        data: {
          discovery: {
            active: false,
            accessType: null,
            apple: { ...APPLE, active: false, environment, expiresAt: Date.now() + 30 * 86400000 },
          },
          accepted: ["2000000123"],
        },
      }),
    });
    await page.controller.load();
    assert.equal(await page.controller.subscribe(), "locked");
    assert.equal(page.view().tone, "warn");
    assert.match(page.view().status, message);
    assert.doesNotMatch(page.view().status, /Welcome/);
    assert.deepEqual(page.haptics, [], "no success haptic for a locked purchase");
    assert.equal(page.view().owned, null);
    assert.ok(
      page.calls.some((call) => call[0] === "finishTransaction"),
      "STRATA kept the transaction, so StoreKit can finish it",
    );
  }
});

test("pending and cancelled purchases change nothing and send nothing", async () => {
  for (const [status, expected, tone] of [
    ["pending", /waiting for approval/, "warn"],
    ["cancelled", /^$/, ""],
  ]) {
    const page = paywall({ native: { purchase: async () => ({ status }) }, server: accepted() });
    await page.controller.load();
    assert.equal(await page.controller.subscribe(), status);
    assert.deepEqual(page.posts, [], status);
    assert.equal(
      page.calls.some((call) => call[0] === "finishTransaction"),
      false,
      status,
    );
    assert.match(page.view().status, expected, status);
    assert.equal(page.view().tone, tone, status);
    assert.equal(page.view().busy, false);
    assert.deepEqual(page.haptics, []);
  }
  for (const [code, message] of [
    ["PRODUCT_NOT_FOUND", /not available/],
    ["VERIFICATION_FAILED", /could not verify/],
    ["PURCHASE_FAILED", /could not complete/],
  ]) {
    const page = paywall({
      native: {
        purchase: async () => {
          throw Object.assign(new Error("StoreKit"), { code });
        },
      },
      server: accepted(),
    });
    await page.controller.load();
    assert.equal(await page.controller.subscribe(), "failed");
    assert.match(page.view().status, message, code);
    assert.deepEqual(page.posts, []);
  }
});

test("a purchase STRATA rejects stays unfinished so StoreKit delivers it again", async () => {
  for (const [status, code, message] of [
    [403, "APPLE_ACCOUNT_MISMATCH", /different STRATA account/],
    [409, "APPLE_PURCHASE_OTHER_ACCOUNT", /already linked to another STRATA account/],
    [422, "APPLE_FAMILY_SHARED", /isn’t shared through Family Sharing/],
    [400, "APPLE_SIGNATURE_INVALID", /could not verify this App Store purchase/],
    [503, "UNAVAILABLE", /could not confirm the purchase yet/],
  ]) {
    const page = paywall({ server: async () => ({ status, data: { error: "No", code } }) });
    await page.controller.load();
    assert.equal(await page.controller.subscribe(), "unconfirmed", code);
    assert.equal(
      page.calls.some((call) => call[0] === "finishTransaction"),
      false,
      `${code} must not finish the transaction`,
    );
    assert.match(page.view().status, message, code);
    assert.equal(page.view().tone, "error");
    assert.equal(page.view().owned, null);
    assert.deepEqual(page.haptics, []);
  }
  const unlisted = paywall({ server: accepted(["someone-else"]) });
  await unlisted.controller.load();
  assert.equal(await unlisted.controller.subscribe(), "unconfirmed");
  assert.equal(
    unlisted.calls.some((call) => call[0] === "finishTransaction"),
    false,
  );
  assert.match(unlisted.view().status, /will not be charged twice/);
});

test("Restore Purchases sends the Apple Account's transactions and reports what it found", async () => {
  const restored = paywall({
    native: { restore: async () => ({ signedTransactions: ["jws.a", "jws.b"] }) },
    server: accepted(["1"]),
  });
  await restored.controller.load();
  assert.equal(await restored.controller.restore(), "restored");
  assert.deepEqual(restored.posts, [["jws.a", "jws.b"]]);
  assert.deepEqual(restored.haptics, ["success"]);
  assert.equal(restored.view().owned, "apple");
  const empty = paywall({ server: accepted() });
  await empty.controller.load();
  assert.equal(await empty.controller.restore(), "empty");
  assert.match(empty.view().status, /No App Store purchases/);
  assert.deepEqual(empty.posts, []);
  const lapsed = paywall({
    native: { restore: async () => ({ signedTransactions: ["jws.old"] }) },
    server: async () => ({
      status: 200,
      data: {
        discovery: {
          active: false,
          accessType: null,
          apple: { ...APPLE, active: false, expiresAt: Date.parse("2026-09-01T12:00:00Z") },
        },
        accepted: ["1"],
      },
    }),
  });
  await lapsed.controller.load();
  assert.equal(await lapsed.controller.restore(), "inactive");
  assert.match(lapsed.view().status, /No active Strata\+ subscription/);
  const rejected = paywall({
    native: { restore: async () => ({ signedTransactions: ["jws.x"] }) },
    server: async () => ({ status: 409, data: { code: "APPLE_PURCHASE_OTHER_ACCOUNT" } }),
  });
  await rejected.controller.load();
  assert.equal(await rejected.controller.restore(), "rejected");
  assert.match(rejected.view().status, /another STRATA account/);
  const failed = paywall({
    native: {
      restore: async () => {
        throw new Error("cancelled sign-in");
      },
    },
    server: accepted(),
  });
  await failed.controller.load();
  assert.equal(await failed.controller.restore(), "failed");
});

test("members who already have Strata+ see it, never a buy button", async () => {
  for (const [discovery, owned, detail] of [
    [
      {
        active: true,
        accessType: "paid",
        subscription: { id: "sub_1", status: "active", active: true },
      },
      "paddle",
      /billed on stratafitness\.online/,
    ],
    [{ active: true, accessType: "grant", adminGrant: { active: true } }, "grant", /complimentary/],
    [
      { active: true, accessType: "apple", apple: { ...APPLE, autoRenew: false } },
      "apple",
      /ends Nov 1, 2026 and will not renew/,
    ],
    [
      { active: true, accessType: "apple", apple: { ...APPLE, inGracePeriod: true } },
      "apple",
      /billing problem/,
    ],
  ]) {
    const page = paywall({ user: { id: USER_ID, discovery }, server: accepted() });
    await page.controller.load();
    assert.equal(page.view().owned, owned);
    const html = page.html();
    assert.match(html, /You have Strata\+/);
    assert.match(html, detail);
    assert.doesNotMatch(html, /data-paywall-action\s*=\s*"(?:subscribe|restore)"/);
    assert.match(html, /href="\/discover\.html">Open Strata\+/);
    assert.equal(
      /Manage subscription/.test(html),
      owned === "apple",
      `only App Store subscribers manage in the app (${owned})`,
    );
    assert.doesNotMatch(html, /<\s*a[^>]*href\s*=\s*"https?\s*:/, "no link out to web billing");
    assert.equal(await page.controller.subscribe(), "ignored");
    assert.equal(
      page.calls.some((call) => call[0] === "purchase"),
      false,
    );
  }
  const ai = paywall({
    user: { id: USER_ID, discovery: { active: true, accessType: "grant" } },
    reason: "ai",
    server: accepted(),
  });
  await ai.controller.load();
  assert.match(ai.html(), /href="\/ai">Open Strata AI/);
});

test("signed-out people are asked to sign in first, and an old app build without the plugin breaks nothing", async () => {
  const visitor = paywall({ user: null, server: accepted() });
  await visitor.controller.load();
  const html = visitor.html();
  assert.match(html, /href="\/account\.html\?mode=signup&amp;next=pricing"/);
  assert.match(html, /href="\/account\.html\?mode=login&amp;next=pricing">Sign in to subscribe/);
  assert.doesNotMatch(html, /data-paywall-action\s*=\s*"subscribe"/);
  assert.match(html, /4,99 €/, "the price is visible before signing in");
  assert.equal(await visitor.controller.restore(), "signed-out");
  assert.match(visitor.view().status, /Sign in to STRATA first/);
  assert.equal(
    visitor.calls.some((call) => call[0] === "restore" || call[0] === "purchase"),
    false,
  );
  const oldBuild = paywall({ withPlugin: false, server: accepted() });
  await oldBuild.controller.load();
  assert.equal(oldBuild.view().status, "Update STRATA from the App Store to subscribe.");
  assert.equal(oldBuild.view().nativeAvailable, false);
  assert.doesNotMatch(oldBuild.html(), /data-paywall-action/);
  assert.equal(await oldBuild.controller.subscribe(), "ignored");
  assert.equal(await oldBuild.controller.restore(), "ignored");
  const missingProduct = paywall({ products: [], server: accepted() });
  await missingProduct.controller.load();
  assert.match(missingProduct.view().status, /not available from the App Store/);
  assert.match(missingProduct.html(), /data-paywall-action="subscribe" disabled/);
});

test("a renewal or approval synced in the background updates the open paywall, and the reason a member arrived stays visible", async () => {
  const page = paywall({
    reason: "recovery",
    native: { purchase: async () => ({ status: "pending" }) },
    server: accepted(),
  });
  await page.controller.load();
  assert.match(
    page.html(),
    /<p class="app-paywall-note">Recovery, with your Polar sleep and Nightly Recharge, is part of Strata\+\.<\/p>/,
  );
  await page.controller.subscribe();
  assert.equal(page.view().owned, null);
  page.controller.billingChanged({ active: true, accessType: "apple", apple: APPLE });
  assert.equal(page.view().owned, "apple");
  assert.match(page.html(), /You have Strata\+/);
  const lapsed = paywall({
    user: {
      id: USER_ID,
      discovery: {
        active: false,
        accessType: null,
        apple: { ...APPLE, active: false, revoked: true },
      },
    },
    server: accepted(),
  });
  await lapsed.controller.load();
  assert.match(lapsed.view().status, /refunded or revoked/);
});

test("pricing never requests Paddle in the app, and still loads it on the website", async () => {
  const sources = [
    "entitlements",
    "pricing-logic",
    "pricing-state",
    "pricing-api",
    "pricing-render",
    "pricing-events",
    "pricing",
  ]
    .map((name) => read(`public/scripts/${name}.js`))
    .join("\n");
  const run = (extra) => {
    const appended = [],
      requests = [];
    const node = () => ({
      hidden: false,
      disabled: false,
      textContent: "",
      classList: { toggle() {} },
      setAttribute() {},
      addEventListener() {},
      focus() {},
    });
    const nodes = new Map();
    const context = {
      URLSearchParams,
      navigator: { onLine: true },
      location: { search: "" },
      window: { addEventListener() {} },
      requestAnimationFrame: (callback) => callback(),
      document: {
        getElementById: (id) => {
          if (!nodes.has(id)) nodes.set(id, node());
          return nodes.get(id);
        },
        createElement: () => ({}),
        head: { append: (element) => appended.push(element) },
      },
      fetch: async (url) => {
        requests.push(url);
        return jsonResponse(401, {});
      },
      ...extra,
    };
    vm.runInNewContext(`${HTML_SOURCE}\n${sources}`, context);
    return { appended, requests };
  };
  const app = run({ StrataApp: Object.freeze({ platform: "ios", shellVersion: 1 }) });
  await settle();
  assert.deepEqual(app.appended, []);
  assert.deepEqual(app.requests, [], "pricing.js stands down in the app");
  const web = run({});
  await settle();
  assert.equal(web.appended.length, 1);
  assert.equal(web.appended[0].src, "https://cdn.paddle.com/paddle/v2/paddle.js");
  assert.deepEqual(web.requests.sort(), ["/api/billing/config", "/api/me"]);
});
