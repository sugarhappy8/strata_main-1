/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAiConversation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * One Strata AI conversation: asking, waiting for the answer, and applying what Strata AI proposes.
   * The Strata AI page and the Strata+ chat panel both run on it. The conversation itself lives in this
   * browser tab, so moving from the chat panel to the full page keeps it, including an answer still on its way.
   */
  function createConversation({
    logic,
    store,
    state,
    client,
    view,
    nodes,
    storage,
    onAccessError = () => false,
    onApplied = () => {},
    onAnswer = () => {},
    confirmImpl = (text) => globalThis.confirm(text),
    reloadPage = () => globalThis.location.reload(),
  }) {
    let generation = 0,
      pollTimer = 0;
    const findMessage = (id) =>
      state.messages.find((message) => message.id === id && message.role === "assistant");

    function render() {
      view.renderConversation(state);
      view.renderStatus(state);
      view.renderComposer(state);
    }
    function persist() {
      if (state.user)
        store.save(storage, state.user.id, {
          messages: state.messages.slice(-logic.LIMITS.storedMessages),
          pending: state.pending && {
            id: state.pending.id,
            kind: state.pending.kind,
            startedAt: state.pending.startedAt,
            retry: state.pending.retry,
          },
        });
    }

    async function refreshStatus() {
      try {
        const status = await client.status();
        state.status = status;
        if (status.csrfToken) state.csrfToken = status.csrfToken;
      } catch (error) {
        if (onAccessError(error)) return;
        if (!state.status)
          state.status = { configured: true, online: false, dailyLimit: 0, remainingToday: 1 };
      }
      render();
    }

    function finish(entry) {
      state.pending = null;
      state.messages.push(entry);
      persist();
      render();
      view.reveal(entry.id);
      if (entry.role === "assistant") view.announce(`Strata AI answered. ${entry.result.reply}`);
      else view.announce(entry.error.message);
      onAnswer(entry);
      void refreshStatus();
    }
    function failure(error, retry) {
      return { id: logic.newId(), role: "error", error: logic.errorView(error), retry };
    }

    async function poll(expected) {
      if (expected !== generation || !state.pending) return;
      const pending = state.pending;
      try {
        const { request } = await client.poll(pending.id);
        if (expected !== generation) return;
        pending.failures = 0;
        pending.request = request;
        if (request.status === "done")
          return finish({
            id: logic.newId(),
            role: "assistant",
            kind: pending.kind,
            result: request.result,
            applied: {},
          });
        if (request.status === "failed") return finish(failure(request.error, pending.retry));
      } catch (error) {
        if (expected !== generation || onAccessError(error)) return;
        pending.failures = (pending.failures || 0) + 1;
        if (error?.status === 404 || pending.failures >= 4)
          return finish(
            failure(
              error?.status === 404
                ? {
                    code: "AI_REQUEST_NOT_FOUND",
                    message: "That request expired before Strata AI answered. Ask again.",
                  }
                : error,
              pending.retry,
            ),
          );
      }
      view.renderConversation(state);
      pollTimer = setTimeout(
        () => {
          void poll(expected);
        },
        logic.pollDelay(Date.now() - pending.startedAt) * (pending.failures ? 2 : 1),
      );
    }

    async function ask(kind, message, { addUserMessage = true } = {}) {
      if (state.pending || state.busy) return;
      const history = logic.historyFor(state.messages),
        draft = kind === "chat" ? logic.draftPlanFor(state.messages) : null;
      if (addUserMessage) {
        state.messages.push({
          id: logic.newId(),
          role: "user",
          kind,
          text: kind === "suggestions" ? logic.SUGGESTION_PROMPT : message,
        });
        if (kind === "chat") nodes.message.value = "";
      }
      state.busy = true;
      view.setFormError("");
      render();
      view.revealEnd();
      const retry = { kind, message };
      try {
        const { request } = await client.ask({
          kind,
          message,
          history,
          draftPlan: draft?.plan,
          draftPlanUpdatedAt: draft?.planUpdatedAt,
        });
        state.pending = { id: request.id, kind, startedAt: Date.now(), request, retry };
        persist();
        const expected = ++generation;
        clearTimeout(pollTimer);
        pollTimer = setTimeout(() => {
          void poll(expected);
        }, logic.pollDelay(0));
      } catch (error) {
        if (!onAccessError(error)) {
          state.messages.push(failure(error, retry));
          persist();
          view.announce(error.message);
          void refreshStatus();
        }
      } finally {
        state.busy = false;
        render();
        view.revealEnd();
      }
    }

    async function send() {
      const text = nodes.message.value.trim(),
        problem = logic.messageError(text);
      if (problem) {
        view.setFormError(problem);
        nodes.message.focus();
        return;
      }
      await ask("chat", text);
    }

    function confirmReplace(count) {
      const text = `Your current plan has ${count} exercise${count === 1 ? "" : "s"}. Applying this week replaces it. You can still edit every day afterwards in Plan.`;
      if (typeof nodes.confirm?.showModal !== "function") return Promise.resolve(confirmImpl(text));
      nodes.confirmText.textContent = text;
      nodes.confirm.returnValue = "";
      return new Promise((resolve) => {
        nodes.confirm.addEventListener(
          "close",
          () => resolve(nodes.confirm.returnValue === "replace"),
          { once: true },
        );
        nodes.confirm.showModal();
      });
    }

    /** Runs one apply action with a busy marker, reporting failures on the message they belong to. */
    async function applying(message, key, work) {
      if (!message || state.applying) return;
      state.applying = `${message.id}:${key}`;
      message.notice = "";
      render();
      try {
        const done = await work();
        if (done) {
          message.applied = { ...message.applied, ...done.applied };
          view.announce(done.announce);
          onApplied(done.kind);
        }
      } catch (error) {
        if (!onAccessError(error))
          message.notice =
            error?.code === "PLAN_CHANGED"
              ? "Your plan changed in another tab or device. Try again to apply it to the latest copy."
              : error?.code === "COACHING_PROFILE_CHANGED"
                ? "Your personal setup changed after Strata AI calculated these targets. Ask again for fresh ones."
                : error?.message || "That change was not saved. Try again.";
      } finally {
        state.applying = "";
        persist();
        render();
        if (message.notice) view.announce(message.notice);
      }
    }
    const samePlanOwner = (data) => {
      if (data?.user?.id && String(data.user.id) !== String(state.user?.id)) {
        reloadPage();
        return false;
      }
      return true;
    };

    const actions = {
      send,
      suggest: () => ask("suggestions", ""),
      starter: (index) => {
        const starter = logic.STARTERS[index];
        if (!starter) return;
        nodes.message.value = starter.message;
        return send();
      },
      followUp: (index) => {
        const reply = logic.FOLLOW_UPS[index];
        if (!reply) return;
        nodes.message.value = reply.message;
        return send();
      },
      inputChanged: () => {
        view.setFormError("");
        view.renderComposer(state);
      },
      refine: () => {
        nodes.message.placeholder = "What should change? For example: a shorter Friday.";
        nodes.message.focus();
      },
      retry: (id) => {
        const index = state.messages.findIndex(
          (message) => message.id === id && message.role === "error",
        );
        const entry = state.messages[index];
        if (!entry?.retry || state.pending || state.busy) return;
        state.messages.splice(index, 1);
        persist();
        return ask(entry.retry.kind, entry.retry.message, { addUserMessage: false });
      },
      applyWeek: (id) => {
        const message = findMessage(id);
        return applying(message, "week", async () => {
          const current = await client.plan();
          if (!samePlanOwner(current)) return null;
          if (!logic.planRevisionMatches(message, current))
            throw Object.assign(
              new Error(
                "Your plan changed after this week was created. Ask Strata AI to update the latest plan.",
              ),
              { code: "PLAN_CHANGED" },
            );
          const count = logic.planExerciseCount(current.plan);
          if (count > 0 && !(await confirmReplace(count))) return null;
          await client.savePlan({
            plan: message.result.week.plan,
            expectedPlanUpdatedAt: message.result.planUpdatedAt,
          });
          return { kind: "week", applied: { week: true }, announce: "Saved as your weekly plan." };
        });
      },
      applyNutrition: (id) => {
        const message = findMessage(id);
        return applying(message, "nutrition", async () => {
          const nutrition = message.result.nutrition;
          await client.saveProfile({
            profile: nutrition.profile,
            expectedRevision: nutrition.expectedRevision,
          });
          return {
            kind: "nutrition",
            applied: { nutrition: true },
            announce: "Saved to your nutrition targets.",
          };
        });
      },
      applySwap: (id, suggestionId) => {
        const message = findMessage(id),
          suggestion = message?.result?.suggestions?.find((item) => item.id === suggestionId);
        if (!suggestion?.action) return;
        return applying(message, suggestionId, async () => {
          const current = await client.plan();
          if (!samePlanOwner(current)) return null;
          const plan = logic.swapPlan(current.plan, suggestion.action);
          if (!plan)
            throw new Error(
              "Your plan changed, so this swap no longer fits. Ask for fresh suggestions.",
            );
          await client.savePlan({ plan, expectedPlanUpdatedAt: current.planUpdatedAt });
          return {
            kind: "swap",
            applied: { swaps: { ...message.applied?.swaps, [suggestionId]: true } },
            announce: `Swapped ${suggestion.action.fromName} for ${suggestion.action.toName}.`,
          };
        });
      },
      reset: () => {
        if (state.pending || state.applying) return;
        state.messages = [];
        store.clear(storage, state.user?.id);
        view.setFormError("");
        render();
        nodes.message.focus();
      },
      allowConsent: async () => {
        try {
          await client.saveSettings({ consent: true });
          view.setFormError("");
          await refreshStatus();
          nodes.message.focus?.();
        } catch (error) {
          if (!onAccessError(error)) view.setFormError(error.message);
        }
      },
      refreshStatus,
    };

    /** Brings back this member's conversation from the tab and forgets any other account's. */
    function restore() {
      store.clearAll(storage, { except: state.user.id });
      const saved = logic.restoreConversation(store.load(storage, state.user.id));
      state.messages = saved.messages;
      if (saved.pending)
        state.pending = { ...saved.pending, request: { status: "running", position: 0 } };
    }
    /** Picks up an answer that was still on its way when the page changed. */
    function resume() {
      if (state.pending) {
        const expected = ++generation;
        void poll(expected);
      }
    }
    function stop() {
      generation += 1;
      clearTimeout(pollTimer);
    }

    return Object.freeze({ actions, refreshStatus, render, restore, resume, stop });
  }

  return Object.freeze({ createConversation });
});
