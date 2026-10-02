/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAccountDevices = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The Account page's Connected devices card: consent before connecting, finishing Polar's return, sync
  // status, Sync now, the lighter-session switch, and disconnecting with deletion.

  const POLL_MS = 3000,
    POLL_LIMIT_MS = 90000;

  function createController({
    element,
    api,
    core,
    locationLike = globalThis.location,
    historyLike = globalThis.history,
    now = () => Date.now(),
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = (id) => globalThis.clearTimeout(id),
    onAccountChanged = () => {},
  }) {
    const card = element("connectedDevices");
    let status = null,
      generation = 0,
      pollTimer = null,
      userId = "";

    const current = (request) => request === generation;
    function busy(button, value) {
      if (!button) return;
      button.disabled = value;
      if (value) button.dataset.busy = "true";
      else delete button.dataset.busy;
    }
    function say(message, { error = false, focus = false } = {}) {
      const node = element("devicesStatus");
      node.textContent = message;
      node.classList.toggle("bad", error);
      if (focus && message) node.focus({ preventScroll: true });
    }
    function stopPolling() {
      if (pollTimer !== null) clearTimer(pollTimer);
      pollTimer = null;
    }
    function mutate(path, method = "POST", body = {}) {
      return api.deviceRequest(path, method, { ...body, expectedUserId: userId });
    }
    function failure(error, fallback) {
      if (
        error?.status === 401 ||
        error?.code === "DEVICES_ACCOUNT_CHANGED" ||
        error?.code === "INVALID_CSRF"
      ) {
        onAccountChanged();
        return;
      }
      say(
        error?.message && error.message !== "Request failed." && error.code !== "network"
          ? error.message
          : fallback,
        { error: true, focus: true },
      );
    }

    function render() {
      const view = core.connectionView(status, now()),
        connection = status?.connection || null,
        consent = element("devicesConsent");
      if (!view.connect) consent.hidden = true;
      card.hidden = !view.visible;
      card.dataset.state = view.state;
      element("devicesTitle").textContent = view.title || "Polar Loop";
      element("devicesBadge").textContent = view.badge;
      element("devicesDetail").textContent = view.detail;
      element("devicesWarning").textContent = view.warning;
      element("devicesWarning").hidden = !view.warning;
      element("devicesFacts").hidden = !view.facts;
      if (connection) {
        element("devicesConnectedAt").textContent = Number(connection.connectedAt)
          ? new Date(connection.connectedAt).toLocaleDateString("en", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })
          : "—";
        element("devicesLastSync").textContent = connection.lastSyncAt
          ? core.ago(connection.lastSyncAt, now())
          : connection.importing
            ? "Importing…"
            : "Not yet";
        element("devicesSyncedThrough").textContent = connection.syncedThrough
          ? core.dateLabel(connection.syncedThrough)
          : "—";
      }
      const connect = element("devicesConnect");
      connect.hidden = !view.connect || !consent.hidden;
      connect.firstElementChild.textContent = view.connectLabel;
      element("devicesUpgrade").hidden = !view.upgrade;
      element("devicesRecovery").hidden = !view.recovery;
      element("devicesSync").hidden = !view.sync;
      element("devicesDisconnect").hidden = !view.disconnect;
      element("devicesSuggestionsField").hidden = !view.suggestions;
      element("devicesSuggestions").checked = connection?.settings?.recoverySuggestions !== false;
    }

    /** Re-reads the connection until an import or requested sync finishes. */
    function poll(request, since = null) {
      stopPolling();
      const until = now() + POLL_LIMIT_MS;
      const step = async () => {
        pollTimer = null;
        if (!current(request)) return;
        try {
          const next = await api.devices();
          if (!current(request)) return;
          status = next;
          render();
          const connection = status.connection;
          if (!connection || connection.status !== "active") {
            say(connection ? core.syncErrorText(connection.lastError) : "");
            return;
          }
          if (!connection.importing && (since === null || Number(connection.lastSyncAt) > since)) {
            say(`Polar synced ${core.ago(connection.lastSyncAt, now())}.`);
            return;
          }
        } catch {
          /* A missed check is retried below until the time limit. */
        }
        if (now() < until) pollTimer = setTimer(step, POLL_MS);
        else if (current(request)) say("Polar is still syncing. Check back in a few minutes.");
      };
      pollTimer = setTimer(step, POLL_MS);
    }

    function clearReturn() {
      try {
        const url = new URL(locationLike.href);
        url.searchParams.delete("devices");
        historyLike.replaceState(historyLike.state, "", `${url.pathname}${url.search}${url.hash}`);
      } catch {
        /* The outcome message still shows when history is unavailable. */
      }
    }
    async function finishReturn(request, outcome) {
      clearReturn();
      card.hidden = false;
      if (!outcome.complete) {
        say(outcome.message, { error: outcome.error, focus: true });
        return;
      }
      say(outcome.message);
      try {
        const result = await mutate("/api/devices/polar/complete");
        if (!current(request)) return;
        status = { ...status, connection: result.connection };
        render();
        say("Polar is connected. Importing your recent history…", { focus: true });
        poll(request);
      } catch (error) {
        if (current(request)) failure(error, "Polar couldn’t be connected. Try again.");
      }
    }

    function openConsent() {
      element("devicesConsent").hidden = false;
      element("devicesConsentCheck").checked = false;
      element("devicesContinue").disabled = true;
      say("");
      render();
      element("devicesConsentTitle").focus({ preventScroll: false });
    }
    function closeConsent() {
      element("devicesConsent").hidden = true;
      render();
      element("devicesConnect").focus();
    }
    async function connect() {
      const request = generation,
        button = element("devicesContinue");
      if (!element("devicesConsentCheck").checked) return;
      busy(button, true);
      say("");
      try {
        const result = await mutate("/api/devices/polar/connect"),
          target = new URL(String(result.authorizeUrl || ""));
        if (!current(request)) return;
        if (!/^https?:$/.test(target.protocol))
          throw new Error("Polar couldn’t be opened. Try again.");
        locationLike.assign(target.toString());
      } catch (error) {
        if (current(request)) {
          busy(button, false);
          failure(error, "Polar couldn’t be opened. Try again.");
        }
      }
    }
    async function syncNow() {
      const request = generation,
        button = element("devicesSync"),
        since = Number(status?.connection?.lastSyncAt) || 0;
      busy(button, true);
      say("Syncing with Polar…");
      try {
        await mutate("/api/devices/polar/sync");
        if (current(request)) poll(request, since);
      } catch (error) {
        if (current(request)) failure(error, "Polar couldn’t sync right now. Try again later.");
      } finally {
        if (current(request)) busy(button, false);
      }
    }
    async function saveSuggestions() {
      const input = element("devicesSuggestions"),
        request = generation,
        connection = status?.connection,
        value = input.checked;
      if (!connection) return;
      input.disabled = true;
      try {
        const result = await mutate("/api/devices/settings", "PUT", {
          provider: "polar",
          settings: { recoverySuggestions: value },
          expectedRevision: connection.revision,
        });
        if (!current(request)) return;
        status = { ...status, connection: result.connection };
        render();
        say(
          value
            ? "Train will offer a lighter session after a poor night."
            : "Train won’t offer lighter sessions. Recovery still shows every night.",
        );
      } catch (error) {
        if (!current(request)) return;
        input.checked = !value;
        failure(error, "That setting wasn’t saved. Try again.");
        if (error?.code === "DEVICES_CHANGED")
          void api
            .devices()
            .then((next) => {
              if (current(request)) {
                status = next;
                render();
              }
            })
            .catch(() => {});
      } finally {
        if (current(request)) input.disabled = false;
      }
    }
    // Escape keeps the previous returnValue, so it is cleared before every confirmation.
    function askDisconnect() {
      const dialog = element("devicesDisconnectDialog");
      if (typeof dialog?.showModal !== "function") {
        void disconnect();
        return;
      }
      dialog.returnValue = "";
      dialog.showModal();
    }
    async function disconnect() {
      const request = generation,
        button = element("devicesDisconnect");
      busy(button, true);
      stopPolling();
      say("Disconnecting Polar…");
      try {
        await mutate("/api/devices/polar", "DELETE");
        if (!current(request)) return;
        status = { ...status, connection: null };
        render();
        say("Polar is disconnected. STRATA deleted the data it imported from Polar.", {
          focus: true,
        });
      } catch (error) {
        if (current(request)) failure(error, "Polar couldn’t be disconnected. Try again.");
      } finally {
        if (current(request)) busy(button, false);
      }
    }

    function reset() {
      generation += 1;
      stopPolling();
      status = null;
      userId = "";
      card.hidden = true;
      element("devicesConsent").hidden = true;
      say("");
    }
    async function load(user) {
      reset();
      userId = String(user?.id || "");
      const request = generation;
      try {
        status = await api.devices();
      } catch (error) {
        if (current(request) && error?.status === 401) onAccountChanged();
        return;
      }
      if (!current(request)) return;
      render();
      const outcome = core.returnOutcome(locationLike.search);
      if (outcome) await finishReturn(request, outcome);
      else if (status?.connection?.importing) poll(request);
      if (
        current(request) &&
        !card.hidden &&
        (outcome || locationLike.hash === "#connectedDevices")
      )
        card.scrollIntoView?.({ block: "start" });
    }

    element("devicesConnect").addEventListener("click", openConsent);
    element("devicesConsentCancel").addEventListener("click", closeConsent);
    element("devicesConsentCheck").addEventListener("change", (event) => {
      element("devicesContinue").disabled = !event.currentTarget.checked;
    });
    element("devicesContinue").addEventListener("click", () => void connect());
    element("devicesSync").addEventListener("click", () => void syncNow());
    element("devicesSuggestions").addEventListener("change", () => void saveSuggestions());
    element("devicesDisconnect").addEventListener("click", askDisconnect);
    element("devicesDisconnectDialog").addEventListener("close", (event) => {
      if (event.currentTarget.returnValue === "disconnect") void disconnect();
      else element("devicesDisconnect").focus();
    });
    return { load, reset };
  }

  return { createController };
});
