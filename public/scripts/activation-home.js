"use strict";
(() => {
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    $ = (id) => document.getElementById(id);
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>'"]/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character],
    );
  function profileFrom(sample) {
    const availability = {
      2: ["Monday", "Thursday"],
      3: ["Monday", "Wednesday", "Friday"],
      4: ["Monday", "Tuesday", "Thursday", "Friday"],
      5: ["Monday", "Tuesday", "Wednesday", "Friday", "Saturday"],
    };
    return {
      version: 1,
      goal: sample.goal,
      level: sample.level,
      minutes: sample.minutes,
      equipment: [sample.equipment],
      availability: availability[sample.days] || availability[3],
      preferences: ["simple-setup"],
      limitations: [],
      focusGroup: sample.group,
    };
  }
  function canBuild({ exercises, sample }) {
    if (!globalThis.StrataOnboarding?.buildWeek || !globalThis.StrataDiscovery) return false;
    try {
      let sequence = 0;
      globalThis.StrataOnboarding.buildWeek(
        profileFrom(sample),
        exercises,
        globalThis.StrataDiscovery,
        () => `home-check-${++sequence}`,
      );
      return true;
    } catch {
      return false;
    }
  }
  function weekMarkup(plan, exercises) {
    const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]));
    return DAYS.map((day) => {
      const items = Array.isArray(plan?.days?.[day]) ? plan.days[day] : [];
      return `<article class="quick-week-day ${items.length ? "" : "is-recovery"}"><div><span>${day.slice(0, 3)}</span><strong>${items.length ? `${items.length} movement${items.length === 1 ? "" : "s"}` : "Recovery"}</strong></div>${items.length ? `<ol>${items.map((item) => `<li><b>${escape(byId.get(item.exerciseId)?.name || "Movement unavailable")}</b><small>${escape(item.sets)} × ${escape(item.reps)}</small></li>`).join("")}</ol>` : "<p>No scheduled session.</p>"}</article>`;
    }).join("");
  }
  function renderWeek(plan, profile, exercises, { restored = false } = {}) {
    const movementCount = DAYS.reduce(
        (total, day) => total + (Array.isArray(plan?.days?.[day]) ? plan.days[day].length : 0),
        0,
      ),
      trainingDays = DAYS.filter((day) => plan?.days?.[day]?.length).length;
    $("quickWeekGrid").innerHTML = weekMarkup(plan, exercises);
    $("quickWeekMeta").textContent =
      `${trainingDays} training days · ${movementCount} movements · ${profile.minutes} minutes per session`;
    $("quickWeekBoundary").textContent = restored
      ? "Your preview is back. Sign in to choose which week to keep. Your account plan stays unchanged until you save."
      : "Like this week? Save it with a free account. Guided workouts and Training Memory are part of Strata+.";
    $("quickWeekPreview").hidden = false;
  }
  function render({ exercises, sample, profile, plan, previewResultMarkup, restored = false }) {
    const result = globalThis.StrataPreview.buildPreview({
      exercises,
      profile: sample,
      discovery: globalThis.StrataDiscovery,
      limit: 3,
    });
    $("quickPreviewSummary").textContent = `${profile.availability.length}-day week ready`;
    $("quickPreviewResults").innerHTML = result.items.map(previewResultMarkup).join("");
    renderWeek(plan, profile, exercises, { restored });
    $("quickPreviewActions").hidden = false;
    $("quickPreviewStatus").textContent = restored
      ? "Your complete device preview was restored. Review it, then sign in or create an account to choose what to keep."
      : `Complete week ready. Review all seven days and ${result.items.length} explained recommendation${result.items.length === 1 ? "" : "s"}. Nothing has been saved to an account.`;
  }
  function generate({ exercises, sample, previewResultMarkup }) {
    if (!globalThis.StrataOnboarding?.buildWeek)
      throw new Error("The complete-week builder is unavailable. Reload and try again.");
    const profile = profileFrom(sample);
    let sequence = 0;
    const week = globalThis.StrataOnboarding.buildWeek(
      profile,
      exercises,
      globalThis.StrataDiscovery,
      () => `home-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
    );
    let stored = false;
    try {
      globalThis.StrataActivation.writeIntent(localStorage, {
        source: "homepage",
        profile,
        plan: week.plan,
      });
      stored = true;
    } catch {}
    render({ exercises, sample, profile, plan: week.plan, previewResultMarkup });
    return { stored, profile, plan: week.plan };
  }
  function restore({ exercises, applyProfile, readSample, previewResultMarkup }) {
    if (!globalThis.StrataActivation?.readIntent) return false;
    let intent;
    try {
      intent = globalThis.StrataActivation.readIntent(localStorage);
    } catch {
      return false;
    }
    if (!intent) return false;
    applyProfile(intent.profile);
    try {
      render({
        exercises,
        sample: readSample(),
        profile: intent.profile,
        plan: intent.plan,
        previewResultMarkup,
        restored: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  function hide() {
    $("quickWeekPreview").hidden = true;
  }
  globalThis.StrataHomeActivation = { generate, restore, hide, profileFrom, canBuild };
})();
