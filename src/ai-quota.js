// @ts-check
"use strict";

// The provider's free tier is a budget for the whole organization, not per member. This module spends it in
// order: Daily Briefs first (a reserved share), then chat; a per-minute limiter keeps every burst under the
// provider's request-per-minute cap. Counts persist in ai_usage_days so a restart never resets the day.

const MINUTE_MS = 60 * 1000;

/** @param {number} time */
const isoDate = (time) => new Date(time).toISOString().slice(0, 10);

/**
 * @param {{store:import("./domain-types").AiStore,now?:()=>number,limits:{dailyRequests:number,briefShare:number,perMinute:number,userDaily:number}}} dependencies
 */
function createAiQuota({ store, now = Date.now, limits }) {
  const dailyRequests = Math.max(1, Math.floor(limits.dailyRequests)),
    perMinute = Math.max(1, Math.floor(limits.perMinute)),
    userDaily = Math.max(1, Math.floor(limits.userDaily));
  const briefShare = Math.min(0.9, Math.max(0, Number(limits.briefShare) || 0)),
    chatCap = Math.max(1, Math.floor(dailyRequests * (1 - briefShare)));
  /** @type {number[]} */
  const recent = [];
  const today = () => isoDate(now());
  function minuteRoom() {
    const time = now();
    while (recent.length && time - (recent[0] ?? 0) >= MINUTE_MS) recent.shift();
    return recent.length < perMinute;
  }
  /** @param {string} scope */
  async function usage(scope, date = today()) {
    const totals = { chat: { requests: 0, tokens: 0 }, brief: { requests: 0, tokens: 0 } };
    for (const row of await store.aiUsage(date, scope)) {
      const kind = String(row.kind);
      if (kind === "chat" || kind === "brief")
        totals[kind] = { requests: Number(row.requests) || 0, tokens: Number(row.tokens) || 0 };
    }
    return totals;
  }
  /**
   * Claims one request, or explains why not: "AI_BUSY" (this minute is full), "AI_RESTING" (today's shared
   * budget is spent), or "AI_DAILY_LIMIT" (this member's chat allowance is spent). Each limit is claimed with one
   * conditional write, never read and then written, so concurrent requests cannot overshoot it; a claim that a later
   * limit refuses is given back.
   * @param {"chat"|"brief"} kind @param {string} userId
   */
  async function reserve(kind, userId) {
    if (!minuteRoom())
      return { ok: false, code: "AI_BUSY", retryAt: (recent[0] ?? now()) + MINUTE_MS };
    // The minute slot is taken before the first await, so a burst cannot all see the same free slot.
    const stamp = now();
    recent.push(stamp);
    const release = () => {
      const index = recent.indexOf(stamp);
      if (index >= 0) recent.splice(index, 1);
    };
    const date = today();
    try {
      if (kind === "chat" && !(await store.claimMemberAiRequest(date, userId, "chat", userDaily))) {
        release();
        return { ok: false, code: "AI_DAILY_LIMIT" };
      }
      if (
        !(await store.claimGlobalAiRequest(
          date,
          kind,
          dailyRequests,
          kind === "chat" ? chatCap : dailyRequests,
        ))
      ) {
        if (kind === "chat") await store.refundAiUsage(date, userId, "chat");
        release();
        return { ok: false, code: "AI_RESTING" };
      }
      if (kind === "brief") await store.addAiUsage(date, userId, "brief", 1, 0);
      return { ok: true, date };
    } catch (error) {
      release();
      throw error;
    }
  }
  /**
   * Tokens are counted on the day the request was claimed.
   * @param {"chat"|"brief"} kind
   * @param {string} userId
   * @param {string} date
   * @param {number} tokens
   */
  async function record(kind, userId, date, tokens) {
    const count = Math.max(0, Math.floor(Number(tokens) || 0));
    if (!count) return;
    await store.addAiUsage(date, "global", kind, 0, count);
    await store.addAiUsage(date, userId, kind, 0, count);
  }
  /**
   * A request that failed before the provider did any work is given back.
   * @param {"chat"|"brief"} kind
   * @param {string} userId
   * @param {string} date
   */
  async function refund(kind, userId, date) {
    await store.refundAiUsage(date, "global", kind);
    await store.refundAiUsage(date, userId, kind);
  }
  /** @param {string} userId */
  async function memberStatus(userId) {
    const date = today(),
      [mine, global] = await Promise.all([usage(userId, date), usage("global", date)]);
    const resting =
      global.chat.requests >= chatCap ||
      global.chat.requests + global.brief.requests >= dailyRequests;
    return {
      dailyLimit: userDaily,
      usedToday: mine.chat.requests,
      remainingToday: Math.max(0, userDaily - mine.chat.requests),
      resting,
    };
  }
  /** Today's totals and the heaviest users, for the owner. @param {number} [limit] */
  async function adminSummary(limit = 10) {
    const date = today(),
      [totals, top] = await Promise.all([store.aiUsageTotals(date), store.aiUsageTop(date, limit)]);
    return {
      date,
      dailyRequests,
      chatCap,
      perMinute,
      totals: totals.map((row) => ({
        kind: String(row.kind),
        requests: Number(row.requests) || 0,
        tokens: Number(row.tokens) || 0,
      })),
      topUsers: top.map((row) => ({
        userId: String(row.user_id),
        email: row.email == null ? null : String(row.email),
        requests: Number(row.requests) || 0,
        tokens: Number(row.tokens) || 0,
      })),
    };
  }
  return {
    reserve,
    record,
    refund,
    memberStatus,
    adminSummary,
    limits: Object.freeze({ dailyRequests, chatCap, perMinute, userDaily, briefShare }),
    /** @param {number} keepDays */
    cleanup: (keepDays = 90) =>
      store.deleteOldAiUsage(isoDate(now() - keepDays * 24 * MINUTE_MS * 60)),
  };
}

module.exports = { createAiQuota };
