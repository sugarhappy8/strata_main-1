/* global module, require */
(function (root, factory) {
  "use strict";
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const render = factory(StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = render;
  else root.StrataWorkoutRender = render;
})(typeof globalThis !== "undefined" ? globalThis : this, function (StrataHtml) {
  "use strict";
  const esc = StrataHtml.escape;
  const number = (value) =>
    Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const option = (value, label, current) =>
    `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`;
  const hasActuals = (entry) =>
    entry.sets.some(
      (set) => set.completed || set.reps !== null || set.weight !== null || set.seconds !== null,
    );
  function formatLabel(entry) {
    return `${entry.measurement === "timed" ? "Time" : "Reps"} · ${entry.loadType === "bodyweight" ? "Bodyweight" : entry.loadType === "assisted" ? "Assistance" : "External load"}${entry.loadType !== "bodyweight" ? ` · ${entry.unit}` : ""}`;
  }
  function setValue(entry, set) {
    const actual =
      entry.measurement === "timed"
        ? `${set.seconds == null ? "—" : number(set.seconds)} sec`
        : `${set.reps == null ? "—" : number(set.reps)} reps`;
    const load =
      entry.loadType === "bodyweight"
        ? "Bodyweight"
        : set.weight == null
          ? "Load not guessed"
          : `${number(set.weight)} ${entry.unit}${entry.loadType === "assisted" ? " assistance" : ""}`;
    const rememberedScale = ["rir", "rpe"].includes(set.effortType) ? set.effortType : "";
    return `${actual} · ${load}${set.effort != null && rememberedScale ? ` · ${number(set.effort)} ${rememberedScale.toUpperCase()}` : ""}`;
  }

  function create({ state, workout: W, discovery: G, nextTarget = () => null }) {
    function exercise(id) {
      return (
        state.catalog.find((item) => item.id === id) || { name: id, equipment: "", caution: "" }
      );
    }
    function memoryFor(entry) {
      return W.previousComparable(
        state.memoryHistory,
        entry,
        state.workout?.id,
        state.workout?.startedAt ?? Infinity,
      );
    }
    function guideMarkup(item) {
      const guidance = G?.exerciseGuidance?.(item, state.catalog);
      if (!guidance) return "";
      return `<details class="exercise-guide"><summary>Setup, cues &amp; equipment swaps</summary><div class="exercise-guide-grid"><section><span>Set up</span><p>${esc(guidance.setup)}</p></section><section><span>Purpose</span><p>${esc(guidance.purpose)}</p></section><section><span>Technique cues</span><ul>${guidance.cues.map((cue) => StrataHtml.html`<li>${cue}</li>`).join("")}</ul></section><section class="guide-warning"><span>Caution / Common mistake</span><p>${esc(guidance.mistake)}</p></section><section><span>General catalog range</span><p>${esc(guidance.prescription)}</p></section><section><span>Same target · other equipment</span><ul>${guidance.alternatives.map(({ exercise: alternative }) => StrataHtml.html`<li><strong>${alternative.name}</strong> · ${alternative.equipment}</li>`).join("")}</ul></section></div></details>`;
    }
    function memoryMarkup(entry) {
      if (!state.memoryReady) {
        const failed = !!state.memoryError;
        return `<section class="workout-memory" aria-label="Previous performance"${failed ? "" : ' aria-busy="true"'}><div class="memory-previous empty"><span>${failed ? "Couldn’t check older history" : "Checking previous performance…"}</span><p>${failed ? StrataHtml.html`${state.memoryError} Refresh history to retry; no result has been assumed.` : "Looking through your saved sessions for the latest exact match."}</p></div></section>`;
      }
      const memory = memoryFor(entry),
        canApply =
          memory?.sets.length > 0 && !W.hasSetValues(entry) && state.workout.status === "active";
      if (memory && !memory.sets.length)
        return StrataHtml.html`<section class="workout-memory" aria-label="Previous performance"><div class="memory-previous empty"><span>Previous session · ${W.displayDate(memory.date)}</span><p>No sets were completed for this exercise in the latest matching session. Enter today’s values to establish a fresh baseline.</p></div></section>`;
      return memory
        ? `<section class="workout-memory" aria-label="Previous performance"><div class="memory-previous"><span>Previous performance · ${esc(W.displayDate(memory.date))}</span><ol>${memory.sets.map((set, index) => `<li><b>Set ${index + 1}</b> ${esc(setValue(entry, set))}</li>`).join("")}</ol><button class="button secondary compact" type="button" data-use-last${canApply ? "" : " disabled"}>Use previous values</button></div></section>`
        : `<section class="workout-memory" aria-label="Previous performance"><div class="memory-previous empty"><span>No previous performance yet</span><p>Complete this logging format once and Training Memory will bring it back here.</p></div></section>`;
    }
    function targetMarkup(entry) {
      if (!state.memoryReady)
        return `<section class="memory-target" aria-label="Today’s target"><span>Today’s target</span><p>${state.memoryError ? "Enter today’s values manually while history is unavailable." : "Checking saved performance before recommending a weight."}</p></section>`;
      const proposal = nextTarget(entry);
      if (proposal && !["ready", "baseline"].includes(proposal.status))
        return StrataHtml.html`<section class="memory-target" aria-label="Today’s target"><span>Today’s target</span><p>${proposal.explanation}</p></section>`;
      const memory = memoryFor(entry),
        suggestion = proposal?.status === "ready" ? proposal : W.suggestedTargets(entry, memory),
        canApply = !W.hasSetValues(entry) && state.workout.status === "active" && !state.blocked;
      const action =
        {
          increase_load: "Increase weight",
          reduce_assistance: "Reduce assistance",
          increase_reps: "Build reps first",
          increase_time: "Build time",
          repeat: "Repeat this target",
        }[proposal?.suggestion?.action] || "Your starting target";
      return `<section class="memory-target" aria-label="Today’s target"><span>Today’s target</span><h4>${esc(action)}</h4>${proposal?.sourceDate ? StrataHtml.html`<small>Based on ${W.displayDate(proposal.sourceDate)}</small>` : ""}<ol>${suggestion.sets.map((set, index) => `<li><b>Set ${index + 1}</b> ${esc(setValue(entry, set))}</li>`).join("")}</ol><p>${esc(suggestion.explanation)}</p><button class="button secondary compact" type="button" data-apply-target${canApply ? "" : " disabled"}>Apply suggested target</button><small>Review before each set. Applying a target does not mark any set complete.</small></section>`;
    }
    function advancedTools(entry, ex) {
      if (entry.loadType !== "external") return "";
      const memory = state.memoryReady ? memoryFor(entry) : null,
        suggested = W.suggestedTargets(entry, memory).sets[0]?.weight ?? "",
        barbell = /barbell|smith/i.test(ex.equipment || "");
      return `<details class="advanced-tools"><summary>Warm-ups${barbell ? " &amp; plate calculator" : ""}</summary><div class="advanced-grid"><section><h4>Warm-up ramp</h4><p>Enter a working load for three non-working preparation sets.</p><div class="calculator-row"><label class="field">Working load (${entry.unit})<input type="number" min="0.01" max="1000" step="0.01" value="${suggested}" data-warmup-load /></label><button class="button secondary compact" type="button" data-calc-warmup>Calculate</button></div><div class="calculator-result" data-warmup-result role="status"></div></section>${barbell ? `<section><h4>Plate calculator</h4><p>Assumes pairs of ${W.plateInventory(entry.unit).map(number).join(", ")} ${entry.unit} plates. Confirm what your gym has.</p><div class="plate-fields"><label class="field">Target (${entry.unit})<input type="number" min="0" max="1000" step="0.01" value="${suggested}" data-plate-target /></label><label class="field">Bar (${entry.unit})<input type="number" min="0" max="1000" step="0.01" value="${entry.unit === "lb" ? 45 : 20}" data-bar-weight /></label></div><button class="button secondary compact" type="button" data-calc-plates>Show plates per side</button><div class="calculator-result" data-plate-result role="status"></div></section>` : ""}</div></details>`;
    }
    function supersetLabel(entry) {
      const groups = [
          ...new Set(state.workout.entries.map((item) => item.supersetGroup).filter(Boolean)),
        ],
        index = groups.indexOf(entry.supersetGroup);
      return index >= 0 ? `Superset ${String.fromCharCode(65 + index)}` : "";
    }
    function renderEntry(entry, index) {
      const ex = exercise(entry.exerciseId),
        timed = entry.measurement === "timed",
        weighted = entry.loadType !== "bodyweight",
        locked = hasActuals(entry) || state.workout.status === "completed",
        disabled = locked ? " disabled" : "",
        completedSets = entry.sets.filter((set) => set.completed).length,
        next = W.nextIncompleteSet(state.workout),
        effort = entry.effortType !== "none",
        effortLocked =
          entry.sets.some((set) => set.effort != null) || state.workout.status === "completed",
        grouped = !!entry.supersetGroup,
        nextEntry = state.workout.entries[index + 1],
        measurement = timed ? "seconds" : "reps";
      const setRows = entry.sets
        .map(
          (set, setIndex) =>
            `<tr data-set="${setIndex}" class="${set.completed ? "set-complete" : next?.entryId === entry.id && next.setIndex === setIndex ? "set-next" : ""}"><td class="set-number" data-label="Set">${setIndex + 1}</td>${weighted ? `<td data-label="${entry.loadType === "assisted" ? "Assist" : "Load"} (${entry.unit})"><input type="number" inputmode="decimal" min="0" max="1000" step="0.01" data-actual="weight" value="${set.weight ?? ""}" placeholder="—" aria-label="${esc(ex.name)}, set ${setIndex + 1}, ${entry.loadType === "assisted" ? "assistance" : "load"} in ${entry.unit}"${set.completed || state.workout.status === "completed" ? " disabled" : ""}/></td>` : ""}<td data-label="${timed ? "Seconds" : "Reps"}"><input type="number" inputmode="numeric" min="1" max="${timed ? 3600 : 1000}" step="1" data-actual="${measurement}" value="${set[measurement] ?? ""}" placeholder="—" aria-label="${esc(ex.name)}, set ${setIndex + 1}, actual ${measurement}"${set.completed || state.workout.status === "completed" ? " disabled" : ""}/></td>${effort ? `<td data-label="${entry.effortType.toUpperCase()}"><input type="number" inputmode="decimal" min="${entry.effortType === "rpe" ? 1 : 0}" max="10" step="0.5" data-actual="effort" value="${set.effort ?? ""}" placeholder="Optional" aria-label="${esc(ex.name)}, set ${setIndex + 1}, ${entry.effortType.toUpperCase()}"${set.completed || state.workout.status === "completed" ? " disabled" : ""}/></td>` : ""}<td class="set-actions-cell" data-label="Complete"><div class="set-actions"><button type="button" class="button secondary set-check" data-complete="${setIndex}" aria-pressed="${set.completed}" aria-label="${set.completed ? "Uncheck" : "Complete"} ${esc(ex.name)}, set ${setIndex + 1}"${state.workout.status === "completed" ? " disabled" : ""}>${set.completed ? "✓ Completed" : "Complete set"}</button><details class="set-more"><summary aria-label="More actions for ${esc(ex.name)}, set ${setIndex + 1}">More</summary><div class="set-more-actions"><button type="button" class="button quiet set-copy" data-duplicate-set="${setIndex}"${entry.sets.length >= 10 || state.workout.status === "completed" ? " disabled" : ""}>Duplicate set</button><button type="button" class="button quiet set-remove" data-remove-set="${setIndex}"${entry.sets.length <= 1 || set.completed || state.workout.status === "completed" ? " disabled" : ""}>Remove set</button></div></details></div></td></tr>`,
        )
        .join("");
      const formatNote = `${locked ? "Logging format is locked while actual values are present. Clear uncompleted values to change it." : "Check the logging format before your first set. Enter 0 explicitly if an external or assisted set has no added load."}${entry.loadType === "assisted" ? " Assistance is not lifted weight; it does not create weight or volume records." : ""} Effort is optional and never inferred.`;
      return `<article class="exercise-card${grouped ? " is-superset" : ""}" data-entry="${esc(entry.id)}"><div class="exercise-heading"><span class="exercise-index">${String(index + 1).padStart(2, "0")}</span><div>${grouped ? `<span class="superset-badge">${supersetLabel(entry)}</span>` : ""}<h3>${esc(ex.name)}</h3><p>Planned: ${entry.sets.length} × ${esc(entry.prescribedReps)}${ex.equipment ? StrataHtml.html` · ${ex.equipment}` : ""}${entry.replacedFromExerciseId ? StrataHtml.html` · Replaced ${exercise(entry.replacedFromExerciseId).name} for this session` : ""}</p></div><span class="exercise-progress">${completedSets}/${entry.sets.length} sets</span></div>${memoryMarkup(entry)}${targetMarkup(entry)}<div class="sets-scroll"><table class="sets-table"><thead><tr><th scope="col">Set</th>${weighted ? `<th scope="col">${entry.loadType === "assisted" ? "Assist" : "Load"} (${entry.unit})</th>` : ""}<th scope="col">${timed ? "Seconds" : "Reps"}</th>${effort ? `<th scope="col">${entry.effortType.toUpperCase()}</th>` : ""}<th scope="col">Complete</th></tr></thead><tbody>${setRows}</tbody></table></div><details class="exercise-more"><summary><span>More options</span><small>Swap, setup, logging format, notes &amp; tools</small></summary><div class="exercise-more-body"><div class="exercise-actions"><button class="button secondary compact" type="button" data-open-swap${locked ? ' disabled title="Clear logged values before swapping this exercise"' : ""}>Swap exercise</button>${nextEntry || grouped ? `<button class="button quiet compact" type="button" data-toggle-superset>${grouped ? "Unpair superset" : "Pair with next"}</button>` : ""}</div>${guideMarkup(ex)}<div class="format-controls"><label class="field">Record<select data-format="measurement" aria-label="Measurement for ${esc(ex.name)}"${disabled}>${option("reps", "Repetitions", entry.measurement)}${option("timed", "Time in seconds", entry.measurement)}</select></label><label class="field">Load type<select data-format="loadType" aria-label="Load type for ${esc(ex.name)}"${disabled}>${option("external", "External load", entry.loadType)}${option("bodyweight", "Bodyweight", entry.loadType)}${option("assisted", "Assistance", entry.loadType)}</select></label><label class="field">Unit<select data-format="unit" aria-label="Load unit for ${esc(ex.name)}"${disabled}${!weighted && !locked ? " disabled" : ""}>${option("kg", "kg", entry.unit)}${option("lb", "lb", entry.unit)}</select></label><label class="field">Effort (optional)<select data-format="effortType" aria-label="Effort scale for ${esc(ex.name)}"${effortLocked ? " disabled" : ""}>${option("none", "Off", entry.effortType)}${option("rir", "RIR", entry.effortType)}${option("rpe", "RPE", entry.effortType)}</select></label></div><p class="format-note">${formatNote}</p><button class="button secondary compact add-set" type="button" data-add-set${entry.sets.length >= 10 || state.workout.status === "completed" ? " disabled" : ""}>+ Add set</button><label class="exercise-note">Exercise note <span>Optional · private to this session</span><textarea rows="2" maxlength="500" data-entry-note placeholder="Setup, cue, or anything you want to remember"${state.workout.status === "completed" ? " disabled" : ""}>${esc(entry.note)}</textarea></label>${advancedTools(entry, ex)}</div></details></article>`;
    }
    function planPreview(items) {
      return items
        .map((item, index) => {
          const itemExercise = exercise(item.exerciseId);
          return `<article class="preview-card"><span class="preview-number">${String(index + 1).padStart(2, "0")}</span><strong>${esc(itemExercise.name)}</strong><small>${Number(item.sets)} sets · ${esc(item.reps)}</small>${guideMarkup(itemExercise)}</article>`;
        })
        .join("");
    }
    function detailMarkup(saved) {
      const counts = W.progress(saved);
      return `<p>${esc(W.displayDate(saved.date))} · ${counts.completed}/${counts.total} completed sets · ${W.duration(saved.elapsedSeconds)} since start</p>${W.normalizeWorkout(
        saved,
      )
        .entries.map(
          (entry) =>
            `<section class="detail-exercise"><h3>${esc(exercise(entry.exerciseId).name)}</h3><p>${esc(formatLabel(entry))} · planned ${esc(entry.prescribedReps)}${entry.supersetGroup ? " · Superset pair" : ""}${entry.replacedFromExerciseId ? StrataHtml.html` · Replaced ${exercise(entry.replacedFromExerciseId).name}` : ""}</p>${entry.note ? StrataHtml.html`<blockquote>${entry.note}</blockquote>` : ""}${entry.sets.map((set, index) => `<div class="detail-set${set.completed ? "" : " unfinished"}"><span>Set ${index + 1}</span><span>${set[entry.measurement === "timed" ? "seconds" : "reps"] ?? "—"} ${entry.measurement === "timed" ? "sec" : "reps"}${entry.loadType !== "bodyweight" ? ` · ${set.weight ?? "—"} ${entry.unit}${entry.loadType === "assisted" ? " assistance" : ""}` : ""}${set.effort != null && entry.effortType !== "none" ? ` · ${set.effort} ${entry.effortType.toUpperCase()}` : ""}</span><span class="${set.completed ? "done" : ""}">${set.completed ? "✓ Done" : "Unfinished"}</span></div>`).join("")}</section>`,
        )
        .join("")}`;
    }
    function refreshTargets(container) {
      for (const card of container.querySelectorAll("[data-entry]")) {
        const entry = state.workout?.entries.find((item) => item.id === card.dataset.entry),
          target = card.querySelector(".memory-target");
        if (entry && target) StrataHtml.replaceHtml(target, targetMarkup(entry));
      }
    }
    return {
      esc,
      number,
      exercise,
      guideMarkup,
      formatLabel,
      hasActuals,
      setValue,
      memoryFor,
      renderEntry,
      planPreview,
      detailMarkup,
      refreshTargets,
    };
  }
  return { esc, number, option, hasActuals, formatLabel, setValue, create };
});
