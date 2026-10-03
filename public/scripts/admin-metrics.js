/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAdminMetrics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The owner's investor metrics, drawn from GET /api/admin/metrics. The server computes every figure; this module
  // only formats them, as text nodes, into the summary cards and one table per figure.
  const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
  const count = (value) => (finite(value) ? Number(value).toLocaleString("en-US") : "—");
  const percent = (value) => (finite(value) ? `${(Number(value) * 100).toFixed(1)}%` : "—");
  const usd = (value, digits = 2) => (finite(value) ? `$${Number(value).toFixed(digits)}` : "—");
  const share = (part, whole, rate) =>
    finite(whole) && Number(whole) > 0
      ? `${count(part)} of ${count(whole)} · ${percent(rate)}`
      : "—";
  const period = (label, complete) => (complete === false ? `${label} (so far)` : String(label));

  const SUMMARY_IDS = Object.freeze([
    "metricsWeeklyActiveStat",
    "metricsPayingStat",
    "metricsMrrStat",
    "metricsConversionStat",
  ]);

  function scopeText(metrics) {
    const since = String(metrics?.activationRecordedSince || "").slice(0, 10);
    return [
      `${count(metrics?.internalAccountsExcluded)} internal accounts are left out.`,
      since ? `Activation is recorded from ${since}.` : "Activation is not recorded yet.",
      `Generated ${String(metrics?.generatedAt || "")
        .slice(0, 16)
        .replace("T", " ")} UTC.`,
    ].join(" ");
  }

  function createMetricsView({ document }) {
    if (!document) throw new TypeError("The metrics view requires a document.");
    const el = (id) => document.getElementById(id);
    function create(tag, className = "", text = "") {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== "") node.textContent = String(text);
      return node;
    }
    // A wide table scrolls inside its own labelled region, so the page never scrolls sideways on a phone.
    function table(caption, headings, rows) {
      const wrap = create("div", "metrics-table-wrap"),
        node = create("table", "metrics-table"),
        head = create("thead"),
        headRow = create("tr"),
        body = create("tbody");
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", caption);
      wrap.tabIndex = 0;
      for (const heading of headings) {
        const cell = create("th", "", heading);
        cell.scope = "col";
        headRow.append(cell);
      }
      head.append(headRow);
      for (const row of rows) {
        const line = create("tr");
        row.forEach((value, index) => {
          const cell = create(index === 0 ? "th" : "td", "", value);
          if (index === 0) cell.scope = "row";
          line.append(cell);
        });
        body.append(line);
      }
      node.append(create("caption", "", caption), head, body);
      wrap.append(node);
      return wrap;
    }

    function render(metrics) {
      const summary = metrics?.summary || {},
        revenue = metrics?.revenue || {},
        ai = metrics?.ai || {};
      el("metricsWeeklyActiveStat").textContent = count(summary.weeklyActiveMembers);
      el("metricsPayingStat").textContent = count(summary.payingMembers);
      el("metricsMrrStat").textContent = usd(summary.mrr?.list);
      el("metricsMrrNote").textContent = `After provider fees: ${usd(summary.mrr?.afterFees)}`;
      el("metricsConversionStat").textContent = percent(summary.conversionRate);
      el("metricsScope").textContent = scopeText(metrics);
      const rate = finite(ai.usdPerMillionTokens)
        ? `at ${usd(ai.usdPerMillionTokens)} per million tokens`
        : "set STRATA_AI_USD_PER_MILLION_TOKENS to price it";
      el("metricsTables").replaceChildren(
        table(
          "Revenue now",
          ["Measure", "Value"],
          [
            ["Customer accounts", count(revenue.accounts)],
            ["Ever paid", `${count(revenue.everPaid)} · ${percent(revenue.conversionRate)}`],
            ["Paying members", count(revenue.payingMembers)],
            ["Paddle subscriptions", count(revenue.paddleSubscriptions)],
            ["App Store subscriptions", count(revenue.appStoreSubscriptions)],
            ["Google Play subscriptions", count(revenue.googlePlaySubscriptions)],
            ["Yearly subscriptions", count(revenue.yearlySubscriptions)],
            ["Lifetime access (no recurring charge)", count(revenue.lifetimeMembers)],
            ["MRR at list price", usd(revenue.mrr?.list)],
            ["MRR after provider fees", usd(revenue.mrr?.afterFees)],
          ],
        ),
        table(
          "Weekly active members and sign-ups",
          ["Week starting", "Active members", "Sign-ups", "Email", "Google"],
          (metrics?.weekly || []).map((row) => [
            period(row.weekStart, row.complete),
            count(row.activeMembers),
            count(row.signups),
            count(row.emailSignups),
            count(row.googleSignups),
          ]),
        ),
        table(
          "Sign-up cohorts: activation and retention",
          [
            "Sign-up week",
            "Sign-ups",
            "Full week in 7 days",
            "Active in week 4",
            "Active in week 8",
          ],
          (metrics?.cohorts || []).map((row) => [
            row.weekStart,
            count(row.signups),
            share(row.activation?.activated, row.activation?.eligible, row.activation?.rate),
            ...(row.retention || []).map((item) => share(item.retained, item.eligible, item.rate)),
          ]),
        ),
        table(
          "Paying subscriptions by month",
          ["Month", "At start", "New", "Ended", "Churn", "At end", "MRR at end"],
          (metrics?.monthly || []).map((row) => [
            period(row.month, row.complete),
            count(row.payingAtStart),
            count(row.started),
            count(row.ended),
            percent(row.churnRate),
            count(row.payingAtEnd),
            usd(row.mrrAtEnd),
          ]),
        ),
        table(
          `Strata AI cost per active Strata+ member (${rate})`,
          [
            "Month",
            "Active Strata+ members",
            "Requests",
            "Tokens",
            "Tokens per member",
            "Cost",
            "Cost per member",
          ],
          (ai.months || []).map((row) => [
            period(row.month, row.complete),
            count(row.activePlusMembers),
            count(row.requests),
            count(row.tokens),
            count(row.tokensPerMember),
            usd(row.estimatedCost),
            usd(row.costPerMember, 4),
          ]),
        ),
      );
    }

    function clear() {
      for (const id of SUMMARY_IDS) el(id).textContent = "—";
      el("metricsMrrNote").textContent = "After provider fees: —";
      el("metricsScope").textContent = "";
      el("metricsTables").replaceChildren();
    }

    return { render, clear };
  }

  return { count, percent, usd, share, period, scopeText, createMetricsView };
});
