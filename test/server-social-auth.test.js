"use strict";

// Sign up and sign in with Google against the real server. A local stand-in plays Google: it signs RS256 ID tokens
// and checks the client secret and PKCE verifier, so every hop the server makes is exercised without reaching Google.
const test = require("node:test"),
  assert = require("node:assert/strict");
const { spawn } = require("node:child_process"),
  { createServer } = require("node:http");
const { createHash, generateKeyPairSync, randomBytes, sign } = require("node:crypto");
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs"),
  { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = join(__dirname, "..");
const CLIENTS = { google: { id: "google-client", secret: "google-secret" } };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
let server, directory, base, provider;

function idToken(claims, { kid = "stand-in-key", key = rsa.privateKey } = {}) {
  const signingInput = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(claims)}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url")}`;
}

/** One loopback server answering for Google under /google/... */
function startProvider() {
  const state = { codes: new Map(), calls: [] };
  const http = createServer(async (req, res) => {
    const url = new URL(req.url, "http://stand-in.test");
    let body = "";
    for await (const chunk of req) body += chunk;
    const [, id, action] = url.pathname.split("/"),
      form = new URLSearchParams(body);
    state.calls.push({ id, action, form: Object.fromEntries(form) });
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data ?? {}));
    };
    if (action === "jwks")
      return send(200, {
        keys: [
          {
            ...rsa.publicKey.export({ format: "jwk" }),
            kid: "stand-in-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    if (action === "token") {
      const client = CLIENTS[id],
        secretOk = form.get("client_secret") === client?.secret;
      if (!client || form.get("client_id") !== client.id || !secretOk)
        return send(401, { error: "invalid_client" });
      const grant = state.codes.get(form.get("code"));
      if (!grant || grant.id !== id || grant.used || form.get("redirect_uri") !== grant.redirectUri)
        return send(400, { error: "invalid_grant" });
      if (
        grant.challenge &&
        createHash("sha256")
          .update(String(form.get("code_verifier")))
          .digest("base64url") !== grant.challenge
      )
        return send(400, { error: "invalid_grant" });
      grant.used = true;
      return send(200, {
        access_token: `access-${grant.claims.sub}`,
        id_token: idToken(grant.claims),
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    send(404, {});
  });
  return new Promise((resolve) =>
    http.listen(0, "127.0.0.1", () =>
      resolve({ ...state, state, http, url: `http://127.0.0.1:${http.address().port}` }),
    ),
  );
}

async function launch() {
  provider = await startProvider();
  mkdirSync(join(ROOT, "test-runtime"), { recursive: true });
  directory = mkdtempSync(join(ROOT, "test-runtime", "social-auth-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      NODE_ENV: "test",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      STRATA_DATA_DIR: directory,
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      EMAIL_VERIFICATION_ENABLED: "false",
      PADDLE_CHECKOUT_ENABLED: "false",
      PADDLE_CLIENT_TOKEN: "",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "",
      PADDLE_PRICE_ID: "",
      PADDLE_PRODUCT_ID: "",
      APP_BASE_URL: "",
      SIGN_IN_PROVIDER_STAND_IN: provider.url,
      GOOGLE_SIGN_IN_CLIENT_ID: CLIENTS.google.id,
      GOOGLE_SIGN_IN_CLIENT_SECRET: CLIENTS.google.secret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let output = "",
      errors = "";
    const timer = setTimeout(
      () => reject(new Error(`Sign-in server startup timed out: ${errors}`)),
      6000,
    );
    server.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    server.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-4096);
    });
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Sign-in server exited ${code}: ${errors}`)));
  });
}
async function stop() {
  if (server && server.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill("SIGTERM");
    });
  await new Promise((resolve) => provider?.http.close(resolve) || resolve());
  if (directory) rmSync(directory, { recursive: true, force: true });
}
function database(callback) {
  const db = new DatabaseSync(join(directory, "strata.sqlite"), { timeout: 5000 });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}
const cookieOf = (headers, name) =>
  (headers.getSetCookie?.() || [])
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith(`${name}=`)) || "";
async function request(path, { method = "GET", cookie = "", body, form, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(form
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      ...headers,
    },
    ...(form
      ? { body: new URLSearchParams(form).toString() }
      : body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return {
    status: response.status,
    data,
    text,
    headers: response.headers,
    location: response.headers.get("location") || "",
  };
}

/** Leaves STRATA for the provider and returns what the provider would need to send the member back. */
async function begin(id, { intent = "signup", next = "planner", headers = {} } = {}) {
  const started = await request("/auth/social/start", {
    method: "POST",
    form: { provider: id, intent, next },
    headers,
  });
  assert.equal(started.status, 303);
  const location = new URL(started.location);
  return {
    started,
    location,
    state: location.searchParams.get("state"),
    nonce: location.searchParams.get("nonce"),
    browser: cookieOf(started.headers, "strata_social"),
  };
}
/** The provider authorizes the member and sends them back; the server then finishes the sign-in. */
async function complete(
  id,
  flow,
  claims,
  { cookie = flow.browser, code = `code-${randomBytes(6).toString("hex")}` } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  provider.codes.set(code, {
    id,
    redirectUri: flow.location.searchParams.get("redirect_uri"),
    challenge: flow.location.searchParams.get("code_challenge"),
    claims: {
      iss: `${provider.url}/${id}`,
      aud: CLIENTS[id].id,
      iat: now,
      exp: now + 600,
      nonce: flow.nonce,
      ...claims,
    },
  });
  const back = await request(
    `/auth/social/${id}/callback?${new URLSearchParams({ state: flow.state, code })}`,
    { headers: { Origin: "" } },
  );
  assert.equal(back.status, 303, back.text);
  if (!back.location.startsWith("/auth/social/finish")) return { back, finished: null };
  const finished = await request(back.location, { cookie, headers: { Origin: "" } });
  return { back, finished, session: cookieOf(finished.headers, "strata_session") };
}
async function me(session) {
  const result = await request("/api/me", { cookie: session });
  return result.status === 200 ? { ...result.data.user, csrf: result.data.csrfToken } : null;
}
const errorOf = (location) => new URL(location, "http://strata.local").searchParams.get("error");

test.before(launch);
test.after(stop);

test("the account page offers each configured provider, and the CSP lets its form reach them", async () => {
  const page = await request("/account.html?mode=signup&next=discover");
  assert.equal(page.status, 200);
  for (const id of ["google"])
    assert.equal(
      (page.text.match(new RegExp(`data-social="${id}"(\\s+hidden)?>`, "g")) || []).filter(
        (match) => !match.includes("hidden"),
      ).length,
      2,
      id,
    );
  assert.doesNotMatch(page.text, /data-social-options\s+hidden/);
  // The logo carries its own size, so a stale cached stylesheet can never let it fill the button.
  assert.equal(
    (
      page.text.match(
        /<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">/g,
      ) || []
    ).length,
    2,
  );
  assert.match(
    page.text,
    /<input id="socialSignupNext" type="hidden" name="next" value="\/discover\.html" \/>/,
  );
  assert.match(
    page.headers.get("content-security-policy"),
    /form-action 'self' https:\/\/accounts\.google\.com;/,
  );
  assert.equal(
    (await request("/api/status")).data.signInProviders,
    undefined,
    "sign-in setup is not public",
  );
  assert.doesNotMatch(page.text, /samsung|data-social\s*=\s*"apple"/i, "only Google is offered");
});

test("Google sign-up creates a verified account without a password, and signing in again finds it", async () => {
  const flow = await begin("google");
  assert.equal(
    `${flow.location.origin}${flow.location.pathname}`,
    `${provider.url}/google/authorize`,
  );
  assert.equal(
    flow.location.searchParams.get("redirect_uri"),
    `${base}/auth/social/google/callback`,
  );
  assert.equal(flow.location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(flow.location.searchParams.get("scope"), "openid email profile");
  assert.match(
    flow.started.headers.get("set-cookie"),
    /^strata_social=[^;]+; Path=\/auth\/social\/finish; HttpOnly; SameSite=Lax; Max-Age=600/,
  );

  const { back, finished, session } = await complete("google", flow, {
    sub: "google-ada",
    email: "Ada@Example.test",
    email_verified: true,
    name: "Ada Lovelace",
  });
  assert.match(back.location, /^\/auth\/social\/finish\?state=/);
  assert.equal(finished.status, 200);
  assert.match(finished.text, /<meta http-equiv="refresh" content="0;url=\/planner\.html">/);
  assert.equal(finished.headers.get("cache-control"), "no-store");
  assert.match(
    finished.headers.get("set-cookie"),
    /strata_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict/,
  );
  const user = await me(session);
  assert.deepEqual(
    { name: user.name, email: user.email, signIn: user.signIn },
    {
      name: "Ada Lovelace",
      email: "ada@example.test",
      signIn: { hasPassword: false, providers: ["google"] },
    },
  );
  assert.equal(
    (
      await request("/api/login", {
        method: "POST",
        body: { email: "ada@example.test", password: "anything-at-all-123" },
      })
    ).status,
    401,
    "no password signs in to it",
  );

  const again = await complete(
    "google",
    await begin("google", { intent: "login", next: "discover" }),
    { sub: "google-ada", email: "ada@example.test", email_verified: true },
  );
  assert.match(again.finished.text, /url=\/discover\.html/);
  const signedInAgain = await me(again.session);
  assert.equal(signedInAgain.id, user.id);
  assert.equal(
    database(
      (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get("ada@example.test")
          .count,
    ),
    1,
  );

  const exported = await request("/api/account/export", {
    method: "POST",
    cookie: again.session,
    body: {},
    headers: { "X-CSRF-Token": signedInAgain.csrf },
  });
  assert.equal(exported.status, 200);
  assert.deepEqual(
    exported.data.account.signIns.map((item) => [item.provider, item.email]),
    [["google", "ada@example.test"]],
  );
  assert.equal(
    exported.text.includes("google-ada"),
    false,
    "the provider's subject is never exported",
  );
});

test("in the app, an account made with Google deletes with DELETE alone soon after signing in", async () => {
  const { finished, session } = await complete("google", await begin("google"), {
    sub: "google-grace",
    email: "grace@example.test",
    email_verified: true,
    name: "Grace Hopper",
  });
  assert.equal(finished.status, 200);
  const user = await me(session);
  assert.equal(user.name, "Grace Hopper");
  assert.deepEqual(user.signIn, { hasPassword: false, providers: ["google"] });
  const deleted = await request("/api/account/delete/now", {
    method: "POST",
    cookie: session,
    body: { confirmation: "DELETE" },
    headers: { "X-CSRF-Token": user.csrf },
  });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(
    database(
      (db) =>
        db
          .prepare("SELECT COUNT(*) AS count FROM account_identities WHERE subject='google-grace'")
          .get().count,
    ),
    0,
    "the delete removed the linked sign-in",
  );
  assert.equal(
    database(
      (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM users WHERE email='grace@example.test'").get()
          .count,
    ),
    0,
  );
});

test("a provider account links to an existing account only after STRATA has verified that email", async () => {
  const signup = await request("/api/signup", {
    method: "POST",
    body: { name: "Linus", email: "linus@example.test", password: "password-for-linus-123" },
  });
  assert.equal(signup.status, 201);
  const refused = await complete("google", await begin("google", { intent: "login" }), {
    sub: "google-linus",
    email: "linus@example.test",
    email_verified: true,
  });
  assert.equal(refused.finished.status, 303);
  assert.equal(
    errorOf(refused.finished.location),
    "An account with that email already exists. Sign in with your password to continue.",
  );
  assert.match(refused.finished.location, /^\/account\.html\?mode=login&/);

  database((db) =>
    db
      .prepare("UPDATE users SET email_verified_at=? WHERE email=?")
      .run(Date.now(), "linus@example.test"),
  );
  const linked = await complete("google", await begin("google", { intent: "login" }), {
    sub: "google-linus",
    email: "linus@example.test",
    email_verified: true,
  });
  const user = await me(linked.session);
  assert.equal(user.email, "linus@example.test");
  assert.deepEqual(user.signIn, { hasPassword: true, providers: ["google"] });
  assert.equal(
    (
      await request("/api/login", {
        method: "POST",
        body: { email: "linus@example.test", password: "password-for-linus-123" },
      })
    ).status,
    200,
    "the password still works",
  );

  const other = await complete("google", await begin("google", { intent: "login" }), {
    sub: "google-linus-second",
    email: "linus@example.test",
    email_verified: true,
  });
  assert.equal(
    errorOf(other.finished.location),
    "This STRATA account is already linked to a different Google account.",
  );
  const unverified = await complete("google", await begin("google"), {
    sub: "google-nobody",
    email: "nobody@example.test",
    email_verified: false,
  });
  assert.equal(
    errorOf(unverified.finished.location),
    "Your Google account did not share a verified email address. Create an account with your email instead.",
  );
});

test("a sign-in state finishes once, only in the browser that started it, and canceling says so", async () => {
  const flow = await begin("google");
  const elsewhere = await complete(
    "google",
    flow,
    { sub: "google-mallory", email: "mallory@example.test", email_verified: true },
    { cookie: `strata_social=${randomBytes(32).toString("base64url")}` },
  );
  assert.equal(elsewhere.finished.status, 303);
  assert.equal(
    errorOf(elsewhere.finished.location),
    "That sign-in expired or was started in another browser. Please try again.",
  );
  assert.equal(cookieOf(elsewhere.finished.headers, "strata_session"), "");
  assert.equal(
    database(
      (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get("mallory@example.test")
          .count,
    ),
    0,
  );

  const once = await begin("google"),
    first = await complete("google", once, {
      sub: "google-once",
      email: "once@example.test",
      email_verified: true,
    });
  assert.equal(first.finished.status, 200);
  const replay = await request(first.back.location, {
    cookie: once.browser,
    headers: { Origin: "" },
  });
  assert.equal(
    errorOf(replay.location),
    "That sign-in expired or was started in another browser. Please try again.",
  );
  const recall = await request(
    `/auth/social/google/callback?${new URLSearchParams({ state: once.state, code: "code-again" })}`,
    { headers: { Origin: "" } },
  );
  assert.equal(
    errorOf(recall.location),
    "That sign-in expired or was started in another browser. Please try again.",
  );

  const canceled = await begin("google", { next: "pricing" }),
    back = await request(
      `/auth/social/google/callback?${new URLSearchParams({ state: canceled.state, error: "access_denied" })}`,
      { headers: { Origin: "" } },
    );
  assert.equal(
    back.location,
    `/account.html?${new URLSearchParams({ mode: "signup", error: "Sign-in was canceled. Choose an option to try again.", next: "pricing" })}`,
  );
  const page = await request(back.location);
  assert.match(
    page.text,
    /id="signupMessage"[^>]*>Sign-in was canceled\. Choose an option to try again\.<\/div>/,
  );

  assert.equal(
    errorOf(
      (
        await request("/auth/social/start", {
          method: "POST",
          form: { provider: "google" },
          headers: { Origin: "https://evil.example" },
        })
      ).location,
    ),
    "Cross-origin request rejected.",
  );
  assert.equal(
    errorOf(
      (await request("/auth/social/start", { method: "POST", form: { provider: "facebook" } }))
        .location,
    ),
    "That sign-in option is not available right now. Use your email and password or try again later.",
  );
  assert.equal((await request("/auth/social/start")).status, 405);
  assert.equal(
    (
      await request(`/auth/social/google/callback?state=${canceled.state}`, {
        method: "POST",
        form: {},
      })
    ).status,
    405,
    "Google returns only by GET",
  );
  assert.equal((await request("/auth/social/apple/callback")).status, 404, "Apple has no callback");
  assert.equal((await request("/auth/social/unknown/callback")).status, 404);
  assert.equal(
    (await request("/auth/social/samsung/callback")).status,
    404,
    "Samsung has no callback",
  );
  for (const other of ["apple", "samsung"])
    assert.equal(
      errorOf(
        (await request("/auth/social/start", { method: "POST", form: { provider: other } }))
          .location,
      ),
      "That sign-in option is not available right now. Use your email and password or try again later.",
    );
});

test("a forged or mismatched ID token never signs anyone in", async () => {
  const flow = await begin("google");
  provider.codes.set("code-forged", {
    id: "google",
    redirectUri: flow.location.searchParams.get("redirect_uri"),
    challenge: flow.location.searchParams.get("code_challenge"),
    claims: {
      iss: `${provider.url}/google`,
      aud: "another-client",
      sub: "google-eve",
      email: "eve@example.test",
      email_verified: true,
      nonce: flow.nonce,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    },
  });
  const back = await request(
    `/auth/social/google/callback?${new URLSearchParams({ state: flow.state, code: "code-forged" })}`,
    { headers: { Origin: "" } },
  );
  const finished = await request(back.location, { cookie: flow.browser, headers: { Origin: "" } });
  assert.equal(errorOf(finished.location), "The sign-in could not be completed. Please try again.");
  const wrongNonce = await complete("google", await begin("google"), {
    sub: "google-eve",
    email: "eve@example.test",
    email_verified: true,
    nonce: "not-the-nonce",
  });
  assert.equal(
    errorOf(wrongNonce.finished.location),
    "The sign-in could not be completed. Please try again.",
  );
  assert.equal(
    database(
      (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get("eve@example.test")
          .count,
    ),
    0,
  );
  assert.equal(
    readFileSync(join(ROOT, "public", "pages", "account.html"), "utf8").includes(
      "data-social-options hidden",
    ),
    true,
    "the static page keeps the buttons hidden until the server shows them",
  );
});
