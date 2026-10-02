"use strict";
(() => {
  const activation = globalThis.StrataActivation;
  if (!activation?.readIntent) return;
  let intent;
  try {
    intent = activation.readIntent(localStorage);
  } catch {
    return;
  }
  if (!intent) return;
  const movements = activation.planCount(intent.plan),
    days = activation.DAYS.filter((day) => intent.plan.days[day].length).length;
  document.querySelectorAll("[data-activation-handoff]").forEach((node) => {
    const detail = node.querySelector("[data-activation-handoff-detail]");
    if (detail)
      detail.textContent = `${days} training days · ${movements} movements · ${intent.profile.minutes} minutes per session`;
    node.hidden = false;
  });
})();
