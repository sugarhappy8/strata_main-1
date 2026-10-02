// @ts-check
"use strict";

const { AI_SQL } = require("./ai-schema");

/** @param {string} date @param {string} userId @param {string} kind @param {number} limit */
const memberClaimArgs = (date, userId, kind, limit) => [date, userId, kind, limit, limit];
/** @param {import("./domain-types").AiJobRecord} job */
const jobArgs = (job) => [
  job.id,
  job.userId,
  job.kind,
  job.requestJson,
  job.usageDate,
  job.createdAt,
];
/** @param {string} id @param {import("./domain-types").AiJobOutcome} outcome */
const finishArgs = (id, outcome) => [
  outcome.status,
  outcome.tokens,
  outcome.resultJson,
  outcome.errorJson,
  outcome.finishedAt,
  id,
];
/** @param {string} date @param {string} kind @param {number} dailyLimit @param {number} kindLimit */
const globalClaimArgs = (date, kind, dailyLimit, kindLimit) => [
  date,
  kind,
  date,
  dailyLimit,
  date,
  kind,
  kindLimit,
];

/** @param {{statements:Record<string,import("./domain-types").PreparedStatementLike>,plainRow:(row:any)=>any}} dependencies @returns {import("./domain-types").AiStore} */
function createLocalAiMethods({ statements, plainRow }) {
  /** @param {string} name */
  const statement = (name) => {
    const prepared = statements[name];
    if (!prepared) throw new Error(`Missing Strata AI statement: ${name}`);
    return prepared;
  };
  return {
    async aiSettings(userId) {
      return plainRow(statement("aiSettings").get(userId));
    },
    async upsertAiSettings(userId, settings) {
      return plainRow(
        statement("upsertAiSettings").get(
          settings.consentAt,
          settings.consentVersion,
          settings.dailyBrief ? 1 : 0,
          settings.updatedAt,
          userId,
        ),
      );
    },
    async briefCandidates(limit, offset) {
      return statement("briefCandidates")
        .all(limit, offset)
        .map((row) => plainRow(row));
    },
    async aiUsage(date, scope) {
      return statement("aiUsage")
        .all(date, scope)
        .map((row) => plainRow(row));
    },
    async addAiUsage(date, scope, kind, requests, tokens) {
      statement("addAiUsage").run(date, scope, kind, requests, tokens);
    },
    async refundAiUsage(date, scope, kind) {
      statement("refundAiUsage").run(date, scope, kind);
    },
    async claimMemberAiRequest(date, userId, kind, limit) {
      return Boolean(
        plainRow(
          statement("claimMemberAiRequest").get(...memberClaimArgs(date, userId, kind, limit)),
        ),
      );
    },
    async claimGlobalAiRequest(date, kind, dailyLimit, kindLimit) {
      return Boolean(
        plainRow(
          statement("claimGlobalAiRequest").get(
            ...globalClaimArgs(date, kind, dailyLimit, kindLimit),
          ),
        ),
      );
    },
    async aiUsageTotals(date) {
      return statement("aiUsageTotals")
        .all(date)
        .map((row) => plainRow(row));
    },
    async aiUsageTop(date, limit) {
      return statement("aiUsageTop")
        .all(date, limit)
        .map((row) => plainRow(row));
    },
    async deleteOldAiUsage(beforeDate) {
      statement("deleteOldAiUsage").run(beforeDate);
    },
    async insertAiJob(job) {
      return plainRow(statement("insertAiJob").get(...jobArgs(job)));
    },
    async aiJob(id, userId) {
      return plainRow(statement("aiJob").get(id, userId));
    },
    async activeAiJob(userId) {
      return plainRow(statement("activeAiJob").get(userId));
    },
    async queuedAiJobs() {
      return Number(plainRow(statement("queuedAiJobs").get())?.count || 0);
    },
    async aiJobPosition(id) {
      return Number(plainRow(statement("aiJobPosition").get(id))?.position || 0);
    },
    async claimAiJob(leaseUntil) {
      return plainRow(statement("claimAiJob").get(leaseUntil));
    },
    async finishAiJob(id, outcome) {
      statement("finishAiJob").run(...finishArgs(id, outcome));
    },
    async requeueStaleAiJobs(now) {
      statement("requeueStaleAiJobs").run(now);
    },
    async deleteFinishedAiJobs(before) {
      statement("deleteFinishedAiJobs").run(before);
    },
  };
}

/** @param {{first:(sql:string,args:any[])=>Promise<any>,all:(sql:string,args:any[])=>Promise<any[]>,run:(sql:string,args:any[])=>Promise<any>}} dependencies @returns {import("./domain-types").AiStore} */
function createTursoAiMethods({ first, all, run }) {
  return {
    aiSettings: (userId) => first(AI_SQL.aiSettings, [userId]),
    upsertAiSettings: (userId, settings) =>
      first(AI_SQL.upsertAiSettings, [
        settings.consentAt,
        settings.consentVersion,
        settings.dailyBrief ? 1 : 0,
        settings.updatedAt,
        userId,
      ]),
    briefCandidates: (limit, offset) => all(AI_SQL.briefCandidates, [limit, offset]),
    aiUsage: (date, scope) => all(AI_SQL.aiUsage, [date, scope]),
    async addAiUsage(date, scope, kind, requests, tokens) {
      await run(AI_SQL.addAiUsage, [date, scope, kind, requests, tokens]);
    },
    async refundAiUsage(date, scope, kind) {
      await run(AI_SQL.refundAiUsage, [date, scope, kind]);
    },
    async claimMemberAiRequest(date, userId, kind, limit) {
      return Boolean(
        await first(AI_SQL.claimMemberAiRequest, memberClaimArgs(date, userId, kind, limit)),
      );
    },
    async claimGlobalAiRequest(date, kind, dailyLimit, kindLimit) {
      return Boolean(
        await first(
          AI_SQL.claimGlobalAiRequest,
          globalClaimArgs(date, kind, dailyLimit, kindLimit),
        ),
      );
    },
    aiUsageTotals: (date) => all(AI_SQL.aiUsageTotals, [date]),
    aiUsageTop: (date, limit) => all(AI_SQL.aiUsageTop, [date, limit]),
    async deleteOldAiUsage(beforeDate) {
      await run(AI_SQL.deleteOldAiUsage, [beforeDate]);
    },
    insertAiJob: (job) => first(AI_SQL.insertAiJob, jobArgs(job)),
    aiJob: (id, userId) => first(AI_SQL.aiJob, [id, userId]),
    activeAiJob: (userId) => first(AI_SQL.activeAiJob, [userId]),
    async queuedAiJobs() {
      return Number((await first(AI_SQL.queuedAiJobs, []))?.count || 0);
    },
    async aiJobPosition(id) {
      return Number((await first(AI_SQL.aiJobPosition, [id]))?.position || 0);
    },
    claimAiJob: (leaseUntil) => first(AI_SQL.claimAiJob, [leaseUntil]),
    async finishAiJob(id, outcome) {
      await run(AI_SQL.finishAiJob, finishArgs(id, outcome));
    },
    async requeueStaleAiJobs(now) {
      await run(AI_SQL.requeueStaleAiJobs, [now]);
    },
    async deleteFinishedAiJobs(before) {
      await run(AI_SQL.deleteFinishedAiJobs, [before]);
    },
  };
}

/** @param {Record<string,import("./domain-types").PreparedStatementLike>} statements @param {string} userId */
function deleteLocalAiData(statements, userId) {
  for (const name of ["deleteAiSettingsForDeletedUser", "deleteAiUsageForDeletedUser"]) {
    const statement = statements[name];
    if (!statement) throw new Error(`Missing Strata AI deletion statement: ${name}`);
    statement.run(userId, userId);
  }
}

/** @param {string} userId */
function aiDeletionBatch(userId) {
  return [
    { sql: AI_SQL.deleteAiSettingsForDeletedUser, args: [userId, userId] },
    { sql: AI_SQL.deleteAiUsageForDeletedUser, args: [userId, userId] },
  ];
}

module.exports = { aiDeletionBatch, createLocalAiMethods, createTursoAiMethods, deleteLocalAiData };
