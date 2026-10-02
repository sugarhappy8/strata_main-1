/* global module */
(function (root, factory) {
  "use strict";
  const recovery = factory();
  if (typeof module === "object" && module.exports) module.exports = recovery;
  else root.StrataWorkoutRecovery = recovery;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Train's recovery line from the member's own Polar data, and the optional lighter session. A lighter session
  // keeps every exercise with one set fewer each (never below one) for today only; the weekly Plan never changes.

  function create({ $, state, request, core, esc, renderHistory = () => {} }) {
    let today = null,
      deviceWorkouts = [],
      loaded = false,
      lighter = false;
    state.deviceNote = (item) =>
      item?.status === "completed"
        ? core.deviceWorkoutText(core.matchDeviceWorkout(item, deviceWorkouts))
        : "";

    function render() {
      const box = $("deviceRecovery");
      if (!box) return;
      const summary = today?.summary,
        start = $("startWorkout"),
        active =
          today?.connected &&
          today.connection?.status === "active" &&
          summary &&
          summary.state !== "no-data";
      if (!active) {
        box.hidden = true;
        box.innerHTML = "";
        return;
      }
      const stress = core.stressView(summary.stress),
        advice = summary.lighterSession || {},
        canStart = Boolean(start && !start.hidden && !start.disabled);
      const offer = advice.offer === true && summary.state === "current" && canStart,
        note = offer || advice.note ? core.lighterText(advice) : "";
      const facts =
        summary.state === "stale"
          ? `Latest night from Polar: ${core.dateLabel(summary.date)}`
          : [
              `Overnight stress signals ${stress.label.toLowerCase()}`,
              summary.sleep?.asleepSeconds
                ? `slept ${core.durationText(summary.sleep.asleepSeconds)}`
                : "",
            ]
              .filter(Boolean)
              .join(" · ");
      box.hidden = false;
      box.dataset.tone = core.recoveryTone(summary.recovery?.status);
      box.innerHTML = `<div><strong>${esc(summary.recovery?.label ? `Polar recovery: ${summary.recovery.label}` : "Polar recovery")}</strong><span>${esc(facts)}</span>${note ? `<p>${esc(note)}</p>` : ""}</div><div class="device-recovery-actions">${offer ? '<button class="button secondary" type="button" id="startLighterWorkout">Start a lighter session</button>' : ""}<a class="text-link" href="/discover.html#recoveryWorkspace">Recovery details ↗</a></div>`;
    }
    /** The Start button runs this on every new workout; only the lighter-session button asks for the change. */
    function prepare(workout) {
      return lighter ? core.lighterWorkout(workout).workout : workout;
    }
    async function load() {
      if (loaded || state.mode !== "account") return;
      loaded = true;
      try {
        const [result, workouts] = await Promise.all([
          request(`/api/wellness/today?date=${core.localDate()}`),
          request("/api/wellness/workouts?days=90").catch(() => null),
        ]);
        if (state.blocked) return;
        today = result;
        deviceWorkouts = Array.isArray(workouts?.workouts) ? workouts.workouts : [];
      } catch {
        today = null;
        deviceWorkouts = [];
      }
      render();
      if (deviceWorkouts.length) renderHistory();
    }
    function reset() {
      today = null;
      deviceWorkouts = [];
      loaded = false;
      render();
    }

    $("deviceRecovery")?.addEventListener("click", (event) => {
      if (!event.target.closest?.("#startLighterWorkout")) return;
      lighter = true;
      try {
        $("startWorkout").click();
      } finally {
        lighter = false;
      }
    });
    return { load, prepare, render, reset };
  }

  return { create };
});
