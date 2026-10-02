"use strict";

// Sign in with Google: which settings turn it on, every way an ID token is refused, and how the account page shows
// the button. The full browser round trip is in server-social-auth.test.js.
const test = require("node:test"),
  assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const { socialAuthSettings } = require("../src/social-auth-config");
const { codeChallenge, createSocialAuthClient } = require("../src/social-auth-client");
const { createSocialAuthService } = require("../src/social-auth");
const { SOCIAL_PAGE_MESSAGES } = require("../src/social-auth-messages");

const NOW = 1_800_000_000_000,
  SECONDS = NOW / 1000;
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }),
  other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const ENV = {
  NODE_ENV: "test",
  GOOGLE_SIGN_IN_CLIENT_ID: "google-client",
  GOOGLE_SIGN_IN_CLIENT_SECRET: "google-secret",
};

function jwt(claims, { kid = "key-1", alg = "RS256", key = rsa.privateKey } = {}) {
  const input = `${b64({ alg, kid })}.${b64(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}
const claims = (extra = {}) => ({
  iss: "https://accounts.google.com",
  aud: "google-client",
  sub: "subject-1",
  email: "a@example.test",
  email_verified: true,
  nonce: "nonce-1",
  iat: SECONDS,
  exp: SECONDS + 600,
  ...extra,
});
function keyServer(
  keys = [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" }],
) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

test("Google turns on only when both of its values are set, and no other provider is offered", () => {
  const none = socialAuthSettings({ NODE_ENV: "test" });
  assert.deepEqual(none.enabled, []);
  assert.match(
    none.providers.google.problems[0],
    /GOOGLE_SIGN_IN_CLIENT_ID and GOOGLE_SIGN_IN_CLIENT_SECRET/,
  );
  assert.deepEqual(socialAuthSettings(ENV).enabled, ["google"]);
  assert.deepEqual(socialAuthSettings({ ...ENV, GOOGLE_SIGN_IN_CLIENT_SECRET: "" }).enabled, []);
  const others = socialAuthSettings({
    ...ENV,
    SAMSUNG_SIGN_IN_CLIENT_ID: "x",
    SAMSUNG_SIGN_IN_CLIENT_SECRET: "y",
    APPLE_SIGN_IN_SERVICES_ID: "a.b",
  });
  assert.deepEqual(Object.keys(others.providers), ["google"], "Apple and Samsung are not offered");

  const production = socialAuthSettings({
    ...ENV,
    NODE_ENV: "production",
    APP_BASE_URL: "http://stratafitness.online",
  });
  assert.deepEqual(production.enabled, []);
  assert.match(
    production.providers.google.problems.join(" "),
    /APP_BASE_URL must be an https address/,
  );
  const live = socialAuthSettings({
    ...ENV,
    NODE_ENV: "production",
    APP_BASE_URL: "https://stratafitness.online/",
    SIGN_IN_PROVIDER_STAND_IN: "http://127.0.0.1:9999",
  });
  assert.equal(live.redirectBase, "https://stratafitness.online");
  assert.equal(live.secureCookies, true);
  assert.equal(
    live.providers.google.tokenUrl,
    "https://oauth2.googleapis.com/token",
    "production never uses a stand-in",
  );
  const local = socialAuthSettings({ ...ENV, SIGN_IN_PROVIDER_STAND_IN: "http://127.0.0.1:9999/" });
  assert.deepEqual(
    [local.providers.google.issuers, local.providers.google.tokenUrl],
    [["http://127.0.0.1:9999/google"], "http://127.0.0.1:9999/google/token"],
  );
  assert.equal(
    socialAuthSettings({ ...ENV, SIGN_IN_PROVIDER_STAND_IN: "https://example.test" }).providers
      .google.tokenUrl,
    "https://oauth2.googleapis.com/token",
    "a stand-in must be this machine",
  );
});

test("the authorization address asks Google for exactly what STRATA needs", () => {
  const client = createSocialAuthClient({
    settings: socialAuthSettings(ENV),
    fetchImpl: async () => {
      throw new Error("no network");
    },
  });
  const request = {
    state: "state-1",
    nonce: "nonce-1",
    codeVerifier: "verifier-1",
    redirectUri: "https://stratafitness.online/auth/social/google/callback",
  };
  const google = new URL(client.authorizeUrl("google", request));
  assert.equal(google.origin + google.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(Object.fromEntries(google.searchParams), {
    response_type: "code",
    client_id: "google-client",
    redirect_uri: request.redirectUri,
    scope: "openid email profile",
    state: "state-1",
    nonce: "nonce-1",
    code_challenge: codeChallenge("verifier-1"),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  assert.equal(google.searchParams.has("response_mode"), false);
  assert.throws(
    () =>
      createSocialAuthClient({ settings: socialAuthSettings({ NODE_ENV: "test" }) }).authorizeUrl(
        "google",
        request,
      ),
    { code: "SOCIAL_NOT_CONFIGURED" },
  );
});

test("an ID token is accepted only when its signature, issuer, audience, time, nonce, and subject all check out", async () => {
  const keys = keyServer(),
    client = createSocialAuthClient({
      settings: socialAuthSettings(ENV),
      fetchImpl: keys.fetchImpl,
      now: () => NOW,
    });
  const accepted = await client.verifyIdToken("google", jwt(claims()), { nonce: "nonce-1" });
  assert.equal(accepted.sub, "subject-1");
  assert.equal(
    (
      await client.verifyIdToken("google", jwt(claims({ iss: "accounts.google.com" })), {
        nonce: "nonce-1",
      })
    ).sub,
    "subject-1",
    "Google's short issuer is listed",
  );
  assert.equal(
    (
      await client.verifyIdToken(
        "google",
        jwt(claims({ aud: ["google-client", "other"], azp: "google-client" })),
        { nonce: "nonce-1" },
      )
    ).sub,
    "subject-1",
  );

  const refused = [
    ["another signing key", jwt(claims(), { key: other.privateKey })],
    ["no signature", `${b64({ alg: "none", kid: "key-1" })}.${b64(claims())}.`],
    ["another algorithm", jwt(claims(), { alg: "HS256" })],
    ["another issuer", jwt(claims({ iss: "https://appleid.apple.com" }))],
    ["another audience", jwt(claims({ aud: "someone-else" }))],
    ["several audiences without azp", jwt(claims({ aud: ["google-client", "other"] }))],
    ["expired", jwt(claims({ exp: SECONDS - 121 }))],
    ["issued in the future", jwt(claims({ iat: SECONDS + 121 }))],
    ["another nonce", jwt(claims({ nonce: "nonce-2" }))],
    ["no nonce", jwt(claims({ nonce: undefined }))],
    ["no subject", jwt(claims({ sub: "" }))],
    ["not a token", "abc.def"],
  ];
  for (const [label, token] of refused)
    await assert.rejects(
      client.verifyIdToken("google", token, { nonce: "nonce-1" }),
      { code: "SOCIAL_TOKEN_INVALID" },
      label,
    );
  const tampered = jwt(claims()).split(".");
  tampered[1] = b64(claims({ sub: "subject-2" }));
  await assert.rejects(
    client.verifyIdToken("google", tampered.join("."), { nonce: "nonce-1" }),
    { code: "SOCIAL_TOKEN_INVALID" },
    "a changed payload",
  );
});

test("signing keys are cached, and an unknown key is looked up again at most once a minute", async () => {
  const keys = keyServer();
  let time = NOW;
  const client = createSocialAuthClient({
    settings: socialAuthSettings(ENV),
    fetchImpl: keys.fetchImpl,
    now: () => time,
  });
  await client.verifyIdToken("google", jwt(claims()), { nonce: "nonce-1" });
  await client.verifyIdToken("google", jwt(claims()), { nonce: "nonce-1" });
  assert.equal(keys.calls.length, 1);
  await assert.rejects(
    client.verifyIdToken("google", jwt(claims(), { kid: "rotated" }), { nonce: "nonce-1" }),
    { code: "SOCIAL_TOKEN_INVALID" },
  );
  assert.equal(keys.calls.length, 1, "a refresh within a minute of the last fetch is not repeated");
  time += 61_000;
  await assert.rejects(
    client.verifyIdToken("google", jwt(claims(), { kid: "rotated" }), { nonce: "nonce-1" }),
    { code: "SOCIAL_TOKEN_INVALID" },
  );
  assert.equal(keys.calls.length, 2);
  const empty = createSocialAuthClient({
    settings: socialAuthSettings(ENV),
    fetchImpl: keyServer([]).fetchImpl,
    now: () => NOW,
  });
  await assert.rejects(empty.verifyIdToken("google", jwt(claims()), { nonce: "nonce-1" }), {
    code: "SOCIAL_BAD_RESPONSE",
  });
});

test("the code exchange sends the client credentials and reports a refused code", async () => {
  const sent = [];
  let status = 200;
  const client = createSocialAuthClient({
    settings: socialAuthSettings(ENV),
    now: () => NOW,
    fetchImpl: async (url, init) => {
      sent.push({
        url: String(url),
        form: Object.fromEntries(new URLSearchParams(String(init.body))),
      });
      return new Response(
        JSON.stringify(
          status === 200
            ? { id_token: "a.b.c", access_token: "access", refresh_token: "refresh" }
            : { error: "invalid_grant" },
        ),
        { status },
      );
    },
  });
  assert.deepEqual(
    await client.exchangeCode("google", {
      code: "code-1",
      redirectUri: "https://x.test/cb",
      codeVerifier: "verifier",
    }),
    { idToken: "a.b.c" },
    "only the ID token is kept",
  );
  assert.deepEqual(sent[0].form, {
    grant_type: "authorization_code",
    code: "code-1",
    redirect_uri: "https://x.test/cb",
    client_id: "google-client",
    client_secret: "google-secret",
    code_verifier: "verifier",
  });
  status = 400;
  await assert.rejects(
    client.exchangeCode("google", {
      code: "used",
      redirectUri: "https://x.test/cb",
      codeVerifier: "v",
    }),
    { code: "SOCIAL_CODE_REJECTED", status: 400 },
  );
  status = 503;
  await assert.rejects(
    client.exchangeCode("google", {
      code: "c",
      redirectUri: "https://x.test/cb",
      codeVerifier: "v",
    }),
    { code: "SOCIAL_UNAVAILABLE" },
  );
});

function serviceFor(settings) {
  const calls = { deleted: [] };
  const store = {
    async deleteExpiredSocialSignInData(now) {
      calls.deleted.push(now);
    },
  };
  const service = createSocialAuthService({
    store,
    settings,
    client: {},
    getAuth: () => ({}),
    trustedAuthOrigin: () => true,
    rateAllowed: () => true,
    http: { bodyForm: async () => ({}), redirect: () => {}, securityHeaders: () => ({}) },
    now: () => NOW,
  });
  return { service, calls };
}

test("cleanup removes expired sign-in states", async () => {
  const { service, calls } = serviceFor(socialAuthSettings(ENV));
  await service.cleanup();
  await service.cleanup(NOW + 5);
  assert.deepEqual(calls.deleted, [NOW, NOW + 5]);
});

test("the account page shows only the configured buttons, and every sign-in message is allowlisted for it", () => {
  const html =
    '<div class="social-sign-in" data-social-options hidden><button data-social="google" hidden></button></div>';
  const service = (env) => serviceFor(socialAuthSettings(env)).service;
  assert.equal(service({ NODE_ENV: "test" }).renderAccountPage(html), html);
  assert.equal(
    service(ENV).renderAccountPage(html),
    '<div class="social-sign-in" data-social-options><button data-social="google"></button></div>',
  );
  const { KNOWN_AUTH_ERRORS } = loadAccountLogicAllowlist();
  for (const message of SOCIAL_PAGE_MESSAGES)
    assert.ok(KNOWN_AUTH_ERRORS.includes(message), `account-logic.js shows: ${message}`);
});

function loadAccountLogicAllowlist() {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "public", "scripts", "account-logic.js"),
    "utf8",
  );
  const list = source.slice(
    source.indexOf("const KNOWN_AUTH_ERRORS"),
    source.indexOf("]);", source.indexOf("const KNOWN_AUTH_ERRORS")),
  );
  return { KNOWN_AUTH_ERRORS: [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]) };
}
