// @ts-check
"use strict";

// The Daily Brief: once a day, after the member's night has synced, Strata AI writes a short structured note
// (readiness, today's recommendation, suggested plan adjustments, one insight) and stores it on that day's
// Daily Snapshot, so every screen can show it without calling the model again. Runs are spread over the
// morning and throttled by the quota manager; a member is never sent to the provider without consent.

const { buildDataContext } = require("./ai-context");

const DAYS = Object.freeze([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);
const LEVELS = Object.freeze(["ready", "steady", "take_it_easy", "unknown"]);
const BRIEF_VERSION = 1;
const CARE_FALLBACK =
  "Some of your recent readings are outside your usual range. If it continues or you feel unwell, consider checking in with a health professional.";
const RETRYABLE = new Set([
  "AI_OFFLINE",
  "AI_AUTH",
  "AI_UNAVAILABLE",
  "AI_NOT_CONFIGURED",
  "AI_RATE_LIMIT",
]);
const BRIEF_RULES = [
  "You are Strata AI, STRATA's training coach. Write today's Daily Brief for one member from the facts below.",
  "Be warm, specific, and short. Use only the facts given and never invent numbers.",
  "readiness.level is ready, steady, take_it_easy, or unknown (unknown when there is no recovery reading).",
  "planAdjustments are optional suggestions the member reviews in their plan; never say they are applied. Use at most two.",
  "Never diagnose, never name a medical condition, and never give medical advice.",
  "If care notes are listed, careNote is one gentle sentence suggesting a health professional if it continues; otherwise careNote is null.",
  "Return only the JSON object.",
].join(" ");

/** The structured-output schema sent to the provider. Lengths are enforced by validateBrief, not the schema. */
function briefSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      readiness: {
        type: "object",
        additionalProperties: false,
        properties: { level: { type: "string", enum: [...LEVELS] }, summary: { type: "string" } },
        required: ["level", "summary"],
      },
      recommendation: {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string" }, detail: { type: "string" } },
        required: ["title", "detail"],
      },
      planAdjustments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            day: { type: "string", enum: [...DAYS] },
            change: { type: "string" },
            reason: { type: "string" },
          },
          required: ["day", "change", "reason"],
        },
      },
      insight: { type: "string" },
      careNote: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["readiness", "recommendation", "planAdjustments", "insight", "careNote"],
  };
}

/** @param {unknown} value @param {number} max */
const clean = (value, max) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * Validates the model's brief before anything is saved. Care notes appear only when STRATA's own care flags
 * fired, and a deterministic note replaces a missing one.
 * @param {any} data @param {{flags?:string[]}} [options]
 */
function validateBrief(data, { flags = [] } = {}) {
  if (!data || typeof data !== "object") return null;
  const level = LEVELS.includes(data.readiness?.level) ? String(data.readiness.level) : null,
    summary = clean(data.readiness?.summary, 240);
  const title = clean(data.recommendation?.title, 80),
    detail = clean(data.recommendation?.detail, 320);
  if (!level || !summary || !title || !detail) return null;
  const planAdjustments = (Array.isArray(data.planAdjustments) ? data.planAdjustments : [])
    .slice(0, 2)
    .map((/** @type {any} */ item) => ({
      day: DAYS.includes(item?.day) ? String(item.day) : "",
      change: clean(item?.change, 160),
      reason: clean(item?.reason, 200),
    }))
    .filter((item) => item.day && item.change && item.reason);
  const careNote = flags.length ? clean(data.careNote, 240) || CARE_FALLBACK : null;
  return {
    version: BRIEF_VERSION,
    readiness: { level, summary },
    recommendation: { title, detail },
    planAdjustments,
    insight: clean(data.insight, 240),
    careNote,
  };
}

/** @param {number} time @param {string} zone */
function localParts(time, zone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(time)),
      part = (/** @type {string} */ type) => parts.find((item) => item.type === type)?.value || "";
    return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
  } catch {
    return localParts(time, "UTC");
  }
}
/** @param {string} date @param {number} days */
const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/** @param {unknown} profileJson */
function zoneOf(profileJson) {
  try {
    const zone = String(JSON.parse(String(profileJson))?.timeZone || "UTC");
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return "UTC";
  }
}

/**
 * @param {{store:any,dataService:any,provider:{configured:boolean,complete:Function},quota:ReturnType<typeof import("./ai-quota").createAiQuota>,
 *   hasAccess:(userId:string)=>Promise<boolean>,logger?:{info?:Function,warn?:Function,error?:Function}|null,now?:()=>number,
 *   settings?:{hour?:number,waitForNightUntil?:number,batch?:number,scan?:number,intervalMs?:number}}} dependencies
 */
function createDailyBriefJob({
  store,
  dataService,
  provider,
  quota,
  hasAccess,
  logger = null,
  now = Date.now,
  settings = {},
}) {
  const hour = settings.hour ?? 5,
    waitForNightUntil = settings.waitForNightUntil ?? 10,
    batch = settings.batch ?? 3,
    scan = settings.scan ?? 50,
    intervalMs = settings.intervalMs ?? 60000;
  /** @type {Map<string,{count:number,at:number}>} */
  const failures = new Map();
  /** @type {Set<string>} */
  const done = new Set(),
    priority = new Set();
  let cursor = 0,
    ticking = false;
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;

  /** Today's work for one member, or null when it is not due yet. @param {string} userId @param {unknown} profileJson */
  async function due(userId, profileJson) {
    const { date, hour: localHour } = localParts(now(), zoneOf(profileJson)),
      key = `${userId}:${date}`;
    if (localHour < hour || done.has(key)) return null;
    const failure = failures.get(key);
    if (failure && (failure.count >= 3 || now() - failure.at < 60 * 60 * 1000)) return null;
    const [row] = await store.dailySnapshots(userId, date, date);
    if (row?.brief_json) {
      done.add(key);
      return null;
    }
    if (!(await hasAccess(userId))) return null;
    // A member who syncs Polar gets the brief after last night arrives, or mid-morning at the latest.
    if (localHour < waitForNightUntil) {
      const connection = await store.deviceConnection(userId, "polar");
      let hasNight = false;
      try {
        hasNight = Boolean(row && JSON.parse(String(row.snapshot_json))?.sleep);
      } catch {
        hasNight = false;
      }
      if (connection?.status === "active" && !hasNight) return null;
    }
    return { userId, date, key };
  }

  /** @param {{userId:string,date:string,key:string}} item */
  async function generate({ userId, date, key }) {
    const claim = await quota.reserve("brief", userId);
    if (!claim.ok) return { status: String(claim.code) };
    let tokens = 0;
    try {
      const [snapshots, entries, signals, changes] = await Promise.all([
        dataService.snapshots.read(userId, { from: addDays(date, -13), to: date, today: date }),
        dataService.trainingLog
          .read(userId, { from: addDays(date, -6), to: date, today: date })
          .catch(() => []),
        dataService.rankingsSignals(userId).catch(() => null),
        dataService.planChanges(userId, 3).catch(() => []),
      ]);
      const context = buildDataContext({ snapshots, entries, signals, planChanges: changes });
      const ask = async (/** @type {string} */ note) => {
        const result = await provider.complete({
          messages: [
            { role: "system", content: BRIEF_RULES },
            {
              role: "user",
              content: [`Today is ${date}.`, context.text, note].filter(Boolean).join("\n\n"),
            },
          ],
          maxTokens: 600,
          temperature: 0.3,
          responseFormat: {
            type: "json_schema",
            name: "strata_daily_brief",
            schema: briefSchema(),
          },
          reasoningEffort: "low",
        });
        tokens += Number(result.usage?.totalTokens) || 0;
        return result;
      };
      let completion = await ask(""),
        brief = validateBrief(completion.data, { flags: context.flags });
      if (!brief) {
        completion = await ask(
          "Your previous answer did not match the schema. Return one complete JSON object with every field.",
        );
        brief = validateBrief(completion.data, { flags: context.flags });
      }
      if (!brief)
        throw Object.assign(new Error("The Daily Brief could not be read."), {
          code: "AI_BAD_OUTPUT",
        });
      const saved = await store.saveDailyBrief(
        userId,
        date,
        JSON.stringify({
          ...brief,
          generatedBy: "ai",
          model: completion.model || null,
          careFlags: context.flags.length,
        }),
        now(),
      );
      if (saved) done.add(key);
      logger?.info?.("ai.brief", { status: saved ? "saved" : "no_snapshot", tokens });
      return { status: saved ? "saved" : "no_snapshot" };
    } catch (error) {
      const code = String(/** @type {any} */ (error)?.code || "AI_FAILED"),
        previous = failures.get(key);
      failures.set(key, { count: (previous?.count || 0) + 1, at: now() });
      if (RETRYABLE.has(code) && !tokens) await quota.refund("brief", userId, claim.date);
      logger?.warn?.("ai.brief_failed", { code });
      return { status: "failed", code };
    } finally {
      await quota.record("brief", userId, claim.date, tokens);
    }
  }

  /** One scheduler pass: members whose snapshot just changed first, then the next slice of everyone with briefs on. */
  async function tick() {
    if (ticking || !provider.configured) return [];
    ticking = true;
    try {
      /** @type {Array<{userId:string,date:string,key:string}>} */
      const picked = [];
      const consider = async (/** @type {string} */ userId, /** @type {unknown} */ profileJson) => {
        if (picked.length < batch && !picked.some((item) => item.userId === userId)) {
          const item = await due(userId, profileJson);
          if (item) picked.push(item);
        }
      };
      for (const userId of [...priority]) {
        priority.delete(userId);
        const settingsRow = await store.aiSettings(userId);
        if (settingsRow?.consent_at != null && Number(settingsRow.daily_brief) === 1) {
          const profile = await store.coachingProfile(userId);
          await consider(userId, profile?.profile_json);
        }
      }
      const rows = await store.briefCandidates(scan, cursor);
      cursor = rows.length < scan ? 0 : cursor + rows.length;
      for (const row of rows) await consider(String(row.user_id), row.profile_json);
      const results = [];
      for (const item of picked) {
        const result = await generate(item);
        results.push(result);
        if (result.status === "AI_BUSY" || result.status === "AI_RESTING") break;
      }
      if (done.size > 20000) done.clear();
      return results;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    generate,
    due,
    /** @param {import("./domain-types").EventBus} events */
    subscribe(events) {
      events.on(
        "snapshot.ready",
        (payload) => {
          priority.add(String(payload.userId));
        },
        "daily_brief.priority",
      );
    },
    start() {
      if (timer) return;
      timer = setInterval(
        () => void tick().catch((error) => logger?.error?.("ai.brief_loop_failed", { error })),
        intervalMs,
      );
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = {
  BRIEF_RULES,
  BRIEF_VERSION,
  CARE_FALLBACK,
  LEVELS,
  briefSchema,
  createDailyBriefJob,
  localParts,
  validateBrief,
};
