"use strict";

// Product activity is aggregated at write time. Counts are keyed by day and action name, split into signed-in and
// anonymous totals. To count each action once per account or network per UTC day, the server keeps a one-way daily
// key (an HMAC under a key that lives only in server memory) until that day ends; no account, browser, address, URL,
// workout, or recommendation record is stored.
const PRODUCT_SIGNAL_TABLE = `CREATE TABLE IF NOT EXISTS product_signal_counts (
  event_day TEXT NOT NULL CHECK(length(event_day)=10 AND event_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  event_name TEXT NOT NULL CHECK(event_name IN (
    'preview_generated','onboarding_previewed','onboarding_saved','plan_saved',
    'workout_started','workout_completed','upgrade_viewed',
    'checkout_opened','upgrade_activated','recommendation_feedback_useful',
    'recommendation_feedback_not_relevant','recommendation_feedback_not_clear'
  )),
  event_count INTEGER NOT NULL CHECK(event_count BETWEEN 1 AND 2147483647),
  member_count INTEGER NOT NULL DEFAULT 0,
  anonymous_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(event_day,event_name)
)`;

const PRODUCT_SIGNAL_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS product_signal_actors (
    event_day TEXT NOT NULL,
    event_name TEXT NOT NULL,
    actor_key TEXT NOT NULL CHECK(length(actor_key)=64),
    audience TEXT NOT NULL CHECK(audience IN ('member','anonymous')),
    PRIMARY KEY(event_day,event_name,actor_key)
  ) WITHOUT ROWID`,
]);

// A counted action adds its daily key; the trigger adds it to the day's totals in the same statement, so a repeat
// (the key already present) changes nothing. Migration 010 creates it once the count columns exist, because SQLite
// re-checks every trigger when an older database's migration renames a table.
const PRODUCT_SIGNAL_TRIGGER = Object.freeze([
  "DROP TRIGGER IF EXISTS product_signal_actors_count",
  `CREATE TRIGGER product_signal_actors_count AFTER INSERT ON product_signal_actors BEGIN
    INSERT INTO product_signal_counts(event_day,event_name,event_count,member_count,anonymous_count)
    VALUES(NEW.event_day,NEW.event_name,1,NEW.audience='member',NEW.audience='anonymous')
    ON CONFLICT(event_day,event_name) DO UPDATE SET
      event_count=MIN(product_signal_counts.event_count+1,2147483647),
      member_count=MIN(product_signal_counts.member_count+excluded.member_count,2147483647),
      anonymous_count=MIN(product_signal_counts.anonymous_count+excluded.anonymous_count,2147483647);
  END`,
]);

const PRODUCT_SIGNAL_SQL = Object.freeze({
  recordProductSignal:
    "INSERT INTO product_signal_actors(event_day,event_name,actor_key,audience) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING event_name",
  productSignalCounts: `SELECT event_day,event_name,event_count,member_count,anonymous_count
    FROM product_signal_counts
    WHERE event_day>=? AND event_day<=?
    ORDER BY event_day,event_name`,
  deleteOldProductSignals: "DELETE FROM product_signal_counts WHERE event_day<?",
  deleteProductSignalActors: "DELETE FROM product_signal_actors WHERE event_day<?",
});

module.exports = {
  PRODUCT_SIGNAL_TABLE,
  PRODUCT_SIGNAL_SCHEMA,
  PRODUCT_SIGNAL_TRIGGER,
  PRODUCT_SIGNAL_SQL,
};
