/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAiWidget = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Strata AI chat on Strata+: a glowing launcher that opens a small chat panel. Nothing is requested until the
  // member first opens it, and it shows the same conversation as the full Strata AI page in this tab.
  const COMPACT = "(max-width: 560px), (max-height: 560px)";

  function accessError(error, locationImpl) {
    if (error?.status === 401) {
      locationImpl.assign("/account.html?mode=login&next=discover");
      return true;
    }
    if (error?.status === 402 || error?.code === "DISCOVERY_ACCESS_REQUIRED") {
      locationImpl.assign("/pricing?reason=ai");
      return true;
    }
    if (
      ["AI_ACCOUNT_CHANGED", "ACCOUNT_CHANGED", "COACHING_ACCOUNT_CHANGED"].includes(error?.code)
    ) {
      locationImpl.reload();
      return true;
    }
    return false;
  }

  /** Wires the launcher and panel already in the page; returns null when the page has no chat. */
  function mount({
    documentImpl = globalThis.document,
    windowImpl = globalThis.window,
    modules = globalThis,
    onApplied = () => {},
  } = {}) {
    const doc = documentImpl,
      el = (id) => doc.getElementById(id),
      launcher = el("aiChatLauncher"),
      panel = el("aiChatPanel");
    if (!launcher || !panel) return null;
    const logic = modules.StrataAiLogic,
      store = modules.StrataAiState,
      state = store.createState();
    const nodes = {
      conversation: el("aiChatConversation"),
      empty: el("aiChatEmpty"),
      starterList: el("aiChatStarters"),
      starters: [],
      form: el("aiChatForm"),
      message: el("aiChatMessage"),
      count: el("aiChatCount"),
      send: el("aiChatSend"),
      sendLabel: el("aiChatSendLabel"),
      suggest: el("aiChatSuggest"),
      reset: el("aiChatReset"),
      formError: el("aiChatError"),
      announce: el("aiChatAnnounce"),
      status: el("aiChatStatus"),
      statusTitle: el("aiChatStatusTitle"),
      statusDetail: el("aiChatStatusDetail"),
      confirm: el("aiChatConfirm"),
      confirmText: el("aiChatConfirmText"),
    };
    const storage = (() => {
      try {
        return windowImpl.sessionStorage;
      } catch {
        return null;
      }
    })();
    const onAccessError = (error) => accessError(error, windowImpl.location);
    const client = modules.StrataAiApi.createClient({
      getCsrfToken: () => state.csrfToken,
      getUserId: () => state.user?.id,
    });
    const view = modules.StrataAiRender.createRenderer({
      documentImpl: doc,
      nodes,
      logic,
      energy: modules.StrataPersonalTrainingEnergyUi,
      scroller: el("aiChatScroll"),
    });
    const conversation = modules.StrataAiConversation.createConversation({
      logic,
      store,
      state,
      client,
      view,
      nodes,
      storage,
      onAccessError,
      onApplied,
      onAnswer: () => {
        if (panel.hidden) {
          launcher.dataset.unread = "true";
          launcher.setAttribute("aria-label", "Strata AI chat, new answer");
        }
      },
      reloadPage: () => windowImpl.location.reload(),
    });
    const compact = () => Boolean(windowImpl.matchMedia?.(COMPACT).matches);
    let starting = null,
      returnFocus = null;
    // The message box grows with what is typed, up to about five lines, and shrinks again once a message is sent.
    function grow() {
      const box = nodes.message;
      box.style.height = "";
      if (!panel.hidden) box.style.height = `${Math.min(box.scrollHeight, 132)}px`;
    }
    const focusStart = () => (compact() ? panel : nodes.message).focus({ preventScroll: true });
    // Starters, quick replies, and apply buttons are replaced once used; focus then returns to the chat, not the page.
    function keepFocus() {
      const active = doc.activeElement;
      if (!panel.hidden && (!active || active === doc.body)) focusStart();
    }
    const actions = { ...conversation.actions, reload: () => {} };
    for (const name of [
      "send",
      "starter",
      "followUp",
      "inputChanged",
      "retry",
      "applyWeek",
      "applyNutrition",
      "applySwap",
    ]) {
      const run = actions[name];
      actions[name] = (...args) => {
        const result = run(...args);
        grow();
        Promise.resolve(result).then(keepFocus, keepFocus);
        return result;
      };
    }

    async function start() {
      view.renderStarters();
      conversation.render();
      try {
        const data = await client.me();
        state.user = data.user;
        state.csrfToken = String(data.csrfToken || "");
      } catch (error) {
        starting = null;
        if (onAccessError(error)) return;
        nodes.status.dataset.tone = "offline";
        nodes.statusTitle.textContent = "Strata AI couldn’t load";
        nodes.statusDetail.textContent = "Check your connection, then close and reopen the chat.";
        return;
      }
      conversation.restore();
      modules.StrataAiEvents.bind({ windowImpl, documentImpl: doc, nodes, actions });
      conversation.render();
      conversation.resume();
      await conversation.refreshStatus();
    }

    // On a phone the panel covers the screen; it follows the visible area so the keyboard never hides the message box.
    function fit() {
      const viewport = windowImpl.visualViewport;
      if (panel.hidden || !viewport) return;
      panel.style.setProperty("--ai-chat-top", `${Math.round(viewport.offsetTop)}px`);
      panel.style.setProperty("--ai-chat-height", `${Math.round(viewport.height)}px`);
    }
    function open() {
      if (panel.hidden) {
        returnFocus = doc.activeElement;
        panel.hidden = false;
        launcher.setAttribute("aria-expanded", "true");
        launcher.setAttribute("aria-label", "Strata AI chat");
        delete launcher.dataset.unread;
        doc.documentElement.classList.add("ai-chat-open");
        fit();
        if (!starting)
          starting = start().catch(() => {
            starting = null;
          });
      }
      // A phone keyboard would cover half the panel, so focus starts on the panel there and in the message box elsewhere.
      focusStart();
    }
    function close() {
      if (panel.hidden) return;
      panel.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      doc.documentElement.classList.remove("ai-chat-open");
      const target = returnFocus?.isConnected && returnFocus !== doc.body ? returnFocus : launcher;
      returnFocus = null;
      target.focus?.({ preventScroll: true });
    }

    launcher.addEventListener("click", () => {
      if (panel.hidden) open();
      else close();
    });
    el("aiChatClose")?.addEventListener("click", close);
    // Escape closes the chat from inside it, or when nothing on the page has focus; page dialogs keep their own Escape.
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || panel.hidden || event.isComposing || event.defaultPrevented)
        return;
      if (event.target === doc.body || panel.contains(event.target)) {
        event.preventDefault();
        close();
      }
    });
    // Other “Ask Strata AI” actions on the page open the chat; a modified click still opens the full page.
    doc.addEventListener("click", (event) => {
      const trigger = event.target.closest?.("[data-ai-chat-open]");
      if (
        !trigger ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      open();
    });
    windowImpl.visualViewport?.addEventListener("resize", fit);
    windowImpl.visualViewport?.addEventListener("scroll", fit);
    // Signing out forgets the conversation in this tab, as it does on the Strata AI page. The next member to sign in
    // here never sees it either way: opening the chat removes every other account's conversation first.
    el("logoutButton")?.addEventListener("click", () => {
      store.clearAll(storage);
    });

    return Object.freeze({ open, close, isOpen: () => !panel.hidden });
  }

  return Object.freeze({ mount });
});
