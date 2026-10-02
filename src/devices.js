// @ts-check
"use strict";

// Connected devices for Strata+ members, starting with Polar. Each member connects their own Polar account to
// their own STRATA account; STRATA keeps its own copy of their recovery, sleep, heart rate, and workouts and
// shows them compared with the member's usual nights. Polar tokens are sealed at rest and never leave the server.
//
// Sign-in cookies are SameSite=Strict, so they are not sent when Polar redirects the member back. The callback
// therefore only parks the one-time code in a short-lived cookie scoped to /api/devices/polar/complete, and the
// Account page finishes the connection with a same-site request that carries the session which started it.

const { randomId, seal, sha256 } = require("./devices-crypto");
const { devicesSettings } = require("./devices-config");
const { createDeviceSync } = require("./devices-sync");
const { createPolarClient, serializePolarCredentials } = require("./polar-client");
const { addDays, daysBetween, todaySummary, trendSummary } = require("./wellness-core");

const PROVIDER = "polar";
const CONSENT_VERSION = "2026-10-polar-v4";
const RETURN_COOKIE = "strata_device_return";
const STATE_TTL_MS = 10 * 60 * 1000;
const SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE = /^[A-Za-z0-9_-]{43}$/;

/** @param {string} code @param {string} message @param {number} [status] @param {Record<string,unknown>} [extra] */
function deviceError(code, message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}
/** @param {unknown} value */
function num(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
/** @param {number} time */
const isoDate = (time) => new Date(time).toISOString().slice(0, 10);

/** @param {any} row */
function settingsOf(row) {
  try {
    const value = JSON.parse(String(row?.settings_json || "{}"));
    return { recoverySuggestions: value?.recoverySuggestions !== false };
  } catch {
    return { recoverySuggestions: true };
  }
}
/** What the browser may know about a connection: never the token, member reference, or Polar user id. @param {any} row */
function publicConnection(row) {
  if (!row) return null;
  return {
    provider: String(row.provider),
    status: String(row.status),
    connectedAt: num(row.connected_at),
    lastSyncAt: num(row.last_sync_at),
    syncedThrough: row.synced_through || null,
    lastError: row.last_error || null,
    settings: settingsOf(row),
    revision: num(row.revision),
    importing: row.status === "active" && !row.last_sync_at,
  };
}

/**
 * @param {{store:any,auth:{requireSession:Function,validCsrf:Function},requireAccess:(req:any,res:any)=>Promise<any>,trustedOrigin:(req:any)=>boolean,
 *   rateAllowed:(req:any,key:string,max:number,windowMs:number)=>boolean|Promise<boolean>,http:{json:Function,bodyJson:Function,redirect:Function},
 *   settings:ReturnType<typeof devicesSettings>,hasAccess:(userId:string)=>Promise<boolean>,logger?:{info?:Function,warn?:Function,error?:Function}|null,
 *   now?:()=>number,polar?:any,sync?:any,fetchImpl?:typeof fetch,isUniqueViolation?:(error:unknown)=>boolean,events?:import("./domain-types").EventBus|null}} dependencies
 */
function createDevicesService({
  store,
  auth,
  requireAccess,
  trustedOrigin,
  rateAllowed,
  http,
  settings,
  hasAccess,
  logger = null,
  now = Date.now,
  polar = null,
  sync = null,
  fetchImpl,
  isUniqueViolation,
  events = null,
}) {
  if (
    !store ||
    !auth ||
    typeof requireAccess !== "function" ||
    typeof trustedOrigin !== "function" ||
    typeof rateAllowed !== "function" ||
    !http ||
    !settings ||
    typeof hasAccess !== "function"
  )
    throw new TypeError(
      "Connected devices require storage, access guards, rate limiting, HTTP helpers, settings, and access checks.",
    );
  const { json, bodyJson, redirect } = http;
  const client = polar || createPolarClient({ settings, now, ...(fetchImpl ? { fetchImpl } : {}) });
  const worker =
    sync ||
    createDeviceSync({
      store,
      polar: client,
      keys: settings.keys,
      hasAccess,
      logger,
      now,
      intervalMs: settings.syncIntervalMs,
      events,
      locks: typeof store.acquireLock === "function" ? store : null,
    });
  const uniqueViolation =
    isUniqueViolation ||
    ((/** @type {any} */ error) => /UNIQUE constraint failed/i.test(String(error?.message || "")));

  /** @param {any} req @param {any} session */
  function validMutation(req, session) {
    if (!trustedOrigin(req))
      throw deviceError(
        "DEVICES_ORIGIN_REQUIRED",
        "Security check failed. Refresh and try again.",
        403,
      );
    if (!auth.validCsrf(req, session))
      throw deviceError("INVALID_CSRF", "Security check failed. Refresh and try again.", 403);
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || "")))
      throw deviceError("JSON_REQUIRED", "Connected-device requests must use JSON.", 415);
  }
  /** @param {any} req @param {any} session @param {string[]} allowed */
  async function readInput(req, session, allowed) {
    validMutation(req, session);
    const input = await bodyJson(req),
      extra = Object.keys(input).filter((key) => ![...allowed, "expectedUserId"].includes(key));
    if (extra.length)
      throw deviceError(
        "DEVICES_INVALID_REQUEST",
        `Request contains unsupported fields: ${extra.join(", ")}.`,
      );
    if (input.expectedUserId !== undefined && String(input.expectedUserId) !== String(session.id))
      throw deviceError(
        "DEVICES_ACCOUNT_CHANGED",
        "Your account changed. Reload before changing connected devices.",
        409,
      );
    return input;
  }
  /** @param {any} req @param {string} name */
  function cookie(req, name) {
    for (const part of String(req.headers.cookie || "").split(";")) {
      const index = part.indexOf("=");
      if (index > 0 && part.slice(0, index).trim() === name) {
        try {
          return decodeURIComponent(part.slice(index + 1).trim());
        } catch {
          return "";
        }
      }
    }
    return "";
  }
  /** @param {string} value @param {number} maxAge */
  function returnCookie(value, maxAge) {
    const parts = [
      `${RETURN_COOKIE}=${encodeURIComponent(value)}`,
      "Path=/api/devices/polar/complete",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
    ];
    if (settings.secureCookies) parts.push("Secure");
    return parts.join("; ");
  }
  /** Outside production the redirect may follow the request host, so a local test needs no extra settings. @param {any} req */
  function redirectUriFor(req) {
    if (settings.polar.redirectUri) return settings.polar.redirectUri;
    const protocol =
      String(req.headers["x-forwarded-proto"] || "http")
        .split(",")[0]
        ?.trim() || "http";
    return `${protocol}://${req.headers.host}/api/devices/polar/callback`;
  }
  /** The member's own date when the browser sends it (within a day of UTC), otherwise today in UTC. @param {URL} url */
  function todayFor(url) {
    const requested = String(url.searchParams.get("date") || ""),
      utc = isoDate(now());
    return /^\d{4}-\d{2}-\d{2}$/.test(requested) && Math.abs(daysBetween(utc, requested)) <= 1
      ? requested
      : utc;
  }
  /** V4 has no remote deregistration endpoint; deleting the sealed credentials ends STRATA's access. @param {string} userId */
  async function releaseConnection(userId) {
    const removed = await store.deleteDeviceData(userId, PROVIDER);
    if (!removed) return false;
    await events?.emit("polar.data_deleted", { userId, provider: PROVIDER });
    logger?.info?.("device.disconnected", { provider: PROVIDER });
    return true;
  }
  /** @param {any} row */
  function startImport(row) {
    void Promise.resolve(worker.syncConnection(row)).catch((error) =>
      logger?.error?.("device.sync_start_failed", { error }),
    );
  }

  /** @param {any} req @param {any} res @param {any} session */
  async function connect(req, res, session) {
    await readInput(req, session, []);
    if (!settings.configured)
      throw deviceError("DEVICES_NOT_CONFIGURED", "Polar is not set up on this server yet.", 503);
    if (!(await rateAllowed(req, `identity:devices:connect:${session.id}`, 10, 15 * 60 * 1000)))
      throw deviceError(
        "DEVICES_RATE_LIMIT",
        "Too many connection attempts. Wait a few minutes.",
        429,
      );
    const state = randomId(32),
      time = now(),
      redirectUri = redirectUriFor(req);
    const saved = await store.insertDeviceConnectState({
      stateHash: sha256(state),
      userId: String(session.id),
      provider: PROVIDER,
      sessionHash: String(session.token_hash || ""),
      redirectUri,
      createdAt: time,
      expiresAt: time + STATE_TTL_MS,
    });
    if (!saved)
      throw deviceError(
        "DEVICES_ACCOUNT_CHANGED",
        "Your account changed. Reload before connecting Polar.",
        409,
      );
    json(res, 200, {
      authorizeUrl: client.authorizeUrl({ state, redirectUri }),
      csrfToken: session.csrf_token,
    });
  }

  /** Polar sends the member back here. No session cookie arrives, so nothing is linked yet. @param {any} req @param {any} res @param {URL} url */
  async function callback(req, res, url) {
    const state = String(url.searchParams.get("state") || ""),
      code = String(url.searchParams.get("code") || ""),
      problem = url.searchParams.get("error");
    /** @param {string} outcome @param {Record<string,string>} [headers] */
    const back = (outcome, headers = {}) =>
      redirect(res, `/account.html?devices=${outcome}#connectedDevices`, headers);
    if (!STATE.test(state) || !(await rateAllowed(req, "devices:callback", 30, 15 * 60 * 1000))) {
      back("polar-failed");
      return;
    }
    const pending = await store.readDeviceConnectState(sha256(state)),
      time = now();
    if (!pending || pending.used_at != null || Number(pending.expires_at) <= time) {
      back("polar-expired");
      return;
    }
    if (problem || !code) {
      await store.discardDeviceConnectState(sha256(state), time);
      back(problem === "access_denied" ? "polar-declined" : "polar-failed");
      return;
    }
    if (code.length > 512 || !/^[\x21-\x7e]+$/.test(code)) {
      back("polar-failed");
      return;
    }
    back("polar-return", {
      "Set-Cookie": returnCookie(`${state}.${code}`, Math.round(STATE_TTL_MS / 1000)),
    });
  }

  /** @param {any} req @param {any} res @param {any} session */
  async function complete(req, res, session) {
    await readInput(req, session, []);
    const clear = { "Set-Cookie": returnCookie("", 0) },
      userId = String(session.id);
    /** @param {number} status @param {string} code @param {string} message */
    const fail = (status, code, message) => json(res, status, { error: message, code }, clear);
    const saved = cookie(req, RETURN_COOKIE),
      dot = saved.indexOf("."),
      state = dot > 0 ? saved.slice(0, dot) : "",
      code = dot > 0 ? saved.slice(dot + 1) : "";
    const expired =
      "This Polar connection request expired or was started in another sign-in. Connect Polar again.";
    if (!STATE.test(state) || !code) {
      fail(409, "DEVICES_CONNECT_EXPIRED", expired);
      return;
    }
    const pending = await store.consumeDeviceConnectState(
      sha256(state),
      userId,
      String(session.token_hash || ""),
      now(),
    );
    if (!pending) {
      fail(409, "DEVICES_CONNECT_EXPIRED", expired);
      return;
    }
    /** Polar failures while connecting become answers the Account page can show; a sign-in problem is not the member's session. @param {unknown} error */
    const polarFailed = (error) => {
      const failure = /** @type {any} */ (error);
      if (!String(failure?.code || "").startsWith("POLAR_")) throw error;
      if (failure.code === "POLAR_CODE_REJECTED") fail(400, failure.code, failure.message);
      else fail(503, failure.code, "Polar could not be reached. Try connecting again.");
    };
    let credentials;
    try {
      credentials = await client.exchangeCode(code, String(pending.redirect_uri));
    } catch (error) {
      polarFailed(error);
      return;
    }
    const current = await store.deviceConnection(userId, PROVIDER);
    // V4 exposes no stable account identifier. Every completed authorization gets a local connection id, and an
    // earlier connection's imported rows are cleared so data from two Polar accounts can never mix.
    if (current) {
      await store.deleteDeviceData(userId, PROVIDER);
      await events?.emit("polar.data_deleted", { userId, provider: PROVIDER });
    }
    const time = now(),
      providerUserId = randomId(16),
      memberRef = randomId(16);
    let row;
    try {
      row = await store.upsertDeviceConnection({
        userId,
        provider: PROVIDER,
        providerUserId,
        memberRef,
        tokenSealed: seal(settings.keys, serializePolarCredentials(credentials)),
        tokenExpiresAt: credentials.expiresAt,
        settingsJson: JSON.stringify(settingsOf(current)),
        consentVersion: CONSENT_VERSION,
        connectedAt: time,
        nextSyncAt: time + 10 * 60 * 1000,
        updatedAt: time,
      });
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      fail(
        409,
        "DEVICES_CONNECT_CONFLICT",
        "The connection changed while Polar was linking. Start again.",
      );
      return;
    }
    if (!row) {
      fail(409, "DEVICES_ACCOUNT_CHANGED", "Your account changed. Reload before connecting Polar.");
      return;
    }
    logger?.info?.("device.connected", { provider: PROVIDER });
    startImport(row);
    json(
      res,
      200,
      { connection: { ...publicConnection(row), importing: true }, csrfToken: session.csrf_token },
      clear,
    );
  }

  /** @param {any} req @param {any} res @param {any} session */
  async function syncNow(req, res, session) {
    await readInput(req, session, []);
    const row = await store.deviceConnection(String(session.id), PROVIDER);
    if (!row) throw deviceError("DEVICES_NOT_CONNECTED", "Connect Polar first.", 404);
    if (row.status !== "active")
      throw deviceError("DEVICES_RECONNECT", "Reconnect Polar first.", 409);
    const last = num(row.last_sync_at);
    if (last !== null && now() - last < SYNC_COOLDOWN_MS)
      throw deviceError(
        "DEVICES_SYNC_TOO_SOON",
        "Polar was synced a moment ago. Try again in a few minutes.",
        429,
        { retryAt: last + SYNC_COOLDOWN_MS },
      );
    startImport(row);
    json(res, 202, {
      connection: { ...publicConnection(row), importing: true },
      csrfToken: session.csrf_token,
    });
  }

  /** @param {any} req @param {any} res @param {any} session */
  async function saveSettings(req, res, session) {
    const input = await readInput(req, session, ["provider", "settings", "expectedRevision"]),
      value = input.settings;
    if (
      input.provider !== PROVIDER ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "recoverySuggestions") ||
      typeof value.recoverySuggestions !== "boolean"
    )
      throw deviceError(
        "DEVICES_INVALID_REQUEST",
        "Choose whether recovery can suggest lighter sessions.",
      );
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw deviceError(
        "DEVICES_INVALID_REQUEST",
        "Settings need the revision they were based on.",
      );
    const row = await store.updateDeviceSettings(
      String(session.id),
      PROVIDER,
      JSON.stringify({ recoverySuggestions: value.recoverySuggestions }),
      input.expectedRevision,
      now(),
    );
    if (!row)
      throw deviceError(
        "DEVICES_CHANGED",
        "Your connected-device settings changed in another tab. Reload and try again.",
        409,
      );
    json(res, 200, { connection: publicConnection(row), csrfToken: session.csrf_token });
  }

  /** @param {any} res @param {any} session @param {URL} url */
  async function wellness(res, session, url) {
    const userId = String(session.id),
      row = await store.deviceConnection(userId, PROVIDER),
      today = todayFor(url);
    if (!row) {
      json(res, 200, {
        configured: settings.configured,
        connected: false,
        connection: null,
        csrfToken: session.csrf_token,
      });
      return;
    }
    const base = {
      configured: settings.configured,
      connected: true,
      connection: publicConnection(row),
      today,
      csrfToken: session.csrf_token,
    };
    if (url.pathname === "/api/wellness/today") {
      const nights = await store.wellnessNights(
          userId,
          PROVIDER,
          addDays(today, -40),
          addDays(today, 1),
        ),
        days = await store.wellnessDays(userId, PROVIDER, addDays(today, -1), addDays(today, 1));
      const summary = /** @type {any} */ (todaySummary({ nights, days, today }));
      if (!settingsOf(row).recoverySuggestions)
        summary.lighterSession = { offer: false, reason: null, note: summary.lighterSession.note };
      json(res, 200, { ...base, summary });
      return;
    }
    if (url.pathname === "/api/wellness/workouts") {
      const days = Math.min(
        90,
        Math.max(1, Math.floor(Number(url.searchParams.get("days")) || 30)),
      );
      const rows = await store.wellnessWorkouts(
        userId,
        PROVIDER,
        now() - days * DAY_MS,
        now() + DAY_MS,
      );
      json(res, 200, {
        ...base,
        workouts: rows.map((/** @type {any} */ item) => ({
          startedAt: num(item.started_at),
          durationSeconds: num(item.duration_seconds),
          sport: String(item.sport),
          calories: num(item.calories),
          hrAvg: num(item.hr_avg),
          hrMax: num(item.hr_max),
          cardioLoad: num(item.cardio_load),
        })),
      });
      return;
    }
    const requested = Number(url.searchParams.get("weeks")),
      weeks = [4, 8, 12].includes(requested) ? requested : 4;
    const nights = await store.wellnessNights(
      userId,
      PROVIDER,
      addDays(today, -(weeks * 7 + 28)),
      today,
    );
    const trends = trendSummary({ nights, today, weeks }),
      from = Date.parse(`${trends.from}T00:00:00Z`) - DAY_MS;
    const deviceWorkouts = await store.wellnessWorkouts(
      userId,
      PROVIDER,
      from,
      Date.parse(`${today}T00:00:00Z`) + 2 * DAY_MS,
    );
    const history = ((await store.workouts(userId, 120, 0)) || [])
      .map((/** @type {any} */ item) => {
        try {
          return JSON.parse(String(item.summary_json));
        } catch {
          return null;
        }
      })
      .filter((/** @type {any} */ item) => item && item.status === "completed");
    const training = trends.weekly.map((week) => ({
      start: week.start,
      end: week.end,
      strataWorkouts: history.filter(
        (/** @type {any} */ item) =>
          String(item.date) >= week.start && String(item.date) <= week.end,
      ).length,
      cardioLoad: Math.round(
        deviceWorkouts
          .filter(
            (/** @type {any} */ item) =>
              String(item.local_date) >= week.start && String(item.local_date) <= week.end,
          )
          .reduce(
            (/** @type {number} */ sum, /** @type {any} */ item) =>
              sum + (num(item.cardio_load) || 0),
            0,
          ),
      ),
    }));
    json(res, 200, { ...base, trends: { ...trends, training } });
  }

  /** Strata+ members, or anyone who still has a Polar connection (read-only after Strata+ ends). @param {any} req @param {any} res */
  async function readOnlySession(req, res) {
    const session = await auth.requireSession(req, res);
    if (!session) return null;
    if (
      (await hasAccess(String(session.id))) ||
      (await store.deviceConnection(String(session.id), PROVIDER))
    )
      return session;
    json(res, 402, {
      error: "Strata+ purchase required.",
      code: "DISCOVERY_ACCESS_REQUIRED",
      feature: "plus.recovery",
    });
    return null;
  }

  /** @param {any} req @param {any} res @param {URL} url */
  async function handleApi(req, res, url) {
    const path = url.pathname,
      method = String(req.method);
    const routes = new Map([
      ["/api/devices", "GET"],
      ["/api/devices/polar/connect", "POST"],
      ["/api/devices/polar/callback", "GET"],
      ["/api/devices/polar/complete", "POST"],
      ["/api/devices/polar/sync", "POST"],
      ["/api/devices/settings", "PUT"],
      ["/api/devices/polar", "DELETE"],
      ["/api/wellness/today", "GET"],
      ["/api/wellness/trends", "GET"],
      ["/api/wellness/workouts", "GET"],
    ]);
    const allowed = routes.get(path);
    if (!allowed) return false;
    try {
      if (method !== allowed && !(allowed === "GET" && method === "HEAD")) {
        json(res, 405, { error: "Method not allowed." }, { Allow: allowed });
        return true;
      }
      if (path === "/api/devices/polar/callback") {
        await callback(req, res, url);
        return true;
      }
      // Status and disconnect work for every signed-in member, so a lapsed member can still see and remove a connection.
      if (path === "/api/devices" || path === "/api/devices/polar") {
        const session = await auth.requireSession(req, res);
        if (!session) return true;
        if (path === "/api/devices/polar") {
          await readInput(req, session, []);
          json(res, 200, {
            disconnected: await releaseConnection(String(session.id)),
            csrfToken: session.csrf_token,
          });
          return true;
        }
        if (!(await rateAllowed(req, `identity:devices:read:${session.id}`, 240, 60 * 1000)))
          throw deviceError("DEVICES_RATE_LIMIT", "Too many checks. Wait a moment.", 429);
        json(res, 200, {
          configured: settings.configured,
          plus: await hasAccess(String(session.id)),
          connection: publicConnection(await store.deviceConnection(String(session.id), PROVIDER)),
          csrfToken: session.csrf_token,
        });
        return true;
      }
      // After Strata+ ends, syncing pauses but a member who still has a connection keeps read-only access to what was imported.
      const lapsedRead = method !== "POST" && method !== "PUT" && path.startsWith("/api/wellness/");
      const session = lapsedRead ? await readOnlySession(req, res) : await requireAccess(req, res);
      if (!session) return true;
      if (
        method === "GET" &&
        !(await rateAllowed(req, `identity:devices:read:${session.id}`, 240, 60 * 1000))
      )
        throw deviceError("DEVICES_RATE_LIMIT", "Too many checks. Wait a moment.", 429);
      if (path === "/api/devices/polar/connect") await connect(req, res, session);
      else if (path === "/api/devices/polar/complete") await complete(req, res, session);
      else if (path === "/api/devices/polar/sync") await syncNow(req, res, session);
      else if (path === "/api/devices/settings") await saveSettings(req, res, session);
      else await wellness(res, session, url);
    } catch (error) {
      const failure = /** @type {any} */ (error);
      if (!failure?.status) throw error;
      json(res, failure.status, {
        error: failure.message,
        code: failure.code || "DEVICES_FAILED",
        ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
      });
    }
    return true;
  }

  return {
    handleApi,
    start() {
      if (settings.configured) worker.start();
    },
    stop() {
      worker.stop();
    },
  };
}

module.exports = { CONSENT_VERSION, createDevicesService, devicesSettings, publicConnection };
