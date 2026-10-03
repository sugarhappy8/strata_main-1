"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const espree = require("espree");
const { createRouter } = require("../src/router");

const MEMBER = { id: "member-1", csrf_token: "token" };

function harness({
  session = MEMBER,
  origin = true,
  csrf = true,
  feature = true,
  admin = true,
} = {}) {
  const calls = { features: [], admin: [], handled: [] };
  const json = (res, status, data, headers = {}) => Object.assign(res, { status, data, headers });
  const requireSession = async (req, res) => {
    if (session) return session;
    json(res, 401, { error: "Sign in required." });
    return null;
  };
  const router = createRouter({
    json,
    trustedOrigin: () => origin,
    sessionFor: async () => session,
    requireSession,
    requireFeature: (name) => async (req, res) => {
      calls.features.push(name);
      if (!(await requireSession(req, res))) return null;
      if (feature) return session;
      json(res, 402, { code: "DISCOVERY_ACCESS_REQUIRED" });
      return null;
    },
    requireAdmin: async (req, res, options) => {
      calls.admin.push(options);
      if (admin && session) return session;
      json(res, 403, { code: "ADMIN_REQUIRED" });
      return null;
    },
    validCsrf: () => csrf,
  });
  const handler = (name) => (context) => {
    calls.handled.push({ name, params: context.params, session: context.session });
    context.res.status = 200;
  };
  router.add([
    { method: "POST", path: "/api/things", handler: handler("create") },
    { method: "GET", path: "/api/things", handler: handler("list") },
    { method: "GET", path: "/api/things/search", handler: handler("search") },
    { method: "PUT", path: "/api/things/:id", handler: handler("update") },
    { method: "PUT", path: "/api/plus", feature: "plus.train", handler: handler("plus") },
    { method: "POST", path: "/api/owner", auth: "admin", handler: handler("owner") },
    {
      method: "GET",
      path: "/api/owner/boot",
      auth: "admin",
      allowBootstrap: true,
      handler: handler("boot"),
    },
    { method: "POST", path: "/api/login", public: true, handler: handler("login") },
    { method: "POST", path: "/api/contact", public: true, form: true, handler: handler("contact") },
    { method: "POST", path: "/api/count", auth: "optional", handler: handler("count") },
    { method: "POST", path: "/api/hook", webhook: true, handler: handler("hook") },
  ]);
  async function call(method, pathname, headers = { "content-type": "application/json" }) {
    const res = {};
    const handled = await router.dispatch(
      { method, headers },
      res,
      new URL(`https://strata.test${pathname}`),
    );
    return { handled, ...res };
  }
  return { router, call, calls };
}

test("a write is checked for origin, session, CSRF, and JSON before its handler runs", async () => {
  assert.equal(
    (await harness({ origin: false }).call("POST", "/api/things")).data.code,
    "ORIGIN_REQUIRED",
  );
  assert.equal((await harness({ session: null }).call("POST", "/api/things")).status, 401);
  assert.equal(
    (await harness({ csrf: false }).call("POST", "/api/things")).data.code,
    "INVALID_CSRF",
  );
  const form = await harness().call("POST", "/api/things", {
    "content-type": "application/x-www-form-urlencoded",
  });
  assert.deepEqual([form.status, form.data.code], [415, "JSON_REQUIRED"]);
  const text = await harness().call("POST", "/api/things", { "content-type": "text/plain" });
  assert.equal(text.status, 415);
  for (const failed of [
    harness({ origin: false }),
    harness({ session: null }),
    harness({ csrf: false }),
  ]) {
    await failed.call("POST", "/api/things");
    assert.deepEqual(failed.calls.handled, [], "a refused write never reaches its handler");
  }
  const ok = harness();
  assert.equal((await ok.call("POST", "/api/things")).status, 200);
  assert.deepEqual(ok.calls.handled, [{ name: "create", params: {}, session: MEMBER }]);
  const bodiless = harness();
  assert.equal(
    (await bodiless.call("PUT", "/api/things/a", {})).status,
    200,
    "a write without a body needs no type",
  );
});

test("reads need a session but no origin, CSRF, or JSON; features and the admin are checked by name", async () => {
  const read = harness({ origin: false, csrf: false });
  assert.equal((await read.call("GET", "/api/things", {})).status, 200);
  assert.equal((await harness({ session: null }).call("GET", "/api/things")).status, 401);
  const plus = harness({ feature: false });
  assert.equal((await plus.call("PUT", "/api/plus")).status, 402);
  assert.deepEqual(plus.calls.features, ["plus.train"]);
  const owner = harness({ admin: false });
  assert.equal((await owner.call("POST", "/api/owner")).data.code, "ADMIN_REQUIRED");
  const boot = harness();
  await boot.call("GET", "/api/owner/boot");
  assert.deepEqual(boot.calls.admin, [{ allowBootstrap: true }]);
});

test("public, optional-session, form, and webhook routes opt out only of what they name", async () => {
  const visitor = harness({ session: null, csrf: false });
  assert.equal((await visitor.call("POST", "/api/login")).status, 200);
  assert.equal(
    (await harness({ origin: false }).call("POST", "/api/login")).data.code,
    "ORIGIN_REQUIRED",
  );
  assert.equal(
    (await visitor.call("POST", "/api/login", { "content-type": "text/plain" })).status,
    415,
  );
  const contact = await visitor.call("POST", "/api/contact", {
    "content-type": "application/x-www-form-urlencoded",
  });
  assert.equal(contact.status, 200);

  assert.equal((await visitor.call("POST", "/api/count")).status, 200, "visitors may count");
  const member = harness({ csrf: false });
  assert.equal(
    (await member.call("POST", "/api/count")).data.code,
    "INVALID_CSRF",
    "a member's write needs CSRF",
  );
  const counted = harness();
  await counted.call("POST", "/api/count");
  assert.equal(counted.calls.handled[0].session, MEMBER);

  const hook = harness({ session: null, origin: false, csrf: false });
  assert.equal(
    (await hook.call("POST", "/api/hook", { "content-type": "text/plain" })).status,
    200,
  );
});

test("paths match exactly, fixed paths win, IDs are strict, and wrong methods get 405", async () => {
  const page = harness();
  assert.equal((await page.call("GET", "/api/unknown")).handled, false);
  assert.equal((await page.call("GET", "/api/things/a/b")).handled, false);
  await page.call("GET", "/api/things/search");
  await page.call("PUT", "/api/things/Ab_9-2026-10-02");
  assert.deepEqual(
    page.calls.handled.map(({ name, params }) => [name, params]),
    [
      ["search", {}],
      ["update", { id: "Ab_9-2026-10-02" }],
    ],
  );
  for (const id of ["a%2Fb", "a%2fb", "..", "%2E%2E", "a%20b", "a.b", "a%00", "x".repeat(201)])
    assert.equal(
      (await page.call("PUT", `/api/things/${id}`)).handled,
      false,
      `${id} is not an ID: it is never decoded into one`,
    );
  assert.equal(page.calls.handled.length, 2, "no refused ID reached a handler");
  const wrong = await page.call("DELETE", "/api/things");
  assert.deepEqual(
    [wrong.status, wrong.data.code, wrong.headers.Allow],
    [405, "METHOD_NOT_ALLOWED", "POST, GET"],
  );
  assert.equal((await page.call("HEAD", "/api/things", {})).status, 200, "HEAD is served by GET");
  assert.equal(
    (await page.call("PUT", "/api/things/%E0%A4%A")).handled,
    false,
    "a malformed escape names nothing",
  );
});

test("route tables are checked when they are added", () => {
  const { router } = harness();
  const handler = () => {};
  for (const [route, message] of [
    [{ method: "GET", path: "/api/things", handler }, /registered twice/],
    [{ method: "TRACE", path: "/api/x", handler }, /unsupported method/],
    [{ method: "GET", path: "/x", handler }, /start with \/api\//],
    [{ method: "GET", path: "/api/x" }, /missing handler/],
    [{ method: "GET", path: "/api/x", webhook: true, handler }, /webhooks are POST/],
    [
      { method: "GET", path: "/api/x", public: true, feature: "plus.train", handler },
      /public route/,
    ],
    [{ method: "GET", path: "/api/x", auth: "owner", handler }, /auth is/],
    [
      { method: "GET", path: "/api/x", auth: "admin", feature: "plus.train", handler },
      /do not take a feature/,
    ],
  ])
    assert.throws(() => router.add([route]), message);
  assert.ok(
    router.list().some((route) => route.path === "/api/hook" && route.access === "webhook"),
  );
});

// Every route in src/, read from the route tables themselves.
function sourceRoutes() {
  const routes = [];
  const src = path.join(__dirname, "../src");
  for (const file of fs.readdirSync(src).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(src, file), "utf8");
    const ast = espree.parse(source, { ecmaVersion: "latest", sourceType: "script" });
    const constants = new Map();
    const visit = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init?.type === "Literal"
      )
        constants.set(node.id.name, node.init.value);
      if (node.type === "ObjectExpression") {
        const props = new Map(
          node.properties
            .filter((prop) => prop.type === "Property" && prop.key.type === "Identifier")
            .map((prop) => [prop.key.name, prop.value]),
        );
        const value = (name) => {
          const prop = props.get(name);
          if (!prop) return undefined;
          if (prop.type === "Literal") return prop.value;
          if (prop.type === "Identifier") return constants.get(prop.name);
          return undefined;
        };
        if (props.has("method") && props.has("path") && props.has("handler"))
          routes.push({
            file,
            method: value("method"),
            path: value("path"),
            public: value("public") === true,
            webhook: value("webhook") === true,
          });
      }
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child.type === "string") visit(child);
      }
    };
    visit(ast);
  }
  return routes;
}

test("every write in src/ is protected unless it is one of the reviewed public or webhook routes", () => {
  const routes = sourceRoutes();
  assert.ok(routes.length >= 85, `found ${routes.length} routes`);
  for (const route of routes)
    assert.ok(route.method && route.path, `${route.file} declares a literal route`);
  const unprotected = routes
    .filter((route) => route.method !== "GET" && (route.public || route.webhook))
    .map((route) => `${route.webhook ? "webhook" : "public"} ${route.method} ${route.path}`)
    .sort();
  // Adding to this list is a security review: these writes run without a signed-in session.
  assert.deepEqual(unprotected, [
    "public POST /api/account/delete/complete",
    "public POST /api/account/delete/status",
    "public POST /api/login",
    "public POST /api/logout",
    "public POST /api/password-reset/complete",
    "public POST /api/password-reset/request",
    "public POST /api/password-reset/status",
    "public POST /api/resend-verification",
    "public POST /api/signup",
    "public POST /api/support",
    "public POST /api/verify-email",
    "webhook POST /api/billing/apple/notifications",
    "webhook POST /api/billing/google/notifications",
    "webhook POST /api/paddle/webhook",
  ]);
  const keys = routes.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(keys).size, keys.length, "each method and path is declared once");
});

test("no service checks CSRF or origin itself any more", () => {
  const src = path.join(__dirname, "../src");
  for (const file of fs.readdirSync(src).filter((name) => name.endsWith(".js"))) {
    if (["router.js", "server.js", "auth.js", "social-auth.js"].includes(file)) continue;
    const source = fs.readFileSync(path.join(src, file), "utf8");
    assert.doesNotMatch(source, /\bvalidCsrf\s*\(/, `${file} must leave CSRF to src/router.js`);
    assert.doesNotMatch(
      source,
      /\btrusted(?:Auth)?Origin\s*\(/,
      `${file} must leave origin to src/router.js`,
    );
  }
});
