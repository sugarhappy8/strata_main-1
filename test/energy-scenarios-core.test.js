"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { scenarioFor, weightChange } = require("../src/energy-scenarios-core");

test("dynamic sensitivity model respects initial condition, energy-balance equilibrium, sign and finite limit", () => {
  assert.equal(weightChange(0, -400), 0);
  assert.equal(weightChange(84, 0), 0);
  assert.ok(
    Math.abs(weightChange(1, -400) - -400 / 7700) < 0.001,
    "one-day response approaches initial energy balance",
  );
  assert.equal(weightChange(84, 400), -weightChange(84, -400));
  assert.ok(Math.abs(weightChange(100000, -400) + 400 / 22) < 1e-9);
  assert.ok(Math.abs(weightChange(28, -400)) < Math.abs(weightChange(84, -400)));
  for (const args of [
    [-1, 400],
    [1, NaN],
    [1, 400, 0],
    [1, 400, 22, 0],
  ])
    assert.throws(() => weightChange(...args), TypeError);
});
test("maintenance uncertainty propagates into directions rather than promising weight loss", () => {
  const uncertain = scenarioFor(75, 2200, { targetKcal: 2400, planningRangeKcal: [2000, 2800] });
  for (const scenario of uncertain) {
    assert.ok(scenario.weightKg < 75);
    assert.ok(scenario.rangeKg[0] < 75);
    assert.ok(scenario.rangeKg[1] > 75);
    assert.equal(scenario.includesGainAndLoss, true);
    assert.match(scenario.rangeLabel, /not a prediction/);
  }
  assert.ok(
    uncertain[2].rangeKg[1] - uncertain[2].rangeKg[0] >
      uncertain[0].rangeKg[1] - uncertain[0].rangeKg[0],
  );
  const exact = scenarioFor(75, 2400, { targetKcal: 2400, planningRangeKcal: [2400, 2400] });
  assert.ok(exact.every((s) => s.weightKg === 75 && s.rangeKg.every((x) => x === 75)));
});
test("scenario envelope contains every modeled assumption and does not mutate inputs", () => {
  const maintenance = { targetKcal: 2400, planningRangeKcal: [2100, 2700] },
    copy = structuredClone(maintenance),
    scenarios = scenarioFor(80, 2600, maintenance);
  for (const scenario of scenarios)
    for (const m of maintenance.planningRangeKcal)
      for (const k of [15, 30])
        for (const rho of [5500, 9500]) {
          const point =
            Math.round((80 + weightChange(scenario.weeks * 7, 2600 - m, k, rho)) * 10) / 10;
          assert.ok(point >= scenario.rangeKg[0] && point <= scenario.rangeKg[1]);
        }
  assert.deepEqual(maintenance, copy);
  assert.throws(
    () => scenarioFor(80, 2600, { targetKcal: 2400, planningRangeKcal: [2500, 2700] }),
    TypeError,
  );
});
