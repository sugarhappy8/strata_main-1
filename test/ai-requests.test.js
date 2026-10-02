"use strict";

// Strata AI request intake against a store with network-like latency (as on Turso): a member's simultaneous requests
// are marked in flight before the first await, so only one reaches the quota and the queue. The queue lives in the
// store, so a request a stopped server left running is picked up again by the next start.
const test = require("node:test"),
  assert = require("node:assert/strict");
const { createAiService } = require("../src/ai");
const { routeHarness } = require("./support/route-harness");

const pause = () => new Promise((resolve) => setImmediate(resolve));

/** The ai_jobs rules in memory: one unfinished request per member, oldest first, message dropped when finished. */
function jobStore() {
  const jobs = new Map();
  let sequence = 0;
  const row = (job) => (job ? { ...job } : null),
    active = (job) => job.status === "queued" || job.status === "running";
  return {
    jobs,
    async aiSettings() {
      await pause();
      return { consent_at: 1, consent_version: 1, daily_brief: 1, updated_at: 1 };
    },
    async coachingProfile() {
      return null;
    },
    async workouts() {
      return [];
    },
    async insertAiJob(job) {
      await pause();
      if ([...jobs.values()].some((item) => item.user_id === job.userId && active(item)))
        throw new Error("UNIQUE constraint failed: ai_jobs.user_id");
      const stored = {
        id: job.id,
        user_id: job.userId,
        kind: job.kind,
        status: "queued",
        request_json: job.requestJson,
        usage_date: job.usageDate,
        tokens: 0,
        result_json: null,
        error_json: null,
        created_at: job.createdAt,
        finished_at: null,
        order: (sequence += 1),
        lease_until: 0,
      };
      jobs.set(job.id, stored);
      return row(stored);
    },
    async aiJob(id, userId) {
      const job = jobs.get(id);
      return job && job.user_id === userId ? row(job) : null;
    },
    async activeAiJob(userId) {
      await pause();
      return row([...jobs.values()].find((job) => job.user_id === userId && active(job)));
    },
    async queuedAiJobs() {
      return [...jobs.values()].filter((job) => job.status === "queued").length;
    },
    async aiJobPosition(id) {
      const queued = [...jobs.values()]
        .filter((job) => job.status === "queued")
        .sort((a, b) => a.order - b.order);
      return queued.findIndex((job) => job.id === id) + 1;
    },
    async claimAiJob(leaseUntil) {
      const next = [...jobs.values()]
        .filter((job) => job.status === "queued")
        .sort((a, b) => a.order - b.order)[0];
      if (!next) return null;
      Object.assign(next, { status: "running", lease_until: leaseUntil });
      return row(next);
    },
    async finishAiJob(id, outcome) {
      const job = jobs.get(id);
      if (job?.status === "running")
        Object.assign(job, {
          status: outcome.status,
          tokens: outcome.tokens,
          result_json: outcome.resultJson,
          error_json: outcome.errorJson,
          finished_at: outcome.finishedAt,
          request_json: null,
          lease_until: 0,
        });
    },
    async requeueStaleAiJobs(now) {
      for (const job of jobs.values())
        if (job.status === "running" && job.lease_until < now)
          Object.assign(job, { status: "queued", lease_until: 0 });
    },
    async deleteFinishedAiJobs(before) {
      for (const [id, job] of jobs)
        if (job.finished_at !== null && job.finished_at < before) jobs.delete(id);
    },
  };
}

function harness({
  store = jobStore(),
  complete = () => new Promise(() => {}),
  message = "Plan my week",
} = {}) {
  const reserved = [],
    responses = [];
  const quota = {
    limits: { userDaily: 6 },
    async reserve(kind, userId) {
      await pause();
      reserved.push(userId);
      return { ok: true, date: "2030-01-01" };
    },
    async record() {},
    async refund() {},
  };
  // By default the model never answers, so an accepted request stays running.
  const provider = { configured: true, model: "m", complete, health: async () => ({}) };
  const json = (res, status, data) => {
    responses.push({ status, data });
    res.status = status;
    res.data = data;
  };
  const ai = createAiService({
    store,
    rateAllowed: () => true,
    http: {
      json,
      async bodyJson(req) {
        await pause();
        return req.body;
      },
    },
    // Until the model is set to answer, reading the member's plan never finishes, so an accepted request stays running.
    provider,
    getPlanSnapshot: async () => {
      if (!complete.answers) await new Promise(() => {});
      return { plan: null, updatedAt: 0 };
    },
    quota,
    config: { maxConcurrent: 1, maxQueue: 20 },
  });
  const service = {
    ...ai,
    ...routeHarness(ai.routes, {
      json,
      requireFeature: () => async () => ({ id: "member-1", csrf_token: "token" }),
      validCsrf: () => true,
    }),
  };
  const ask = async () => {
    const res = {};
    await service.handleApi(
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { kind: "chat", message },
      },
      res,
      new URL("https://strata.test/api/ai/requests"),
    );
    return res;
  };
  const poll = async (id) => {
    const res = {};
    await service.handleApi(
      { method: "GET", headers: {} },
      res,
      new URL(`https://strata.test/api/ai/requests/${id}`),
    );
    return res;
  };
  return { service, store, ask, poll, reserved, responses };
}

test("simultaneous requests from one member start one job and claim the quota once", async () => {
  const page = harness();
  const statuses = (await Promise.all(Array.from({ length: 5 }, () => page.ask()))).map(
    (res) => res.status,
  );
  assert.deepEqual(statuses.sort(), [202, 409, 409, 409, 409]);
  assert.ok(
    page.responses
      .filter(({ status }) => status === 409)
      .every(({ data }) => data.code === "AI_REQUEST_IN_PROGRESS"),
  );
  assert.deepEqual(page.reserved, ["member-1"], "only the accepted request reached the quota");
  assert.equal(page.store.jobs.size, 1);
});

test("a refused request clears the in-flight mark so the member can ask again", async () => {
  const page = harness();
  const res = {};
  await page.service.handleApi(
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { kind: "chat", message: "" },
    },
    res,
    new URL("https://strata.test/api/ai/requests"),
  );
  assert.equal(res.status, 400);
  assert.equal(
    (await page.ask()).status,
    202,
    "the earlier failure did not leave the member marked busy",
  );
});

test("a second server sharing the queue cannot start another request for the same member", async () => {
  const store = jobStore(),
    first = harness({ store }),
    second = harness({ store });
  assert.equal((await first.ask()).status, 202);
  const other = await second.ask();
  assert.deepEqual(
    [other.status, other.data.code],
    [409, "AI_REQUEST_IN_PROGRESS"],
    "the queue in the database, not one server's memory, decides",
  );
});

test("a request a stopped server left running runs again on the next start, and its message goes once it is answered", async () => {
  const store = jobStore(),
    stopped = harness({ store, message: "How much protein should I eat each day?" });
  const accepted = await stopped.ask();
  assert.equal(accepted.status, 202);
  const id = accepted.data.request.id;
  await pause();
  assert.equal(store.jobs.get(id).status, "running", "the first server took it and then stopped");
  const answers = Object.assign(
    async () => ({
      data: {
        reply: "About 1.6 g per kg of body weight.",
        week: null,
        nutrition: null,
        suggestions: [],
      },
      model: "m",
      usage: { totalTokens: 42 },
    }),
    { answers: true },
  );
  const restarted = harness({ store, complete: answers });
  await restarted.service.start();
  for (let attempt = 0; attempt < 50 && store.jobs.get(id).status !== "done"; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const answer = await restarted.poll(id);
  assert.equal(answer.status, 200);
  assert.equal(
    answer.data.request.status,
    "done",
    JSON.stringify(answer.data.request.error || null),
  );
  assert.equal(answer.data.request.result.reply, "About 1.6 g per kg of body weight.");
  assert.equal(
    store.jobs.get(id).request_json,
    null,
    "the member's message is not kept after the answer",
  );
  assert.equal(store.jobs.get(id).tokens, 42);
});
