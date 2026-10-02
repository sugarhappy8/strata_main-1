// @ts-check
"use strict";

const { expectedPlanRevision, planStats, sanitizePlan, sanitizePreferences } = require("./plans");

/**
 * Typed dependency-injection boundary for atomic weekly-plan setup.
 * @param {import("./domain-types").SetupServiceDependencies} dependencies
 * @returns {import("./domain-types").SetupService}
 */
function createSetupService({
  store,
  auth,
  requireAccess,
  trustedOrigin,
  getPlanSnapshot,
  getPreferencesSnapshot,
  getUserPayload,
  http,
  events = null,
}) {
  if (
    !store ||
    !auth ||
    typeof requireAccess !== "function" ||
    typeof trustedOrigin !== "function" ||
    typeof getPlanSnapshot !== "function" ||
    typeof getPreferencesSnapshot !== "function" ||
    typeof getUserPayload !== "function" ||
    !http
  ) {
    throw new TypeError(
      "Setup service requires storage, account guards, snapshots, and HTTP helpers.",
    );
  }
  const { json, bodyJson } = http;

  /** @param {import("./domain-types").SessionRow} session */
  async function currentSetup(session) {
    const [planSnapshot, preferenceSnapshot, user] = await Promise.all([
      getPlanSnapshot(session.id),
      getPreferencesSnapshot(session.id),
      getUserPayload(session),
    ]);
    return {
      plan: planSnapshot.plan,
      planUpdatedAt: planSnapshot.updatedAt,
      preferences: preferenceSnapshot.preferences,
      preferencesUpdatedAt: preferenceSnapshot.updatedAt,
      user,
      csrfToken: session.csrf_token,
    };
  }

  /**
   * @param {import("./domain-types").HttpRequest} req
   * @param {import("./domain-types").HttpResponse} res
   * @param {import("./domain-types").SessionRow} session
   */
  async function saveSetup(req, res, session) {
    if (!trustedOrigin(req)) {
      json(res, 403, {
        error: "Setup security check failed. Refresh and try again.",
        code: "SETUP_ORIGIN_REQUIRED",
      });
      return;
    }
    if (!auth.validCsrf(req, session)) {
      json(res, 403, {
        error: "Security check failed. Refresh and try again.",
        code: "INVALID_CSRF",
      });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
      json(res, 415, { error: "Setup requests must use JSON.", code: "JSON_REQUIRED" });
      return;
    }
    const input = /** @type {import("./domain-types").TrainingSetupInput} */ (await bodyJson(req));
    const expectedPlanUpdatedAt = expectedPlanRevision(input.expectedPlanUpdatedAt);
    const rawPreferencesRevision = input.expectedPreferencesUpdatedAt;
    if (
      typeof rawPreferencesRevision !== "number" ||
      !Number.isSafeInteger(rawPreferencesRevision) ||
      rawPreferencesRevision < 0
    ) {
      json(res, 400, {
        error: "Your preference version is missing or invalid. Reload setup and try again.",
        code: "PREFERENCE_VERSION_REQUIRED",
      });
      return;
    }
    const expectedPreferencesUpdatedAt = rawPreferencesRevision;
    if (String(input.expectedUserId || "") !== String(session.id)) {
      json(res, 409, {
        error: "The signed-in account changed. Reload setup before saving.",
        code: "ACCOUNT_CHANGED",
      });
      return;
    }
    const plan = sanitizePlan(input.plan),
      preferences = sanitizePreferences(input.preferences),
      stats = planStats(plan);
    if (stats.workoutDays !== preferences.days) {
      json(res, 400, {
        error:
          "Your training-day profile does not match the generated week. Preview the week again before saving.",
        code: "SETUP_PROFILE_MISMATCH",
      });
      return;
    }
    const planJson = JSON.stringify(plan),
      preferencesJson = JSON.stringify(preferences);
    const saved = await store.saveTrainingSetup(
      session.id,
      planJson,
      preferencesJson,
      Math.max(Date.now(), expectedPlanUpdatedAt + 1, expectedPreferencesUpdatedAt + 1),
      expectedPlanUpdatedAt,
      expectedPreferencesUpdatedAt,
    );
    if (saved) {
      await events?.emit("plan.updated", {
        userId: session.id,
        plan,
        updatedAt: Number(saved.updated_at),
        source: "system",
        detail: "setup",
      });
      await events?.emit("preferences.saved", { userId: session.id, preferences });
      json(res, 200, {
        ok: true,
        plan,
        planUpdatedAt: Number(saved.updated_at),
        preferences,
        preferencesUpdatedAt: Number(saved.preferences_updated_at),
        stats,
      });
      return;
    }
    const [currentPlan, currentPreferences] = await Promise.all([
      getPlanSnapshot(session.id),
      getPreferencesSnapshot(session.id),
    ]);
    if (
      currentPlan.storedPlanJson === planJson &&
      currentPreferences.storedPreferencesJson === preferencesJson
    ) {
      json(res, 200, {
        ok: true,
        reused: true,
        plan: currentPlan.plan,
        planUpdatedAt: currentPlan.updatedAt,
        preferences: currentPreferences.preferences,
        preferencesUpdatedAt: currentPreferences.updatedAt,
        stats,
      });
      return;
    }
    json(res, 409, {
      error:
        "Your weekly setup changed in another tab or device. Review the saved copy before replacing it.",
      code: "SETUP_CHANGED",
      plan: currentPlan.plan,
      planUpdatedAt: currentPlan.updatedAt,
      preferences: currentPreferences.preferences,
      preferencesUpdatedAt: currentPreferences.updatedAt,
      stats: planStats(currentPlan.plan),
    });
  }

  /**
   * @param {import("./domain-types").HttpRequest} req
   * @param {import("./domain-types").HttpResponse} res
   * @param {URL} url
   */
  async function handleApi(req, res, url) {
    if (url.pathname !== "/api/setup") return false;
    const session = await requireAccess(req, res);
    if (!session) return true;
    if (req.method === "GET") json(res, 200, await currentSetup(session));
    else if (req.method === "PUT") await saveSetup(req, res, session);
    else json(res, 405, { error: "Method not allowed." }, { Allow: "GET, PUT" });
    return true;
  }

  return { handleApi };
}

module.exports = { createSetupService };
