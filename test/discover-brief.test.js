"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Brief = require("../public/scripts/discover-brief");
const Core = require("../public/scripts/devices-core");

function elements() {
  const nodes = new Map();
  return {
    nodes,
    element: (id) => {
      if (!nodes.has(id))
        nodes.set(id, { id, textContent: "", innerHTML: "", hidden: true, dataset: {} });
      return nodes.get(id);
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const brief = {
  readiness: { level: "take_it_easy", summary: "Poor recovery after a short night." },
  recommendation: { title: "Go lighter today", detail: "Keep Upper A but stop two reps earlier." },
  planAdjustments: [
    { day: "Thursday", change: "Swap squats for <b>leg press</b>", reason: "Knee comfort" },
  ],
  insight: "",
  careNote: null,
};

test("the Overview shows today's stored Daily Brief and hides it when there is none", async () => {
  const { element, nodes } = elements(),
    calls = [];
  let answer = { snapshots: [{ date: Core.localDate(), brief }] };
  const controller = Brief.createController({
    element,
    api: async (path) => {
      calls.push(path);
      return answer;
    },
    state: { user: { id: "m" } },
    core: Core,
    getGeneration: () => 1,
  });
  controller.activate("plan");
  await flush();
  assert.equal(calls.length, 0, "only the Overview loads the brief");
  controller.activate("today");
  await flush();
  const card = nodes.get("todayBrief");
  assert.equal(card.hidden, false);
  assert.equal(card.dataset.level, "take_it_easy");
  assert.equal(nodes.get("todayBriefLevel").textContent, "Take it easy");
  assert.equal(nodes.get("todayBriefTitle").textContent, "Go lighter today");
  assert.match(
    nodes.get("todayBriefAdjustments").innerHTML,
    /&lt;b&gt;leg press/,
    "suggestions are escaped",
  );
  assert.equal(nodes.get("todayBriefInsight").hidden, true);
  assert.equal(nodes.get("todayBriefCare").hidden, true);
  assert.match(calls[0], /^\/api\/snapshots\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  controller.activate("today");
  await flush();
  assert.equal(calls.length, 1, "a fresh brief is reused");
  answer = { snapshots: [{ date: Core.localDate(), brief: null }] };
  await controller.load({ force: true });
  assert.equal(card.hidden, true);
  controller.reset();
  assert.equal(card.hidden, true);
});
