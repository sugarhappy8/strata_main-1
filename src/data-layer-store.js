// @ts-check
"use strict";

const { DATA_LAYER_SQL } = require("./data-layer-schema");

// Plan history keeps the latest 50 changes, plus the latest change of each day for this long: longer than any
// window the owner's metrics read (12 weeks of activity, 8-week retention).
const PLAN_CHANGE_DAYS = 120;
/** @param {{createdAt:number}} change */
const dailySince = (change) => Number(change.createdAt) - PLAN_CHANGE_DAYS * 24 * 60 * 60 * 1000;

/** @param {{statements:Record<string,import("./domain-types").PreparedStatementLike>,plainRow:(row:any)=>any}} dependencies @returns {import("./domain-types").DataLayerStore} */
function createLocalDataLayerMethods({ statements, plainRow }) {
  /** @param {string} name */
  const statement = (name) => {
    const prepared = statements[name];
    if (!prepared) throw new Error(`Missing data-layer statement: ${name}`);
    return prepared;
  };
  return {
    async trainingLinks(userId) {
      return statement("trainingLinks")
        .all(userId)
        .map((row) => plainRow(row));
    },
    async upsertTrainingLink(userId, link) {
      statement("upsertTrainingLink").run(
        link.provider,
        link.externalId,
        link.workoutId,
        link.method,
        link.linkedAt,
        userId,
      );
    },
    async deleteTrainingLink(userId, provider, externalId) {
      statement("deleteTrainingLink").run(userId, provider, externalId);
    },
    async dailySnapshots(userId, fromDate, toDate) {
      return statement("dailySnapshots")
        .all(userId, fromDate, toDate)
        .map((row) => plainRow(row));
    },
    async upsertDailySnapshot(userId, date, snapshotJson, updatedAt) {
      statement("upsertDailySnapshot").run(date, snapshotJson, updatedAt, userId);
    },
    async saveDailyBrief(userId, date, briefJson, generatedAt) {
      return (
        Number(
          statement("saveDailyBrief").run(briefJson, generatedAt, generatedAt, userId, date)
            .changes,
        ) === 1
      );
    },
    async deleteDailyBriefs(userId, updatedAt) {
      statement("deleteDailyBriefs").run(updatedAt, userId);
    },
    async deleteOldDailySnapshots(beforeDate) {
      statement("deleteOldDailySnapshots").run(beforeDate);
    },
    async deleteUserDailySnapshots(userId) {
      statement("deleteUserDailySnapshots").run(userId);
    },
    async deleteTrainingLinksForProvider(userId, provider) {
      statement("deleteTrainingLinksForProvider").run(userId, provider);
    },
    async insertPlanChange(userId, change, keep = 50) {
      statement("insertPlanChange").run(
        change.planUpdatedAt,
        change.source,
        change.detail,
        change.createdAt,
        userId,
      );
      statement("prunePlanChanges").run(userId, userId, keep, userId, dailySince(change));
    },
    async planChanges(userId, limit) {
      return statement("planChanges")
        .all(userId, limit)
        .map((row) => plainRow(row));
    },
  };
}

/** @param {{first:(sql:string,args:any[])=>Promise<any>,all:(sql:string,args:any[])=>Promise<any[]>,run:(sql:string,args:any[])=>Promise<any>}} dependencies @returns {import("./domain-types").DataLayerStore} */
function createTursoDataLayerMethods({ all, run }) {
  return {
    trainingLinks: (userId) => all(DATA_LAYER_SQL.trainingLinks, [userId]),
    async upsertTrainingLink(userId, link) {
      await run(DATA_LAYER_SQL.upsertTrainingLink, [
        link.provider,
        link.externalId,
        link.workoutId,
        link.method,
        link.linkedAt,
        userId,
      ]);
    },
    async deleteTrainingLink(userId, provider, externalId) {
      await run(DATA_LAYER_SQL.deleteTrainingLink, [userId, provider, externalId]);
    },
    dailySnapshots: (userId, fromDate, toDate) =>
      all(DATA_LAYER_SQL.dailySnapshots, [userId, fromDate, toDate]),
    async upsertDailySnapshot(userId, date, snapshotJson, updatedAt) {
      await run(DATA_LAYER_SQL.upsertDailySnapshot, [date, snapshotJson, updatedAt, userId]);
    },
    async saveDailyBrief(userId, date, briefJson, generatedAt) {
      const result = await run(DATA_LAYER_SQL.saveDailyBrief, [
        briefJson,
        generatedAt,
        generatedAt,
        userId,
        date,
      ]);
      return Number(result?.rowsAffected ?? result?.changes ?? 0) === 1;
    },
    async deleteDailyBriefs(userId, updatedAt) {
      await run(DATA_LAYER_SQL.deleteDailyBriefs, [updatedAt, userId]);
    },
    async deleteOldDailySnapshots(beforeDate) {
      await run(DATA_LAYER_SQL.deleteOldDailySnapshots, [beforeDate]);
    },
    async deleteUserDailySnapshots(userId) {
      await run(DATA_LAYER_SQL.deleteUserDailySnapshots, [userId]);
    },
    async deleteTrainingLinksForProvider(userId, provider) {
      await run(DATA_LAYER_SQL.deleteTrainingLinksForProvider, [userId, provider]);
    },
    async insertPlanChange(userId, change, keep = 50) {
      await run(DATA_LAYER_SQL.insertPlanChange, [
        change.planUpdatedAt,
        change.source,
        change.detail,
        change.createdAt,
        userId,
      ]);
      await run(DATA_LAYER_SQL.prunePlanChanges, [
        userId,
        userId,
        keep,
        userId,
        dailySince(change),
      ]);
    },
    planChanges: (userId, limit) => all(DATA_LAYER_SQL.planChanges, [userId, limit]),
  };
}

/** @param {Record<string,import("./domain-types").PreparedStatementLike>} statements @param {string} userId */
function deleteLocalDataLayerData(statements, userId) {
  for (const name of [
    "deleteTrainingLinksForDeletedUser",
    "deleteDailySnapshotsForDeletedUser",
    "deletePlanChangesForDeletedUser",
  ]) {
    const statement = statements[name];
    if (!statement) throw new Error(`Missing data-layer deletion statement: ${name}`);
    statement.run(userId, userId);
  }
}

/** @param {string} userId */
function dataLayerDeletionBatch(userId) {
  return [
    { sql: DATA_LAYER_SQL.deleteTrainingLinksForDeletedUser, args: [userId, userId] },
    { sql: DATA_LAYER_SQL.deleteDailySnapshotsForDeletedUser, args: [userId, userId] },
    { sql: DATA_LAYER_SQL.deletePlanChangesForDeletedUser, args: [userId, userId] },
  ];
}

module.exports = {
  createLocalDataLayerMethods,
  createTursoDataLayerMethods,
  dataLayerDeletionBatch,
  deleteLocalDataLayerData,
};
