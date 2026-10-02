// @ts-check
"use strict";

// OpenID Connect for Google: the authorization address (with PKCE), the code exchange, and the ID-token
// check. Every ID token is verified here against the provider's published RS256 keys (signature, issuer, audience,
// expiry, and the nonce STRATA sent), so nothing a browser carries back is trusted on its own.

const { createHash, createPublicKey, verify } = require("node:crypto");
const { sameSecret } = require("./devices-crypto");

const KEYS_TTL_MS = 6 * 60 * 60 * 1000;
const KEYS_REFRESH_MS = 60 * 1000;
const SKEW_SECONDS = 120;
const MAX_TOKEN_LENGTH = 16384;

/** @param {string} code @param {string} message @param {number} [status] */
function socialError(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}
/** Releases the connection of a response STRATA will not read. @param {Response} response */
function discard(response) {
  void response.body?.cancel().catch(() => {});
}
/** @param {string} part */
function decodeSegment(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}
/** The PKCE S256 challenge for a verifier. @param {string} verifier */
function codeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}
/** @param {unknown} value */
function text(value) {
  return typeof value === "string" ? value : "";
}

/**
 * @param {{settings:ReturnType<typeof import("./social-auth-config").socialAuthSettings>,fetchImpl?:typeof fetch,now?:()=>number,timeoutMs?:number}} options
 */
function createSocialAuthClient({
  settings,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 10000,
}) {
  /** @type {Map<string,{keys:Map<string,import("node:crypto").KeyObject>,fetchedAt:number}>} */
  const keyCache = new Map();

  /** @param {import("./social-auth-config").SocialProviderId} id */
  function providerFor(id) {
    const provider = settings.providers[id];
    if (!provider?.configured)
      throw socialError(
        "SOCIAL_NOT_CONFIGURED",
        "This sign-in option is not available right now.",
        503,
      );
    return provider;
  }
  /** @param {string} name @param {string} url @param {RequestInit} init */
  async function send(name, url, init) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = /** @type {Error} */ (error)?.name === "TimeoutError";
      throw socialError(
        timedOut ? "SOCIAL_TIMEOUT" : "SOCIAL_UNAVAILABLE",
        `${name} took too long to answer or could not be reached.`,
        503,
      );
    }
  }
  /** @param {string} name @param {Response} response */
  async function readJson(name, response) {
    if (!response.ok) {
      discard(response);
      throw socialError(
        response.status >= 500 ? "SOCIAL_UNAVAILABLE" : "SOCIAL_BAD_RESPONSE",
        `${name} answered with status ${response.status}.`,
        response.status >= 500 ? 503 : 502,
      );
    }
    try {
      return await response.json();
    } catch {
      throw socialError("SOCIAL_BAD_RESPONSE", `${name} sent a response STRATA could not read.`);
    }
  }

  /** The provider's current signing keys, fetched again when stale or when a token names an unknown key. @param {ReturnType<typeof providerFor>} provider @param {boolean} refresh */
  async function signingKeys(provider, refresh) {
    const cached = keyCache.get(provider.id),
      time = now();
    if (
      cached &&
      (refresh ? time - cached.fetchedAt < KEYS_REFRESH_MS : time - cached.fetchedAt < KEYS_TTL_MS)
    )
      return cached.keys;
    const body = await readJson(
      provider.name,
      await send(provider.name, provider.jwksUrl, { headers: { Accept: "application/json" } }),
    );
    /** @type {Map<string,import("node:crypto").KeyObject>} */
    const keys = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (
        jwk?.kty !== "RSA" ||
        typeof jwk.kid !== "string" ||
        (jwk.use && jwk.use !== "sig") ||
        (jwk.alg && jwk.alg !== "RS256")
      )
        continue;
      try {
        keys.set(
          jwk.kid,
          createPublicKey({
            key: { kty: "RSA", n: String(jwk.n), e: String(jwk.e) },
            format: "jwk",
          }),
        );
      } catch {
        /* Skip a key Node cannot read. */
      }
    }
    if (!keys.size)
      throw socialError(
        "SOCIAL_BAD_RESPONSE",
        `${provider.name} published no usable signing keys.`,
      );
    keyCache.set(provider.id, { keys, fetchedAt: time });
    return keys;
  }

  return Object.freeze({
    /**
     * @param {import("./social-auth-config").SocialProviderId} id
     * @param {{state:string,nonce:string,codeVerifier:string,redirectUri:string}} request
     */
    authorizeUrl(id, { state, nonce, codeVerifier, redirectUri }) {
      const provider = providerFor(id),
        url = new URL(provider.authorizeUrl);
      const query = new URLSearchParams({
        response_type: "code",
        client_id: provider.clientId,
        redirect_uri: redirectUri,
        scope: provider.scope,
        state,
        nonce,
      });
      query.set("code_challenge", codeChallenge(codeVerifier));
      query.set("code_challenge_method", "S256");
      query.set("prompt", "select_account");
      url.search = query.toString();
      return url.toString();
    },
    /**
     * @param {import("./social-auth-config").SocialProviderId} id
     * @param {{code:string,redirectUri:string,codeVerifier:string}} request
     */
    async exchangeCode(id, { code, redirectUri, codeVerifier }) {
      const provider = providerFor(id);
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: codeVerifier,
      });
      const response = await send(provider.name, provider.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
      });
      if (response.status === 400 || response.status === 401) {
        discard(response);
        throw socialError(
          "SOCIAL_CODE_REJECTED",
          `${provider.name} did not accept this sign-in. Try again.`,
          400,
        );
      }
      const body = await readJson(provider.name, response);
      const idToken = text(body?.id_token);
      if (!idToken || idToken.length > MAX_TOKEN_LENGTH)
        throw socialError(
          "SOCIAL_BAD_RESPONSE",
          `${provider.name} sent an incomplete sign-in response.`,
        );
      return { idToken };
    },
    /**
     * Verifies an ID token and returns its claims.
     * @param {import("./social-auth-config").SocialProviderId} id @param {string} idToken @param {{nonce:string}} expected
     * @returns {Promise<Record<string,unknown>>}
     */
    async verifyIdToken(id, idToken, { nonce }) {
      const provider = providerFor(id),
        parts = String(idToken).split(".");
      const invalid = () =>
        socialError(
          "SOCIAL_TOKEN_INVALID",
          `${provider.name} sent a sign-in STRATA could not verify. Try again.`,
          400,
        );
      if (parts.length !== 3 || idToken.length > MAX_TOKEN_LENGTH) throw invalid();
      let header, claims;
      try {
        header = decodeSegment(parts[0] || "");
        claims = decodeSegment(parts[1] || "");
      } catch {
        throw invalid();
      }
      if (
        header?.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        !claims ||
        typeof claims !== "object" ||
        Array.isArray(claims)
      )
        throw invalid();
      const key =
        (await signingKeys(provider, false)).get(header.kid) ||
        (await signingKeys(provider, true)).get(header.kid);
      if (
        !key ||
        !verify(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          key,
          Buffer.from(parts[2] || "", "base64url"),
        )
      )
        throw invalid();
      const time = Math.floor(now() / 1000),
        audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        !provider.issuers.includes(claims.iss) ||
        !audience.includes(provider.clientId) ||
        (audience.length > 1 && claims.azp !== provider.clientId)
      )
        throw invalid();
      if (!(Number(claims.exp) > time - SKEW_SECONDS) || Number(claims.iat) > time + SKEW_SECONDS)
        throw invalid();
      if (!(typeof claims.nonce === "string" && sameSecret(claims.nonce, nonce))) throw invalid();
      if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw invalid();
      return claims;
    },
  });
}

module.exports = { codeChallenge, createSocialAuthClient, socialError };
