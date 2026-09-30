// @ts-check
"use strict";

// Every account export query is an explicit allowlist. Authentication secrets,
// session material, provider customer records, and administrative data never
// cross this storage boundary.
const ACCOUNT_EXPORT_QUERIES=Object.freeze({
  profile:"SELECT id,name,email,created_at,email_verified_at FROM users WHERE id=? AND suspended_at IS NULL",
  weeklyPlan:"SELECT plan_json,updated_at FROM plans WHERE user_id=?",
  monthlyPlan:"SELECT plan_json,updated_at FROM monthly_plans WHERE user_id=?",
  preferences:"SELECT preferences_json,updated_at FROM preferences WHERE user_id=?",
  ratings:"SELECT exercise_id,comfort,pump,enjoyment,stability,setup,overall,created_at,updated_at FROM ratings WHERE user_id=? ORDER BY exercise_id",
  checkIns:"SELECT workout_id,difficulty,energy,comfort,enjoyment,created_at,updated_at FROM workout_check_ins WHERE user_id=? ORDER BY created_at,workout_id",
  trainingBlock:"SELECT block_json,revision,updated_at FROM training_blocks WHERE user_id=?",
  trainingAdaptations:"SELECT id,workout_id,adaptation_json,plan_updated_at,status,created_at,resolved_at FROM training_adaptations WHERE user_id=? ORDER BY created_at,id",
  coachingProfile:"SELECT profile_json,revision,updated_at FROM coaching_profiles WHERE user_id=?",
  coachingWeeks:"SELECT week_start,plan_key,profile_revision,snapshot_json,generated_at FROM coaching_weeks WHERE user_id=? ORDER BY week_start",
  coachingLogs:"SELECT log_date,calories,protein_g,carbs_g,fat_g,morning_weight_kg,intake_complete,revision,updated_at FROM coaching_daily_logs WHERE user_id=? ORDER BY log_date",
  communityPlans:"SELECT id,title,description,plan_json,is_published,created_at,updated_at FROM community_weekly_plans WHERE user_id=? ORDER BY created_at,id",
  grants:"SELECT grant_starts_at,grant_expires_at,grant_revoked_at,checkout_blocked_at FROM admin_account_controls WHERE user_id=?",
  trials:"SELECT started_at,expires_at FROM discovery_trials WHERE user_id=? ORDER BY started_at",
  purchases:"SELECT transaction_id,price_id,product_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at FROM paddle_purchases WHERE user_id=? ORDER BY created_at,transaction_id",
  subscriptions:"SELECT subscription_id,transaction_id,status,price_id,product_id,scheduled_change_action,scheduled_change_at,current_period_ends_at,created_at,updated_at FROM paddle_subscriptions WHERE user_id=? ORDER BY created_at,subscription_id",
  adjustments:"SELECT a.adjustment_id,a.transaction_id,a.action,a.type,a.status,a.occurred_at,a.updated_at FROM paddle_adjustments a JOIN paddle_purchases p ON p.transaction_id=a.transaction_id WHERE p.user_id=? ORDER BY a.occurred_at,a.adjustment_id",
  supportTickets:"SELECT id,reference,name,email,category,subject,reference_id,message,status,last_response_at,created_at,updated_at FROM support_tickets WHERE user_id=? ORDER BY created_at,id",
  // Connected devices export what STRATA stored about the member, never the sealed token or Polar identifiers.
  deviceConnections:"SELECT provider,status,settings_json,consent_version,connected_at,synced_through,last_sync_at FROM device_connections WHERE user_id=? ORDER BY provider",
  wellnessNights:"SELECT provider,night_date,recovery_status,COALESCE(ans_charge_v4,ans_charge) AS ans_charge,ans_charge_status,sleep_charge,heart_rate_avg,hrv_avg,breathing_rate_avg,sleep_score,sleep_start,sleep_end,asleep_seconds,light_seconds,deep_seconds,rem_seconds,interruption_seconds,updated_at FROM wellness_nights WHERE user_id=? ORDER BY night_date,provider",
  wellnessDays:"SELECT provider,day_date,resting_hr,min_hr,avg_hr,max_hr,samples,buckets_json,updated_at FROM wellness_days WHERE user_id=? ORDER BY day_date,provider",
  wellnessWorkouts:"SELECT provider,external_id,started_at,local_date,duration_seconds,sport,calories,hr_avg,hr_max,cardio_load,updated_at FROM wellness_workouts WHERE user_id=? ORDER BY started_at,external_id"
});
const ACCOUNT_EXPORT_SINGLE_ROWS=new Set(["profile","weeklyPlan","monthlyPlan","preferences","trainingBlock","coachingProfile"]);
const ACCOUNT_EXPORT_WORKOUTS_QUERY="SELECT id,workout_json,summary_json,started_at,revision,updated_at FROM workouts WHERE user_id=? AND (started_at>? OR (started_at=? AND id>?)) ORDER BY started_at,id LIMIT ?";
const ACCOUNT_SELF_SERVICE_SQL=Object.freeze({
  accountSessions:"SELECT s.token_hash,s.created_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id AND u.auth_version=s.auth_version AND u.suspended_at IS NULL WHERE s.user_id=? AND s.expires_at>? ORDER BY CASE WHEN s.token_hash=? THEN 0 ELSE 1 END,s.created_at DESC,s.token_hash",
  revokeAccountSession:"DELETE FROM sessions WHERE user_id=? AND token_hash=? AND token_hash<>? AND expires_at>? AND auth_version=(SELECT auth_version FROM users WHERE id=?) AND EXISTS(SELECT 1 FROM sessions current JOIN users u ON u.id=current.user_id AND u.auth_version=current.auth_version AND u.suspended_at IS NULL WHERE current.token_hash=? AND current.user_id=sessions.user_id AND current.expires_at>?) RETURNING token_hash",
  revokeOtherAccountSessions:"DELETE FROM sessions WHERE user_id=? AND token_hash<>? AND expires_at>? AND auth_version=(SELECT auth_version FROM users WHERE id=?) AND EXISTS(SELECT 1 FROM sessions current JOIN users u ON u.id=current.user_id AND u.auth_version=current.auth_version AND u.suspended_at IS NULL WHERE current.token_hash=? AND current.user_id=sessions.user_id AND current.expires_at>?) RETURNING token_hash",
  accountExportWorkouts:ACCOUNT_EXPORT_WORKOUTS_QUERY,
  ...Object.fromEntries(Object.entries(ACCOUNT_EXPORT_QUERIES).map(([name,sql])=>[`accountExport${name.charAt(0).toUpperCase()}${name.slice(1)}`,sql]))
});

module.exports={ACCOUNT_EXPORT_QUERIES,ACCOUNT_EXPORT_SINGLE_ROWS,ACCOUNT_EXPORT_WORKOUTS_QUERY,ACCOUNT_SELF_SERVICE_SQL};
