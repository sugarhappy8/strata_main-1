"use strict";

// Product activity is deliberately aggregated at write time. The database
// never receives a browser, account, URL, workout, or recommendation record.
const PRODUCT_SIGNAL_TABLE=`CREATE TABLE IF NOT EXISTS product_signal_counts (
  event_day TEXT NOT NULL CHECK(length(event_day)=10 AND event_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  event_name TEXT NOT NULL CHECK(event_name IN (
    'preview_generated','onboarding_previewed','onboarding_saved','plan_saved',
    'workout_started','workout_completed','upgrade_viewed',
    'checkout_opened','upgrade_activated','recommendation_feedback_useful',
    'recommendation_feedback_not_relevant','recommendation_feedback_not_clear'
  )),
  event_count INTEGER NOT NULL CHECK(event_count BETWEEN 1 AND 2147483647),
  PRIMARY KEY(event_day,event_name)
)`;

const PRODUCT_SIGNAL_SQL=Object.freeze({
  incrementProductSignal:"INSERT INTO product_signal_counts(event_day,event_name,event_count) VALUES(?,?,1) ON CONFLICT(event_day,event_name) DO UPDATE SET event_count=MIN(product_signal_counts.event_count+1,2147483647) RETURNING event_day,event_name,event_count",
  productSignalCounts:"SELECT event_day,event_name,event_count FROM product_signal_counts WHERE event_day>=? AND event_day<=? ORDER BY event_day,event_name",
  deleteOldProductSignals:"DELETE FROM product_signal_counts WHERE event_day<?"
});

module.exports={PRODUCT_SIGNAL_TABLE,PRODUCT_SIGNAL_SQL};
