"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, ".."),
  RUNTIME_ROOT = join(ROOT, "test-runtime");
let child, runtime, base;

async function start() {
  mkdirSync(RUNTIME_ROOT, { recursive: true });
  runtime = mkdtempSync(join(RUNTIME_ROOT, "account-self-service-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtime,
      PADDLE_CHECKOUT_ENABLED: "false",
      PADDLE_CLIENT_TOKEN: "",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "",
      PADDLE_PRODUCT_ID: "",
      PADDLE_PRICE_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let output = "",
      settled = false,
      timer;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    timer = setTimeout(() => fail(new Error("Server startup timed out")), 5_000);
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4_096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`Server exited before startup (${code})`)));
  });
}
async function stop() {
  if (child && child.exitCode === null)
    await new Promise((resolve) => {
      let timer;
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    });
  if (runtime) rmSync(runtime, { recursive: true, force: true });
}
async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options),
    data = await response.json();
  return { response, data, cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
}
async function signup(name, email, password) {
  return request("/api/signup", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
}
async function login(email, password) {
  return request("/api/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}
async function me(cookie) {
  return request("/api/me", { headers: { Cookie: cookie } });
}
function mutationHeaders(cookie, csrf) {
  return { Cookie: cookie, Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrf };
}

test.before(start);
test.after(stop);

test("account self-service enforces session ownership, current-session safety, CSRF, and private export delivery", async () => {
  const anonymous = await request("/api/account/sessions");
  assert.equal(anonymous.response.status, 401);
  const password = "self-service-password-123",
    first = await signup("Session Owner", "sessions@example.test", password);
  assert.equal(first.response.status, 201);
  const second = await login("sessions@example.test", password);
  assert.equal(second.response.status, 200);
  const secondMe = await me(second.cookie),
    csrf = secondMe.data.csrfToken;
  assert.equal(secondMe.response.status, 200);

  const sessions = await request("/api/account/sessions", { headers: { Cookie: second.cookie } });
  assert.equal(sessions.response.status, 200);
  assert.equal(sessions.data.sessions.length, 2);
  assert.equal(sessions.data.otherCount, 1);
  assert.equal(sessions.data.sessions.filter((item) => item.current).length, 1);
  assert.doesNotMatch(
    JSON.stringify(sessions.data),
    /strata_session|token_hash|csrf_token|fingerprint|remoteAddress/i,
  );

  const wrongExportMethod = await request("/api/account/export", {
    headers: { Cookie: second.cookie },
  });
  assert.equal(wrongExportMethod.response.status, 405);
  assert.equal(wrongExportMethod.response.headers.get("allow"), "POST");
  const exportWithoutCsrf = await request("/api/account/export", {
    method: "POST",
    headers: { Cookie: second.cookie, Origin: base, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(exportWithoutCsrf.response.status, 403);
  const plan = await request("/api/plan", { headers: { Cookie: second.cookie } });
  const savedPlan = await request("/api/plan", {
    method: "PUT",
    headers: mutationHeaders(second.cookie, csrf),
    body: JSON.stringify({ plan: plan.data.plan, expectedPlanUpdatedAt: plan.data.planUpdatedAt }),
  });
  assert.equal(savedPlan.response.status, 200);
  const exported = await request("/api/account/export", {
    method: "POST",
    headers: mutationHeaders(second.cookie, csrf),
    body: "{}",
  });
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get("cache-control") || "", /no-store/);
  assert.match(
    exported.response.headers.get("content-disposition") || "",
    /^attachment; filename="strata-account-export-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  assert.equal(exported.data.account.id, first.data.user.id);
  assert.equal(exported.data.weeklyPlan.data.version, 1);
  assert.doesNotMatch(
    JSON.stringify(exported.data),
    /password_hash|password_salt|token_hash|csrf_token|customer_id|admin_note|ip_hash|email_hash/i,
  );

  const currentId = sessions.data.sessions.find((item) => item.current).id,
    otherId = sessions.data.sessions.find((item) => !item.current).id;
  const protectedCurrent = await request("/api/account/sessions/revoke", {
    method: "POST",
    headers: mutationHeaders(second.cookie, csrf),
    body: JSON.stringify({ sessionId: currentId }),
  });
  assert.equal(protectedCurrent.response.status, 409);
  assert.equal(protectedCurrent.data.code, "CURRENT_SESSION_PROTECTED");

  const outsiderPassword = "outsider-password-123",
    outsider = await signup("Other Member", "other-session@example.test", outsiderPassword),
    outsiderMe = await me(outsider.cookie);
  const outsiderSessions = await request("/api/account/sessions", {
      headers: { Cookie: outsider.cookie },
    }),
    outsiderId = outsiderSessions.data.sessions[0].id;
  const foreign = await request("/api/account/sessions/revoke", {
    method: "POST",
    headers: mutationHeaders(second.cookie, csrf),
    body: JSON.stringify({ sessionId: outsiderId }),
  });
  assert.equal(foreign.response.status, 404);
  assert.equal((await me(outsider.cookie)).response.status, 200);
  assert.equal(outsiderMe.response.status, 200);

  const revokedOne = await request("/api/account/sessions/revoke", {
    method: "POST",
    headers: mutationHeaders(second.cookie, csrf),
    body: JSON.stringify({ sessionId: otherId }),
  });
  assert.equal(revokedOne.response.status, 200);
  assert.equal(revokedOne.data.revoked, 1);
  assert.equal((await me(first.cookie)).response.status, 401);
  assert.equal((await me(second.cookie)).response.status, 200);

  const third = await login("sessions@example.test", password);
  assert.equal(third.response.status, 200);
  const invalidBulkCsrf = await request("/api/account/sessions/revoke-others", {
    method: "POST",
    headers: mutationHeaders(second.cookie, "invalid"),
    body: "{}",
  });
  assert.equal(invalidBulkCsrf.response.status, 403);
  assert.equal((await me(third.cookie)).response.status, 200);
  const revokedOthers = await request("/api/account/sessions/revoke-others", {
    method: "POST",
    headers: mutationHeaders(second.cookie, csrf),
    body: "{}",
  });
  assert.equal(revokedOthers.response.status, 200);
  assert.equal(revokedOthers.data.revoked, 1);
  assert.equal(revokedOthers.data.otherCount, 0);
  assert.equal((await me(third.cookie)).response.status, 401);
  assert.equal((await me(second.cookie)).response.status, 200);
});
