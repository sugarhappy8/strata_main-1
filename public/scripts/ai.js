"use strict";

(() => {
  const logic = globalThis.StrataAiLogic,
    store = globalThis.StrataAiState,
    state = store.createState();
  const el = (id) => document.getElementById(id);
  const nodes = {
    conversation: el("aiConversation"),
    empty: el("aiEmpty"),
    starterList: el("aiStarters"),
    starters: [],
    form: el("aiForm"),
    message: el("aiMessage"),
    count: el("aiCount"),
    send: el("aiSend"),
    suggest: el("aiSuggest"),
    reset: el("aiReset"),
    formError: el("aiFormError"),
    announce: el("aiAnnounce"),
    status: el("aiStatus"),
    statusTitle: el("aiStatusTitle"),
    statusDetail: el("aiStatusDetail"),
    userName: el("userName"),
    logout: el("logoutButton"),
    confirm: el("aiConfirm"),
    confirmText: el("aiConfirmText"),
  };
  const client = globalThis.StrataAiApi.createClient({
    getCsrfToken: () => state.csrfToken,
    getUserId: () => state.user?.id,
  });
  const view = globalThis.StrataAiRender.createRenderer({
    nodes,
    logic,
    energy: globalThis.StrataPersonalTrainingEnergyUi,
  });
  const storage = (() => {
    try {
      return globalThis.sessionStorage;
    } catch {
      return null;
    }
  })();

  /** Signed-out, lapsed, or switched accounts leave the page instead of showing someone else's work. */
  function handleAccessError(error) {
    if (error?.status === 401) {
      location.assign("/account.html?mode=login&next=ai");
      return true;
    }
    if (error?.status === 402 || error?.code === "DISCOVERY_ACCESS_REQUIRED") {
      location.assign("/pricing?reason=ai");
      return true;
    }
    if (
      ["AI_ACCOUNT_CHANGED", "ACCOUNT_CHANGED", "COACHING_ACCOUNT_CHANGED"].includes(error?.code)
    ) {
      location.reload();
      return true;
    }
    return false;
  }

  const conversation = globalThis.StrataAiConversation.createConversation({
    logic,
    store,
    state,
    client,
    view,
    nodes,
    storage,
    onAccessError: handleAccessError,
  });
  const actions = {
    ...conversation.actions,
    logout: async () => {
      conversation.stop();
      store.clearAll(storage);
      try {
        await client.logout();
      } catch {
        /* The account page confirms the signed-out state either way. */
      }
      location.assign("/account.html?mode=login");
    },
    reload: () => location.reload(),
    allowConsent: async () => {
      await conversation.actions.allowConsent();
      syncSettings();
    },
  };
  // Settings for members who already agreed: the Daily Brief choice, deleting stored notes, and turning Strata AI off.
  const settings = {
    panel: el("aiSettings"),
    brief: el("aiDailyBrief"),
    status: el("aiSettingsStatus"),
  };
  async function changeSettings(work, done) {
    settings.status.textContent = "Saving…";
    try {
      await work();
      settings.status.textContent = done;
      await conversation.refreshStatus();
      syncSettings();
    } catch (error) {
      if (!handleAccessError(error)) settings.status.textContent = error.message;
    }
  }
  function syncSettings() {
    settings.panel.hidden = !state.status?.consent;
    settings.brief.checked = state.status?.dailyBrief !== false;
  }
  function bindSettings() {
    settings.brief.addEventListener(
      "change",
      () =>
        void changeSettings(
          () => client.saveSettings({ consent: true, dailyBrief: settings.brief.checked }),
          settings.brief.checked ? "Daily Brief is on." : "Daily Brief is off.",
        ),
    );
    el("aiDeleteNotes").addEventListener(
      "click",
      () => void changeSettings(() => client.deleteNotes(), "Your stored AI notes were deleted."),
    );
    el("aiWithdraw").addEventListener(
      "click",
      () =>
        void changeSettings(
          () => client.saveSettings({ consent: false }),
          "Strata AI is off. Nothing more is sent until you allow it again.",
        ),
    );
  }

  async function start() {
    view.renderStarters();
    conversation.render();
    try {
      const data = await client.me();
      state.user = data.user;
      state.csrfToken = String(data.csrfToken || "");
      nodes.userName.textContent = data.user?.name || "Member";
    } catch (error) {
      if (handleAccessError(error)) return;
      nodes.statusTitle.textContent = "STRATA couldn’t load your account";
      nodes.statusDetail.textContent = "Check your connection, then refresh this page.";
      nodes.status.dataset.tone = "offline";
      return;
    }
    conversation.restore();
    globalThis.StrataAiEvents.bind({ nodes, actions });
    bindSettings();
    conversation.render();
    conversation.resume();
    await conversation.refreshStatus();
    syncSettings();
  }

  void start();
})();
