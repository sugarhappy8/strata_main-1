"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTrend } = require("../public/scripts/discover-coaching-trend");

function elements() {
  const nodes = new Map();
  return (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: "", innerHTML: "", hidden: false });
    return nodes.get(id);
  };
}
const day = (offset) => new Date(Date.UTC(2026, 8, 27 + offset)).toISOString().slice(0, 10);
const week = { diaryEndDate: day(0) };

test("the weight trend draws each morning weight and its seven-day average with an accessible table", () => {
  const el = elements(),
    trend = createTrend({ element: el }),
    logs = Array.from({ length: 10 }, (_, index) => ({
      date: day(index - 9),
      calories: 2100,
      morningWeightKg: Math.round((82 - index * 0.1) * 100) / 100,
    }));
  trend.render({ profile: { measurementSystem: "metric" }, week, logs });
  const markup = el("coachingTrendChart").innerHTML;
  assert.equal((markup.match(/<circle class="trend-dot"/g) || []).length, 10);
  assert.match(markup, /<path class="trend-line" d="M/);
  assert.match(
    markup,
    /role="img" aria-label="Morning weight from .+ with its seven-day average, in kg"/,
  );
  assert.match(markup, /Morning weight<\/span><span><i class="trend-key-line"/);
  assert.equal(
    (markup.match(/<tr><th scope="row">/g) || []).length,
    10,
    "every point is in the hidden table",
  );
  assert.match(
    el("coachingTrendSummary").textContent,
    /^Seven-day average 81\.4 kg, trending −0\.7 kg per week\. Latest weigh-in 81\.1 kg\.$/,
  );
  assert.equal(el("coachingStreak").hidden, false);
  assert.equal(el("coachingStreak").textContent, "10-day logging streak");
  trend.render({ profile: { measurementSystem: "imperial" }, week, logs });
  assert.match(el("coachingTrendSummary").textContent, /Latest weigh-in 178\.8 lb/);
  assert.match(el("coachingTrendChart").innerHTML, /in lb"/);
  trend.render({ profile: { measurementSystem: "metric" }, week, logs: logs.slice(-1) });
  assert.equal(el("coachingTrendChart").innerHTML, "");
  assert.match(el("coachingTrendSummary").textContent, /two or more days/);
  assert.equal(el("coachingStreak").hidden, true, "a single logged day is not a streak");
  trend.clear();
  assert.equal(el("coachingTrendSummary").textContent, "");
  assert.equal(el("coachingStreak").hidden, true);
});

test("the weight trend is drawn at the figure's width and labels its unit once", () => {
  const el = elements(),
    trend = createTrend({ element: el }),
    logs = Array.from({ length: 6 }, (_, index) => ({
      date: day(index - 5),
      calories: 2000,
      morningWeightKg: 80 + index * 0.2,
    }));
  el("coachingTrendChart").clientWidth = 390;
  trend.render({ profile: { measurementSystem: "metric" }, week, logs });
  const phone = el("coachingTrendChart").innerHTML;
  assert.match(phone, /<svg viewBox="0 0 390 200"/);
  const ticks = [
    ...phone.matchAll(
      /<text class="trend-axis" x="50" y="[\d.]+" text-anchor="end">([^<]+)<\/text>/g,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    ticks,
    ["82 kg", "80.5", "79"],
    "integral ticks drop the decimal and only the top tick carries the unit",
  );
  el("coachingTrendChart").clientWidth = 1100;
  trend.render({ profile: { measurementSystem: "metric" }, week, logs });
  assert.match(el("coachingTrendChart").innerHTML, /<svg viewBox="0 0 1100 240"/);
  el("coachingTrendChart").clientWidth = 0;
  trend.render({ profile: { measurementSystem: "metric" }, week, logs });
  assert.match(
    el("coachingTrendChart").innerHTML,
    /<svg viewBox="0 0 640 240"/,
    "a hidden figure falls back to a default width",
  );
});
