// @ts-check
"use strict";
const { TRAINING_LOOP_SQL } = require("./training-loop-schema");
/**
 * @param {import("./domain-types").LocalTrainingStoreDependencies} dependencies
 * @returns {import("./domain-types").TrainingStore}
 */
function createLocalTrainingMethods({ db, statements, plainRow }) {
  return {
    async workoutCheckIn(userId, workoutId) {
      return plainRow(statements.workoutCheckIn.get(userId, workoutId));
    },
    async upsertWorkoutCheckIn(record) {
      return plainRow(
        statements.upsertWorkoutCheckIn.get(
          record.userId,
          record.difficulty,
          record.energy,
          record.comfort,
          record.enjoyment,
          record.createdAt,
          record.updatedAt,
          record.userId,
          record.workoutId,
        ),
      );
    },
    async trainingBlock(userId) {
      return plainRow(statements.trainingBlock.get(userId));
    },
    async upsertTrainingBlock(record, expectedRevision) {
      return plainRow(
        statements.upsertTrainingBlock.get(
          record.blockJson,
          record.updatedAt,
          record.userId,
          expectedRevision,
          expectedRevision,
          expectedRevision,
        ),
      );
    },
    async deleteWorkout(userId, id, expectedRevision) {
      let open = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        open = true;
        const deleted = plainRow(statements.deleteWorkout.get(userId, id, expectedRevision));
        if (!deleted) {
          db.exec("ROLLBACK");
          open = false;
          return false;
        }
        statements.deleteTrainingAdaptationsForWorkout.run(userId, id, userId, id);
        statements.deleteWorkoutCheckInForWorkout.run(userId, id, userId, id);
        db.exec("COMMIT");
        open = false;
        return true;
      } catch (error) {
        if (open)
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original failure. */
          }
        throw error;
      }
    },
    async trainingAdaptation(userId, id) {
      return plainRow(statements.trainingAdaptation.get(userId, id));
    },
    async latestTrainingAdaptation(userId) {
      return plainRow(statements.latestTrainingAdaptation.get(userId));
    },
    async upsertTrainingAdaptation(record) {
      return plainRow(
        statements.upsertTrainingAdaptation.get(
          record.userId,
          record.id,
          record.adaptationJson,
          record.planUpdatedAt,
          record.createdAt,
          record.planUpdatedAt,
          record.userId,
          record.workoutId,
          record.checkInUpdatedAt,
          record.id,
        ),
      );
    },
    async dismissTrainingAdaptation(userId, id, resolvedAt, checkInUpdatedAt = null) {
      return plainRow(
        statements.dismissTrainingAdaptation.get(
          resolvedAt,
          userId,
          id,
          checkInUpdatedAt,
          checkInUpdatedAt,
        ),
      );
    },
    async acceptTrainingAdaptation(record) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const plan = plainRow(
          statements.applyTrainingAdaptationPlan.get(
            record.planJson,
            record.resolvedAt,
            record.userId,
            record.expectedPlanUpdatedAt,
            record.userId,
            record.id,
            record.expectedPlanUpdatedAt,
            record.expectedCheckInUpdatedAt,
          ),
        );
        if (!plan) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        const adaptation = plainRow(
          statements.acceptTrainingAdaptation.get(
            record.resolvedAt,
            record.userId,
            record.id,
            record.expectedPlanUpdatedAt,
          ),
        );
        if (!adaptation)
          throw new Error("Accepted training plan could not be linked to its proposal.");
        db.exec("COMMIT");
        transactionOpen = false;
        return { plan, adaptation };
      } catch (error) {
        if (transactionOpen)
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original failure. */
          }
        throw error;
      }
    },
  };
}
/**
 * @param {import("./domain-types").TursoTrainingStoreDependencies} dependencies
 * @returns {import("./domain-types").TrainingStore}
 */
function createTursoTrainingMethods({ client, first, run, plainRow }) {
  /** @param {string} sql @param {any[]} args */
  async function returned(sql, args) {
    const result = await run(sql, args);
    return plainRow(result.rows?.[0], result.columns);
  }
  return {
    workoutCheckIn: (userId, workoutId) =>
      first(TRAINING_LOOP_SQL.workoutCheckIn, [userId, workoutId]),
    upsertWorkoutCheckIn: (record) =>
      returned(TRAINING_LOOP_SQL.upsertWorkoutCheckIn, [
        record.userId,
        record.difficulty,
        record.energy,
        record.comfort,
        record.enjoyment,
        record.createdAt,
        record.updatedAt,
        record.userId,
        record.workoutId,
      ]),
    trainingBlock: (userId) => first(TRAINING_LOOP_SQL.trainingBlock, [userId]),
    upsertTrainingBlock: (record, expectedRevision) =>
      returned(TRAINING_LOOP_SQL.upsertTrainingBlock, [
        record.blockJson,
        record.updatedAt,
        record.userId,
        expectedRevision,
        expectedRevision,
        expectedRevision,
      ]),
    async deleteWorkout(userId, id, expectedRevision) {
      const results = await client.batch(
        [
          { sql: TRAINING_LOOP_SQL.deleteWorkout, args: [userId, id, expectedRevision] },
          {
            sql: TRAINING_LOOP_SQL.deleteTrainingAdaptationsForWorkout,
            args: [userId, id, userId, id],
          },
          { sql: TRAINING_LOOP_SQL.deleteWorkoutCheckInForWorkout, args: [userId, id, userId, id] },
        ],
        "write",
      );
      return Boolean(plainRow(results[0]?.rows?.[0], results[0]?.columns));
    },
    trainingAdaptation: (userId, id) => first(TRAINING_LOOP_SQL.trainingAdaptation, [userId, id]),
    latestTrainingAdaptation: (userId) =>
      first(TRAINING_LOOP_SQL.latestTrainingAdaptation, [userId]),
    upsertTrainingAdaptation: (record) =>
      returned(TRAINING_LOOP_SQL.upsertTrainingAdaptation, [
        record.userId,
        record.id,
        record.adaptationJson,
        record.planUpdatedAt,
        record.createdAt,
        record.planUpdatedAt,
        record.userId,
        record.workoutId,
        record.checkInUpdatedAt,
        record.id,
      ]),
    dismissTrainingAdaptation: (userId, id, resolvedAt, checkInUpdatedAt = null) =>
      returned(TRAINING_LOOP_SQL.dismissTrainingAdaptation, [
        resolvedAt,
        userId,
        id,
        checkInUpdatedAt,
        checkInUpdatedAt,
      ]),
    async acceptTrainingAdaptation(record) {
      const results = await client.batch(
        [
          {
            sql: TRAINING_LOOP_SQL.applyTrainingAdaptationPlan,
            args: [
              record.planJson,
              record.resolvedAt,
              record.userId,
              record.expectedPlanUpdatedAt,
              record.userId,
              record.id,
              record.expectedPlanUpdatedAt,
              record.expectedCheckInUpdatedAt,
            ],
          },
          {
            sql: TRAINING_LOOP_SQL.acceptTrainingAdaptation,
            args: [record.resolvedAt, record.userId, record.id, record.expectedPlanUpdatedAt],
          },
        ],
        "write",
      );
      const plan = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      const adaptation = plainRow(results[1]?.rows?.[0], results[1]?.columns);
      if (!plan) return null;
      if (!adaptation)
        throw new Error("Accepted training plan could not be linked to its proposal.");
      return { plan, adaptation };
    },
  };
}

/** @param {import("./domain-types").LocalTrainingStoreDependencies["statements"]} statements @param {string} userId */
function deleteLocalTrainingData(statements, userId) {
  statements.deleteTrainingAdaptationsForDeletedUser.run(userId, userId);
  statements.deleteWorkoutCheckInsForDeletedUser.run(userId, userId);
  statements.deleteTrainingBlockForDeletedUser.run(userId, userId);
}

/** @param {string} userId */
function trainingDeletionBatch(userId) {
  return [
    { sql: TRAINING_LOOP_SQL.deleteTrainingAdaptationsForDeletedUser, args: [userId, userId] },
    { sql: TRAINING_LOOP_SQL.deleteWorkoutCheckInsForDeletedUser, args: [userId, userId] },
    { sql: TRAINING_LOOP_SQL.deleteTrainingBlockForDeletedUser, args: [userId, userId] },
  ];
}

module.exports = {
  createLocalTrainingMethods,
  createTursoTrainingMethods,
  deleteLocalTrainingData,
  trainingDeletionBatch,
};
