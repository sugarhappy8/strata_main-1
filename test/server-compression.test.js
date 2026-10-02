"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { gunzipSync } = require("node:zlib");

const PROJECT_ROOT = join(__dirname, "..");

let server;
let runtimeDir;
let baseUrl;

async function startServer() {
  mkdirSync(join(PROJECT_ROOT, "test-runtime"), { recursive: true });
  runtimeDir = mkdtempSync(join(PROJECT_ROOT, "test-runtime", "compression-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      TRUST_PROXY: "",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtimeDir,
      PADDLE_CHECKOUT_ENABLED: "false",
      PADDLE_CLIENT_TOKEN: "",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "",
      PADDLE_PRODUCT_ID: "",
      PADDLE_PRICE_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseUrl = await new Promise((resolve, reject) => {
    let output = "",
      settled = false,
      timer;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    timer = setTimeout(() => fail(new Error("Server startup timed out")), 5000);
    server.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(new URL(`http://127.0.0.1:${match[1]}`));
      }
    });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    server.once("error", fail);
    server.once("exit", (code, signal) =>
      fail(new Error(`Server exited before startup (${code ?? signal ?? "unknown"})`)),
    );
  });
}

async function stopServer() {
  const child = server;
  server = undefined;
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
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  runtimeDir = undefined;
  baseUrl = undefined;
}

function request(path, { method = "GET", headers = {}, body } = {}) {
  const payload = body === undefined ? null : Buffer.from(body);
  const requestHeaders = { ...headers };
  if (payload && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-length"))
    requestHeaders["Content-Length"] = payload.length;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: baseUrl.hostname, port: baseUrl.port, path, method, headers: requestHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

test.before(startServer);
test.after(stopServer);

test("negotiates gzip for large text while preserving response semantics", async () => {
  const compressed = await request("/exercises.json", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.match(compressed.headers.vary, /Accept-Encoding/i);
  assert.equal(Number(compressed.headers["content-length"]), compressed.body.length);
  assert.equal(compressed.headers["cache-control"], "public, max-age=300");
  const exercises = JSON.parse(gunzipSync(compressed.body));
  assert.ok(Array.isArray(exercises));
  assert.equal(exercises.length, 320);

  const identity = await request("/exercises.json", {
    headers: { "Accept-Encoding": "gzip;q=0, *;q=1" },
  });
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.match(identity.headers.vary, /Accept-Encoding/i);
  assert.equal(Number(identity.headers["content-length"]), identity.body.length);
  assert.deepEqual(JSON.parse(identity.body), exercises);

  const wildcard = await request("/exercises.json", {
    headers: { "Accept-Encoding": "br, *;q=0.5" },
  });
  assert.equal(wildcard.headers["content-encoding"], "gzip");

  const head = await request("/exercises.json", {
    method: "HEAD",
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal(Number(head.headers["content-length"]), compressed.body.length);
  assert.equal(head.body.length, 0);

  const home = await request("/", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(home.headers["content-encoding"], "gzip");
  assert.match(home.headers.vary, /Cookie/i);
  assert.match(home.headers.vary, /Accept-Encoding/i);
  assert.equal(home.headers["cache-control"], "private, no-store");

  const status = await request("/api/status", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(status.headers["content-encoding"], undefined);
  assert.equal(status.headers.vary, undefined);
  assert.equal(status.headers["cache-control"], "no-store");
});

test("keeps an unpaid Discovery denial small, uncompressed, and private", async () => {
  const credentials = JSON.stringify({
    name: "Compression Tester",
    email: "compression@example.test",
    password: "compression-safe-123",
  });
  const signup = await request("/api/signup", {
    method: "POST",
    headers: { Origin: baseUrl.origin, "Content-Type": "application/json" },
    body: credentials,
  });
  assert.equal(signup.status, 201);
  const cookie = signup.headers["set-cookie"][0].split(";", 1)[0];
  const signedInHome = await request("/", {
    headers: { Cookie: cookie, "Accept-Encoding": "gzip" },
  });
  assert.match(gunzipSync(signedInHome.body).toString(), /Compression profile/);
  assert.equal(signedInHome.headers["cache-control"], "private, no-store");
  const publicHome = await request("/", { headers: { "Accept-Encoding": "gzip" } });
  assert.doesNotMatch(gunzipSync(publicHome.body).toString(), /Compression\s*profile/);
  assert.match(gunzipSync(publicHome.body).toString(), /id="accountButton"[^>]*>Log in/);

  const discovery = await request("/api/discovery", {
    headers: { Cookie: cookie, "Accept-Encoding": "gzip" },
  });
  assert.equal(discovery.status, 402);
  assert.equal(discovery.headers["content-encoding"], undefined);
  assert.equal(discovery.headers.vary, undefined);
  assert.equal(discovery.headers["cache-control"], "no-store");
  assert.equal(Number(discovery.headers["content-length"]), discovery.body.length);
  const payload = JSON.parse(discovery.body.toString("utf8"));
  assert.equal(payload.code, "DISCOVERY_ACCESS_REQUIRED");
  assert.match(payload.error, /purchase required/i);
});

test("SIGTERM bounds draining an unfinished request", { timeout: 15_000 }, async (t) => {
  const held = http.request({
    hostname: baseUrl.hostname,
    port: baseUrl.port,
    path: "/api/signup",
    method: "POST",
    headers: {
      Origin: baseUrl.origin,
      "Content-Type": "application/json",
      "Content-Length": "64",
      Expect: "100-continue",
    },
  });
  held.on("error", () => {});
  t.after(() => held.destroy());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Server did not accept the held request")),
      2000,
    );
    held.once("continue", () => {
      clearTimeout(timer);
      resolve();
    });
    held.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    held.flushHeaders();
  });
  const started = Date.now();
  const stopped = new Promise((resolve) =>
    server.once("exit", (code, signal) => resolve({ code, signal })),
  );
  server.kill("SIGTERM");
  const result = await stopped;
  assert.equal(result.code, 1, "a forced drain must be visible to the process supervisor");
  assert.equal(result.signal, null);
  assert.ok(
    Date.now() - started < 12_000,
    "unfinished clients must not block deployment indefinitely",
  );
});
