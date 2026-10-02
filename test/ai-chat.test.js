"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("../public/scripts/ai-logic");
const store = require("../public/scripts/ai-state");
const { createConversation } = require("../public/scripts/ai-conversation");
const { mount } = require("../public/scripts/ai-widget");

const REQUEST_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function memoryStorage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}
function fakeView() {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    renderConversation: record("renderConversation"),
    renderStatus: record("renderStatus"),
    renderComposer: record("renderComposer"),
    reveal: record("reveal"),
    revealEnd: record("revealEnd"),
    announce: record("announce"),
    setFormError: record("setFormError"),
    renderStarters: record("renderStarters"),
  };
}
function conversationFixture(client, options = {}) {
  const state = store.createState(),
    view = fakeView(),
    storage = memoryStorage(),
    applied = [],
    answers = [];
  state.user = { id: "member-1" };
  const nodes = {
    message: { value: "", placeholder: "", focus() {} },
    confirm: null,
    confirmText: null,
  };
  const conversation = createConversation({
    logic,
    store,
    state,
    client,
    view,
    nodes,
    storage,
    onApplied: (kind) => applied.push(kind),
    onAnswer: (entry) => answers.push(entry),
    ...options,
  });
  return { conversation, state, view, storage, nodes, applied, answers };
}
const weekAnswer = (id, planUpdatedAt = 5) => ({
  id,
  role: "assistant",
  kind: "chat",
  applied: {},
  result: {
    reply: "Here is your week.",
    planUpdatedAt,
    week: {
      title: "Three days",
      plan: {
        version: 1,
        days: { Monday: [{ instanceId: "a", exerciseId: "hack-squat", sets: 3, reps: "8-12" }] },
      },
    },
  },
});

test("a conversation sends a message, waits in line, and keeps the answer in this tab", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const polls = [
      { status: "queued", position: 2 },
      { status: "running" },
      { status: "done", result: { reply: "Add a rep first, then load." } },
    ],
    asked = [];
  const client = {
    ask: async (body) => {
      asked.push(body);
      return { request: { id: REQUEST_ID, status: "queued", position: 2 } };
    },
    poll: async () => ({ request: polls.shift() }),
    status: async () => ({ configured: true, online: true, dailyLimit: 30, remainingToday: 29 }),
  };
  const { conversation, state, view, storage, nodes, answers } = conversationFixture(client);
  nodes.message.value = "  How does progressive overload work?  ";
  await conversation.actions.send();
  assert.equal(nodes.message.value, "", "the message box clears once the message is on its way");
  assert.deepEqual(
    state.messages.map((message) => [message.role, message.text]),
    [["user", "How does progressive overload work?"]],
  );
  assert.equal(asked[0].message, "How does progressive overload work?");
  assert.equal(state.pending.id, REQUEST_ID);
  assert.ok(
    view.calls.filter(([name]) => name === "revealEnd").length >= 2,
    "a panel follows the conversation to the new message and the waiting line",
  );
  assert.equal(
    JSON.parse(storage.getItem("strata-ai-conversation:member-1")).pending.id,
    REQUEST_ID,
    "a request still on its way survives moving to the full page",
  );
  for (let round = 0; round < 3; round += 1) {
    t.mock.timers.tick(1500);
    await flush();
  }
  assert.equal(state.pending, null);
  assert.equal(state.messages.at(-1).result.reply, "Add a rep first, then load.");
  assert.equal(
    answers.length,
    1,
    "the page learns an answer arrived, so a closed chat can show it",
  );
  assert.ok(view.calls.some(([name, id]) => name === "reveal" && id === state.messages.at(-1).id));
  assert.equal(JSON.parse(storage.getItem("strata-ai-conversation:member-1")).messages.length, 2);
});

test("a failed request offers a retry that reuses the member's message, and access errors are left to the page", async () => {
  let fail = true;
  const asked = [];
  const client = {
    ask: async (body) => {
      asked.push(body);
      if (fail)
        throw Object.assign(new Error("Could not reach STRATA."), { code: "NETWORK_ERROR" });
      return { request: { id: REQUEST_ID, status: "queued", position: 1 } };
    },
    status: async () => ({ configured: true, online: true, dailyLimit: 30, remainingToday: 30 }),
  };
  const { conversation, state, nodes } = conversationFixture(client);
  nodes.message.value = "Plan my week";
  await conversation.actions.send();
  const error = state.messages.at(-1);
  assert.equal(error.role, "error");
  assert.equal(error.error.retry, true);
  fail = false;
  await conversation.actions.retry(error.id);
  assert.equal(
    state.messages.filter((message) => message.role === "user").length,
    1,
    "a retry never repeats the member's message",
  );
  assert.equal(asked.at(-1).message, "Plan my week");
  assert.equal(state.pending.id, REQUEST_ID);
  conversation.stop();

  const handled = [];
  const denied = conversationFixture(
    {
      ask: async () => {
        throw Object.assign(new Error("Sign in."), { status: 401 });
      },
      status: async () => ({}),
    },
    {
      onAccessError: (failure) => {
        handled.push(failure.status);
        return true;
      },
    },
  );
  denied.nodes.message.value = "Plan my week";
  await denied.conversation.actions.send();
  assert.deepEqual(handled, [401]);
  assert.equal(
    denied.state.messages.some((message) => message.role === "error"),
    false,
    "a sign-in redirect shows no error in the chat",
  );
});

test("applying a week checks the plan revision, asks before replacing a saved plan, and reports the change", async () => {
  const saved = [],
    plan = {
      plan: { days: { Monday: [{ instanceId: "x", exerciseId: "flat-dumbbell-press" }] } },
      planUpdatedAt: 5,
      user: { id: "member-1" },
    };
  let answer = false;
  const asked = [];
  const client = {
    plan: async () => plan,
    savePlan: async (body) => {
      saved.push(body);
      return {};
    },
  };
  const { conversation, state, applied } = conversationFixture(client, {
    confirmImpl: (text) => {
      asked.push(text);
      return answer;
    },
  });
  state.messages.push(weekAnswer("a1"));
  await conversation.actions.applyWeek("a1");
  assert.match(asked[0], /Your current plan has 1 exercise\. Applying this week replaces it\./);
  assert.deepEqual(saved, [], "keeping the plan changes nothing");
  assert.deepEqual(applied, []);
  answer = true;
  await conversation.actions.applyWeek("a1");
  assert.equal(saved[0].expectedPlanUpdatedAt, 5);
  assert.deepEqual(state.messages[0].applied, { week: true });
  assert.deepEqual(applied, ["week"], "the Strata+ page refreshes the views a new week touches");

  state.messages.push(weekAnswer("a2", 4));
  await conversation.actions.applyWeek("a2");
  assert.match(state.messages[1].notice, /Your plan changed in another tab or device/);
  assert.deepEqual(applied, ["week"], "a stale proposal is never applied");
});

function fakeElement(id, extra = {}) {
  return {
    id,
    hidden: false,
    isConnected: true,
    dataset: {},
    attributes: {},
    listeners: {},
    value: "",
    scrollHeight: 60,
    style: {
      height: "",
      props: {},
      setProperty(name, value) {
        this.props[name] = value;
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    focus() {
      this.owner.activeElement = this;
    },
    ...extra,
  };
}
function widgetFixture({
  compact = false,
  me = async () => ({ user: { id: "member-1" }, csrfToken: "csrf-1" }),
} = {}) {
  const doc = {
    activeElement: null,
    body: {},
    listeners: {},
    documentElement: {
      classes: new Set(),
      classList: {
        add(name) {
          doc.documentElement.classes.add(name);
        },
        remove(name) {
          doc.documentElement.classes.delete(name);
        },
      },
    },
    getElementById: (id) => nodes.get(id) || null,
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
  };
  const nodes = new Map();
  for (const id of [
    "aiChatLauncher",
    "aiChatPanel",
    "aiChatClose",
    "aiChatMessage",
    "aiChatStatus",
    "aiChatStatusTitle",
    "aiChatStatusDetail",
    "aiChatScroll",
    "aiChatConversation",
    "aiChatEmpty",
    "aiChatStarters",
    "aiChatForm",
    "aiChatCount",
    "aiChatSend",
    "aiChatSendLabel",
    "aiChatSuggest",
    "aiChatReset",
    "aiChatError",
    "aiChatAnnounce",
    "logoutButton",
  ]) {
    const node = fakeElement(id);
    node.owner = doc;
    nodes.set(id, node);
  }
  const panel = nodes.get("aiChatPanel");
  panel.hidden = true;
  panel.contains = (node) => node === panel || node === nodes.get("aiChatMessage");
  doc.body.focus = () => {};
  const assigned = [],
    storage = memoryStorage(),
    bound = [],
    created = [],
    client = {
      me,
      status: async () => ({ configured: true, online: true, dailyLimit: 30, remainingToday: 30 }),
    };
  const windowImpl = {
    sessionStorage: storage,
    location: { assign: (url) => assigned.push(url), reload() {} },
    matchMedia: () => ({ matches: compact }),
    visualViewport: { offsetTop: 12, height: 640, addEventListener() {} },
    addEventListener() {},
  };
  const conversationModule = require("../public/scripts/ai-conversation");
  const modules = {
    StrataAiLogic: logic,
    StrataAiState: store,
    StrataAiApi: { createClient: () => client },
    StrataAiRender: { createRenderer: () => fakeView() },
    StrataAiEvents: { bind: (options) => bound.push(options) },
    StrataAiConversation: {
      createConversation: (options) => {
        created.push(options);
        return conversationModule.createConversation(options);
      },
    },
  };
  const widget = mount({ documentImpl: doc, windowImpl, modules });
  const click = (target, extra = {}) => {
    const event = {
      target: {
        closest: (selector) =>
          selector === "[data-ai-chat-open]" && target === "trigger" ? {} : null,
      },
      button: 0,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    for (const handler of doc.listeners.click || []) handler(event);
    return event;
  };
  return {
    doc,
    nodes,
    widget,
    assigned,
    storage,
    bound,
    created,
    click,
    el: (id) => nodes.get(id),
  };
}
const press = (node, event = {}) => {
  for (const handler of node.listeners[event.type || "click"] || [])
    handler({ preventDefault() {}, defaultPrevented: false, ...event });
};

test("the chat launcher opens and closes the panel, starts only once, and returns focus", async () => {
  assert.equal(
    mount({ documentImpl: { getElementById: () => null }, windowImpl: {} }),
    null,
    "pages without the chat are left alone",
  );
  const { doc, widget, bound, el } = widgetFixture();
  assert.equal(bound.length, 0, "nothing is requested until the member opens the chat");
  press(el("aiChatLauncher"));
  await flush();
  assert.equal(el("aiChatPanel").hidden, false);
  assert.equal(el("aiChatLauncher").getAttribute("aria-expanded"), "true");
  assert.ok(doc.documentElement.classes.has("ai-chat-open"));
  assert.equal(
    doc.activeElement,
    el("aiChatMessage"),
    "focus starts in the message box on a large screen",
  );
  assert.equal(el("aiChatPanel").style.props["--ai-chat-height"], "640px");
  assert.equal(el("aiChatPanel").style.props["--ai-chat-top"], "12px");
  assert.equal(bound.length, 1);
  assert.equal(widget.isOpen(), true);
  const escape = (target) => {
    const event = {
      key: "Escape",
      target,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const handler of doc.listeners.keydown || []) handler(event);
    return event;
  };
  assert.equal(
    escape(el("logoutButton")).defaultPrevented,
    false,
    "Escape elsewhere on the page leaves the chat open",
  );
  assert.equal(el("aiChatPanel").hidden, false);
  assert.equal(escape(el("aiChatMessage")).defaultPrevented, true);
  assert.equal(el("aiChatPanel").hidden, true);
  assert.equal(el("aiChatLauncher").getAttribute("aria-expanded"), "false");
  assert.equal(doc.activeElement, el("aiChatLauncher"), "closing returns focus to the launcher");
  press(el("aiChatLauncher"));
  await flush();
  doc.activeElement = doc.body;
  escape(doc.body);
  assert.equal(
    el("aiChatPanel").hidden,
    true,
    "Escape still closes the chat after a re-rendered reply dropped focus",
  );
  press(el("aiChatLauncher"));
  await flush();
  press(el("aiChatClose"));
  press(el("aiChatLauncher"));
  await flush();
  assert.equal(bound.length, 1, "reopening keeps the same conversation");
  press(el("aiChatLauncher"));
  assert.equal(el("aiChatPanel").hidden, true, "the launcher also closes the chat");
});

test("other Strata AI actions open the chat, a closed chat marks a new answer, and phones focus the panel", async () => {
  const { click, created, el, storage, doc } = widgetFixture({ compact: true });
  assert.equal(
    click("trigger", { metaKey: true }).defaultPrevented,
    false,
    "a modified click still opens the full page",
  );
  assert.equal(click("elsewhere").defaultPrevented, false);
  const opened = click("trigger");
  await flush();
  assert.equal(opened.defaultPrevented, true);
  assert.equal(el("aiChatPanel").hidden, false);
  assert.equal(
    doc.activeElement,
    el("aiChatPanel"),
    "a phone keyboard does not cover the chat as it opens",
  );
  press(el("aiChatClose"));
  created[0].onAnswer({});
  assert.equal(el("aiChatLauncher").dataset.unread, "true");
  assert.equal(el("aiChatLauncher").getAttribute("aria-label"), "Strata AI chat, new answer");
  press(el("aiChatLauncher"));
  await flush();
  assert.equal(el("aiChatLauncher").dataset.unread, undefined);
  assert.equal(el("aiChatLauncher").getAttribute("aria-label"), "Strata AI chat");
  storage.setItem("strata-ai-conversation:member-1", "{}");
  press(el("logoutButton"));
  assert.equal(
    storage.getItem("strata-ai-conversation:member-1"),
    null,
    "signing out forgets the conversation in this tab",
  );
});

test("the chat explains a failed start, retries on the next open, and sends signed-out members to sign in", async () => {
  let attempts = 0;
  const offline = widgetFixture({
    me: async () => {
      attempts += 1;
      throw Object.assign(new Error("offline"), { code: "NETWORK_ERROR" });
    },
  });
  press(offline.el("aiChatLauncher"));
  await flush();
  assert.equal(offline.el("aiChatStatus").dataset.tone, "offline");
  assert.match(offline.el("aiChatStatusTitle").textContent, /couldn’t load/);
  press(offline.el("aiChatLauncher"));
  press(offline.el("aiChatLauncher"));
  await flush();
  assert.equal(attempts, 2, "closing and reopening tries again");
  const signedOut = widgetFixture({
    me: async () => {
      throw Object.assign(new Error("Sign in."), { status: 401 });
    },
  });
  press(signedOut.el("aiChatLauncher"));
  await flush();
  assert.deepEqual(signedOut.assigned, ["/account.html?mode=login&next=discover"]);
  const message = signedOut.el("aiChatMessage");
  message.scrollHeight = 400;
  const grown = widgetFixture();
  press(grown.el("aiChatLauncher"));
  await flush();
  grown.el("aiChatMessage").scrollHeight = 400;
  grown.bound[0].actions.inputChanged();
  assert.equal(
    grown.el("aiChatMessage").style.height,
    "132px",
    "the message box grows to about five lines, then scrolls",
  );
  grown.doc.activeElement = grown.doc.body;
  await grown.bound[0].actions.applyWeek("missing");
  await flush();
  assert.equal(
    grown.doc.activeElement,
    grown.el("aiChatMessage"),
    "focus dropped by a replaced reply returns to the message box",
  );
});
