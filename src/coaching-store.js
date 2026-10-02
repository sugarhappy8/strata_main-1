// @ts-check
"use strict";

const { COACHING_SQL } = require("./coaching-schema");

/** @param {import("./domain-types").LocalCoachingStoreDependencies} dependencies @returns {import("./domain-types").CoachingStore} */
function createLocalCoachingMethods({ statements, plainRow }) {
  /** @param {string} name */
  const statement = (name) => {
    const prepared = statements[name];
    if (!prepared) throw new Error(`Missing coaching statement: ${name}`);
    return prepared;
  };
  return {
    async coachingProfile(userId) {
      return plainRow(statement("coachingProfile").get(userId));
    },
    async upsertCoachingProfile(userId, profileJson, updatedAt, expectedRevision) {
      return plainRow(
        statement("upsertCoachingProfile").get(
          profileJson,
          updatedAt,
          userId,
          expectedRevision,
          expectedRevision,
          expectedRevision,
        ),
      );
    },
    async coachingWeek(userId, weekStart) {
      return plainRow(statement("coachingWeek").get(userId, weekStart));
    },
    async upsertCoachingWeek(record) {
      return plainRow(
        statement("upsertCoachingWeek").get(
          record.weekStart,
          record.planKey,
          record.profileRevision,
          record.snapshotJson,
          record.generatedAt,
          record.profileRevision,
          record.userId,
        ),
      );
    },
    async coachingDailyLog(userId, logDate) {
      return plainRow(statement("coachingDailyLog").get(userId, logDate));
    },
    async coachingDailyLogs(userId, startDate, endDate) {
      return statement("coachingDailyLogs")
        .all(userId, startDate, endDate)
        .map((row) => plainRow(row));
    },
    async upsertCoachingDailyLog(record, expectedRevision) {
      return plainRow(
        statement("upsertCoachingDailyLog").get(
          record.logDate,
          record.calories,
          record.proteinG,
          record.carbsG,
          record.fatG,
          record.morningWeightKg ?? null,
          record.complete == null ? null : Number(record.complete),
          record.updatedAt,
          record.userId,
          expectedRevision,
          record.logDate,
          expectedRevision,
          expectedRevision,
        ),
      );
    },
  };
}

/** @param {import("./domain-types").TursoCoachingStoreDependencies} dependencies @returns {import("./domain-types").CoachingStore} */
function createTursoCoachingMethods({ first, all }) {
  return {
    coachingProfile: (userId) => first(COACHING_SQL.coachingProfile, [userId]),
    upsertCoachingProfile: (userId, profileJson, updatedAt, expectedRevision) =>
      first(COACHING_SQL.upsertCoachingProfile, [
        profileJson,
        updatedAt,
        userId,
        expectedRevision,
        expectedRevision,
        expectedRevision,
      ]),
    coachingWeek: (userId, weekStart) => first(COACHING_SQL.coachingWeek, [userId, weekStart]),
    upsertCoachingWeek: (record) =>
      first(COACHING_SQL.upsertCoachingWeek, [
        record.weekStart,
        record.planKey,
        record.profileRevision,
        record.snapshotJson,
        record.generatedAt,
        record.profileRevision,
        record.userId,
      ]),
    coachingDailyLog: (userId, logDate) => first(COACHING_SQL.coachingDailyLog, [userId, logDate]),
    coachingDailyLogs: (userId, startDate, endDate) =>
      all(COACHING_SQL.coachingDailyLogs, [userId, startDate, endDate]),
    upsertCoachingDailyLog: (record, expectedRevision) =>
      first(COACHING_SQL.upsertCoachingDailyLog, [
        record.logDate,
        record.calories,
        record.proteinG,
        record.carbsG,
        record.fatG,
        record.morningWeightKg ?? null,
        record.complete == null ? null : Number(record.complete),
        record.updatedAt,
        record.userId,
        expectedRevision,
        record.logDate,
        expectedRevision,
        expectedRevision,
      ]),
  };
}

/** @param {Record<string,import("./domain-types").PreparedStatementLike>} statements @param {string} userId */
function deleteLocalCoachingData(statements, userId) {
  for (const name of [
    "deleteCoachingLogsForDeletedUser",
    "deleteCoachingWeeksForDeletedUser",
    "deleteCoachingProfileForDeletedUser",
  ]) {
    const statement = statements[name];
    if (!statement) throw new Error(`Missing coaching deletion statement: ${name}`);
    statement.run(userId, userId);
  }
}

/** @param {string} userId */
function coachingDeletionBatch(userId) {
  return [
    { sql: COACHING_SQL.deleteCoachingLogsForDeletedUser, args: [userId, userId] },
    { sql: COACHING_SQL.deleteCoachingWeeksForDeletedUser, args: [userId, userId] },
    { sql: COACHING_SQL.deleteCoachingProfileForDeletedUser, args: [userId, userId] },
  ];
}

module.exports = {
  coachingDeletionBatch,
  createLocalCoachingMethods,
  createTursoCoachingMethods,
  deleteLocalCoachingData,
};
