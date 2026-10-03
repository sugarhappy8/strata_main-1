// @ts-check
"use strict";

const EXPORT_PAGE_SIZE = 50;

/** @param {unknown} value */
function storedJson(value) {
  const raw = String(value ?? "");
  try {
    return JSON.parse(raw);
  } catch {
    return { unreadable: true, raw };
  }
}
/** @param {unknown} value */
function optionalNumber(value) {
  return value == null ? null : Number(value);
}
/** @param {any} row @param {string} field */
function jsonSnapshot(row, field) {
  return row ? { data: storedJson(row[field]), updatedAt: Number(row.updated_at) } : null;
}
/** @param {any} row */
function exportWorkout(row) {
  return {
    id: String(row.id),
    workout: storedJson(row.workout_json),
    summary: storedJson(row.summary_json),
    startedAt: Number(row.started_at),
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
  };
}

/** @param {unknown} value */
function optionalText(value) {
  return value == null ? null : String(value);
}
/**
 * Connected-device data STRATA stored for the member; tokens and Polar identifiers are never
 * exported.
 * @param {import("./domain-types").AccountExportStoreRows} rows
 */
function exportDevices(rows) {
  return {
    connections: (rows.deviceConnections || []).map((row) => ({
      provider: String(row.provider),
      status: String(row.status),
      settings: storedJson(row.settings_json),
      consentVersion: String(row.consent_version),
      connectedAt: Number(row.connected_at),
      syncedThrough: optionalText(row.synced_through),
      lastSyncAt: optionalNumber(row.last_sync_at),
    })),
    nights: (rows.wellnessNights || []).map((row) => ({
      provider: String(row.provider),
      date: String(row.night_date),
      recoveryStatus: optionalNumber(row.recovery_status),
      ansCharge: optionalNumber(row.ans_charge),
      ansChargeStatus: optionalNumber(row.ans_charge_status),
      sleepCharge: optionalNumber(row.sleep_charge),
      heartRateAvg: optionalNumber(row.heart_rate_avg),
      hrvAvg: optionalNumber(row.hrv_avg),
      breathingRateAvg: optionalNumber(row.breathing_rate_avg),
      sleepScore: optionalNumber(row.sleep_score),
      sleepStart: optionalText(row.sleep_start),
      sleepEnd: optionalText(row.sleep_end),
      asleepSeconds: optionalNumber(row.asleep_seconds),
      lightSeconds: optionalNumber(row.light_seconds),
      deepSeconds: optionalNumber(row.deep_seconds),
      remSeconds: optionalNumber(row.rem_seconds),
      interruptionSeconds: optionalNumber(row.interruption_seconds),
      updatedAt: Number(row.updated_at),
    })),
    days: (rows.wellnessDays || []).map((row) => ({
      provider: String(row.provider),
      date: String(row.day_date),
      restingHr: optionalNumber(row.resting_hr),
      minHr: optionalNumber(row.min_hr),
      avgHr: optionalNumber(row.avg_hr),
      maxHr: optionalNumber(row.max_hr),
      samples: Number(row.samples),
      halfHours: row.buckets_json == null ? null : storedJson(row.buckets_json),
      updatedAt: Number(row.updated_at),
    })),
    workouts: (rows.wellnessWorkouts || []).map((row) => ({
      provider: String(row.provider),
      id: String(row.external_id),
      startedAt: Number(row.started_at),
      date: String(row.local_date),
      durationSeconds: optionalNumber(row.duration_seconds),
      sport: optionalText(row.sport),
      calories: optionalNumber(row.calories),
      hrAvg: optionalNumber(row.hr_avg),
      hrMax: optionalNumber(row.hr_max),
      cardioLoad: optionalNumber(row.cardio_load),
      updatedAt: Number(row.updated_at),
    })),
  };
}

/** @param {import("./domain-types").AccountExportStoreRows} rows @param {number} now */
function exportPayload(rows, now) {
  const profile = rows.profile;
  return {
    format: "strata-account-export",
    schemaVersion: 1,
    exportedAt: new Date(now).toISOString(),
    account: {
      id: String(profile.id),
      name: String(profile.name),
      email: String(profile.email),
      createdAt: Number(profile.created_at),
      emailVerifiedAt: optionalNumber(profile.email_verified_at),
      signIns: (rows.signIns || []).map((row) => ({
        provider: String(row.provider),
        email: String(row.email),
        linkedAt: Number(row.linked_at),
        lastUsedAt: Number(row.last_used_at),
      })),
    },
    weeklyPlan: jsonSnapshot(rows.weeklyPlan, "plan_json"),
    monthlyPlan: jsonSnapshot(rows.monthlyPlan, "plan_json"),
    preferences: jsonSnapshot(rows.preferences, "preferences_json"),
    ratings: rows.ratings.map((row) => ({
      exerciseId: String(row.exercise_id),
      comfort: Number(row.comfort),
      pump: Number(row.pump),
      enjoyment: Number(row.enjoyment),
      stability: Number(row.stability),
      setup: Number(row.setup),
      overall: Number(row.overall),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })),
    workouts: rows.workouts.map(exportWorkout),
    checkIns: rows.checkIns.map((row) => ({
      workoutId: String(row.workout_id),
      difficulty: Number(row.difficulty),
      energy: Number(row.energy),
      comfort: Number(row.comfort),
      enjoyment: Number(row.enjoyment),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })),
    training: {
      block: rows.trainingBlock
        ? {
            data: storedJson(rows.trainingBlock.block_json),
            revision: Number(rows.trainingBlock.revision),
            updatedAt: Number(rows.trainingBlock.updated_at),
          }
        : null,
      adaptations: rows.trainingAdaptations.map((row) => ({
        id: String(row.id),
        workoutId: String(row.workout_id),
        data: storedJson(row.adaptation_json),
        planUpdatedAt: Number(row.plan_updated_at),
        status: String(row.status),
        createdAt: Number(row.created_at),
        resolvedAt: optionalNumber(row.resolved_at),
      })),
    },
    coaching: {
      profile: rows.coachingProfile
        ? {
            data: storedJson(rows.coachingProfile.profile_json),
            revision: Number(rows.coachingProfile.revision),
            updatedAt: Number(rows.coachingProfile.updated_at),
          }
        : null,
      weeks: (rows.coachingWeeks || []).map((row) => ({
        weekStart: String(row.week_start),
        planKey: String(row.plan_key),
        profileRevision: Number(row.profile_revision),
        data: storedJson(row.snapshot_json),
        generatedAt: Number(row.generated_at),
      })),
      logs: (rows.coachingLogs || []).map((row) => ({
        date: String(row.log_date),
        calories: Number(row.calories),
        proteinG: optionalNumber(row.protein_g),
        carbsG: optionalNumber(row.carbs_g),
        fatG: optionalNumber(row.fat_g),
        morningWeightKg: optionalNumber(row.morning_weight_kg),
        complete: row.intake_complete == null ? null : Number(row.intake_complete) === 1,
        revision: Number(row.revision),
        updatedAt: Number(row.updated_at),
      })),
    },
    access: {
      grants: (rows.grants || []).map((row) => ({
        startedAt: optionalNumber(row.grant_starts_at),
        expiresAt: optionalNumber(row.grant_expires_at),
        revokedAt: optionalNumber(row.grant_revoked_at),
        checkoutBlocked: row.checkout_blocked_at != null,
      })),
      purchases: rows.purchases.map((row) => ({
        transactionId: String(row.transaction_id),
        priceId: String(row.price_id),
        productId: String(row.product_id),
        subscriptionId: row.subscription_id == null ? null : String(row.subscription_id),
        status: String(row.paddle_status),
        completedAt: optionalNumber(row.completed_at),
        accessRevokedAt: optionalNumber(row.access_revoked_at),
        revocationReason: row.revocation_reason == null ? null : String(row.revocation_reason),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      })),
      subscriptions: rows.subscriptions.map((row) => ({
        id: String(row.subscription_id),
        transactionId: String(row.transaction_id),
        status: String(row.status),
        priceId: String(row.price_id),
        productId: String(row.product_id),
        scheduledChange:
          row.scheduled_change_action == null
            ? null
            : {
                action: String(row.scheduled_change_action),
                effectiveAt: optionalNumber(row.scheduled_change_at),
              },
        currentPeriodEndsAt: optionalNumber(row.current_period_ends_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      })),
      adjustments: rows.adjustments.map((row) => ({
        id: String(row.adjustment_id),
        transactionId: String(row.transaction_id),
        action: String(row.action),
        type: row.type == null ? null : String(row.type),
        status: String(row.status),
        occurredAt: Number(row.occurred_at),
        updatedAt: Number(row.updated_at),
      })),
      appleSubscriptions: (rows.appleSubscriptions || []).map((row) => ({
        originalTransactionId: String(row.original_transaction_id),
        productId: String(row.product_id),
        environment: String(row.environment),
        latestTransactionId: String(row.latest_transaction_id),
        purchasedAt: optionalNumber(row.purchased_at),
        originalPurchasedAt: optionalNumber(row.original_purchased_at),
        expiresAt: optionalNumber(row.expires_at),
        revokedAt: optionalNumber(row.revoked_at),
        revocationReason: optionalText(row.revocation_reason),
        autoRenew: row.auto_renew == null ? null : Number(row.auto_renew) === 1,
        gracePeriodExpiresAt: optionalNumber(row.grace_period_expires_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      })),
      googlePlaySubscriptions: (rows.googlePlaySubscriptions || []).map((row) => ({
        productId: String(row.product_id),
        basePlanId: optionalText(row.base_plan_id),
        state: String(row.state),
        testPurchase: Number(row.test_purchase) === 1,
        orderId: optionalText(row.latest_order_id),
        startedAt: optionalNumber(row.started_at),
        expiresAt: optionalNumber(row.expires_at),
        autoRenew: row.auto_renew == null ? null : Number(row.auto_renew) === 1,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      })),
    },
    supportTickets: rows.supportTickets.map((row) => ({
      id: String(row.id),
      reference: String(row.reference),
      name: String(row.name),
      email: String(row.email),
      category: String(row.category),
      subject: String(row.subject),
      referenceId: row.reference_id == null ? null : String(row.reference_id),
      message: String(row.message),
      status: String(row.status),
      lastResponseAt: optionalNumber(row.last_response_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })),
    devices: exportDevices(rows),
    dataLayer: {
      snapshots: (rows.dailySnapshots || []).map((row) => ({
        date: String(row.snapshot_date),
        data: storedJson(row.snapshot_json),
        brief: row.brief_json == null ? null : storedJson(row.brief_json),
        briefGeneratedAt: optionalNumber(row.brief_generated_at),
        updatedAt: Number(row.updated_at),
      })),
      planChanges: (rows.planChanges || []).map((row) => ({
        planUpdatedAt: Number(row.plan_updated_at),
        source: String(row.source),
        detail: String(row.detail),
        createdAt: Number(row.created_at),
      })),
      trainingLinks: (rows.trainingLinks || []).map((row) => ({
        provider: String(row.provider),
        externalId: String(row.external_id),
        workoutId: String(row.workout_id),
        method: String(row.method),
        linkedAt: Number(row.linked_at),
      })),
      firstFullWeekAt: optionalNumber(rows.milestones?.first_full_week_at),
    },
    strataAi: {
      settings: rows.aiSettings
        ? {
            consentedAt: optionalNumber(rows.aiSettings.consent_at),
            consentVersion: Number(rows.aiSettings.consent_version),
            dailyBrief: Number(rows.aiSettings.daily_brief) === 1,
            updatedAt: Number(rows.aiSettings.updated_at),
          }
        : null,
      usage: (rows.aiUsage || []).map((row) => ({
        date: String(row.usage_date),
        kind: String(row.kind),
        requests: Number(row.requests),
        tokens: Number(row.tokens),
      })),
    },
  };
}

/** @param {import("./domain-types").HttpResponse} res @param {string} chunk */
function writeChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", drain);
      res.off("close", close);
      res.off("error", error);
    };
    const drain = () => {
        cleanup();
        resolve(true);
      },
      close = () => {
        cleanup();
        resolve(false);
      };
    /** @param {Error} failure */
    const error = (failure) => {
      cleanup();
      reject(failure);
    };
    res.once("drain", drain);
    res.once("close", close);
    res.once("error", error);
  });
}

/**
 * Stream workout data in bounded storage pages instead of materializing the
 * account's complete history and a second synchronous compression buffer.
 * @param {import("./domain-types").HttpResponse} res
 * @param {import("./domain-types").AccountSelfServiceStore} store
 * @param {string} userId
 * @param {import("./domain-types").AccountExportStoreRows} rows
 * @param {number} exportedAt
 * @param {import("./domain-types").HttpHeaders} headers
 */
async function streamExport(res, store, userId, rows, exportedAt, headers) {
  const date = new Date(exportedAt).toISOString().slice(0, 10),
    base = JSON.stringify(exportPayload({ ...rows, workouts: [] }, exportedAt)),
    marker = '"workouts":[]',
    index = base.indexOf(marker);
  if (index < 0) throw new Error("Account export could not be serialized.");
  res.writeHead(200, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Disposition": `attachment; filename="strata-account-export-${date}.json"`,
    "X-Strata-Export": "account-v1",
  });
  if (!(await writeChunk(res, `${base.slice(0, index)}"workouts":[`))) return;
  let afterStartedAt = -1,
    afterId = "",
    exported = 0,
    first = true;
  while (true) {
    const page = await store.accountExportWorkouts(
      userId,
      afterStartedAt,
      afterId,
      EXPORT_PAGE_SIZE,
    );
    if (!Array.isArray(page) || page.length > EXPORT_PAGE_SIZE)
      throw new Error("Account workout export returned an invalid page.");
    for (const row of page) {
      const startedAt = Number(row.started_at),
        id = String(row.id);
      if (
        !Number.isSafeInteger(startedAt) ||
        startedAt < 0 ||
        startedAt < afterStartedAt ||
        (startedAt === afterStartedAt && id <= afterId)
      )
        throw new Error("Account workout export lost its stable ordering boundary.");
      if (!(await writeChunk(res, `${first ? "" : ","}${JSON.stringify(exportWorkout(row))}`)))
        return;
      afterStartedAt = startedAt;
      afterId = id;
      first = false;
      exported += 1;
      if (exported > 10_000)
        throw new Error("Account workout export exceeded the reviewed account limit.");
    }
    if (page.length < EXPORT_PAGE_SIZE) break;
  }
  if (!res.destroyed && !res.writableEnded) res.end(`]${base.slice(index + marker.length)}`);
}

module.exports = { EXPORT_PAGE_SIZE, exportPayload, exportWorkout, streamExport };
