// @ts-check
"use strict";

// Polar AccessLink V4 client. V4 uses short-lived access tokens, rotating refresh tokens, granular scopes,
// and date-range data endpoints. It has no V3 user-registration, deregistration, or webhook API.

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_HEADROOM_MS = 5 * 60 * 1000;
const POLAR_SCOPES = Object.freeze([
  "sleep:read",
  "nightly_recharge:read",
  "continuous_samples:read",
  "training_sessions:read",
]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {string} code @param {string} message @param {number} [status] @param {Record<string,unknown>} [extra] */
function polarError(code, message, status = 502, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}
/** Releases the connection of a response STRATA will not read. @param {Response} response */
function discard(response) {
  void response.body?.cancel().catch(() => {});
}
/**
 * One number of a header such as "RateLimit-Usage: 50, 700", or null when it is missing.
 * @param {string|null} value
 * @param {number} index
 */
function headerNumber(value, index) {
  const part = String(value ?? "")
      .split(",")
      .at(index)
      ?.trim(),
    number = Number(part);
  return part && Number.isFinite(number) ? number : null;
}
/** @param {unknown} value */
function scopesOf(value) {
  return [
    ...new Set(
      String(value ?? "")
        .split(/\s+/)
        .filter(Boolean),
    ),
  ];
}
/** @param {string} value */
function validDate(value) {
  if (!DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
/** @param {string} value @param {number} days */
function addDays(value, days) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Parses the versioned object kept inside STRATA's sealed token field. Plain V3 tokens deliberately fail closed
 * so an upgraded deployment asks the member to reconnect and grant the V4 scopes.
 * @param {string} value
 */
function parsePolarCredentials(value) {
  let item;
  try {
    item = JSON.parse(value);
  } catch {
    throw polarError(
      "POLAR_V4_RECONNECT",
      "Reconnect Polar to upgrade this connection to AccessLink V4.",
      401,
    );
  }
  const accessToken = String(item?.accessToken ?? ""),
    refreshToken = String(item?.refreshToken ?? ""),
    expiresAt = Number(item?.expiresAt),
    scopes = scopesOf(Array.isArray(item?.scopes) ? item.scopes.join(" ") : item?.scopes);
  if (
    item?.version !== 4 ||
    !accessToken ||
    accessToken.length > 8192 ||
    !refreshToken ||
    refreshToken.length > 8192 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0 ||
    POLAR_SCOPES.some((scope) => !scopes.includes(scope))
  )
    throw polarError(
      "POLAR_V4_RECONNECT",
      "Reconnect Polar to upgrade this connection to AccessLink V4.",
      401,
    );
  return { version: 4, accessToken, refreshToken, expiresAt, scopes };
}
/** @param {{version:number,accessToken:string,refreshToken:string,expiresAt:number,scopes:string[]}} credentials */
function serializePolarCredentials(credentials) {
  const value = parsePolarCredentials(JSON.stringify(credentials));
  return JSON.stringify(value);
}

/**
 * @param {{settings:{polar:{clientId:string,clientSecret:string,authorizeUrl:string,tokenUrl:string,apiBase:string}},
 *   fetchImpl?:typeof fetch,now?:()=>number,timeoutMs?:number,headroom?:number}} options
 */
function createPolarClient({
  settings,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 15000,
  headroom = 0.8,
}) {
  const polar = settings.polar;
  let blockedUntil = 0;

  /** Stops before a window is used up: at 80% of either Polar window, wait for that window to reset. @param {Response} response */
  function observeLimits(response) {
    for (const index of [0, 1]) {
      const usage = headerNumber(response.headers.get("ratelimit-usage"), index),
        limit = headerNumber(response.headers.get("ratelimit-limit"), index),
        reset = headerNumber(response.headers.get("ratelimit-reset"), index);
      if (usage !== null && limit && reset !== null && usage >= limit * headroom)
        blockedUntil = Math.max(blockedUntil, now() + reset * 1000);
    }
    if (response.status === 429) {
      const wait =
        headerNumber(response.headers.get("retry-after"), 0) ??
        headerNumber(response.headers.get("ratelimit-reset"), 0) ??
        60;
      blockedUntil = Math.max(blockedUntil, now() + Math.max(1, wait) * 1000);
    }
  }
  /** @param {string} url @param {RequestInit} init */
  async function send(url, init) {
    if (now() < blockedUntil)
      throw polarError(
        "POLAR_RATE_LIMIT",
        "Polar asked STRATA to slow down. Syncing continues shortly.",
        503,
        { retryAt: blockedUntil },
      );
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = /** @type {Error} */ (error)?.name === "TimeoutError";
      throw polarError(
        timedOut ? "POLAR_TIMEOUT" : "POLAR_UNAVAILABLE",
        timedOut ? "Polar took too long to answer." : "Polar could not be reached.",
        503,
      );
    }
    observeLimits(response);
    return response;
  }
  /** @param {Response} response */
  function assertOk(response) {
    if (response.ok) return;
    discard(response);
    if (response.status === 401 || response.status === 403)
      throw polarError(
        "POLAR_AUTH",
        "Polar no longer accepts this connection. Reconnect Polar.",
        401,
      );
    if (response.status === 429)
      throw polarError(
        "POLAR_RATE_LIMIT",
        "Polar asked STRATA to slow down. Syncing continues shortly.",
        503,
        { retryAt: blockedUntil },
      );
    if (response.status >= 500)
      throw polarError("POLAR_UNAVAILABLE", "Polar is unavailable right now.", 503);
    throw polarError("POLAR_BAD_RESPONSE", `Polar answered with status ${response.status}.`, 502);
  }
  /** @param {Response} response */
  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      throw polarError("POLAR_BAD_RESPONSE", "Polar sent a response STRATA could not read.", 502);
    }
  }
  const clientAuthorization = () =>
    `Basic ${Buffer.from(`${polar.clientId}:${polar.clientSecret}`).toString("base64")}`;
  /** @param {string} token @param {string} path */
  async function memberRead(token, path) {
    const response = await send(`${polar.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (response.status === 204) {
      discard(response);
      return null;
    }
    assertOk(response);
    return readJson(response);
  }
  /** @param {string} path @param {string} from @param {string} to @param {number} maxDays @param {string[]} [features] */
  function rangedPath(path, from, to, maxDays, features = []) {
    const start = Date.parse(`${from}T00:00:00Z`),
      end = Date.parse(`${to}T00:00:00Z`),
      days = (end - start) / DAY_MS;
    if (!validDate(from) || !validDate(to) || !Number.isInteger(days) || days < 1 || days > maxDays)
      throw polarError("POLAR_RANGE", "Polar data dates are outside the supported range.", 400);
    const query = new URLSearchParams({ from, to });
    for (const feature of features) query.append("features", feature);
    return `${path}?${query}`;
  }
  /** @param {any} body @param {(value:any)=>boolean} valid */
  function validBody(body, valid) {
    if (body === null) return null;
    if (!valid(body))
      throw polarError("POLAR_BAD_RESPONSE", "Polar sent an incomplete data response.", 502);
    return body;
  }
  /** @param {any} body @param {any|null} previous */
  function tokenCredentials(body, previous) {
    const accessToken = String(body?.access_token ?? ""),
      refreshToken = String(body?.refresh_token ?? previous?.refreshToken ?? ""),
      expiresIn = Number(body?.expires_in),
      tokenType = String(body?.token_type ?? "bearer");
    const scopes = scopesOf(body?.scope ?? previous?.scopes?.join(" ")),
      complete = POLAR_SCOPES.every((scope) => scopes.includes(scope));
    if (
      !accessToken ||
      accessToken.length > 8192 ||
      !refreshToken ||
      refreshToken.length > 8192 ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0 ||
      !/^bearer$/i.test(tokenType) ||
      !complete
    )
      throw polarError("POLAR_BAD_RESPONSE", "Polar sent an incomplete sign-in response.", 502);
    return parsePolarCredentials(
      JSON.stringify({
        version: 4,
        accessToken,
        refreshToken,
        expiresAt: now() + Math.floor(expiresIn * 1000),
        scopes,
      }),
    );
  }

  return {
    /** @param {{state:string,redirectUri:string}} options */
    authorizeUrl({ state, redirectUri }) {
      const url = new URL(polar.authorizeUrl);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: polar.clientId,
        redirect_uri: redirectUri,
        scope: POLAR_SCOPES.join(" "),
        state,
      }).toString();
      return url.toString();
    },
    /** @param {string} code @param {string} redirectUri */
    async exchangeCode(code, redirectUri) {
      const response = await send(polar.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: clientAuthorization(),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      if (response.status === 400 || response.status === 401) {
        discard(response);
        throw polarError(
          "POLAR_CODE_REJECTED",
          "Polar did not accept this sign-in. Start connecting again.",
          400,
        );
      }
      assertOk(response);
      return tokenCredentials(await readJson(response), null);
    },
    /** @param {{version:number,accessToken:string,refreshToken:string,expiresAt:number,scopes:string[]}} input */
    async refreshCredentials(input) {
      const credentials = parsePolarCredentials(JSON.stringify(input));
      if (credentials.expiresAt > now() + REFRESH_HEADROOM_MS)
        return { credentials, refreshed: false };
      const response = await send(polar.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: clientAuthorization(),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
        }).toString(),
      });
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        discard(response);
        throw polarError(
          "POLAR_AUTH",
          "Polar no longer accepts this connection. Reconnect Polar.",
          401,
        );
      }
      assertOk(response);
      return {
        credentials: tokenCredentials(await readJson(response), credentials),
        refreshed: true,
      };
    },
    /**
     * Sleep details require one V4 request per date after the range listing.
     * @param {string} token
     * @param {string} from
     * @param {string} to
     */
    async sleep(token, from, to) {
      const listed = validBody(
        await memberRead(token, rangedPath("/sleeps", from, to, 30)),
        (body) => Array.isArray(body?.nightSleeps),
      );
      if (listed === null) return null;
      const dates = [
          ...new Set(
            listed.nightSleeps
              .map((/** @type {any} */ item) => String(item?.sleepDate ?? ""))
              .filter(validDate),
          ),
        ],
        nightSleeps = [];
      for (const date of dates) {
        const body = validBody(
          await memberRead(
            token,
            rangedPath("/sleeps", date, addDays(date, 1), 1, [
              "sleep-result",
              "sleep-evaluation",
              "sleep-score",
            ]),
          ),
          (item) => Array.isArray(item?.nightSleeps),
        );
        if (body) nightSleeps.push(...body.nightSleeps);
      }
      return { nightSleeps };
    },
    /** @param {string} token @param {string} from @param {string} to */
    async nightlyRecharge(token, from, to) {
      return validBody(
        await memberRead(token, rangedPath("/nightly-recharge-results", from, to, 28)),
        (body) => Array.isArray(body?.nightlyRechargeResults?.nightlyRechargeResults),
      );
    },
    /** @param {string} token @param {string} from @param {string} to */
    async heartRate(token, from, to) {
      return validBody(
        await memberRead(
          token,
          rangedPath("/continuous-samples", from, to, 30, ["heart-rate-samples"]),
        ),
        (body) => Array.isArray(body?.continuousSamples?.heartRateSamplesPerDay),
      );
    },
    /** @param {string} token @param {string} from @param {string} to */
    async exercises(token, from, to) {
      return validBody(
        await memberRead(token, rangedPath("/training-sessions/list", from, to, 90)),
        (body) => Array.isArray(body?.trainingSessions),
      );
    },
    blockedUntil: () => blockedUntil,
  };
}

module.exports = {
  POLAR_SCOPES,
  createPolarClient,
  parsePolarCredentials,
  polarError,
  serializePolarCredentials,
};
