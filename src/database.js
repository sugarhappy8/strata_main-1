"use strict";

const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const {
  SCHEMA,
  SQL,
  WORKOUT_ACTIVE_INDEX,
  RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,
  PRODUCT_SIGNAL_TABLE,
} = require("./schema");
const { defineStore } = require("./store-contract");
const {
  createLocalTrainingMethods,
  createTursoTrainingMethods,
  deleteLocalTrainingData,
  trainingDeletionBatch,
} = require("./training-loop-store");
const {
  createLocalAccountSelfServiceMethods,
  createTursoAccountSelfServiceMethods,
} = require("./account-self-service-store");
const { createLocalBillingMethods, createTursoBillingMethods } = require("./billing-store");
const {
  createLocalAccessControlMethods,
  createTursoAccessControlMethods,
} = require("./access-controls-store");
const {
  coachingDeletionBatch,
  createLocalCoachingMethods,
  createTursoCoachingMethods,
  deleteLocalCoachingData,
} = require("./coaching-store");
const { createLocalDeviceMethods, createTursoDeviceMethods } = require("./devices-store");
const {
  createLocalDataLayerMethods,
  createTursoDataLayerMethods,
  dataLayerDeletionBatch,
  deleteLocalDataLayerData,
} = require("./data-layer-store");
const {
  aiDeletionBatch,
  createLocalAiMethods,
  createTursoAiMethods,
  deleteLocalAiData,
} = require("./ai-store");
const { createLocalMetricsMethods, createTursoMetricsMethods } = require("./metrics-store");
const {
  appleDeletionBatch,
  createLocalAppleBillingMethods,
  createTursoAppleBillingMethods,
  deleteLocalAppleData,
} = require("./apple-billing-store");
const {
  createLocalSocialAuthMethods,
  createTursoSocialAuthMethods,
} = require("./social-auth-store");
const {
  createLocalServerStateMethods,
  createTursoServerStateMethods,
} = require("./server-state-store");
const { migrateLocalSchema, migrateTursoSchema } = require("./migrations");
function plainValue(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

function plainRow(row, columns) {
  if (row == null) return null;
  const namedColumns = Array.isArray(columns)
    ? columns
        .map((name, index) => ({ name, index }))
        .filter(({ name }) => typeof name === "string" && name.length > 0)
    : [];
  if (namedColumns.length) {
    const source = Object(row),
      seen = new Set(),
      entries = [];
    for (const { name, index } of namedColumns) {
      if (seen.has(name)) continue;
      seen.add(name);
      const value = index in source ? source[index] : source[name];
      entries.push([name, plainValue(value)]);
    }
    return Object.fromEntries(entries);
  }
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plainValue(value)]));
}

function plainRows(rows, columns) {
  return rows.map((row) => plainRow(row, columns));
}

function affectedRows(result) {
  return Number(result?.changes ?? result?.rowsAffected ?? 0);
}

const CONSUMED_VERIFICATION_RETENTION_MS = 60 * 60 * 1000;
const VERIFICATION_SEND_RETENTION_MS = 24 * 60 * 60 * 1000;

function verificationInsertArgs(verification) {
  const purpose = verification.purpose ?? "signup";
  if (purpose !== "signup" && purpose !== "login")
    throw new TypeError("Verification purpose must be signup or login.");
  return [
    verification.challengeId,
    verification.browserTokenHash,
    verification.userId,
    purpose,
    verification.email,
    verification.name,
    verification.passwordHash,
    verification.passwordSalt,
    verification.codeDigest,
    Number(verification.generation ?? 1),
    Number(verification.attemptsUsed ?? 0),
    Number(verification.sendCount ?? 0),
    Number(verification.lastSentAt),
    Number(verification.expiresAt),
    Number(verification.hardExpiresAt),
    verification.deliveryState,
    Number(verification.createdAt),
    Number(verification.updatedAt),
  ];
}

function verificationRotationArgs(challengeId, currentGeneration, rotation) {
  return [
    rotation.codeDigest,
    Number(rotation.lastSentAt),
    Number(rotation.expiresAt),
    rotation.deliveryState,
    Number(rotation.updatedAt),
    challengeId,
    Number(currentGeneration),
  ];
}

function verificationSendArgs(send) {
  return [send.id, send.emailHash, send.challengeId, Number(send.generation), Number(send.sentAt)];
}

function verificationSendClaimArgs(send, since, maxSends) {
  return [...verificationSendArgs(send), send.emailHash, Number(since), Number(maxSends)];
}

function accountActionArgs(action) {
  if (action.purpose !== "password_reset" && action.purpose !== "account_delete") {
    throw new TypeError("Account action purpose must be password_reset or account_delete.");
  }
  return [
    action.requestId,
    action.userId,
    action.purpose,
    action.tokenHash,
    Number(action.expiresAt),
    action.deliveryState,
    Number(action.createdAt),
    Number(action.updatedAt),
  ];
}

// In-app deletion has no emailed token. The store records a short-lived internal account_delete action and consumes
// it through the same deletion path an emailed link takes, so there is one deletion path for both.
function internalDeleteAction(userId, tokenHash, at) {
  return {
    requestId: `in-app-${String(tokenHash).slice(0, 40)}`,
    userId,
    purpose: "account_delete",
    tokenHash,
    expiresAt: Number(at) + 60_000,
    deliveryState: "sent",
    createdAt: Number(at),
    updatedAt: Number(at),
  };
}

function stagedAccountActionArgs(action) {
  if (action.purpose !== "password_reset" && action.purpose !== "account_delete") {
    throw new TypeError("Account action purpose must be password_reset or account_delete.");
  }
  return [
    action.requestId,
    action.userId,
    action.purpose,
    action.tokenHash,
    Number(action.expiresAt),
    Number(action.createdAt),
  ];
}

function accountActionSendArgs(send, since, maxSends) {
  if (send.purpose !== "password_reset" && send.purpose !== "account_delete") {
    throw new TypeError("Account action send purpose must be password_reset or account_delete.");
  }
  return [
    send.id,
    send.emailHash,
    send.purpose,
    Number(send.sentAt),
    send.emailHash,
    send.purpose,
    Number(since),
    Number(maxSends),
  ];
}

function likePattern(value) {
  return `%${String(value || "")
    .toLowerCase()
    .replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function adminSearchArgs(query) {
  const clean = String(query || "")
    .trim()
    .toLowerCase();
  const pattern = likePattern(clean);
  return [clean, pattern, pattern, pattern, pattern];
}

function adminAuditArgs(event) {
  return [
    event.id,
    event.actorUserId,
    event.targetUserId || null,
    event.action,
    event.reason,
    event.result || "success",
    Number(event.createdAt),
  ];
}

async function probeConnection(query) {
  await query();
  return true;
}

function localStore(root) {
  const { DatabaseSync } = require("node:sqlite");
  const dataDir = process.env.STRATA_DATA_DIR || join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "strata.sqlite"), {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  for (const statement of SCHEMA) if (statement !== WORKOUT_ACTIVE_INDEX) db.exec(statement);
  migrateLocalSchema(db, {
    activeWorkoutIndex: WORKOUT_ACTIVE_INDEX,
    reconcileActiveWorkouts: RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,
    productSignalTable: PRODUCT_SIGNAL_TABLE,
  });

  const statements = Object.fromEntries(
    Object.entries(SQL).map(([name, sql]) => [name, db.prepare(sql)]),
  );
  const trainingMethods = createLocalTrainingMethods({ db, statements, plainRow });
  const accountSelfServiceMethods = createLocalAccountSelfServiceMethods({
    db,
    statements,
    plainRow,
  });
  const billingMethods = createLocalBillingMethods({ db, statements, plainRow });
  const coachingMethods = createLocalCoachingMethods({ statements, plainRow }),
    deviceMethods = createLocalDeviceMethods({ db, statements, plainRow }),
    dataLayerMethods = createLocalDataLayerMethods({ statements, plainRow }),
    aiMethods = createLocalAiMethods({ statements, plainRow });
  // The emailed link and the in-app route both delete here. An in-app request first records its internal action
  // inside the same transaction, so a refused deletion rolls back to exactly the previous state.
  function deleteAccountLocal(tokenHash, deletedAt, emailHash, internalAction = null) {
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      if (internalAction) statements.upsertAccountAction.get(...accountActionArgs(internalAction));
      const action = plainRow(statements.accountActionByTokenHash.get(tokenHash));
      if (
        !action ||
        action.purpose !== "account_delete" ||
        action.delivery_state !== "sent" ||
        action.consumed_at != null ||
        Number(action.expires_at) <= deletedAt
      ) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { status: "invalid" };
      }
      if (
        Number(
          plainRow(statements.pendingPurchasesForUser.get(action.user_id))?.pending_count || 0,
        ) > 0
      ) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { status: "purchase_pending" };
      }
      if (plainRow(statements.activeCheckoutCreationForUser.get(action.user_id, deletedAt))) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { status: "checkout_pending" };
      }
      const user = plainRow(statements.deleteUserWithAction.get(tokenHash, deletedAt, deletedAt));
      if (!user) throw new Error("Account deletion did not remove the requested user.");
      // Keep deletion complete even if a future database connection loses
      // its per-session foreign-key PRAGMA state.
      statements.deleteAdminControlsForDeletedUser.run(user.id, user.id);
      deleteLocalTrainingData(statements, user.id);
      deleteLocalCoachingData(statements, user.id);
      deleteLocalDataLayerData(statements, user.id);
      deleteLocalAiData(statements, user.id);
      deleteLocalAppleData(statements, user.id);
      statements.deleteWorkoutsForDeletedUser.run(user.id, user.id);
      statements.deleteCheckoutClaimsForDeletedUser.all(user.id, user.id);
      statements.deleteVerificationSendsForDeletedUser.run(user.id, user.email, user.id);
      statements.deleteVerificationsForDeletedUser.run(user.id, user.email, user.id);
      statements.deleteActionSendsForDeletedUser.run(emailHash, user.id);
      db.exec("COMMIT");
      transactionOpen = false;
      return { status: "deleted", user };
    } catch (error) {
      if (transactionOpen) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* Preserve the original transaction error. */
        }
      }
      throw error;
    }
  }
  return defineStore("local", {
    ...coachingMethods,
    ...deviceMethods,
    ...dataLayerMethods,
    ...aiMethods,
    ...createLocalMetricsMethods({ statements, plainRow }),
    ...createLocalAppleBillingMethods({ statements, plainRow }),
    ...createLocalSocialAuthMethods({ db, statements, plainRow }),
    ...createLocalServerStateMethods({ statements, plainRow }),
    ...createLocalAccessControlMethods({ db, statements, plainRow }),
    async ping() {
      return probeConnection(() => statements.ping.get());
    },
    async userByEmail(email) {
      return plainRow(statements.userByEmail.get(email));
    },
    async userById(id) {
      return plainRow(statements.userById.get(id));
    },
    async accountCredentialsById(id) {
      return plainRow(statements.accountCredentialsById.get(id));
    },
    async insertUser(user) {
      statements.insertUser.run(
        user.id,
        user.name,
        user.email,
        user.passwordHash,
        user.passwordSalt,
        user.createdAt,
        user.emailVerifiedAt ?? user.email_verified_at ?? null,
      );
    },
    async insertSession(session) {
      return Boolean(
        plainRow(
          statements.insertSession.get(
            session.tokenHash,
            session.csrfToken,
            session.expiresAt,
            session.createdAt,
            session.userId,
            Number(session.authVersion ?? 1),
          ),
        ),
      );
    },
    async session(tokenHash, now) {
      return plainRow(statements.session.get(tokenHash, now));
    },
    async renewSession(tokenHash, expiresAt, now) {
      return Boolean(plainRow(statements.renewSession.get(expiresAt, tokenHash, now, expiresAt)));
    },
    async deleteSession(tokenHash) {
      statements.deleteSession.run(tokenHash);
    },
    async deleteExpired(now) {
      statements.deleteExpired.run(now);
    },
    ...accountSelfServiceMethods,
    async verificationByTokenHash(tokenHash) {
      return plainRow(statements.verificationByTokenHash.get(tokenHash));
    },
    async insertVerification(verification) {
      statements.insertVerification.run(...verificationInsertArgs(verification));
      return plainRow(statements.verificationByChallenge.get(verification.challengeId));
    },
    async rotateVerification(challengeId, currentGeneration, rotation) {
      return plainRow(
        statements.rotateVerification.get(
          ...verificationRotationArgs(challengeId, currentGeneration, rotation),
        ),
      );
    },
    async markVerificationDelivery(challengeId, generation, state, updatedAt) {
      return Boolean(
        plainRow(
          statements.markVerificationDelivery.get(state, updatedAt, challengeId, generation),
        ),
      );
    },
    async claimVerificationAttempt(challengeId, generation, updatedAt, maxAttempts = 5) {
      return plainRow(
        statements.claimVerificationAttempt.get(
          updatedAt,
          challengeId,
          generation,
          updatedAt,
          updatedAt,
          maxAttempts,
        ),
      );
    },
    async consumeVerification(challengeId, generation, consumedAt) {
      return plainRow(
        statements.consumeVerification.get(consumedAt, consumedAt, challengeId, generation),
      );
    },
    async completeSignup(challengeId, generation, createdAt, session) {
      if (!session || !session.tokenHash || !session.csrfToken)
        throw new TypeError("A session is required to complete signup.");
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const user = plainRow(
          statements.completeSignupInsert.get(
            createdAt,
            createdAt,
            challengeId,
            generation,
            createdAt,
            createdAt,
          ),
        );
        if (!user) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        const consumed = plainRow(
          statements.completeSignupConsume.get(
            createdAt,
            createdAt,
            challengeId,
            generation,
            createdAt,
            createdAt,
          ),
        );
        if (!consumed) throw new Error("Verification could not be consumed atomically.");
        const insertedSession = plainRow(
          statements.completeSignupSession.get(
            session.tokenHash,
            session.csrfToken,
            session.expiresAt,
            session.createdAt,
            challengeId,
            generation,
            createdAt,
          ),
        );
        if (!insertedSession)
          throw new Error("Verification session could not be created atomically.");
        db.exec("COMMIT");
        transactionOpen = false;
        return user;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async completeLoginVerification(challengeId, generation, verifiedAt, session) {
      if (!session || !session.tokenHash || !session.csrfToken)
        throw new TypeError("A session is required to complete login verification.");
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const user = plainRow(
          statements.completeLoginVerifyUser.get(
            verifiedAt,
            challengeId,
            generation,
            verifiedAt,
            verifiedAt,
          ),
        );
        if (!user) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        const consumed = plainRow(
          statements.completeLoginConsume.get(
            verifiedAt,
            verifiedAt,
            challengeId,
            generation,
            verifiedAt,
            verifiedAt,
          ),
        );
        if (!consumed) throw new Error("Login verification could not be consumed atomically.");
        const insertedSession = plainRow(
          statements.completeLoginSession.get(
            session.tokenHash,
            session.csrfToken,
            session.expiresAt,
            session.createdAt,
            challengeId,
            generation,
            verifiedAt,
          ),
        );
        if (!insertedSession)
          throw new Error("Verified login session could not be created atomically.");
        // Only the freshly verified session should survive. The changes()
        // guard binds this cleanup to the session insert above, so a stale
        // sibling challenge cannot delete the winning session.
        statements.completeLoginDeleteOldSessions.all(
          challengeId,
          generation,
          verifiedAt,
          session.tokenHash,
        );
        db.exec("COMMIT");
        transactionOpen = false;
        return user;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async countVerificationSends(emailHash, since) {
      return Number(
        plainRow(statements.countVerificationSends.get(emailHash, since))?.send_count || 0,
      );
    },
    async recordVerificationSend(send) {
      statements.recordVerificationSend.run(...verificationSendArgs(send));
    },
    async claimVerificationSend(send, since, maxSends) {
      return Boolean(
        plainRow(
          statements.claimVerificationSend.get(...verificationSendClaimArgs(send, since, maxSends)),
        ),
      );
    },
    async verificationSendByChallengeGeneration(challengeId, generation) {
      return plainRow(
        statements.verificationSendByChallengeGeneration.get(challengeId, generation),
      );
    },
    async deleteOldVerificationData(now, sendBefore = now - VERIFICATION_SEND_RETENTION_MS) {
      const consumedBefore = now - CONSUMED_VERIFICATION_RETENTION_MS;
      const verifications = affectedRows(
        statements.deleteOldVerifications.run(now, consumedBefore),
      );
      const sends = affectedRows(statements.deleteOldVerificationSends.run(sendBefore));
      return { verifications, sends };
    },
    async accountActionByTokenHash(tokenHash) {
      return plainRow(statements.accountActionByTokenHash.get(tokenHash));
    },
    async accountActionForUser(userId, purpose) {
      return plainRow(statements.accountActionForUser.get(userId, purpose));
    },
    async upsertAccountAction(action) {
      return plainRow(statements.upsertAccountAction.get(...accountActionArgs(action)));
    },
    async markAccountActionDelivery(requestId, tokenHash, state, updatedAt) {
      return Boolean(
        plainRow(statements.markAccountActionDelivery.get(state, updatedAt, requestId, tokenHash)),
      );
    },
    async stageAccountAction(action) {
      return plainRow(statements.stageAccountAction.get(...stagedAccountActionArgs(action)));
    },
    async activateAccountAction(requestId, tokenHash, activatedAt) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const action = plainRow(
          statements.activateAccountAction.get(activatedAt, requestId, tokenHash, activatedAt),
        );
        if (!action) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        if (!plainRow(statements.discardStagedAccountAction.get(requestId, tokenHash))) {
          throw new Error("Staged account action could not be consumed atomically.");
        }
        db.exec("COMMIT");
        transactionOpen = false;
        return action;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async discardStagedAccountAction(requestId, tokenHash) {
      return Boolean(plainRow(statements.discardStagedAccountAction.get(requestId, tokenHash)));
    },
    async claimAccountActionSend(send, since, maxSends) {
      return Boolean(
        plainRow(
          statements.claimAccountActionSend.get(...accountActionSendArgs(send, since, maxSends)),
        ),
      );
    },
    async countAccountActionSends(emailHash, purpose, since) {
      return Number(
        plainRow(statements.countAccountActionSends.get(emailHash, purpose, since))?.send_count ||
          0,
      );
    },
    async activeAccountDeletion(userId, now) {
      return plainRow(statements.activeAccountDeletion.get(userId, now));
    },
    async cancelAccountDeletion(userId) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const active = plainRow(statements.cancelAccountDeletion.get(userId));
        const staged = plainRows(statements.cancelStagedAccountDeletions.all(userId));
        db.exec("COMMIT");
        transactionOpen = false;
        return Boolean(active || staged.length);
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async cancelAccountDeletionWithAudit(userId, audit) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const active = plainRow(statements.cancelAccountDeletion.get(userId));
        if (!active) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return false;
        }
        if (!plainRow(statements.insertAdminAuditIfChanged.get(...adminAuditArgs(audit))))
          throw new Error("Deletion-cancellation audit could not be recorded atomically.");
        statements.cancelStagedAccountDeletionsIfAudit.all(userId, audit.id);
        db.exec("COMMIT");
        transactionOpen = false;
        return true;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async completePasswordReset(tokenHash, passwordHash, passwordSalt, completedAt) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const action = plainRow(statements.accountActionByTokenHash.get(tokenHash));
        if (
          !action ||
          action.purpose !== "password_reset" ||
          action.delivery_state !== "sent" ||
          action.consumed_at != null ||
          Number(action.expires_at) <= completedAt
        ) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        const user = plainRow(
          statements.completePasswordResetUser.get(
            passwordHash,
            passwordSalt,
            completedAt,
            tokenHash,
            completedAt,
          ),
        );
        if (!user) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        const consumed = plainRow(
          statements.completePasswordResetConsume.get(
            completedAt,
            completedAt,
            tokenHash,
            completedAt,
          ),
        );
        if (!consumed) throw new Error("Password reset could not be consumed atomically.");
        statements.completePasswordResetDeleteSessions.all(tokenHash, completedAt);
        statements.completePasswordResetDeleteStagedActions.all(tokenHash, completedAt);
        statements.completePasswordResetDeleteActions.all(tokenHash, completedAt);
        db.exec("COMMIT");
        transactionOpen = false;
        return user;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async activeCheckoutCreationForUser(userId, now) {
      return plainRow(statements.activeCheckoutCreationForUser.get(userId, now));
    },
    async deleteAccount(tokenHash, deletedAt, emailHash) {
      return deleteAccountLocal(tokenHash, deletedAt, emailHash);
    },
    async deleteAccountForUser(userId, tokenHash, deletedAt, emailHash) {
      return deleteAccountLocal(
        tokenHash,
        deletedAt,
        emailHash,
        internalDeleteAction(userId, tokenHash, deletedAt),
      );
    },
    async deleteOldAccountActionData(now, sendBefore = now - VERIFICATION_SEND_RETENTION_MS) {
      const consumedBefore = now - CONSUMED_VERIFICATION_RETENTION_MS;
      const actions = affectedRows(statements.deleteOldAccountActions.run(now, consumedBefore));
      const staged = affectedRows(statements.deleteOldStagedAccountActions.run(now));
      const sends = affectedRows(statements.deleteOldAccountActionSends.run(sendBefore));
      return { actions: actions + staged, sends };
    },
    async workout(userId, id) {
      return plainRow(statements.workout.get(userId, id));
    },
    async activeWorkout(userId) {
      return plainRow(statements.activeWorkout.get(userId));
    },
    async workouts(userId, limit, offset) {
      return plainRows(statements.workouts.all(userId, limit, offset));
    },
    async workoutCount(userId) {
      return Number(statements.workoutCount.get(userId).count);
    },
    async insertWorkout(record) {
      return plainRow(
        statements.insertWorkout.get(
          record.id,
          record.workoutJson,
          record.summaryJson,
          record.createHash,
          record.startedAt,
          record.updatedAt,
          record.userId,
        ),
      );
    },
    async updateWorkout(record, expectedRevision) {
      return plainRow(
        statements.updateWorkout.get(
          record.workoutJson,
          record.summaryJson,
          record.updatedAt,
          record.userId,
          record.id,
          expectedRevision,
        ),
      );
    },
    async plan(userId) {
      return plainRow(statements.plan.get(userId));
    },
    async upsertPlan(userId, planJson, updatedAt, expectedUpdatedAt) {
      return plainRow(
        statements.upsertPlan.get(
          planJson,
          updatedAt,
          userId,
          expectedUpdatedAt,
          expectedUpdatedAt,
          expectedUpdatedAt,
          expectedUpdatedAt,
        ),
      );
    },
    async saveTrainingSetup(
      userId,
      planJson,
      preferencesJson,
      updatedAt,
      expectedUpdatedAt,
      expectedPreferencesUpdatedAt,
    ) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const plan = plainRow(
          statements.upsertPlanForSetup.get(
            planJson,
            updatedAt,
            expectedPreferencesUpdatedAt,
            userId,
            expectedPreferencesUpdatedAt,
            expectedUpdatedAt,
            expectedUpdatedAt,
            expectedUpdatedAt,
            expectedUpdatedAt,
          ),
        );
        if (!plan) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        statements.upsertPreferences.run(userId, preferencesJson, Number(plan.updated_at));
        db.exec("COMMIT");
        transactionOpen = false;
        return {
          ...plan,
          preferences_json: preferencesJson,
          preferences_updated_at: Number(plan.updated_at),
        };
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async monthlyPlan(userId) {
      return plainRow(statements.monthlyPlan.get(userId));
    },
    async upsertMonthlyPlan(userId, planJson, updatedAt, expectedUpdatedAt) {
      if (expectedUpdatedAt === undefined) {
        statements.upsertMonthlyPlan.run(userId, planJson, updatedAt);
        return;
      }
      return plainRow(
        statements.compareAndSwapMonthlyPlan.get(
          userId,
          planJson,
          updatedAt,
          userId,
          expectedUpdatedAt,
          expectedUpdatedAt,
        ),
      );
    },
    async preferences(userId) {
      return plainRow(statements.preferences.get(userId));
    },
    async upsertPreferences(userId, preferencesJson, updatedAt) {
      statements.upsertPreferences.run(userId, preferencesJson, updatedAt);
    },
    async ratingsForUser(userId) {
      return plainRows(statements.ratingsForUser.all(userId));
    },
    async ratingAggregates() {
      return plainRows(statements.ratingAggregates.all());
    },
    async ratingAggregate(exerciseId) {
      return plainRow(statements.ratingAggregate.get(exerciseId));
    },
    async upsertRating(userId, exerciseId, rating, createdAt, updatedAt) {
      statements.upsertRating.run(
        userId,
        exerciseId,
        rating.comfort,
        rating.pump,
        rating.enjoyment,
        rating.stability,
        rating.setup,
        rating.overall,
        createdAt,
        updatedAt,
      );
    },
    async recordProductSignal(eventDay, eventName, actorKey, audience) {
      return Boolean(
        plainRow(statements.recordProductSignal.get(eventDay, eventName, actorKey, audience)),
      );
    },
    async productSignalCounts(sinceDay, throughDay) {
      return plainRows(statements.productSignalCounts.all(sinceDay, throughDay));
    },
    async deleteOldProductSignals(beforeDay) {
      return affectedRows(statements.deleteOldProductSignals.run(beforeDay));
    },
    async deleteProductSignalActors(beforeDay) {
      return affectedRows(statements.deleteProductSignalActors.run(beforeDay));
    },
    ...billingMethods,
    async adminPrincipal() {
      return plainRow(statements.adminPrincipal.get());
    },
    async claimAdminPrincipal(userId, configuredEmail, boundAt) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const existing = plainRow(statements.adminPrincipal.get());
        if (existing) {
          db.exec("COMMIT");
          transactionOpen = false;
          return { principal: existing, boundNow: false };
        }
        const inserted = plainRow(
          statements.insertAdminPrincipal.get(configuredEmail, boundAt, userId, configuredEmail),
        );
        db.exec("COMMIT");
        transactionOpen = false;
        return {
          principal: inserted || plainRow(statements.adminPrincipal.get()),
          boundNow: Boolean(inserted),
        };
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async adminOverview(now) {
      return plainRow(statements.adminOverview.get(now, now, now));
    },
    async adminUserById(userId, now) {
      return plainRow(statements.adminUserById.get(now, now, now, now, userId));
    },
    async adminUsers(query, limit, offset, now) {
      const search = adminSearchArgs(query);
      const users = plainRows(statements.adminUsers.all(now, now, now, ...search, limit, offset));
      const total = Number(plainRow(statements.adminUserCount.get(...search))?.total || 0);
      return { users, total };
    },
    async revokeUserSessions(userId, audit = null) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const user = plainRow(statements.revokeUserSessionsUser.get(userId));
        if (!user) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        if (audit && !plainRow(statements.insertAdminAuditIfChanged.get(...adminAuditArgs(audit))))
          throw new Error("Admin audit could not be recorded atomically.");
        const revoked = plainRows(statements.revokeUserSessionsDelete.all(userId)).length;
        db.exec("COMMIT");
        transactionOpen = false;
        return { user, revoked };
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async suspendUser(userId, suspendedAt, audit = null) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const user = plainRow(statements.suspendUser.get(suspendedAt, userId));
        if (!user) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        if (audit && !plainRow(statements.insertAdminAuditIfChanged.get(...adminAuditArgs(audit))))
          throw new Error("Admin audit could not be recorded atomically.");
        statements.revokeUserSessionsDelete.all(userId);
        db.exec("COMMIT");
        transactionOpen = false;
        return user;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async restoreUser(userId, audit = null) {
      if (!audit) return plainRow(statements.restoreUser.get(userId));
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const user = plainRow(statements.restoreUser.get(userId));
        if (!user) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        if (!plainRow(statements.insertAdminAuditIfChanged.get(...adminAuditArgs(audit))))
          throw new Error("Admin audit could not be recorded atomically.");
        db.exec("COMMIT");
        transactionOpen = false;
        return user;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async deleteUserByAdmin(
      userId,
      deletedAt,
      targetEmail,
      emailHash,
      actorSessionTokenHash,
      audit,
    ) {
      if (!audit || audit.targetUserId !== userId || audit.action !== "delete-account")
        throw new TypeError("Administrative account deletion requires a matching audit event.");
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const user = plainRow(
          statements.deleteUserByAdmin.get(
            userId,
            targetEmail,
            deletedAt,
            audit.actorUserId,
            actorSessionTokenHash,
            deletedAt,
          ),
        );
        if (!user) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        if (!plainRow(statements.insertAdminAuditIfChanged.get(...adminAuditArgs(audit))))
          throw new Error(
            "Administrative account-deletion audit could not be recorded atomically.",
          );
        statements.deleteAdminControlsForDeletedUser.run(user.id, user.id);
        deleteLocalTrainingData(statements, user.id);
        deleteLocalCoachingData(statements, user.id);
        deleteLocalDataLayerData(statements, user.id);
        deleteLocalAiData(statements, user.id);
        deleteLocalAppleData(statements, user.id);
        statements.deleteWorkoutsForDeletedUser.run(user.id, user.id);
        statements.deleteCheckoutClaimsForDeletedUser.all(user.id, user.id);
        statements.deleteVerificationSendsForDeletedUser.run(user.id, targetEmail, user.id);
        statements.deleteVerificationsForDeletedUser.run(user.id, targetEmail, user.id);
        statements.deleteActionSendsForDeletedUser.run(emailHash, user.id);
        db.exec("COMMIT");
        transactionOpen = false;
        return user;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async recordAdminAudit(event) {
      return Boolean(plainRow(statements.insertAdminAudit.get(...adminAuditArgs(event))));
    },
    async adminAudit(limit) {
      return plainRows(statements.adminAudit.all(limit));
    },
    async insertSupportTicket(ticket) {
      return plainRow(
        statements.insertSupportTicket.get(
          ticket.id,
          ticket.reference,
          ticket.userId || null,
          ticket.name,
          ticket.email,
          ticket.category,
          ticket.subject,
          ticket.referenceId || null,
          ticket.message,
          ticket.createdAt,
          ticket.updatedAt,
        ),
      );
    },
    async supportTicketById(ticketId) {
      return plainRow(statements.supportTicketById.get(ticketId));
    },
    async adminSupportTickets(status, limit, offset) {
      const tickets = plainRows(statements.adminSupportTickets.all(status, status, limit, offset));
      const total = Number(plainRow(statements.adminSupportCount.get(status, status))?.total || 0);
      return { tickets, total };
    },
    async updateSupportTicket(ticketId, update, audit = null) {
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const ticket = plainRow(
          statements.updateSupportTicket.get(
            update.status,
            update.note || null,
            update.responseSent ? 1 : 0,
            update.updatedAt,
            update.updatedAt,
            ticketId,
            update.expectedUpdatedAt,
          ),
        );
        if (!ticket) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        if (audit && !plainRow(statements.insertAdminAuditIfChanged.get(...adminAuditArgs(audit))))
          throw new Error("Support audit could not be recorded atomically.");
        db.exec("COMMIT");
        transactionOpen = false;
        return ticket;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original transaction error. */
          }
        }
        throw error;
      }
    },
    async markSupportResponseSent(ticketId, sentAt) {
      return plainRow(statements.markSupportResponseSent.get(sentAt, sentAt, ticketId));
    },
    async claimSupportRequestEvent(event, { since, ipLimit, emailLimit, globalLimit }) {
      return Boolean(
        plainRow(
          statements.claimSupportRequestEvent.get(
            event.id,
            event.ipHash,
            event.emailHash,
            event.createdAt,
            event.ipHash,
            since,
            ipLimit,
            event.emailHash,
            since,
            emailLimit,
            since,
            globalLimit,
          ),
        ),
      );
    },
    async deleteOldSupportRequestEvents(before) {
      return affectedRows(statements.deleteOldSupportRequestEvents.run(before));
    },
    ...trainingMethods,
    async close() {
      db.close();
    },
  });
}

async function tursoStore(url, authToken, tursoClientFactory) {
  if (!authToken) throw new Error("TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is set.");

  let createClient = tursoClientFactory;
  if (!createClient) {
    try {
      ({ createClient } = await import("@tursodatabase/serverless/compat"));
    } catch (error) {
      throw new Error("Turso support is not installed. Run npm install before starting STRATA.", {
        cause: error,
      });
    }
  }

  const client = createClient({ url, authToken });
  await client.execute("PRAGMA foreign_keys = ON");
  const foreignKeys = await client.execute("PRAGMA foreign_keys");
  const foreignKeyRow = plainRow(foreignKeys.rows[0], foreignKeys.columns);
  if (Number(foreignKeyRow?.foreign_keys ?? foreignKeyRow?.[0]) !== 1) {
    client.close();
    throw new Error("Turso foreign key enforcement could not be enabled.");
  }
  for (const statement of SCHEMA)
    if (statement !== WORKOUT_ACTIVE_INDEX) await client.execute(statement);
  await migrateTursoSchema(client, {
    activeWorkoutIndex: WORKOUT_ACTIVE_INDEX,
    reconcileActiveWorkouts: RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,
    productSignalTable: PRODUCT_SIGNAL_TABLE,
  });

  async function first(sql, args = []) {
    const result = await client.execute({ sql, args });
    return plainRow(result.rows[0], result.columns);
  }
  async function run(sql, args = []) {
    return await client.execute({ sql, args });
  }
  async function all(sql, args = []) {
    const result = await client.execute({ sql, args });
    return plainRows(result.rows, result.columns);
  }

  const trainingMethods = createTursoTrainingMethods({ client, first, run, plainRow });
  const accountSelfServiceMethods = createTursoAccountSelfServiceMethods({
    client,
    first,
    run,
    all,
    plainRow,
  });
  const billingMethods = createTursoBillingMethods({ client, first, run, all, plainRow });
  const coachingMethods = createTursoCoachingMethods({ first, all }),
    deviceMethods = createTursoDeviceMethods({ client, first, all, run, plainRow }),
    dataLayerMethods = createTursoDataLayerMethods({ first, all, run }),
    aiMethods = createTursoAiMethods({ first, all, run });

  // The emailed link and the in-app route both delete here.
  async function deleteAccountTurso(tokenHash, deletedAt, emailHash) {
    const action = await first(SQL.accountActionByTokenHash, [tokenHash]);
    if (
      !action ||
      action.purpose !== "account_delete" ||
      action.delivery_state !== "sent" ||
      action.consumed_at != null ||
      Number(action.expires_at) <= deletedAt
    )
      return { status: "invalid" };
    if (
      Number((await first(SQL.pendingPurchasesForUser, [action.user_id]))?.pending_count || 0) > 0
    )
      return { status: "purchase_pending" };
    if (await first(SQL.activeCheckoutCreationForUser, [action.user_id, deletedAt]))
      return { status: "checkout_pending" };
    const results = await client.batch(
      [
        { sql: SQL.deleteUserWithAction, args: [tokenHash, deletedAt, deletedAt] },
        // This conditional cleanup is intentionally explicit. Turso PRAGMA
        // state is connection-scoped, so account privacy must not depend only
        // on ON DELETE CASCADE surviving a renewed serverless session.
        { sql: SQL.deleteAdminControlsForDeletedUser, args: [action.user_id, action.user_id] },
        ...trainingDeletionBatch(action.user_id),
        ...coachingDeletionBatch(action.user_id),
        ...dataLayerDeletionBatch(action.user_id),
        ...aiDeletionBatch(action.user_id),
        ...appleDeletionBatch(action.user_id),
        { sql: SQL.deleteWorkoutsForDeletedUser, args: [action.user_id, action.user_id] },
        { sql: SQL.deleteCheckoutClaimsForDeletedUser, args: [action.user_id, action.user_id] },
        {
          sql: SQL.deleteVerificationSendsForDeletedUser,
          args: [action.user_id, action.email, action.user_id],
        },
        {
          sql: SQL.deleteVerificationsForDeletedUser,
          args: [action.user_id, action.email, action.user_id],
        },
        { sql: SQL.deleteActionSendsForDeletedUser, args: [emailHash, action.user_id] },
      ],
      "write",
    );
    const user = plainRow(results[0]?.rows?.[0], results[0]?.columns);
    if (user) return { status: "deleted", user };
    if (
      Number((await first(SQL.pendingPurchasesForUser, [action.user_id]))?.pending_count || 0) > 0
    )
      return { status: "purchase_pending" };
    if (await first(SQL.activeCheckoutCreationForUser, [action.user_id, deletedAt]))
      return { status: "checkout_pending" };
    return { status: "invalid" };
  }
  return defineStore("turso", {
    ...coachingMethods,
    ...deviceMethods,
    ...dataLayerMethods,
    ...aiMethods,
    ...createTursoMetricsMethods({ first, all, run }),
    ...createTursoAppleBillingMethods({ first, all, run }),
    ...createTursoSocialAuthMethods({ client, first, all, run, plainRow }),
    ...createTursoServerStateMethods({ first, all, run }),
    ...createTursoAccessControlMethods({ client, first, plainRow, SQL }),
    // A successful query is the health signal. Some Turso-compatible row
    // implementations expose selected values only by numeric index, so the
    // probe must not depend on a particular row-object shape.
    ping: () => probeConnection(() => client.execute(SQL.ping)),
    userByEmail: (email) => first(SQL.userByEmail, [email]),
    userById: (id) => first(SQL.userById, [id]),
    accountCredentialsById: (id) => first(SQL.accountCredentialsById, [id]),
    async insertUser(user) {
      await run(SQL.insertUser, [
        user.id,
        user.name,
        user.email,
        user.passwordHash,
        user.passwordSalt,
        user.createdAt,
        user.emailVerifiedAt ?? user.email_verified_at ?? null,
      ]);
    },
    async insertSession(session) {
      const result = await run(SQL.insertSession, [
        session.tokenHash,
        session.csrfToken,
        session.expiresAt,
        session.createdAt,
        session.userId,
        Number(session.authVersion ?? 1),
      ]);
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    session: (tokenHash, now) => first(SQL.session, [tokenHash, now]),
    async renewSession(tokenHash, expiresAt, now) {
      return Boolean(await first(SQL.renewSession, [expiresAt, tokenHash, now, expiresAt]));
    },
    async deleteSession(tokenHash) {
      await run(SQL.deleteSession, [tokenHash]);
    },
    async deleteExpired(now) {
      await run(SQL.deleteExpired, [now]);
    },
    ...accountSelfServiceMethods,
    verificationByTokenHash: (tokenHash) => first(SQL.verificationByTokenHash, [tokenHash]),
    async insertVerification(verification) {
      await run(SQL.insertVerification, verificationInsertArgs(verification));
      return first(SQL.verificationByChallenge, [verification.challengeId]);
    },
    async rotateVerification(challengeId, currentGeneration, rotation) {
      const result = await run(
        SQL.rotateVerification,
        verificationRotationArgs(challengeId, currentGeneration, rotation),
      );
      return plainRow(result.rows?.[0], result.columns);
    },
    async markVerificationDelivery(challengeId, generation, state, updatedAt) {
      const result = await run(SQL.markVerificationDelivery, [
        state,
        updatedAt,
        challengeId,
        generation,
      ]);
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    async claimVerificationAttempt(challengeId, generation, updatedAt, maxAttempts = 5) {
      const result = await run(SQL.claimVerificationAttempt, [
        updatedAt,
        challengeId,
        generation,
        updatedAt,
        updatedAt,
        maxAttempts,
      ]);
      return plainRow(result.rows[0], result.columns);
    },
    async consumeVerification(challengeId, generation, consumedAt) {
      const result = await run(SQL.consumeVerification, [
        consumedAt,
        consumedAt,
        challengeId,
        generation,
      ]);
      return plainRow(result.rows?.[0], result.columns);
    },
    async completeSignup(challengeId, generation, createdAt, session) {
      if (!session || !session.tokenHash || !session.csrfToken)
        throw new TypeError("A session is required to complete signup.");
      const verification = await first(SQL.verificationByChallenge, [challengeId]);
      if (
        !verification ||
        Number(verification.generation) !== Number(generation) ||
        verification.consumed_at != null
      )
        return null;
      const results = await client.batch(
        [
          {
            sql: SQL.completeSignupInsert,
            args: [createdAt, createdAt, challengeId, generation, createdAt, createdAt],
          },
          {
            sql: SQL.completeSignupConsume,
            args: [createdAt, createdAt, challengeId, generation, createdAt, createdAt],
          },
          {
            sql: SQL.completeSignupSession,
            args: [
              session.tokenHash,
              session.csrfToken,
              session.expiresAt,
              session.createdAt,
              challengeId,
              generation,
              createdAt,
            ],
          },
        ],
        "write",
      );
      const user = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (!user) return null;
      if (!plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Verification could not be consumed atomically.");
      if (!plainRow(results[2]?.rows?.[0], results[2]?.columns))
        throw new Error("Verification session could not be created atomically.");
      return user;
    },
    async completeLoginVerification(challengeId, generation, verifiedAt, session) {
      if (!session || !session.tokenHash || !session.csrfToken)
        throw new TypeError("A session is required to complete login verification.");
      const verification = await first(SQL.verificationByChallenge, [challengeId]);
      if (
        !verification ||
        verification.purpose !== "login" ||
        Number(verification.generation) !== Number(generation) ||
        verification.consumed_at != null
      )
        return null;
      const results = await client.batch(
        [
          {
            sql: SQL.completeLoginVerifyUser,
            args: [verifiedAt, challengeId, generation, verifiedAt, verifiedAt],
          },
          {
            sql: SQL.completeLoginConsume,
            args: [verifiedAt, verifiedAt, challengeId, generation, verifiedAt, verifiedAt],
          },
          {
            sql: SQL.completeLoginSession,
            args: [
              session.tokenHash,
              session.csrfToken,
              session.expiresAt,
              session.createdAt,
              challengeId,
              generation,
              verifiedAt,
            ],
          },
          {
            sql: SQL.completeLoginDeleteOldSessions,
            args: [challengeId, generation, verifiedAt, session.tokenHash],
          },
        ],
        "write",
      );
      const user = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (!user) return null;
      if (!plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Login verification could not be consumed atomically.");
      if (!plainRow(results[2]?.rows?.[0], results[2]?.columns))
        throw new Error("Verified login session could not be created atomically.");
      return user;
    },
    async countVerificationSends(emailHash, since) {
      return Number((await first(SQL.countVerificationSends, [emailHash, since]))?.send_count || 0);
    },
    async recordVerificationSend(send) {
      await run(SQL.recordVerificationSend, verificationSendArgs(send));
    },
    async claimVerificationSend(send, since, maxSends) {
      const result = await run(
        SQL.claimVerificationSend,
        verificationSendClaimArgs(send, since, maxSends),
      );
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    verificationSendByChallengeGeneration: (challengeId, generation) =>
      first(SQL.verificationSendByChallengeGeneration, [challengeId, generation]),
    async deleteOldVerificationData(now, sendBefore = now - VERIFICATION_SEND_RETENTION_MS) {
      const consumedBefore = now - CONSUMED_VERIFICATION_RETENTION_MS;
      const results = await client.batch(
        [
          { sql: SQL.deleteOldVerifications, args: [now, consumedBefore] },
          { sql: SQL.deleteOldVerificationSends, args: [sendBefore] },
        ],
        "write",
      );
      return { verifications: affectedRows(results[0]), sends: affectedRows(results[1]) };
    },
    accountActionByTokenHash: (tokenHash) => first(SQL.accountActionByTokenHash, [tokenHash]),
    accountActionForUser: (userId, purpose) => first(SQL.accountActionForUser, [userId, purpose]),
    async upsertAccountAction(action) {
      const result = await run(SQL.upsertAccountAction, accountActionArgs(action));
      return plainRow(result.rows?.[0], result.columns);
    },
    async markAccountActionDelivery(requestId, tokenHash, state, updatedAt) {
      const result = await run(SQL.markAccountActionDelivery, [
        state,
        updatedAt,
        requestId,
        tokenHash,
      ]);
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    async stageAccountAction(action) {
      const result = await run(SQL.stageAccountAction, stagedAccountActionArgs(action));
      return plainRow(result.rows?.[0], result.columns);
    },
    async activateAccountAction(requestId, tokenHash, activatedAt) {
      const results = await client.batch(
        [
          {
            sql: SQL.activateAccountAction,
            args: [activatedAt, requestId, tokenHash, activatedAt],
          },
          { sql: SQL.discardStagedAccountAction, args: [requestId, tokenHash] },
        ],
        "write",
      );
      const action = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (!action) return null;
      if (!plainRow(results[1]?.rows?.[0], results[1]?.columns)) {
        throw new Error("Staged account action could not be consumed atomically.");
      }
      return action;
    },
    async discardStagedAccountAction(requestId, tokenHash) {
      const result = await run(SQL.discardStagedAccountAction, [requestId, tokenHash]);
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    async claimAccountActionSend(send, since, maxSends) {
      const result = await run(
        SQL.claimAccountActionSend,
        accountActionSendArgs(send, since, maxSends),
      );
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    async countAccountActionSends(emailHash, purpose, since) {
      return Number(
        (await first(SQL.countAccountActionSends, [emailHash, purpose, since]))?.send_count || 0,
      );
    },
    activeAccountDeletion: (userId, now) => first(SQL.activeAccountDeletion, [userId, now]),
    async cancelAccountDeletion(userId) {
      const results = await client.batch(
        [
          { sql: SQL.cancelAccountDeletion, args: [userId] },
          { sql: SQL.cancelStagedAccountDeletions, args: [userId] },
        ],
        "write",
      );
      const active = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      const staged = plainRows(results[1]?.rows, results[1]?.columns);
      return Boolean(active || staged.length);
    },
    async cancelAccountDeletionWithAudit(userId, audit) {
      const results = await client.batch(
        [
          { sql: SQL.cancelAccountDeletion, args: [userId] },
          { sql: SQL.insertAdminAuditIfChanged, args: adminAuditArgs(audit) },
          { sql: SQL.cancelStagedAccountDeletionsIfAudit, args: [userId, audit.id] },
        ],
        "write",
      );
      const active = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (!active) return false;
      if (!plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Deletion-cancellation audit could not be recorded atomically.");
      return true;
    },
    async completePasswordReset(tokenHash, passwordHash, passwordSalt, completedAt) {
      const action = await first(SQL.accountActionByTokenHash, [tokenHash]);
      if (
        !action ||
        action.purpose !== "password_reset" ||
        action.delivery_state !== "sent" ||
        action.consumed_at != null ||
        Number(action.expires_at) <= completedAt
      )
        return null;
      const results = await client.batch(
        [
          {
            sql: SQL.completePasswordResetUser,
            args: [passwordHash, passwordSalt, completedAt, tokenHash, completedAt],
          },
          {
            sql: SQL.completePasswordResetConsume,
            args: [completedAt, completedAt, tokenHash, completedAt],
          },
          { sql: SQL.completePasswordResetDeleteSessions, args: [tokenHash, completedAt] },
          { sql: SQL.completePasswordResetDeleteStagedActions, args: [tokenHash, completedAt] },
          { sql: SQL.completePasswordResetDeleteActions, args: [tokenHash, completedAt] },
        ],
        "write",
      );
      const user = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (!user) return null;
      if (!plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Password reset could not be consumed atomically.");
      return user;
    },
    activeCheckoutCreationForUser: (userId, now) =>
      first(SQL.activeCheckoutCreationForUser, [userId, now]),
    deleteAccount: (tokenHash, deletedAt, emailHash) =>
      deleteAccountTurso(tokenHash, deletedAt, emailHash),
    async deleteAccountForUser(userId, tokenHash, deletedAt, emailHash) {
      // A Turso batch cannot read between its writes, so the internal action is written just before the same
      // deletion path consumes it. A live emailed link is consumed instead of being overwritten, and the internal
      // action never outlives the request (it also expires within a minute if this process stops mid-way).
      const pending = await first(SQL.accountActionForUser, [userId, "account_delete"]);
      if (
        pending &&
        pending.delivery_state === "sent" &&
        pending.consumed_at == null &&
        Number(pending.expires_at) > deletedAt
      )
        return deleteAccountTurso(pending.token_hash, deletedAt, emailHash);
      await run(
        SQL.upsertAccountAction,
        accountActionArgs(internalDeleteAction(userId, tokenHash, deletedAt)),
      );
      try {
        return await deleteAccountTurso(tokenHash, deletedAt, emailHash);
      } finally {
        await run(SQL.discardAccountAction, [tokenHash]).catch(() => {});
      }
    },
    async deleteOldAccountActionData(now, sendBefore = now - VERIFICATION_SEND_RETENTION_MS) {
      const consumedBefore = now - CONSUMED_VERIFICATION_RETENTION_MS;
      const results = await client.batch(
        [
          { sql: SQL.deleteOldAccountActions, args: [now, consumedBefore] },
          { sql: SQL.deleteOldStagedAccountActions, args: [now] },
          { sql: SQL.deleteOldAccountActionSends, args: [sendBefore] },
        ],
        "write",
      );
      return {
        actions: affectedRows(results[0]) + affectedRows(results[1]),
        sends: affectedRows(results[2]),
      };
    },
    workout: (userId, id) => first(SQL.workout, [userId, id]),
    activeWorkout: (userId) => first(SQL.activeWorkout, [userId]),
    workouts: (userId, limit, offset) => all(SQL.workouts, [userId, limit, offset]),
    async workoutCount(userId) {
      return Number((await first(SQL.workoutCount, [userId])).count);
    },
    insertWorkout: (record) =>
      first(SQL.insertWorkout, [
        record.id,
        record.workoutJson,
        record.summaryJson,
        record.createHash,
        record.startedAt,
        record.updatedAt,
        record.userId,
      ]),
    updateWorkout: (record, expectedRevision) =>
      first(SQL.updateWorkout, [
        record.workoutJson,
        record.summaryJson,
        record.updatedAt,
        record.userId,
        record.id,
        expectedRevision,
      ]),
    plan: (userId) => first(SQL.plan, [userId]),
    async upsertPlan(userId, planJson, updatedAt, expectedUpdatedAt) {
      const result = await run(SQL.upsertPlan, [
        planJson,
        updatedAt,
        userId,
        expectedUpdatedAt,
        expectedUpdatedAt,
        expectedUpdatedAt,
        expectedUpdatedAt,
      ]);
      return plainRow(result.rows?.[0], result.columns);
    },
    async saveTrainingSetup(
      userId,
      planJson,
      preferencesJson,
      updatedAt,
      expectedUpdatedAt,
      expectedPreferencesUpdatedAt,
    ) {
      const results = await client.batch(
        [
          {
            sql: SQL.upsertPlanForSetup,
            args: [
              planJson,
              updatedAt,
              expectedPreferencesUpdatedAt,
              userId,
              expectedPreferencesUpdatedAt,
              expectedUpdatedAt,
              expectedUpdatedAt,
              expectedUpdatedAt,
              expectedUpdatedAt,
            ],
          },
          { sql: SQL.upsertPreferencesAfterPlan, args: [userId, preferencesJson, userId] },
        ],
        "write",
      );
      const plan = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      const preferences = plainRow(results[1]?.rows?.[0], results[1]?.columns);
      if (!plan) return null;
      if (!preferences)
        throw new Error("Training preferences could not be saved atomically with the weekly plan.");
      return {
        ...plan,
        preferences_json: preferences.preferences_json,
        preferences_updated_at: Number(preferences.updated_at),
      };
    },
    monthlyPlan: (userId) => first(SQL.monthlyPlan, [userId]),
    async upsertMonthlyPlan(userId, planJson, updatedAt, expectedUpdatedAt) {
      if (expectedUpdatedAt === undefined) {
        await run(SQL.upsertMonthlyPlan, [userId, planJson, updatedAt]);
        return;
      }
      return first(SQL.compareAndSwapMonthlyPlan, [
        userId,
        planJson,
        updatedAt,
        userId,
        expectedUpdatedAt,
        expectedUpdatedAt,
      ]);
    },
    preferences: (userId) => first(SQL.preferences, [userId]),
    async upsertPreferences(userId, preferencesJson, updatedAt) {
      await run(SQL.upsertPreferences, [userId, preferencesJson, updatedAt]);
    },
    ratingsForUser: (userId) => all(SQL.ratingsForUser, [userId]),
    ratingAggregates: () => all(SQL.ratingAggregates),
    ratingAggregate: (exerciseId) => first(SQL.ratingAggregate, [exerciseId]),
    async upsertRating(userId, exerciseId, rating, createdAt, updatedAt) {
      await run(SQL.upsertRating, [
        userId,
        exerciseId,
        rating.comfort,
        rating.pump,
        rating.enjoyment,
        rating.stability,
        rating.setup,
        rating.overall,
        createdAt,
        updatedAt,
      ]);
    },
    async recordProductSignal(eventDay, eventName, actorKey, audience) {
      const result = await run(SQL.recordProductSignal, [eventDay, eventName, actorKey, audience]);
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    productSignalCounts: (sinceDay, throughDay) =>
      all(SQL.productSignalCounts, [sinceDay, throughDay]),
    async deleteOldProductSignals(beforeDay) {
      return affectedRows(await run(SQL.deleteOldProductSignals, [beforeDay]));
    },
    async deleteProductSignalActors(beforeDay) {
      return affectedRows(await run(SQL.deleteProductSignalActors, [beforeDay]));
    },
    ...billingMethods,
    adminPrincipal: () => first(SQL.adminPrincipal),
    async claimAdminPrincipal(userId, configuredEmail, boundAt) {
      const existing = await first(SQL.adminPrincipal);
      if (existing) return { principal: existing, boundNow: false };
      const results = await client.batch(
        [
          {
            sql: SQL.insertAdminPrincipal,
            args: [configuredEmail, boundAt, userId, configuredEmail],
          },
        ],
        "write",
      );
      const inserted = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      return {
        principal: inserted || (await first(SQL.adminPrincipal)),
        boundNow: Boolean(inserted),
      };
    },
    adminOverview: (now) => first(SQL.adminOverview, [now, now, now]),
    adminUserById: (userId, now) => first(SQL.adminUserById, [now, now, now, now, userId]),
    async adminUsers(query, limit, offset, now) {
      const search = adminSearchArgs(query);
      const [users, count] = await Promise.all([
        all(SQL.adminUsers, [now, now, now, ...search, limit, offset]),
        first(SQL.adminUserCount, search),
      ]);
      return { users, total: Number(count?.total || 0) };
    },
    async revokeUserSessions(userId, audit = null) {
      const statements = [{ sql: SQL.revokeUserSessionsUser, args: [userId] }];
      if (audit)
        statements.push({ sql: SQL.insertAdminAuditIfChanged, args: adminAuditArgs(audit) });
      statements.push({ sql: SQL.revokeUserSessionsDelete, args: [userId] });
      const results = await client.batch(statements, "write");
      const user = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (user && audit && !plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Admin audit could not be recorded atomically.");
      const deleted = results[audit ? 2 : 1];
      return user
        ? { user, revoked: plainRows(deleted?.rows || [], deleted?.columns).length }
        : null;
    },
    async suspendUser(userId, suspendedAt, audit = null) {
      const statements = [{ sql: SQL.suspendUser, args: [suspendedAt, userId] }];
      if (audit)
        statements.push({ sql: SQL.insertAdminAuditIfChanged, args: adminAuditArgs(audit) });
      statements.push({ sql: SQL.revokeUserSessionsDelete, args: [userId] });
      const results = await client.batch(statements, "write");
      const user = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (user && audit && !plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Admin audit could not be recorded atomically.");
      return user;
    },
    async restoreUser(userId, audit = null) {
      if (!audit) {
        const result = await run(SQL.restoreUser, [userId]);
        return plainRow(result.rows?.[0], result.columns);
      }
      const results = await client.batch(
        [
          { sql: SQL.restoreUser, args: [userId] },
          { sql: SQL.insertAdminAuditIfChanged, args: adminAuditArgs(audit) },
        ],
        "write",
      );
      const user = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (user && !plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Admin audit could not be recorded atomically.");
      return user;
    },
    async deleteUserByAdmin(
      userId,
      deletedAt,
      targetEmail,
      emailHash,
      actorSessionTokenHash,
      audit,
    ) {
      if (!audit || audit.targetUserId !== userId || audit.action !== "delete-account")
        throw new TypeError("Administrative account deletion requires a matching audit event.");
      const results = await client.batch(
        [
          {
            sql: SQL.deleteUserByAdmin,
            args: [
              userId,
              targetEmail,
              deletedAt,
              audit.actorUserId,
              actorSessionTokenHash,
              deletedAt,
            ],
          },
          { sql: SQL.insertAdminAuditIfChanged, args: adminAuditArgs(audit) },
          { sql: SQL.deleteAdminControlsForDeletedUser, args: [userId, userId] },
          ...trainingDeletionBatch(userId),
          ...coachingDeletionBatch(userId),
          ...dataLayerDeletionBatch(userId),
          ...aiDeletionBatch(userId),
          ...appleDeletionBatch(userId),
          { sql: SQL.deleteWorkoutsForDeletedUser, args: [userId, userId] },
          { sql: SQL.deleteCheckoutClaimsForDeletedUser, args: [userId, userId] },
          { sql: SQL.deleteVerificationSendsForDeletedUser, args: [userId, targetEmail, userId] },
          { sql: SQL.deleteVerificationsForDeletedUser, args: [userId, targetEmail, userId] },
          { sql: SQL.deleteActionSendsForDeletedUser, args: [emailHash, userId] },
        ],
        "write",
      );
      const user = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (user && !plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Administrative account-deletion audit could not be recorded atomically.");
      return user;
    },
    async recordAdminAudit(event) {
      const result = await run(SQL.insertAdminAudit, adminAuditArgs(event));
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    adminAudit: (limit) => all(SQL.adminAudit, [limit]),
    async insertSupportTicket(ticket) {
      const result = await run(SQL.insertSupportTicket, [
        ticket.id,
        ticket.reference,
        ticket.userId || null,
        ticket.name,
        ticket.email,
        ticket.category,
        ticket.subject,
        ticket.referenceId || null,
        ticket.message,
        ticket.createdAt,
        ticket.updatedAt,
      ]);
      return plainRow(result.rows?.[0], result.columns);
    },
    supportTicketById: (ticketId) => first(SQL.supportTicketById, [ticketId]),
    async adminSupportTickets(status, limit, offset) {
      const [tickets, count] = await Promise.all([
        all(SQL.adminSupportTickets, [status, status, limit, offset]),
        first(SQL.adminSupportCount, [status, status]),
      ]);
      return { tickets, total: Number(count?.total || 0) };
    },
    async updateSupportTicket(ticketId, update, audit = null) {
      if (!audit) {
        const result = await run(SQL.updateSupportTicket, [
          update.status,
          update.note || null,
          update.responseSent ? 1 : 0,
          update.updatedAt,
          update.updatedAt,
          ticketId,
          update.expectedUpdatedAt,
        ]);
        return plainRow(result.rows?.[0], result.columns);
      }
      const results = await client.batch(
        [
          {
            sql: SQL.updateSupportTicket,
            args: [
              update.status,
              update.note || null,
              update.responseSent ? 1 : 0,
              update.updatedAt,
              update.updatedAt,
              ticketId,
              update.expectedUpdatedAt,
            ],
          },
          { sql: SQL.insertAdminAuditIfChanged, args: adminAuditArgs(audit) },
        ],
        "write",
      );
      const ticket = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (ticket && !plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Support audit could not be recorded atomically.");
      return ticket;
    },
    async markSupportResponseSent(ticketId, sentAt) {
      const result = await run(SQL.markSupportResponseSent, [sentAt, sentAt, ticketId]);
      return plainRow(result.rows?.[0], result.columns);
    },
    async claimSupportRequestEvent(event, { since, ipLimit, emailLimit, globalLimit }) {
      const result = await run(SQL.claimSupportRequestEvent, [
        event.id,
        event.ipHash,
        event.emailHash,
        event.createdAt,
        event.ipHash,
        since,
        ipLimit,
        event.emailHash,
        since,
        emailLimit,
        since,
        globalLimit,
      ]);
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    async deleteOldSupportRequestEvents(before) {
      return affectedRows(await run(SQL.deleteOldSupportRequestEvents, [before]));
    },
    ...trainingMethods,
    async close() {
      client.close();
    },
  });
}

async function createStore(root, { tursoClientFactory } = {}) {
  const tursoUrl = String(process.env.TURSO_DATABASE_URL || "").trim();
  if (tursoUrl)
    return tursoStore(
      tursoUrl,
      String(process.env.TURSO_AUTH_TOKEN || "").trim(),
      tursoClientFactory,
    );
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Production requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN so accounts are not lost.",
    );
  }
  return localStore(root);
}

function isUniqueViolation(error) {
  return /unique constraint|already exists/i.test(String(error?.message || ""));
}

module.exports = { createStore, isUniqueViolation, plainRow, probeConnection };
