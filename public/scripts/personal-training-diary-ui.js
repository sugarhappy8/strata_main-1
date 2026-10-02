/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPersonalTrainingDiaryUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const prefixes = ["coaching"],
    fields = [
      "LogDate",
      "CaloriesEaten",
      "MorningWeight",
      "ProteinEaten",
      "CarbsEaten",
      "FatEaten",
    ];
  const validDate = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  function targetsFor(week) {
    const rows = Array.isArray(week?.logTargets)
      ? week.logTargets
      : week?.nutrition?.dailyTargets || [];
    return rows
      .filter((row) => validDate(row?.date))
      .map((row) => ({
        ...row,
        day:
          row.day ||
          new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
            new Date(`${row.date}T00:00:00Z`),
          ),
        calories:
          typeof row.calories === "number" && Number.isFinite(row.calories) && row.calories > 0
            ? row.calories
            : null,
      }));
  }
  function selectedDate(week, requested, today) {
    const rows = targetsFor(week);
    return rows.some((row) => row.date === requested)
      ? requested
      : rows.some((row) => row.date === today)
        ? today
        : rows.at(-1)?.date || "";
  }
  function context(week, logs, date) {
    const row = targetsFor(week).find((item) => item.date === date);
    return row
      ? {
          row,
          target: row.calories == null ? null : row,
          log: (logs || []).find((item) => item.date === date) || null,
        }
      : null;
  }
  function captureForms(el) {
    return prefixes.map((prefix) => ({
      prefix,
      values: Object.fromEntries(
        fields.map((field) => [field, String(el(`${prefix}${field}`)?.value ?? "")]),
      ),
      complete: Boolean(el(`${prefix}DayComplete`)?.checked),
    }));
  }
  function formsChanged(before, el) {
    return JSON.stringify(before) !== JSON.stringify(captureForms(el));
  }
  const shiftDate = (value, days) =>
    new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  // Consecutive days with calories logged, counted back from today (or from yesterday while today is still empty).
  function loggingStreak(logs, today) {
    if (!validDate(today)) return { days: 0, includesToday: false };
    const logged = new Set(
        (Array.isArray(logs) ? logs : [])
          .filter(
            (log) => validDate(log?.date) && Number.isFinite(log.calories) && log.calories > 0,
          )
          .map((log) => log.date),
      ),
      includesToday = logged.has(today);
    let day = includesToday ? today : shiftDate(today, -1),
      days = 0;
    while (logged.has(day)) {
      days += 1;
      day = shiftDate(day, -1);
    }
    return { days, includesToday };
  }
  // Morning weights with a trailing seven-day average, plus a weekly rate: the least-squares slope of the last
  // 14 days of weights (at least four spanning a week), which a half-filled early average window cannot bias.
  function weightTrend(logs, today, windowDays = 28) {
    if (!validDate(today))
      return { points: [], latestKg: null, averageKg: null, weeklyChangeKg: null };
    const start = shiftDate(today, -(windowDays - 1)),
      weights = (Array.isArray(logs) ? logs : [])
        .filter(
          (log) =>
            validDate(log?.date) &&
            log.date >= shiftDate(start, -6) &&
            log.date <= today &&
            Number.isFinite(log.morningWeightKg),
        )
        .map((log) => ({ date: log.date, kg: log.morningWeightKg }))
        .sort((a, b) => a.date.localeCompare(b.date));
    const averageAt = (date) => {
      const recent = weights.filter(
        (point) => point.date <= date && point.date >= shiftDate(date, -6),
      );
      return recent.length
        ? recent.reduce((sum, point) => sum + point.kg, 0) / recent.length
        : null;
    };
    const points = weights
        .filter((point) => point.date >= start)
        .map((point) => ({ ...point, averageKg: averageAt(point.date) })),
      latest = points.at(-1),
      recent = points.filter((point) => point.date >= shiftDate(today, -13));
    const days = recent.map(
        (point) =>
          (Date.parse(`${point.date}T00:00:00Z`) - Date.parse(`${recent[0]?.date}T00:00:00Z`)) /
          86400000,
      ),
      meanDay = days.reduce((sum, day) => sum + day, 0) / (days.length || 1),
      meanKg = recent.reduce((sum, point) => sum + point.kg, 0) / (recent.length || 1);
    const spread = days.reduce((sum, day) => sum + (day - meanDay) ** 2, 0),
      slope = spread
        ? days.reduce(
            (sum, day, index) => sum + (day - meanDay) * ((recent[index]?.kg ?? meanKg) - meanKg),
            0,
          ) / spread
        : 0;
    return {
      points,
      latestKg: latest?.kg ?? null,
      averageKg: latest?.averageKg ?? null,
      weeklyChangeKg: recent.length >= 4 && (days.at(-1) ?? 0) >= 7 ? slope * 7 : null,
    };
  }
  return Object.freeze({
    targetsFor,
    selectedDate,
    context,
    captureForms,
    formsChanged,
    loggingStreak,
    weightTrend,
  });
});
