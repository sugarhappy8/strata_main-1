/* global module, require */
(function (root, factory) {
  const diary =
    typeof module === "object" && module.exports
      ? require("./personal-training-diary-ui")
      : root.StrataPersonalTrainingDiaryUi;
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(diary, StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataDiscoverCoachingTrend = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (diary, StrataHtml) {
  "use strict";
  const KG_PER_LB = 0.45359237;
  const escape = StrataHtml.escape;
  const dateLabel = (value) => {
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime())
      ? String(value || "")
      : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  };
  const decimal = (value) =>
    (Math.round(value * 10) / 10).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const signed = (value) => {
    const rounded = Math.round(value * 10) / 10;
    return `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${decimal(Math.abs(rounded))}`;
  };

  // One series of daily dots and its seven-day average line; hover titles and a hidden table carry every value.
  // The SVG is drawn at the figure's own width so 12px labels stay 12px on phones and wide screens alike.
  function chart(points, unit, convert, frameWidth = 640) {
    const width = Math.max(280, Math.min(1200, Math.round(frameWidth) || 640)),
      height = width < 520 ? 200 : 240,
      pad = { left: 60, right: 14, top: 14, bottom: 30 },
      values = points.flatMap((point) => [convert(point.kg), convert(point.averageKg)]);
    const low = Math.floor(Math.min(...values) - 0.5),
      high = Math.ceil(Math.max(...values) + 0.5),
      span = Math.max(1, high - low),
      first = Date.parse(`${points[0].date}T00:00:00Z`),
      days = Math.max(1, (Date.parse(`${points.at(-1).date}T00:00:00Z`) - first) / 86400000);
    const x = (date) =>
        pad.left +
        ((Date.parse(`${date}T00:00:00Z`) - first) / 86400000 / days) *
          (width - pad.left - pad.right),
      y = (value) => pad.top + ((high - value) / span) * (height - pad.top - pad.bottom);
    const grid = [high, (low + high) / 2, low]
      .map(
        (tick, index) =>
          `<line class="trend-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"/><text class="trend-axis" x="${pad.left - 10}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${Number.isInteger(tick) ? tick.toLocaleString() : decimal(tick)}${index ? "" : ` ${unit}`}</text>`,
      )
      .join("");
    const line = points
      .map(
        (point, index) =>
          `${index ? "L" : "M"}${x(point.date).toFixed(1)},${y(convert(point.averageKg)).toFixed(1)}`,
      )
      .join(" ");
    const dots = points
      .map(
        (point) =>
          `<circle class="trend-dot" cx="${x(point.date).toFixed(1)}" cy="${y(convert(point.kg)).toFixed(1)}" r="4"><title>${escape(dateLabel(point.date))}: ${decimal(convert(point.kg))} ${unit} · seven-day average ${decimal(convert(point.averageKg))} ${unit}</title></circle>`,
      )
      .join("");
    const axis = `<text class="trend-axis" x="${pad.left}" y="${height - 8}">${escape(dateLabel(points[0].date))}</text><text class="trend-axis" x="${width - pad.right}" y="${height - 8}" text-anchor="end">${escape(dateLabel(points.at(-1).date))}</text>`;
    const rows = points
      .map(
        (point) =>
          `<tr><th scope="row">${escape(dateLabel(point.date))}</th><td>${decimal(convert(point.kg))}</td><td>${decimal(convert(point.averageKg))}</td></tr>`,
      )
      .join("");
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Morning weight from ${escape(dateLabel(points[0].date))} to ${escape(dateLabel(points.at(-1).date))} with its seven-day average, in ${unit}">${grid}<path class="trend-line" d="${line}"/>${dots}${axis}</svg><figcaption class="trend-legend"><span><i class="trend-key-dot" aria-hidden="true"></i>Morning weight</span><span><i class="trend-key-line" aria-hidden="true"></i>Seven-day average</span></figcaption><table class="sr-only"><caption>Morning weights and seven-day average in ${unit}</caption><thead><tr><th scope="col">Date</th><th scope="col">Weight</th><th scope="col">Seven-day average</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function createTrend({ element }) {
    const el = element;
    let drawn = null;
    // Redraw when the figure's width changes, including when a hidden workspace first becomes visible.
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            const figure = el("coachingTrendChart");
            if (
              drawn &&
              figure &&
              figure.clientWidth &&
              Math.abs(figure.clientWidth - drawn.width) > 8
            )
              draw(figure);
          })
        : null;
    function draw(figure) {
      drawn.width = figure.clientWidth || 640;
      StrataHtml.setHtml(figure, chart(drawn.points, drawn.unit, drawn.convert, drawn.width));
    }
    function clear() {
      drawn = null;
      for (const id of ["coachingStreak", "coachingTrendSummary", "coachingTrendChart"]) {
        const node = el(id);
        if (node) {
          node.textContent = "";
          if (id === "coachingStreak") node.hidden = true;
        }
      }
    }
    function render({ profile, week, logs }) {
      const today = String(week?.diaryEndDate || ""),
        imperial = profile?.measurementSystem === "imperial",
        unit = imperial ? "lb" : "kg",
        convert = (kg) => (imperial ? kg / KG_PER_LB : kg),
        streak = diary.loggingStreak(logs, today),
        trend = diary.weightTrend(logs, today);
      const badge = el("coachingStreak");
      if (badge) {
        badge.hidden = streak.days < 2;
        badge.textContent =
          streak.days < 2
            ? ""
            : `${streak.days}-day logging streak${streak.includesToday ? "" : " · log today to keep it"}`;
      }
      const summary = el("coachingTrendSummary"),
        figure = el("coachingTrendChart");
      if (!summary || !figure) return;
      if (trend.points.length < 2) {
        drawn = null;
        summary.textContent =
          "Log a morning weight on two or more days to see your trend. Daily weights swing with water and food; the seven-day average shows the direction.";
        figure.textContent = "";
        return;
      }
      summary.textContent = `Seven-day average ${decimal(convert(trend.averageKg))} ${unit}${trend.weeklyChangeKg == null ? "" : `, trending ${signed(convert(trend.weeklyChangeKg))} ${unit} per week`}. Latest weigh-in ${decimal(convert(trend.latestKg))} ${unit}.`;
      drawn = { points: trend.points, unit, convert, width: 0 };
      draw(figure);
      observer?.observe(figure);
    }
    return { clear, render };
  }
  return { createTrend };
});
