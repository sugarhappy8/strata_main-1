// @ts-check
"use strict";

// Strata AI consent, the Daily Brief choice, deleting stored AI notes, and the owner's usage view. Consent
// and deletion work for every signed-in member, Strata+ or not, so a member can always withdraw or clean up.

const CONSENT_VERSION = 1;

/** @param {any} row */
function settingsPayload(row) {
  return {
    consent: row?.consent_at != null,
    consentedAt: row?.consent_at == null ? null : Number(row.consent_at),
    dailyBrief: row ? Number(row.daily_brief) === 1 : true,
    version: CONSENT_VERSION,
  };
}

/**
 * Session, origin, CSRF, and JSON checks happen once, in src/router.js.
 * @param {{store:any,rateAllowed:(req:any,key:string,max:number,windowMs:number)=>boolean|Promise<boolean>,
 *   http:{json:Function,bodyJson:Function},quota:{adminSummary:(limit?:number)=>Promise<any>},
 *   now?:()=>number}} dependencies
 */
function createAiSettingsService({ store, rateAllowed, http, quota, now = Date.now }) {
  const { json, bodyJson } = http,
    noStore = { "Cache-Control": "private, no-store" };
  /** @param {string} code @param {string} message @param {number} status */
  const failure = (code, message, status) => Object.assign(new Error(message), { code, status });
  /** Every settings route answers its own failures with this module's codes. @param {(context:any)=>Promise<void>} run */
  const guarded = (run) => async (/** @type {any} */ context) => {
    try {
      await run(context);
    } catch (error) {
      const known = /** @type {any} */ (error);
      if (!known?.status) throw error;
      json(context.res, known.status, {
        error: known.message,
        code: known.code || "AI_SETTINGS_FAILED",
      });
    }
  };
  /** @param {any} req @param {any} session */
  async function writeAllowed(req, session) {
    if (!(await rateAllowed(req, `identity:ai:settings:${session.id}`, 30, 60000)))
      throw failure("AI_RATE_LIMIT", "Too many changes. Wait a moment.", 429);
  }
  /** @param {{res:any,session:any}} context */
  async function readSettings({ res, session }) {
    json(
      res,
      200,
      {
        settings: settingsPayload(await store.aiSettings(String(session.id))),
        csrfToken: session.csrf_token,
      },
      noStore,
    );
  }
  /** @param {{req:any,res:any,session:any}} context */
  async function saveSettings({ req, res, session }) {
    await writeAllowed(req, session);
    const input = await bodyJson(req),
      extra = Object.keys(input && typeof input === "object" ? input : {}).filter(
        (key) => !["consent", "dailyBrief"].includes(key),
      );
    if (
      extra.length ||
      typeof input?.consent !== "boolean" ||
      (input.dailyBrief !== undefined && typeof input.dailyBrief !== "boolean")
    )
      throw failure(
        "AI_INVALID_REQUEST",
        "Choose whether Strata AI may use your training data.",
        400,
      );
    const current = await store.aiSettings(String(session.id)),
      time = now();
    const saved = await store.upsertAiSettings(String(session.id), {
      consentAt: input.consent ? Number(current?.consent_at) || time : null,
      consentVersion: CONSENT_VERSION,
      dailyBrief: input.dailyBrief ?? (current ? Number(current.daily_brief) === 1 : true),
      updatedAt: time,
    });
    if (!saved)
      throw failure("AI_ACCOUNT_CHANGED", "Your account changed. Reload and try again.", 409);
    json(res, 200, { settings: settingsPayload(saved), csrfToken: session.csrf_token }, noStore);
  }
  /** @param {{req:any,res:any,session:any}} context */
  async function deleteNotes({ req, res, session }) {
    await writeAllowed(req, session);
    await store.deleteDailyBriefs(String(session.id), now());
    json(res, 200, { deleted: true, csrfToken: session.csrf_token }, noStore);
  }
  /** The owner's view of today's requests and tokens, in total and for the heaviest members. @param {{res:any}} context */
  async function usage({ res }) {
    json(res, 200, { usage: await quota.adminSummary(10) }, noStore);
  }
  const routes = [
    { method: "GET", path: "/api/ai/settings", handler: guarded(readSettings) },
    { method: "PUT", path: "/api/ai/settings", handler: guarded(saveSettings) },
    { method: "DELETE", path: "/api/ai/notes", handler: guarded(deleteNotes) },
    { method: "GET", path: "/api/ai/usage", auth: "admin", handler: usage },
  ];
  return { routes };
}

module.exports = { CONSENT_VERSION, createAiSettingsService, settingsPayload };
