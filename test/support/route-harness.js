"use strict";

// Serves a service's route table through the real dispatcher (src/router.js) with the security functions a
// test supplies, so unit tests exercise the same session, origin, CSRF, and JSON checks the server applies.
const { createRouter } = require("../../src/router");

/**
 * @param {object[]} routes A service's `routes`.
 * @param {{
 *   json:(res:any,status:number,body:unknown,headers?:object)=>void,
 *   sessionFor?:(req:any,res:any)=>Promise<any>,
 *   requireSession?:(req:any,res:any)=>Promise<any>,
 *   requireFeature?:(feature:string)=>(req:any,res:any)=>Promise<any>,
 *   requireAdmin?:(req:any,res:any,options?:object)=>Promise<any>,
 *   validCsrf?:(req:any,session:any)=>boolean,
 *   trustedOrigin?:(req:any)=>boolean
 * }} security
 */
function routeHarness(routes, security) {
  const sessionFor = security.sessionFor || (async () => null);
  const requireSession =
    security.requireSession ||
    (async (req, res) => {
      const session = await sessionFor(req, res);
      if (!session) security.json(res, 401, { error: "Sign in required." });
      return session || null;
    });
  const router = createRouter({
    json: security.json,
    trustedOrigin: security.trustedOrigin || (() => true),
    sessionFor,
    requireSession,
    requireFeature: security.requireFeature || (() => requireSession),
    requireAdmin:
      security.requireAdmin ||
      (async (req, res) => {
        security.json(res, 403, {
          error: "Administrator access required.",
          code: "ADMIN_REQUIRED",
        });
        return null;
      }),
    validCsrf: security.validCsrf || (() => false),
  });
  router.add(routes);
  return {
    router,
    /** Same contract as the old per-service handleApi: false when no route has the path. */
    handleApi: (req, res, url) => router.dispatch(req, res, url),
  };
}

module.exports = { routeHarness };
