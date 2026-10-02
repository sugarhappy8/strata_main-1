// @ts-check
"use strict";

// Sliding sessions. A member who keeps using STRATA (the iOS app above all) stays signed in: once a valid session is past
// half of its lifetime, the session lookup extends it and adds a fresh cookie with the same token to the response. Renewal never goes
// past an absolute cap counted from when the member signed in, so a stolen cookie cannot be kept alive forever.
const SESSION_MAX_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * The new expiry for a session that should slide forward, or null when it does not need (or may not get) one.
 * @param {{expires_at:unknown,session_created_at?:unknown}} session
 * @param {{now:number,sessionMs:number,maxLifetimeMs?:number}} options
 * @returns {number|null}
 */
function renewedSessionExpiry(
  session,
  { now, sessionMs, maxLifetimeMs = SESSION_MAX_LIFETIME_MS },
) {
  const expiresAt = Number(session.expires_at),
    createdAt = Number(session.session_created_at);
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(createdAt) || expiresAt <= now)
    return null;
  if (expiresAt - now >= sessionMs / 2) return null;
  const renewed = Math.min(now + sessionMs, createdAt + maxLifetimeMs);
  return renewed - expiresAt >= 60_000 ? renewed : null;
}

/** A cookie's name with its "=". @param {string} cookie */
const cookieName = (cookie) => cookie.slice(0, cookie.indexOf("=") + 1);
/** @param {unknown} value @returns {string[]} */
function cookieList(value) {
  return value == null ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * Adds a cookie to the response before any handler writes it, replacing an earlier cookie of the same name. The session
 * lookup calls this when it slides a session forward, so whatever response the route sends carries the new cookie.
 * @param {import("./domain-types").HttpResponse} res @param {string} cookie
 */
function appendSetCookie(res, cookie) {
  const name = cookieName(cookie);
  res.setHeader("Set-Cookie", [
    ...cookieList(res.getHeader("Set-Cookie")).filter((item) => !item.startsWith(name)),
    cookie,
  ]);
}

/**
 * Headers passed to writeHead replace a Set-Cookie set earlier with setHeader, so the response helpers merge them: a
 * route's own cookie wins over an appended one of the same name (sign-out, sign-in, and deletion replace the session
 * cookie) and leaves appended cookies of other names in place.
 * @param {import("./domain-types").HttpResponse} res @param {import("./domain-types").HttpHeaders} headers
 * @returns {import("./domain-types").HttpHeaders}
 */
function withAppendedCookies(res, headers) {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === "set-cookie"),
    appended = cookieList(res.getHeader?.("Set-Cookie"));
  if (!key || !appended.length) return headers;
  const own = cookieList(headers[key]),
    names = own.map(cookieName);
  return {
    ...headers,
    [key]: [...appended.filter((cookie) => !names.includes(cookieName(cookie))), ...own],
  };
}

module.exports = {
  SESSION_MAX_LIFETIME_MS,
  appendSetCookie,
  renewedSessionExpiry,
  withAppendedCookies,
};
