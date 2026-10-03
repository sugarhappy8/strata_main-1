/* global module, require */
(function (root, factory) {
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPlannerRender = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (StrataHtml) {
  "use strict";

  const { html } = StrataHtml;

  function filterMarkup(groups, activeGroup) {
    return groups.map(
      (group) =>
        html`<button class="planner-filter ${activeGroup === group ? "active" : ""}" data-library-group="${group}" type="button" aria-pressed="${activeGroup === group}">${group === "all" ? "All" : group.charAt(0).toUpperCase() + group.slice(1)}</button>`,
    );
  }

  function dayNavMarkup(days, { selectedDay, restDays = [] }) {
    return days.map((day) => {
      const selected = selectedDay === day,
        rest = restDays.includes(day);
      const label = rest
        ? `${day}, recovery day`
        : selected
          ? `${day}, selected for new exercises`
          : `Add new exercises to ${day}`;
      return html`<button class="planner-day-chip ${selected ? "active" : ""} ${rest ? "recovery" : ""}" data-select-day="${day}" data-day-chip="${day}" type="button" aria-label="${label}" aria-pressed="${selected}" ${rest ? "disabled" : ""}>${day.slice(0, 3)}</button>`;
    });
  }

  function libraryMarkup(items, { selectedDay, visibleLimit, pageSize }) {
    const visibleItems = items.slice(0, visibleLimit),
      remaining = Math.max(0, items.length - visibleItems.length),
      nextCount = Math.min(pageSize, remaining);
    if (!items.length)
      return html`<div class="library-empty"><strong>No matching movements</strong><span>Try another search or choose a different muscle group.</span></div>`;
    const cards = visibleItems.map((exercise, index) => {
      const id = exercise.id,
        name = exercise.name,
        sub = exercise.sub,
        equipment = exercise.equipment,
        youtube = exercise.youtube,
        day = selectedDay;
      return html`<article class="library-card" draggable="true" data-library-id="${id}" data-library-index="${index}"><div class="library-score"><span aria-hidden="true">${exercise.score}</span><span class="sr-only">STRATA score ${exercise.score}</span></div><div><h3>${name}</h3><p>${sub} · ${equipment}</p></div><div class="library-actions"><button data-quick-add="${id}" type="button" aria-label="Add ${name} to ${day}">Add to ${day}</button><button class="guide-button" data-guide-exercise="${id}" type="button" aria-label="Open setup and technique guide for ${name}">Guide</button><a class="yt-link" href="${youtube}" target="_blank" rel="noreferrer" aria-label="Find ${name} tutorials on YouTube">Video</a></div></article>`;
    });
    return html`${cards}${!remaining ? "" : html`<div class="library-load-more"><span>${visibleItems.length} of ${items.length}</span><button data-load-more-library type="button" aria-controls="libraryList">Load ${nextCount} more <span aria-hidden="true">↓</span></button></div>`}`;
  }

  function scheduledCardMarkup({ item, exercise, day, index, count, days, restDays = [] }) {
    if (!exercise) return html``;
    const instanceId = item.instanceId,
      name = exercise.name,
      titleId = `scheduled-${instanceId}`;
    const options = days.map(
      (option) =>
        html`<option value="${option}" ${option === day ? "selected" : ""}>${option}${restDays.includes(option) ? " — recovery" : ""}</option>`,
    );
    return html`<article class="scheduled-card" draggable="true" data-instance-id="${instanceId}" aria-labelledby="${titleId}"><div class="scheduled-card-head"><div><h3 id="${titleId}">${name}</h3><small>${exercise.sub} · ${exercise.equipment}</small></div><div class="card-actions"><button data-guide-exercise="${exercise.id}" type="button" aria-label="Open setup and technique guide for ${name}">?</button><a href="${exercise.youtube}" target="_blank" rel="noreferrer" aria-label="Find ${name} tutorials on YouTube">▶</a><button data-remove-item="${instanceId}" type="button" aria-label="Remove ${name} from ${day}">×</button></div></div><button class="replace-exercise-button" data-replace-item="${instanceId}" type="button" aria-label="Replace ${name} on ${day}">Replace exercise</button><div class="prescription"><label>Sets<input data-item-sets="${instanceId}" type="number" min="1" max="10" step="1" inputmode="numeric" value="${item.sets}" aria-label="Sets for ${name} on ${day}" /></label><label>Reps / time<input data-item-reps="${instanceId}" type="text" maxlength="20" value="${item.reps}" aria-label="Reps or time for ${name} on ${day}" /></label></div><div class="card-move"><label><span>Day</span><select data-item-day="${instanceId}" aria-label="Move ${name} to another day">${options}</select></label><div class="move-buttons" role="group" aria-label="Reorder ${name}"><button data-move-item="${instanceId}" data-move-direction="-1" type="button" aria-label="Move ${name} earlier on ${day}" ${index === 0 ? "disabled" : ""}>↑</button><button data-move-item="${instanceId}" data-move-direction="1" type="button" aria-label="Move ${name} later on ${day}" ${index === count - 1 ? "disabled" : ""}>↓</button></div></div></article>`;
  }

  function weekBoardMarkup({ plan, days, selectedDay, restDays = [], exerciseById }) {
    return days.map((day, index) => {
      const items = plan.days[day],
        rest = restDays.includes(day),
        selected = selectedDay === day,
        conflict = rest && items.length > 0;
      const targetText = rest ? "Recovery day" : selected ? "Adding here" : "Add here";
      const restText = rest
        ? "Remove rest day"
        : items.length
          ? "Clear day to make rest"
          : "Add rest day";
      const emptyText = rest
        ? "Recovery day · keep clear"
        : selected
          ? "Ready for exercises · use “Add” in the library"
          : "Choose “Add here,” then add an exercise";
      const cards = items.map((item, itemIndex) =>
        scheduledCardMarkup({
          item,
          exercise: exerciseById(item.exerciseId),
          day,
          index: itemIndex,
          count: items.length,
          days,
          restDays,
        }),
      );
      return html`<section class="day-column ${rest ? "rest-day" : ""} ${selected ? "selected-day" : ""} ${conflict ? "rest-conflict" : ""}" data-day="${day}" aria-labelledby="day-title-${index}"><header class="day-head"><div class="day-index"><span>Day ${String(index + 1).padStart(2, "0")}</span><span>${items.length} movement${items.length === 1 ? "" : "s"}</span></div><div class="day-title-row"><h2 id="day-title-${index}" tabindex="-1">${day}</h2><button class="day-target ${selected ? "active" : ""}" data-select-day="${day}" type="button" aria-pressed="${selected}" ${rest ? "disabled" : ""}>${targetText}</button></div>${rest ? html`<span class="rest-badge">${conflict ? "Recovery day needs clearing" : "Rest day"}</span>` : ""}</header><button class="rest-toggle" data-set-rest="${day}" type="button" aria-pressed="${rest}" ${!rest && items.length ? "disabled" : ""}>${restText}</button>${rest ? html`<div class="rest-callout"><strong>${conflict ? "Clear this day" : "Recover"}</strong><p>${conflict ? "Move every scheduled exercise to another day before saving further recovery changes." : "Keep this day free or use gentle mobility and walking."}</p></div>` : ""}<div class="day-dropzone" data-drop-day="${day}" aria-label="${day} exercises">${items.length ? cards : html`<div class="day-empty">${emptyText}</div>`}</div></section>`;
    });
  }

  function planConflictSummaryMarkup({ plan, days, restDays = [], exerciseById, movementCount }) {
    const rows = days.map((day) => {
      const items = Array.isArray(plan?.days?.[day]) ? plan.days[day] : [];
      const detail = items.length
        ? StrataHtml.join(
            items.map((item) => {
              const exercise = exerciseById(item.exerciseId);
              return html`${exercise?.name || "Unknown movement"} <span>${item.sets} × ${item.reps}</span>`;
            }),
            ", ",
          )
        : "No movements";
      return html`<li><strong>${day}${restDays.includes(day) ? " · recovery" : ""}</strong><p>${detail}</p></li>`;
    });
    return html`<p class="plan-conflict-total">${movementCount} movement${movementCount === 1 ? "" : "s"} · ${restDays.length} rest days</p><ul>${rows}</ul>`;
  }

  function activationOverviewMarkup({ candidate, accountCount, deviceCount }) {
    const profile = candidate.profile;
    return html`<div><span>Device source</span><strong>${candidate.label}</strong></div><div><span>Device week</span><strong>${deviceCount} movement${deviceCount === 1 ? "" : "s"}</strong></div><div><span>Account week</span><strong>${accountCount} movement${accountCount === 1 ? "" : "s"}</strong></div>${profile ? html`<div><span>Goal</span><strong>${String(profile.goal).replace("-", " ")}</strong></div><div><span>Schedule</span><strong>${profile.availability.length} days · ${profile.minutes} min</strong></div><div><span>Equipment</span><strong>${profile.equipment.join(", ")}</strong></div>` : ""}`;
  }

  function modeNoticeMarkup({ guest, status, confirmed, oversized }) {
    const base = guest
      ? html`<strong>Free device plan.</strong> No account required. This week stays in this browser. <a href="/account.html?mode=login&amp;next=planner">Use a synced plan</a>.`
      : status === "checking"
        ? html`<strong>Synced account plan.</strong> Checking Strata+ access. Plan editing and saves remain available.`
        : status === "unavailable"
          ? html`<strong>Synced account plan.</strong> Strata+ access could not be confirmed. Plan editing and saves remain available; reconnect to refresh it.`
          : confirmed
            ? html`<strong>Synced account plan.</strong> Changes save across your signed-in devices. <a href="/discover.html">Open Strata+</a>.`
            : html`<strong>Free synced plan.</strong> Changes save across your signed-in devices. <a href="/pricing">See what Strata+ adds</a>.`;
    return html`${base}${oversized ? html`<p><strong>Large saved draft preserved.</strong> Export a copy, then reduce to 30 exercises per day and 140 per week before syncing or importing.</p>` : ""}`;
  }

  return {
    filterMarkup,
    dayNavMarkup,
    libraryMarkup,
    scheduledCardMarkup,
    weekBoardMarkup,
    planConflictSummaryMarkup,
    activationOverviewMarkup,
    modeNoticeMarkup,
  };
});
