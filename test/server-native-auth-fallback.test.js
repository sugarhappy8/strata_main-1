"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const PROJECT_ROOT = join(__dirname, "..");
let app, base, runtimeDir;

test.before(async () => {
  mkdirSync(join(PROJECT_ROOT, "test-runtime"), { recursive: true });
  runtimeDir = mkdtempSync(join(PROJECT_ROOT, "test-runtime", "native-auth-fallback-"));
  app = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      TRUST_PROXY: "",
      APP_BASE_URL: "http://127.0.0.1",
      STRATA_DATA_DIR: runtimeDir,
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      EMAIL_VERIFICATION_ENABLED: "false",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
      EMAIL_REPLY_TO: "",
      EMAIL_VERIFICATION_SECRET: "",
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
});

test.after(async () => {
  if (app && app.exitCode === null && app.signalCode === null) {
    await new Promise((resolve) => {
      let timer;
      app.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      app.kill("SIGTERM");
      timer = setTimeout(() => app.kill("SIGKILL"), 2000);
    });
  }
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
});

async function html(path) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200);
  return response.text();
}

test("server-rendered account forms preserve a safe native destination and error", async () => {
  const body = await html(
    "/account.html?mode=login&next=pricing&error=Email%20or%20password%20is%20incorrect.",
  );
  assert.match(body, /id="signupNext"[^>]*value="\/pricing"/);
  assert.match(body, /id="loginNext"[^>]*value="\/pricing"/);
  assert.match(body, /id="loginMessage"[^>]*>Email or password is incorrect\.<\/div>/);
  assert.doesNotMatch(body, /id\s*=\s*"loginMessage"[^>]*hidden/);
});

test("server-rendered verification forms preserve planner additions without JavaScript", async () => {
  const body = await html(
    "/verify-email.html?next=planner&add=flat-dumbbell-press&purpose=login&error=" +
      encodeURIComponent("Please wait before requesting another verification code."),
  );
  assert.match(body, /id="verificationNext"[^>]*value="\/planner\.html\?add=flat-dumbbell-press"/);
  assert.match(body, /id="resendNext"[^>]*value="\/planner\.html\?add=flat-dumbbell-press"/);
  assert.match(body, /id="verificationPurpose"[^>]*value="login"/);
  assert.match(body, /id="resendPurpose"[^>]*value="login"/);
  assert.match(
    body,
    /id="verificationMessage"[^>]*>Please wait before requesting another code\.<\/div>/,
  );
  assert.doesNotMatch(body, /id\s*=\s*"verificationMessage"[^>]*hidden/);
});

test("native fallback messages never reflect arbitrary query content", async () => {
  const attack = '<img src=x onerror="alert(1)">';
  const body = await html(
    `/verify-email.html?next=pricing&error=${encodeURIComponent(attack)}&delivery=failed`,
  );
  assert.match(body, /id="verificationNext"[^>]*value="\/pricing"/);
  assert.match(body, /Unable to complete the verification request\. Please try again\./);
  assert.doesNotMatch(body, /<\s*img\s*src\s*=\s*x|onerror\s*=|alert\s*\(\s*1\s*,?\s*\)/i);

  const failed = await html("/verify-email.html?next=pricing&delivery=failed");
  assert.match(
    failed,
    /We could not send the verification email\. Please wait a moment, then request another code\./,
  );
});

test("test mode cannot create an unverified account without the explicit override", async () => {
  const response = await fetch(`${base}/api/signup`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Blocked Test Signup",
      email: "blocked@example.test",
      password: "blocked-test-password-123",
    }),
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.code, "EMAIL_VERIFICATION_UNAVAILABLE");
  assert.equal(payload.verificationRequired, false);
  assert.equal(response.headers.get("set-cookie"), null);
});
