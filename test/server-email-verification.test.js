"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PROJECT_ROOT = join(__dirname, "..");
const EMAIL_SECRET = "email-verification-test-secret-that-is-long-enough-123";
const EMAIL_API_KEY = "re_email_verification_fixture_key_123456";

let provider, app, runtimeDir, providerBase, base;
let providerStatus = 200;
const deliveries = [];
let requestAddressOctet = 10;

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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function startProvider() {
  provider = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    deliveries.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
    res.writeHead(providerStatus, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        providerStatus === 200
          ? { id: `email_${deliveries.length}` }
          : { message: "fixture failure" },
      ),
    );
  });
  providerBase = await listen(provider);
}

async function startApp() {
  mkdirSync(join(PROJECT_ROOT, "test-runtime"), { recursive: true });
  runtimeDir = mkdtempSync(join(PROJECT_ROOT, "test-runtime", "email-verification-"));
  app = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      TRUST_PROXY: "true",
      APP_BASE_URL: "http://127.0.0.1",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtimeDir,
      PADDLE_CHECKOUT_ENABLED: "false",
      PADDLE_CLIENT_TOKEN: "",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "",
      PADDLE_PRODUCT_ID: "",
      PADDLE_PRICE_ID: "",
      EMAIL_VERIFICATION_ENABLED: "true",
      RESEND_API_KEY: EMAIL_API_KEY,
      EMAIL_FROM: "STRATA <accounts@auth.stratafitness.online>",
      EMAIL_REPLY_TO: "stratafitness.official@gmail.com",
      EMAIL_VERIFICATION_SECRET: EMAIL_SECRET,
      RESEND_API_BASE: providerBase,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let output = "",
      errors = "",
      settled = false;
    const timer = setTimeout(() => finish(new Error(`Server startup timed out. ${errors}`)), 5000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
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

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
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
  const response = await fetch(`${base}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await response.json() : await response.text();
  return { response, data, setCookie: response.headers.get("set-cookie") || "" };
}

function cookieValue(header, name) {
  const match = String(header).match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  return match ? `${name}=${match[1]}` : "";
}

function codeFrom(delivery) {
  const match = String(delivery?.body?.text || "").match(/code is ([0-9]{6})\./i);
  assert.ok(match, "the provider fixture must receive a six-digit code");
  return match[1];
}

function postJson(path, body, cookie = "", withOrigin = true, extraHeaders = {}) {
  requestAddressOctet = (requestAddressOctet % 240) + 1;
  const headers = {
    "Content-Type": "application/json",
    "X-Forwarded-For": `198.51.100.${requestAddressOctet}`,
    ...extraHeaders,
  };
  if (withOrigin) headers.Origin = base;
  if (cookie) headers.Cookie = cookie;
  return request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

test.before(async () => {
  await startProvider();
  await startApp();
});
test.after(async () => {
  await stopApp();
  await closeServer(provider);
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
});

test("new accounts require one delivered code while existing accounts remain safe", async () => {
  const status = await request("/api/status");
  assert.deepEqual(Object.keys(status.data).sort(), ["ok", "version"], "email setup is not public");
  assert.doesNotMatch(JSON.stringify(status.data), /fixture_key|verification-test-secret/i);

  const noOrigin = await postJson(
    "/api/signup",
    { name: "No Origin", email: "no-origin@example.test", password: "no-origin-password-123" },
    "",
    false,
  );
  assert.equal(noOrigin.response.status, 403);
  assert.equal(deliveries.length, 0);

  const password = "verified-account-password-123";
  const signup = await postJson("/api/signup", {
    name: "Verified Lifter",
    email: "verified@example.test",
    password,
  });
  assert.equal(signup.response.status, 202);
  assert.equal(signup.data.verificationRequired, true);
  assert.equal(signup.data.maskedEmail, "v******d@example.test");
  assert.ok(Number(signup.data.expiresAt) > Date.now());
  assert.match(signup.setCookie, /strata_signup=/);
  assert.match(signup.setCookie, /HttpOnly/i);
  assert.match(signup.setCookie, /SameSite=Strict/i);
  assert.doesNotMatch(signup.setCookie, /strata_session\s*=/);
  assert.doesNotMatch(JSON.stringify(signup.data), new RegExp(password));

  const signupCookie = cookieValue(signup.setCookie, "strata_signup");
  assert.ok(signupCookie);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].url, "/emails");
  assert.equal(deliveries[0].headers.authorization, `Bearer ${EMAIL_API_KEY}`);
  assert.equal(deliveries[0].body.to[0], "verified@example.test");
  assert.equal(deliveries[0].body.reply_to, "stratafitness.official@gmail.com");
  const firstCode = codeFrom(deliveries[0]);

  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get("verified@example.test")
      .count,
    0,
  );
  const pending = db
    .prepare(
      "SELECT password_hash,password_salt,code_digest,generation,attempts_used,delivery_state FROM signup_verifications WHERE email=?",
    )
    .get("verified@example.test");
  assert.ok(pending.password_hash && pending.password_salt && pending.code_digest);
  assert.notEqual(pending.password_hash, password);
  assert.notEqual(pending.code_digest, firstCode);
  assert.equal(pending.delivery_state, "sent");

  const beforeVerification = await request("/api/me", { headers: { Cookie: signupCookie } });
  assert.equal(beforeVerification.data.user, null);
  const verificationStatus = await request("/api/verification-status", {
    headers: { Cookie: signupCookie },
  });
  assert.equal(verificationStatus.response.status, 200);
  assert.equal(verificationStatus.data.active, true);
  assert.equal(verificationStatus.data.maskedEmail, "v******d@example.test");
  assert.equal(verificationStatus.data.deliveryState, "sent");

  const wrongCode = firstCode === "000000" ? "000001" : "000000";
  const wrong = await postJson("/api/verify-email", { code: wrongCode }, signupCookie);
  assert.equal(wrong.response.status, 400);
  assert.equal(wrong.data.code, "INVALID_VERIFICATION_CODE");
  assert.equal(
    db
      .prepare("SELECT attempts_used FROM signup_verifications WHERE email=?")
      .get("verified@example.test").attempts_used,
    1,
  );
  const beforePrematureLogin = deliveries.length;
  const prematureLogin = await postJson("/api/login", { email: "verified@example.test", password });
  assert.equal(
    prematureLogin.response.status,
    401,
    "a fresh email must not become a login account after a wrong code",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get("verified@example.test")
      .count,
    0,
  );
  assert.equal(
    deliveries.length,
    beforePrematureLogin,
    "a nonexistent account must not trigger login verification",
  );

  const earlyResend = await postJson("/api/resend-verification", {}, signupCookie);
  assert.equal(earlyResend.response.status, 429);
  assert.equal(earlyResend.data.code, "VERIFICATION_COOLDOWN");
  db.prepare("UPDATE signup_verifications SET last_sent_at=? WHERE email=?").run(
    Date.now() - 61_000,
    "verified@example.test",
  );
  const resent = await postJson("/api/resend-verification", {}, signupCookie);
  assert.equal(resent.response.status, 202);
  assert.equal(deliveries.length, 2);
  const currentCode = codeFrom(deliveries[1]);
  assert.equal(
    db
      .prepare("SELECT generation FROM signup_verifications WHERE email=?")
      .get("verified@example.test").generation,
    2,
  );

  const simultaneous = await Promise.all([
    postJson("/api/verify-email", { code: currentCode }, signupCookie),
    postJson("/api/verify-email", { code: currentCode }, signupCookie),
  ]);
  const simultaneousStatuses = simultaneous
    .map((result) => result.response.status)
    .sort((a, b) => a - b);
  assert.equal(simultaneousStatuses[0], 201);
  assert.ok([400, 409, 410].includes(simultaneousStatuses[1]));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get("verified@example.test")
      .count,
    1,
  );
  const completed = simultaneous.find((result) => result.response.status === 201);
  const sessionCookie = cookieValue(completed.setCookie, "strata_session");
  assert.ok(sessionCookie);
  assert.match(completed.setCookie, /strata_signup=;/);
  const me = await request("/api/me", { headers: { Cookie: sessionCookie } });
  assert.equal(me.response.status, 200);
  assert.equal(me.data.user.email, "verified@example.test");

  const secondDevice = await postJson("/api/login", { email: "verified@example.test", password });
  assert.equal(secondDevice.response.status, 200);
  assert.ok(cookieValue(secondDevice.setCookie, "strata_session"));

  db.prepare("UPDATE users SET email_verified_at=NULL WHERE email=?").run("verified@example.test");
  const blockedExistingSession = await request("/api/me", { headers: { Cookie: sessionCookie } });
  assert.equal(
    blockedExistingSession.data.user,
    null,
    "an existing session must stop working when its account is unverified",
  );
  const guestPlannerPage = await request("/planner.html", {
    redirect: "manual",
    headers: { Cookie: sessionCookie },
  });
  assert.equal(
    guestPlannerPage.response.status,
    200,
    "the login-free planner remains available when an account session is invalid",
  );
  const beforeBadLogin = deliveries.length;
  const badUnverifiedLogin = await postJson("/api/login", {
    email: "verified@example.test",
    password: "incorrect-password-123",
  });
  assert.equal(badUnverifiedLogin.response.status, 401);
  assert.equal(
    deliveries.length,
    beforeBadLogin,
    "an incorrect password must never send a login code",
  );

  const unverifiedLogin = await postJson("/api/login", {
    email: "verified@example.test",
    password,
  });
  assert.equal(unverifiedLogin.response.status, 202);
  assert.equal(unverifiedLogin.data.verificationRequired, true);
  assert.equal(unverifiedLogin.data.purpose, "login");
  assert.match(unverifiedLogin.setCookie, /strata_signup=/);
  assert.doesNotMatch(unverifiedLogin.setCookie, /strata_session\s*=/);
  const loginCookie = cookieValue(unverifiedLogin.setCookie, "strata_signup");
  const loginChallenge = db
    .prepare(
      "SELECT purpose,password_hash,password_salt FROM signup_verifications WHERE email=? ORDER BY created_at DESC LIMIT 1",
    )
    .get("verified@example.test");
  assert.equal(loginChallenge.purpose, "login");
  assert.equal(loginChallenge.password_hash, "");
  assert.equal(loginChallenge.password_salt, "");
  const loginCode = codeFrom(deliveries.at(-1));
  const verifiedLogin = await postJson("/api/verify-email", { code: loginCode }, loginCookie);
  assert.equal(verifiedLogin.response.status, 200);
  assert.ok(cookieValue(verifiedLogin.setCookie, "strata_session"));
  assert.ok(
    Number(
      db.prepare("SELECT email_verified_at FROM users WHERE email=?").get("verified@example.test")
        .email_verified_at,
    ) > 0,
  );
  assert.equal(
    (await request("/api/me", { headers: { Cookie: sessionCookie } })).data.user,
    null,
    "the pre-verification session must stay revoked",
  );
  assert.equal(
    (
      await request("/api/me", {
        headers: { Cookie: cookieValue(secondDevice.setCookie, "strata_session") },
      })
    ).data.user,
    null,
    "all other pre-verification sessions must be revoked",
  );

  const duplicatePassword = "must-not-replace-original-123";
  const beforeDuplicate = deliveries.length;
  const duplicate = await postJson("/api/signup", {
    name: "Replacement Attempt",
    email: "verified@example.test",
    password: duplicatePassword,
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.code, "ACCOUNT_EXISTS");
  assert.equal(
    deliveries.length,
    beforeDuplicate,
    "existing-email signup must be rejected before sending a code",
  );
  assert.doesNotMatch(duplicate.setCookie, /strata_(?:signup|session)\s*=/);
  assert.equal(
    (await postJson("/api/login", { email: "verified@example.test", password })).response.status,
    200,
  );
  assert.equal(
    (await postJson("/api/login", { email: "verified@example.test", password: duplicatePassword }))
      .response.status,
    401,
  );
  db.close();
});

test("delivery failures leave a recoverable pending challenge and never a user", async () => {
  providerStatus = 500;
  const password = "delivery-recovery-password-123";
  const failed = await postJson("/api/signup", {
    name: "Delivery Recovery",
    email: "recovery@example.test",
    password,
  });
  assert.equal(failed.response.status, 503);
  assert.equal(failed.data.code, "EMAIL_DELIVERY_UNAVAILABLE");
  assert.equal(failed.data.verificationRequired, true);
  const pendingCookie = cookieValue(failed.setCookie, "strata_signup");
  assert.ok(pendingCookie);

  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get("recovery@example.test")
      .count,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT delivery_state FROM signup_verifications WHERE email=?")
      .get("recovery@example.test").delivery_state,
    "failed",
  );
  const failedStatus = await request("/api/verification-status", {
    headers: { Cookie: pendingCookie },
  });
  assert.equal(failedStatus.response.status, 200);
  assert.equal(failedStatus.data.active, true);
  assert.equal(failedStatus.data.deliveryState, "failed");

  providerStatus = 200;
  db.prepare("UPDATE signup_verifications SET last_sent_at=? WHERE email=?").run(
    Date.now() - 61_000,
    "recovery@example.test",
  );
  const resent = await postJson("/api/resend-verification", {}, pendingCookie);
  assert.equal(resent.response.status, 202);
  const code = codeFrom(deliveries.at(-1));
  const verified = await postJson("/api/verify-email", { code }, pendingCookie);
  assert.equal(verified.response.status, 201);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get("recovery@example.test")
      .count,
    1,
  );
  db.close();
});

test("parallel guesses atomically consume only five attempts and lock out the correct code", async () => {
  providerStatus = 200;
  const email = "parallel-guesses@example.test";
  const signup = await postJson("/api/signup", {
    name: "Parallel Guesses",
    email,
    password: "parallel-guesses-password-123",
  });
  assert.equal(signup.response.status, 202);
  const pendingCookie = cookieValue(signup.setCookie, "strata_signup");
  const correctCode = codeFrom(deliveries.at(-1));

  const guesses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      postJson("/api/verify-email", { code: `bad-${index}` }, pendingCookie),
    ),
  );
  assert.ok(
    guesses.every(
      ({ response, data }) => response.status === 400 && data.code === "INVALID_VERIFICATION_CODE",
    ),
  );

  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  assert.equal(
    db.prepare("SELECT attempts_used FROM signup_verifications WHERE email=?").get(email)
      .attempts_used,
    5,
  );
  const correctAfterLimit = await postJson(
    "/api/verify-email",
    { code: correctCode },
    pendingCookie,
  );
  assert.equal(
    correctAfterLimit.response.status,
    429,
    "the challenge limiter rejects further guesses across addresses",
  );
  assert.equal(correctAfterLimit.data.code, "VERIFICATION_RATE_LIMIT");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get(email).count, 0);
  db.close();
});

test("an expired code preserves the hard-lived challenge and consumes no attempt", async () => {
  providerStatus = 200;
  const email = "expired-code@example.test";
  const signup = await postJson("/api/signup", {
    name: "Expired Code",
    email,
    password: "expired-code-password-123",
  });
  assert.equal(signup.response.status, 202);
  const pendingCookie = cookieValue(signup.setCookie, "strata_signup");
  const originalCode = codeFrom(deliveries.at(-1));
  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  db.prepare("UPDATE signup_verifications SET expires_at=?,last_sent_at=? WHERE email=?").run(
    Date.now() - 1,
    Date.now() - 61_000,
    email,
  );

  const expired = await postJson("/api/verify-email", { code: originalCode }, pendingCookie);
  assert.equal(expired.response.status, 410);
  assert.equal(expired.data.code, "VERIFICATION_CODE_EXPIRED");
  assert.equal(expired.data.verificationRequired, true);
  assert.equal(
    db.prepare("SELECT attempts_used FROM signup_verifications WHERE email=?").get(email)
      .attempts_used,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get(email).count, 0);
  assert.doesNotMatch(expired.setCookie, /strata_signup\s*=\s*;/);

  const resent = await postJson("/api/resend-verification", {}, pendingCookie);
  assert.equal(resent.response.status, 202);
  const replacementCode = codeFrom(deliveries.at(-1));
  const verified = await postJson("/api/verify-email", { code: replacementCode }, pendingCookie);
  assert.equal(verified.response.status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get(email).count, 1);
  db.close();
});

test("parallel signup reserves no more than five durable email send slots", async () => {
  providerStatus = 200;
  const email = "parallel-signups@example.test";
  const before = deliveries.length;
  const signups = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      postJson("/api/signup", {
        name: `Parallel Signup ${index}`,
        email,
        password: `parallel-signup-password-${index}-123`,
      }),
    ),
  );
  assert.equal(signups.filter(({ response }) => response.status === 202).length, 5);
  assert.equal(
    signups.filter(
      ({ response, data }) =>
        response.status === 429 &&
        ["VERIFICATION_EMAIL_LIMIT", "AUTH_RATE_LIMIT"].includes(data.code),
    ).length,
    7,
  );
  assert.equal(deliveries.length - before, 5);

  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM signup_verifications WHERE email=?").get(email).count,
    5,
  );
  const hash = db
    .prepare(
      "SELECT email_hash FROM email_verification_sends WHERE challenge_id IN (SELECT challenge_id FROM signup_verifications WHERE email=?) LIMIT 1",
    )
    .get(email).email_hash;
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM email_verification_sends WHERE email_hash=?")
      .get(hash).count,
    5,
  );
  db.close();
});

test("resend recovers a generation reserved before a process interruption", async () => {
  providerStatus = 200;
  const email = "recoverable-resend@example.test";
  const signup = await postJson("/api/signup", {
    name: "Recoverable Resend",
    email,
    password: "recoverable-resend-password-123",
  });
  assert.equal(signup.response.status, 202);
  const pendingCookie = cookieValue(signup.setCookie, "strata_signup");
  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  const challenge = db
    .prepare("SELECT challenge_id,generation FROM signup_verifications WHERE email=?")
    .get(email);
  const firstSend = db
    .prepare(
      "SELECT email_hash FROM email_verification_sends WHERE challenge_id=? AND generation=1",
    )
    .get(challenge.challenge_id);
  const now = Date.now();
  db.prepare("UPDATE signup_verifications SET last_sent_at=? WHERE challenge_id=?").run(
    now - 61_000,
    challenge.challenge_id,
  );
  db.prepare(
    "INSERT INTO email_verification_sends(send_id,email_hash,challenge_id,generation,sent_at) VALUES(?,?,?,?,?)",
  ).run("interrupted-resend-slot", firstSend.email_hash, challenge.challenge_id, 2, now - 1_000);
  const before = deliveries.length;

  const resent = await postJson("/api/resend-verification", {}, pendingCookie);
  assert.equal(resent.response.status, 202);
  assert.equal(deliveries.length - before, 1);
  assert.equal(
    db
      .prepare("SELECT generation FROM signup_verifications WHERE challenge_id=?")
      .get(challenge.challenge_id).generation,
    2,
  );
  const code = codeFrom(deliveries.at(-1));
  const verified = await postJson("/api/verify-email", { code }, pendingCookie);
  assert.equal(verified.response.status, 201);
  db.close();
});

test("concurrent resend keeps the winning challenge and sends only one replacement", async () => {
  providerStatus = 200;
  const email = "concurrent-resend@example.test";
  const signup = await postJson("/api/signup", {
    name: "Concurrent Resend",
    email,
    password: "concurrent-resend-password-123",
  });
  assert.equal(signup.response.status, 202);
  const pendingCookie = cookieValue(signup.setCookie, "strata_signup");
  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  db.prepare("UPDATE signup_verifications SET last_sent_at=? WHERE email=?").run(
    Date.now() - 61_000,
    email,
  );
  const before = deliveries.length;

  const results = await Promise.all([
    postJson("/api/resend-verification", {}, pendingCookie),
    postJson("/api/resend-verification", {}, pendingCookie),
  ]);
  assert.equal(results.filter(({ response }) => response.status === 202).length, 1);
  const loser = results.find(({ response }) => response.status !== 202);
  assert.equal(loser.response.status, 429);
  assert.ok(["VERIFICATION_COOLDOWN", "VERIFICATION_EMAIL_LIMIT"].includes(loser.data.code));
  assert.doesNotMatch(loser.setCookie, /strata_signup\s*=\s*;/);
  assert.equal(deliveries.length - before, 1);
  assert.equal(
    db.prepare("SELECT generation FROM signup_verifications WHERE email=?").get(email).generation,
    2,
  );

  const currentCode = codeFrom(deliveries.at(-1));
  const verified = await postJson("/api/verify-email", { code: currentCode }, pendingCookie);
  assert.equal(verified.response.status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE email=?").get(email).count, 1);
  db.close();
});

test("near-deadline resend states the real shortened expiry and never clears a live challenge", async () => {
  providerStatus = 200;
  const email = "short-expiry@example.test";
  const signup = await postJson("/api/signup", {
    name: "Short Expiry",
    email,
    password: "short-expiry-password-123",
  });
  assert.equal(signup.response.status, 202);
  const pendingCookie = cookieValue(signup.setCookie, "strata_signup");
  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  const hardExpiry = Date.now() + 90_000;
  db.prepare(
    "UPDATE signup_verifications SET last_sent_at=?,expires_at=?,hard_expires_at=? WHERE email=?",
  ).run(Date.now() - 61_000, hardExpiry, hardExpiry, email);
  const before = deliveries.length;
  const resent = await postJson("/api/resend-verification", {}, pendingCookie);
  assert.equal(resent.response.status, 202);
  assert.equal(deliveries.length - before, 1);
  assert.match(String(deliveries.at(-1).body.text), /expires in 2 minutes/i);
  const updated = db
    .prepare("SELECT expires_at,hard_expires_at FROM signup_verifications WHERE email=?")
    .get(email);
  assert.ok(updated.expires_at <= updated.hard_expires_at);

  const tooClose = Date.now() + 30_000;
  db.prepare(
    "UPDATE signup_verifications SET last_sent_at=?,expires_at=?,hard_expires_at=? WHERE email=?",
  ).run(Date.now() - 61_000, tooClose, tooClose, email);
  const rejected = await postJson("/api/resend-verification", {}, pendingCookie);
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.data.code, "VERIFICATION_EXPIRING");
  assert.doesNotMatch(rejected.setCookie, /strata_signup\s*=\s*;/);
  db.close();
});

test("native forms complete verification without JavaScript", async () => {
  providerStatus = 200;
  const email = "native-verification@example.test";
  const signup = await request("/auth/signup", {
    method: "POST",
    redirect: "manual",
    headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Native Verification",
      email,
      password: "native-verification-password-123",
      next: "pricing",
    }).toString(),
  });
  assert.equal(signup.response.status, 303);
  assert.equal(
    signup.response.headers.get("location"),
    "/verify-email.html?next=pricing&purpose=signup",
  );
  const pendingCookie = cookieValue(signup.setCookie, "strata_signup");
  assert.ok(pendingCookie);
  const code = codeFrom(deliveries.at(-1));

  const verified = await request("/auth/verify-email", {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: base,
      Cookie: pendingCookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code, next: "pricing" }).toString(),
  });
  assert.equal(verified.response.status, 303);
  assert.equal(verified.response.headers.get("location"), "/pricing");
  assert.ok(cookieValue(verified.setCookie, "strata_session"));
  assert.match(verified.setCookie, /strata_signup=;/);
});
