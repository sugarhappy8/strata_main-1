"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, verify } = require("node:crypto");
const { createGooglePlayApi, parseServiceAccount } = require("../src/google-play-api");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY = {
  type: "service_account",
  project_id: "strata-play",
  private_key_id: "key-1",
  private_key: PEM,
  client_email: "play-billing@strata-play.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};
const PACKAGE = "online.stratafitness.app";

/** A fetch that answers Google's token and Android Publisher endpoints and records every request. */
function googleFetch({ token = {}, api = () => ({ status: 200, body: { lineItems: [] } }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === KEY.token_uri) {
      const body = { access_token: "access-1", expires_in: 3600, ...token.body };
      return new Response(JSON.stringify(body), { status: token.status || 200 });
    }
    const answer = api(String(url), init);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status,
    });
  };
  return { calls, fetchImpl };
}

test("the service account key is read as JSON or base64 and must be Google's", () => {
  assert.equal(parseServiceAccount(""), null);
  const parsed = parseServiceAccount(JSON.stringify(KEY));
  assert.equal(parsed.clientEmail, KEY.client_email);
  assert.equal(parsed.privateKeyId, "key-1");
  assert.deepEqual(
    parseServiceAccount(Buffer.from(JSON.stringify(KEY)).toString("base64")),
    parsed,
  );
  for (const bad of [
    "{not json",
    JSON.stringify({ ...KEY, type: "authorized_user" }),
    JSON.stringify({ ...KEY, client_email: "someone@example.com" }),
    JSON.stringify({ ...KEY, private_key: "not a key" }),
    JSON.stringify({ ...KEY, token_uri: "https://evil.example/token" }),
    JSON.stringify({ ...KEY, token_uri: "http://oauth2.googleapis.com/token" }),
  ])
    assert.throws(() => parseServiceAccount(bad), TypeError, bad.slice(0, 40));
});

test("STRATA signs in with an RS256 JWT for the Android Publisher scope and reuses the token", async () => {
  let now = 1_800_000_000_000;
  const { calls, fetchImpl } = googleFetch({
    api: () => ({ status: 200, body: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" } }),
  });
  const api = createGooglePlayApi({
    serviceAccount: parseServiceAccount(JSON.stringify(KEY)),
    fetchImpl,
    now: () => now,
  });
  assert.deepEqual(await api.subscription(PACKAGE, "token-1"), {
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
  });
  await api.subscription(PACKAGE, "token-2");
  assert.equal(calls.filter((call) => call.url === KEY.token_uri).length, 1, "one sign-in");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims, signature] = String(form.get("assertion")).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "RS256",
    typ: "JWT",
    kid: "key-1",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), {
    iss: KEY.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: KEY.token_uri,
    iat: now / 1000,
    exp: now / 1000 + 3600,
  });
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
  assert.equal(
    calls[1].url,
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptionsv2/tokens/token-1`,
  );
  assert.equal(calls[1].init.headers.Authorization, "Bearer access-1");
  now += 3600 * 1000;
  await api.subscription(PACKAGE, "token-3");
  assert.equal(calls.filter((call) => call.url === KEY.token_uri).length, 2, "signs in again");
});

test("Google's answers become STRATA's error codes, and acknowledging twice is fine", async () => {
  const statuses = {
    "gone-token": 410,
    "unknown-token": 404,
    "denied-token": 403,
    "busy-token": 503,
  };
  const { calls, fetchImpl } = googleFetch({
    api: (url) => {
      if (url.endsWith(":acknowledge")) return { status: url.includes("again") ? 409 : 200 };
      const token = decodeURIComponent(url.split("/").at(-1));
      if (token === "offline-token") return new TypeError("fetch failed");
      return { status: statuses[token] || 200, body: {} };
    },
  });
  const api = createGooglePlayApi({
    serviceAccount: parseServiceAccount(JSON.stringify(KEY)),
    fetchImpl,
  });
  const failure = async (token) => {
    try {
      await api.subscription(PACKAGE, token);
      return null;
    } catch (error) {
      return { code: error.code, status: error.status };
    }
  };
  assert.deepEqual(await failure("gone-token"), {
    code: "GOOGLE_PLAY_PURCHASE_INVALID",
    status: 400,
  });
  assert.deepEqual(await failure("unknown-token"), {
    code: "GOOGLE_PLAY_PURCHASE_INVALID",
    status: 400,
  });
  assert.deepEqual(await failure("denied-token"), {
    code: "GOOGLE_PLAY_NOT_CONFIGURED",
    status: 503,
  });
  assert.deepEqual(await failure("busy-token"), { code: "GOOGLE_PLAY_UNAVAILABLE", status: 503 });
  assert.deepEqual(await failure("offline-token"), {
    code: "GOOGLE_PLAY_UNAVAILABLE",
    status: 503,
  });
  assert.deepEqual(await failure("has space"), {
    code: "GOOGLE_PLAY_PURCHASE_INVALID",
    status: 400,
  });
  assert.deepEqual(await failure("a/b"), { code: "GOOGLE_PLAY_PURCHASE_INVALID", status: 400 });
  await api.acknowledge(PACKAGE, "online.stratafitness.app.plus", "ack-token");
  await api.acknowledge(PACKAGE, "online.stratafitness.app.plus", "again-token");
  const ack = calls.find((call) => call.url.endsWith("ack-token:acknowledge"));
  assert.equal(
    ack.url,
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptions/online.stratafitness.app.plus/tokens/ack-token:acknowledge`,
  );
  assert.equal(ack.init.method, "POST");
});

test("a refused sign-in says the service account is not set up, without retrying forever", async () => {
  const { fetchImpl } = googleFetch({ token: { status: 400, body: { error: "invalid_grant" } } });
  const api = createGooglePlayApi({
    serviceAccount: parseServiceAccount(JSON.stringify(KEY)),
    fetchImpl,
  });
  await assert.rejects(api.subscription(PACKAGE, "token-1"), {
    code: "GOOGLE_PLAY_NOT_CONFIGURED",
    status: 503,
  });
});
