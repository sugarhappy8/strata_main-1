// @ts-check
"use strict";

// Asks Google Play about Strata+ subscriptions bought in the Android app. A purchase token from the app is opaque, so
// STRATA reads the subscription's state from the Google Play Developer API (purchases.subscriptionsv2.get) and
// acknowledges a new purchase there (Google refunds one left unacknowledged for three days). It signs in as the Play
// Console service account in GOOGLE_PLAY_SERVICE_ACCOUNT: a short-lived OAuth token from a JWT signed with the
// account's key (RS256). No dependencies: node:crypto signs, and fetch talks to Google over HTTPS only.
const { createSign } = require("node:crypto");

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const TOKEN_LIFETIME_S = 3600;
const TOKEN_MARGIN_MS = 60_000;
const TIMEOUT_MS = 10_000;
const MAX_PURCHASE_TOKEN = 1024;
const EMAIL = /^[^\s@]{1,200}@[a-z0-9.-]{1,200}\.iam\.gserviceaccount\.com$/i;

/** @param {string} code @param {string} message @param {number} status */
function playError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

/** @param {string|Buffer} value */
const base64url = (value) => Buffer.from(value).toString("base64url");

/**
 * The service account in GOOGLE_PLAY_SERVICE_ACCOUNT: its JSON key, as downloaded or base64-encoded. Only the fields
 * STRATA uses are kept, and its token endpoint must be Google's. Throws a TypeError for anything else.
 * @param {unknown} raw
 * @returns {import("./domain-types").GooglePlayServiceAccount|null}
 */
function parseServiceAccount(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf8"));
  } catch {
    throw new TypeError("GOOGLE_PLAY_SERVICE_ACCOUNT must be the service account's JSON key.");
  }
  const clientEmail = String(value?.client_email || ""),
    privateKey = String(value?.private_key || ""),
    tokenUri = String(value?.token_uri || DEFAULT_TOKEN_URI);
  let tokenHost = "";
  try {
    const url = new URL(tokenUri);
    tokenHost = url.protocol === "https:" ? url.hostname : "";
  } catch {
    /* Reported below. */
  }
  if (
    value?.type !== "service_account" ||
    !EMAIL.test(clientEmail) ||
    !/-----BEGIN PRIVATE KEY-----/.test(privateKey) ||
    !/(^|\.)googleapis\.com$/.test(tokenHost)
  )
    throw new TypeError(
      "GOOGLE_PLAY_SERVICE_ACCOUNT must be a Google service account key (type, client_email, private_key).",
    );
  return Object.freeze({
    clientEmail,
    privateKey,
    privateKeyId: String(value.private_key_id || ""),
    tokenUri,
  });
}

/**
 * @param {{serviceAccount:import("./domain-types").GooglePlayServiceAccount,fetchImpl?:typeof fetch,now?:()=>number,timeoutMs?:number}} options
 * @returns {import("./domain-types").GooglePlayApi}
 */
function createGooglePlayApi({
  serviceAccount,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = TIMEOUT_MS,
}) {
  /** @type {{value:string,expiresAt:number}|null} */
  let cached = null;
  /** @type {Promise<string>|null} */
  let pending = null;

  /** @param {string} url @param {RequestInit} init */
  async function send(url, init) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = /** @type {Error} */ (error)?.name === "TimeoutError";
      throw playError(
        "GOOGLE_PLAY_UNAVAILABLE",
        timedOut ? "Google Play took too long to answer." : "Google Play could not be reached.",
        503,
      );
    }
  }

  async function signIn() {
    const issued = Math.floor(now() / 1000);
    const header = {
      alg: "RS256",
      typ: "JWT",
      ...(serviceAccount.privateKeyId ? { kid: serviceAccount.privateKeyId } : {}),
    };
    const claims = {
      iss: serviceAccount.clientEmail,
      scope: SCOPE,
      aud: serviceAccount.tokenUri,
      iat: issued,
      exp: issued + TOKEN_LIFETIME_S,
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    let signature;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.privateKey);
    } catch {
      throw playError(
        "GOOGLE_PLAY_NOT_CONFIGURED",
        "The Google Play service account key is unusable.",
        503,
      );
    }
    const response = await send(serviceAccount.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64url(signature)}`,
      }).toString(),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.access_token !== "string")
      throw playError(
        response.status >= 500 ? "GOOGLE_PLAY_UNAVAILABLE" : "GOOGLE_PLAY_NOT_CONFIGURED",
        "Google did not accept STRATA's Play Console service account.",
        503,
      );
    const lifetime =
      Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : TOKEN_LIFETIME_S * 1000;
    cached = { value: data.access_token, expiresAt: now() + lifetime - TOKEN_MARGIN_MS };
    return cached.value;
  }

  /** One sign-in at a time; the token is reused until a minute before it expires. */
  async function accessToken() {
    if (cached && cached.expiresAt > now()) return cached.value;
    pending ??= signIn().finally(() => {
      pending = null;
    });
    return pending;
  }

  /** @param {string} url @param {RequestInit} [init] */
  async function call(url, init = {}) {
    const token = await accessToken();
    const response = await send(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    if (response.status === 401) cached = null;
    return response;
  }

  /** @param {string} packageName @param {string} purchaseToken */
  function tokenPath(packageName, purchaseToken) {
    if (!purchaseToken || purchaseToken.length > MAX_PURCHASE_TOKEN || /[\s/]/.test(purchaseToken))
      throw playError(
        "GOOGLE_PLAY_PURCHASE_INVALID",
        "This is not a Google Play purchase token.",
        400,
      );
    return `${API_ROOT}/${encodeURIComponent(packageName)}`;
  }

  // 400 (a token Google rejects as malformed), 404, and 410 (a purchase too old to read) will not get better by asking
  // again; Pub/Sub and the purchase route treat them as an invalid purchase rather than an outage.
  /** @param {Response} response */
  function failure(response) {
    if (response.status === 400 || response.status === 404 || response.status === 410)
      return playError(
        "GOOGLE_PLAY_PURCHASE_INVALID",
        "Google Play does not know this purchase for STRATA.",
        400,
      );
    if (response.status === 401 || response.status === 403)
      return playError(
        "GOOGLE_PLAY_NOT_CONFIGURED",
        "STRATA's Play Console service account cannot read this app's purchases.",
        503,
      );
    return playError("GOOGLE_PLAY_UNAVAILABLE", "Google Play is unavailable right now.", 503);
  }

  return Object.freeze({
    /** The subscription as Google Play has it now (SubscriptionPurchaseV2). @param {string} packageName @param {string} purchaseToken */
    async subscription(packageName, purchaseToken) {
      const response = await call(
        `${tokenPath(packageName, purchaseToken)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
      );
      if (!response.ok) throw failure(response);
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw playError("GOOGLE_PLAY_UNAVAILABLE", "Google Play sent an unreadable answer.", 503);
      return data;
    },
    /**
     * Acknowledges a purchase; acknowledging one twice is not an error.
     * @param {string} packageName @param {string} productId @param {string} purchaseToken
     */
    async acknowledge(packageName, productId, purchaseToken) {
      const response = await call(
        `${tokenPath(packageName, purchaseToken)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      if (!response.ok && response.status !== 409) throw failure(response);
    },
  });
}

module.exports = { createGooglePlayApi, parseServiceAccount };
