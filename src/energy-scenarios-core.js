// @ts-check
"use strict";

// Explicit sensitivity assumptions, not a fitted individual physiology model.
const SCENARIO_POLICY = Object.freeze({
  responseKcalPerKgDay: 22,
  responseRange: [15, 30],
  densityKcalPerKg: 7700,
  densityRange: [5500, 9500],
});
/** Solve d(deltaWeight)/dt = (intake - initialMaintenance - response*deltaWeight)/density.
 * @param {number} days @param {number} difference @param {number} [response] @param {number} [density] */
function weightChange(
  days,
  difference,
  response = SCENARIO_POLICY.responseKcalPerKgDay,
  density = SCENARIO_POLICY.densityKcalPerKg,
) {
  if (
    ![days, difference, response, density].every(Number.isFinite) ||
    days < 0 ||
    response <= 0 ||
    density <= 0
  )
    throw new TypeError("Finite scenario inputs and positive response/density are required.");
  if (days === 0 || difference === 0) return 0;
  return (difference / response) * -Math.expm1((-response * days) / density);
}
/** Model envelopes propagate maintenance and physiological assumptions; they are not probabilities.
 * @param {number} weightKg @param {number} intake @param {{targetKcal:number,planningRangeKcal:number[]}} maintenance */
function scenarioFor(weightKg, intake, maintenance) {
  if (
    !Number.isFinite(weightKg) ||
    weightKg <= 0 ||
    !Number.isFinite(intake) ||
    intake <= 0 ||
    !Number.isFinite(maintenance.targetKcal) ||
    maintenance.planningRangeKcal.length !== 2 ||
    !maintenance.planningRangeKcal.every(Number.isFinite)
  )
    throw new TypeError("Valid weight, intake, and maintenance range are required.");
  const low = Math.min(...maintenance.planningRangeKcal),
    high = Math.max(...maintenance.planningRangeKcal);
  if (low < 0 || low > maintenance.targetKcal || high < maintenance.targetKcal)
    throw new TypeError("The maintenance range must contain its central estimate.");
  return [4, 8, 12].map((weeks) => {
    const days = weeks * 7,
      central = weightKg + weightChange(days, intake - maintenance.targetKcal),
      values = [central];
    for (const expenditure of [low, high])
      for (const response of SCENARIO_POLICY.responseRange)
        for (const density of SCENARIO_POLICY.densityRange)
          values.push(weightKg + weightChange(days, intake - expenditure, response, density));
    const round = (/** @type {number} */ value) => Math.round(Math.max(0, value) * 10) / 10;
    return {
      weeks,
      startWeightKg: weightKg,
      weightKg: round(central),
      rawRangeKg: [Math.max(0, Math.min(...values)), Math.max(0, Math.max(...values))],
      rangeKg: [round(Math.min(...values)), round(Math.max(...values))],
      modelLabel: "Energy-balance sensitivity scenario",
      rangeLabel: "Scenario envelope, not a prediction interval",
      includesGainAndLoss: Math.min(...values) < weightKg && Math.max(...values) > weightKg,
      assumptions: {
        dailyIntakeKcal: intake,
        maintenanceRangeKcal: [low, high],
        ...SCENARIO_POLICY,
      },
      caveat:
        "A simplified response model under fixed intake and activity. Water shifts, adherence, illness, and individual adaptation are not predicted; this is an assumption envelope, not a confidence interval. It does not implement the NIDDK model.",
    };
  });
}

module.exports = { SCENARIO_POLICY, scenarioFor, weightChange };
