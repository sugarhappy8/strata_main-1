// @ts-check
"use strict";

/**
 * One table of API routes and one dispatcher that applies every security check, the same way for every
 * route. A route only says who may call it:
 *
 *   { method: "POST", path: "/api/workouts", feature: "plus.train", handler }
 *
 * - A route is for signed-in members unless it says `public: true`. `feature` also requires that feature
 *   (src/entitlements.js), and `auth: "admin"` requires the bound owner. `auth: "optional"` serves visitors
 *   and members alike and hands the handler the member's session when there is one.
 * - Every write (POST, PUT, PATCH, DELETE) must come from a STRATA page: its Origin must be trusted.
 * - Every signed-in write must carry the session's CSRF token, on optional-session routes too.
 * - A write's body must be JSON; `form: true` also accepts a plain HTML form post.
 * - `webhook: true` marks a signed callback from a payment provider. It is public, skips the browser checks
 *   above, and its handler verifies the provider's signature.
 *
 * So a write is protected unless its route opts out by name, and no handler repeats these checks.
 */

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const SECURITY_CHECK_FAILED = "Security check failed. Refresh and try again.";

/**
 * @typedef {{req:any,res:any,url:URL,params:Record<string,string>,session:any}} RouteContext
 * @typedef {{
 *   method:string,path:string,handler:(context:RouteContext)=>unknown,
 *   public?:boolean,feature?:string,auth?:"session"|"admin"|"optional",allowBootstrap?:boolean,form?:boolean,webhook?:boolean
 * }} Route
 */

// A path parameter names one record: letters, digits, "_" and "-", as every STRATA ID, date, and slug is written.
// It is matched against the raw path and never decoded, so an encoded "/" (%2F) or "." cannot reach a handler.
const PARAMETER = "([A-Za-z0-9_-]{1,200})";

/** @param {string} path */
function compilePath(path) {
  const names = [];
  const source = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(segment.slice(1));
      return PARAMETER;
    })
    .join("/");
  return { pattern: new RegExp(`^${source}$`), names, static: names.length === 0 };
}

/** @param {any} req */
function bodyIsJson(req, form = false) {
  const headers = req.headers || {},
    type = String(headers["content-type"] || "").toLowerCase(),
    length = Number(headers["content-length"] || 0);
  if (!type && !(length > 0) && headers["transfer-encoding"] === undefined) return true;
  if (/^application\/json(?:\s*;|$)/.test(type)) return true;
  return form && /^application\/x-www-form-urlencoded(?:\s*;|$)/.test(type);
}

/**
 * @param {{
 *   json:(res:any,status:number,body:unknown,headers?:Record<string,string>)=>void,
 *   trustedOrigin:(req:any)=>boolean,
 *   sessionFor:(req:any,res:any)=>Promise<any>,
 *   requireSession:(req:any,res:any)=>Promise<any>,
 *   requireFeature:(feature:string)=>(req:any,res:any)=>Promise<any>,
 *   requireAdmin:(req:any,res:any,options?:{allowBootstrap?:boolean})=>Promise<any>,
 *   validCsrf:(req:any,session:any)=>boolean
 * }} security
 */
function createRouter({
  json,
  trustedOrigin,
  sessionFor,
  requireSession,
  requireFeature,
  requireAdmin,
  validCsrf,
}) {
  /** @type {Array<Route & {compiled:ReturnType<typeof compilePath>,guard:(req:any,res:any)=>Promise<any>}>} */
  const routes = [];

  /** @param {Route} route */
  function guardFor(route) {
    if (route.webhook || route.public) return async () => null;
    if (route.auth === "optional") return async (req, res) => (await sessionFor(req, res)) || null;
    if (route.auth === "admin")
      return (req, res) =>
        requireAdmin(req, res, { allowBootstrap: route.allowBootstrap === true });
    if (route.feature) return requireFeature(route.feature);
    return requireSession;
  }

  /** @param {...Route[]} tables */
  function add(...tables) {
    for (const route of tables.flat()) {
      const label = `${route?.method} ${route?.path}`;
      if (!METHODS.has(route?.method)) throw new TypeError(`${label}: unsupported method.`);
      if (typeof route.path !== "string" || !route.path.startsWith("/api/"))
        throw new TypeError(`${label}: API paths start with /api/.`);
      if (typeof route.handler !== "function") throw new TypeError(`${label}: missing handler.`);
      if (route.webhook && route.method !== "POST")
        throw new TypeError(`${label}: webhooks are POST routes.`);
      if ((route.public || route.webhook) && (route.feature || route.auth))
        throw new TypeError(`${label}: a public route cannot also require a session.`);
      if (!["session", "admin", "optional", undefined].includes(route.auth))
        throw new TypeError(`${label}: auth is "session", "admin", or "optional".`);
      if ((route.auth === "admin" || route.auth === "optional") && route.feature)
        throw new TypeError(`${label}: ${route.auth} routes do not take a feature.`);
      if (routes.some((other) => other.method === route.method && other.path === route.path))
        throw new TypeError(`${label}: registered twice.`);
      routes.push({ ...route, compiled: compilePath(route.path), guard: guardFor(route) });
    }
    // Fixed paths win over parameterized ones, so /api/x/search never reaches /api/x/:id.
    routes.sort((left, right) => Number(right.compiled.static) - Number(left.compiled.static));
  }

  /** @param {string} pathname */
  function matching(pathname) {
    const found = [];
    for (const route of routes) {
      const match = route.compiled.pattern.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(
        route.compiled.names.map((name, index) => [name, match[index + 1]]),
      );
      found.push({ route, params });
    }
    return found;
  }

  /**
   * Runs the matching route. Returns false when no route has this path.
   * @param {any} req @param {any} res @param {URL} url
   */
  async function dispatch(req, res, url) {
    const found = matching(url.pathname);
    if (!found.length) return false;
    const method = req.method === "HEAD" ? "GET" : req.method;
    const hit = found.find(({ route }) => route.method === method);
    if (!hit) {
      const allow = [...new Set(found.map(({ route }) => route.method))].join(", ");
      json(
        res,
        405,
        { error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" },
        { Allow: allow },
      );
      return true;
    }
    const { route, params } = hit,
      write = !READS.has(req.method);
    if (!route.webhook) {
      if (write && !trustedOrigin(req)) {
        json(res, 403, { error: SECURITY_CHECK_FAILED, code: "ORIGIN_REQUIRED" });
        return true;
      }
    }
    // A guard answers 401, 402, or 403 itself and returns null when the caller may not continue.
    const session = await route.guard(req, res),
      signedOutAllowed = route.public || route.webhook || route.auth === "optional";
    if (session === null && !signedOutAllowed) return true;
    if (write && !route.webhook) {
      if (session && !validCsrf(req, session)) {
        json(res, 403, { error: SECURITY_CHECK_FAILED, code: "INVALID_CSRF" });
        return true;
      }
      if (!bodyIsJson(req, route.form === true)) {
        json(res, 415, { error: "Requests must use JSON.", code: "JSON_REQUIRED" });
        return true;
      }
    }
    await route.handler({ req, res, url, params, session });
    return true;
  }

  /** The table as data, for tests and review: who may call each route. */
  function list() {
    return routes.map(({ method, path, feature, auth, form, webhook, ...route }) => ({
      method,
      path,
      access: webhook
        ? "webhook"
        : route.public
          ? "public"
          : auth === "admin" || auth === "optional"
            ? auth
            : feature
              ? `feature:${feature}`
              : "session",
      form: form === true,
    }));
  }

  return Object.freeze({ add, dispatch, list });
}

module.exports = { createRouter, bodyIsJson };
