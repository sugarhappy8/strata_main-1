// @ts-check
"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { exportPayload, exportWorkout, streamExport } = require("./account-export");
const PUBLIC_SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
/** @param {string} tokenHash */
function publicSessionId(tokenHash) {
  return createHash("sha256")
    .update("strata-account-session:v1\0")
    .update(tokenHash)
    .digest("base64url");
}
/** @param {unknown} left @param {unknown} right */
function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? "")),
    b = Buffer.from(String(right ?? ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** @param {any} row @param {string} currentTokenHash */
function sessionPayload(row, currentTokenHash) {
  return {
    id: publicSessionId(String(row.token_hash)),
    current: safeEqual(row.token_hash, currentTokenHash),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

/**
 * @param {import("./domain-types").AccountSelfServiceDependencies} dependencies
 * @returns {import("./domain-types").AccountSelfService}
 */
function createAccountSelfService({ store, http, rateAllowed, logger = console, now = Date.now }) {
  const { json, bodyJson, securityHeaders } = http;
  /** @param {import("./domain-types").SessionRow} session */
  async function sessionsFor(session) {
    const sessions = await store.accountSessions(session.id, session.token_hash, now());
    return sessions.map((row) => sessionPayload(row, session.token_hash));
  }
  /** @param {import("./domain-types").RouteContext} context */
  async function listSessions({ res, session }) {
    const sessions = await sessionsFor(session);
    json(res, 200, {
      userId: session.id,
      sessions,
      otherCount: sessions.filter((item) => !item.current).length,
    });
  }

  /** @param {import("./domain-types").RouteContext} context */
  async function revokeSession({ req, res, session }) {
    const input = /** @type {Record<string,unknown>} */ (await bodyJson(req)),
      sessionId = String(input.sessionId || "");
    if (!PUBLIC_SESSION_ID.test(sessionId)) {
      json(res, 400, { error: "Choose a valid signed-in session.", code: "INVALID_SESSION" });
      return;
    }
    const owned = await store.accountSessions(session.id, session.token_hash, now());
    const target = owned.find((row) =>
      safeEqual(publicSessionId(String(row.token_hash)), sessionId),
    );
    if (!target) {
      json(res, 404, {
        error: "That signed-in session is no longer active.",
        code: "SESSION_NOT_FOUND",
      });
      return;
    }
    if (safeEqual(target.token_hash, session.token_hash)) {
      json(res, 409, {
        error: "The current session cannot be revoked here. Use Sign out instead.",
        code: "CURRENT_SESSION_PROTECTED",
      });
      return;
    }
    if (!(await rateAllowed(req, `identity:account-session-revoke:${session.id}`, 30))) {
      json(res, 429, {
        error: "Too many session changes. Wait a moment and try again.",
        code: "SESSION_RATE_LIMIT",
      });
      return;
    }
    const revoked = await store.revokeAccountSession(
      session.id,
      String(target.token_hash),
      session.token_hash,
      now(),
    );
    if (!revoked) {
      json(res, 404, {
        error: "That signed-in session is no longer active.",
        code: "SESSION_NOT_FOUND",
      });
      return;
    }
    const sessions = await sessionsFor(session);
    json(res, 200, {
      ok: true,
      revoked: 1,
      sessions,
      otherCount: sessions.filter((item) => !item.current).length,
    });
  }

  /** @param {import("./domain-types").RouteContext} context */
  async function revokeOthers({ req, res, session }) {
    await bodyJson(req);
    if (!(await rateAllowed(req, `identity:account-session-revoke:${session.id}`, 30))) {
      json(res, 429, {
        error: "Too many session changes. Wait a moment and try again.",
        code: "SESSION_RATE_LIMIT",
      });
      return;
    }
    const revoked = await store.revokeOtherAccountSessions(session.id, session.token_hash, now());
    const sessions = await sessionsFor(session);
    json(res, 200, {
      ok: true,
      revoked,
      sessions,
      otherCount: sessions.filter((item) => !item.current).length,
    });
  }

  /** @param {import("./domain-types").RouteContext} context */
  async function exportAccount({ req, res, session }) {
    await bodyJson(req);
    if (!(await rateAllowed(req, `identity:account-export:${session.id}`, 5))) {
      json(res, 429, {
        error: "Too many exports were requested. Wait a moment and try again.",
        code: "ACCOUNT_EXPORT_RATE_LIMIT",
      });
      return;
    }
    const exportedAt = now(),
      rows = await store.accountExport(session.id);
    if (!rows) {
      json(res, 409, {
        error: "The signed-in account changed. Refresh and try again.",
        code: "ACCOUNT_CHANGED",
      });
      return;
    }
    await streamExport(res, store, session.id, rows, exportedAt, securityHeaders());
  }

  /**
   * Every self-service route shares this failure handling: a 4xx is the member's to fix, anything else is logged
   * and answered with a retryable 503 (or the half-sent export is cut off).
   * @param {(context:any)=>Promise<void>} run
   */
  const guarded = (run) => async (/** @type {any} */ context) => {
    const { res } = context;
    try {
      await run(context);
    } catch (error) {
      const failure = /** @type {{status?:unknown,message?:unknown}} */ (error),
        status = Number(failure?.status);
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        json(res, status, {
          error: String(failure.message || "Invalid account request."),
          code: "INVALID_ACCOUNT_REQUEST",
        });
        return;
      }
      logger.error("Account self-service request failed:", error);
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      json(res, 503, {
        error: "Account self-service is temporarily unavailable. Please try again.",
        code: "ACCOUNT_SELF_SERVICE_UNAVAILABLE",
      });
    }
  };

  // Session, origin, CSRF, and JSON checks happen once, in src/router.js.
  /** @type {import("./domain-types").ApiRoute[]} */
  const routes = [
    { method: "GET", path: "/api/account/sessions", handler: guarded(listSessions) },
    { method: "POST", path: "/api/account/sessions/revoke", handler: guarded(revokeSession) },
    { method: "POST", path: "/api/account/sessions/revoke-others", handler: guarded(revokeOthers) },
    { method: "POST", path: "/api/account/export", handler: guarded(exportAccount) },
  ];
  return Object.freeze({ routes });
}

module.exports = {
  createAccountSelfService,
  exportPayload,
  exportWorkout,
  publicSessionId,
  streamExport,
};
