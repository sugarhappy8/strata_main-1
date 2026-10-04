/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPricingRender = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createRenderer({
    state,
    nodes,
    logic,
    navigatorImpl = globalThis.navigator,
    locationImpl = globalThis.location,
    frame = globalThis.requestAnimationFrame,
  }) {
    const {
      panel,
      statusNode,
      signupLink,
      loginLink,
      buyButton,
      openLink,
      manageLink,
      checkButton,
      planChoice,
      yearlyOption,
    } = nodes;
    const pageReason = new URLSearchParams(locationImpl.search).get("reason"),
      featureReason = pageReason === "ai" || pageReason === "recovery";
    // Upgrade lines come from the entitlements module, the same source every page asks about access.
    const upsell = (/** @type {string|null} */ reason) =>
      globalThis.StrataEntitlements?.upsell?.(reason) || "";
    // Members sent here from Strata AI return to it after signing up, signing in, or subscribing.
    if (pageReason === "ai") {
      signupLink.href = "/account.html?mode=signup&next=ai";
      loginLink.href = "/account.html?mode=login&next=ai";
      openLink.href = "/ai";
      if (openLink.firstChild?.nodeType === 3) openLink.firstChild.textContent = "Open Strata AI ";
    }

    function setStatus(message, tone = "", { focus = false } = {}) {
      statusNode.setAttribute("role", tone === "error" ? "alert" : "status");
      statusNode.textContent =
        state.config?.environment === "sandbox" ? `TEST MODE · ${message}` : message;
      statusNode.classList.toggle("purchase-status-good", tone === "good");
      statusNode.classList.toggle("purchase-status-warn", tone === "warn");
      statusNode.classList.toggle("purchase-status-error", tone === "error");
      if (focus)
        (frame || ((callback) => callback()))(() => statusNode.focus({ preventScroll: false }));
    }

    function renderPurchaseState() {
      const signedIn = Boolean(state.user?.id);
      const active = logic.discoveryIsActive(state.user);
      const subscription = logic.subscriptionFor(state.user),
        plan = subscription?.plan === "yearly" ? "yearly" : "monthly",
        subscriptionStatus = String(subscription?.status || "");
      const grandfathered = active && !subscription && state.user?.discovery?.accessType === "paid";
      const online = navigatorImpl.onLine !== false;
      const checkoutReady = Boolean(
        state.config && !state.configError && state.paddleReady && online,
      );
      const paused = subscriptionStatus === "paused",
        canceled = subscriptionStatus === "canceled";
      const held = active ? null : logic.googlePlayHeld(state.user);
      const canSubscribe = signedIn && !active && !paused && !held;
      const checkoutBlocked = state.user?.discovery?.checkoutBlocked === true;
      const checkoutAccountChanged =
        Boolean(state.currentCheckoutUserId) &&
        String(state.user?.id || "") !== state.currentCheckoutUserId;
      // An App Store or Google Play member manages Strata+ on that store's page, never with Paddle (and is active, so no
      // checkout shows).
      const apple = active ? logic.appleAccess(state.user) : null,
        play = active && !apple ? logic.googlePlayAccess(state.user) : null;

      signupLink.hidden = signedIn;
      loginLink.hidden = signedIn;
      buyButton.hidden = !canSubscribe;
      openLink.hidden = !signedIn || !active;
      manageLink.hidden = !signedIn || (!subscription && !apple && !play && !held);
      if (apple || play || held) {
        manageLink.href = apple ? logic.APPLE_MANAGE_URL : logic.PLAY_MANAGE_URL;
        manageLink.target = "_blank";
        manageLink.rel = "noopener noreferrer";
      } else if (manageLink.target) {
        manageLink.href = "/account.html#accountBilling";
        manageLink.removeAttribute("target");
        manageLink.removeAttribute("rel");
      }
      checkButton.hidden = !signedIn || logic.paidAccessReady(state.user) || !state.awaitingAccess;
      buyButton.disabled =
        state.busy ||
        state.awaitingAccess ||
        state.checkoutOpen ||
        !checkoutReady ||
        checkoutBlocked;
      checkButton.disabled = state.busy;
      // The plan choice shows with the subscribe button; yearly only when this server sells it.
      if (planChoice) {
        const yearly = logic.planAvailable(state.config, "yearly");
        if (!yearly) state.plan = "monthly";
        planChoice.hidden = buyButton.hidden;
        if (yearlyOption) yearlyOption.hidden = !yearly;
        for (const input of planChoice.querySelectorAll?.('input[name="plan"]') || []) {
          input.checked = input.value === state.plan;
          input.disabled = buyButton.disabled;
        }
      }
      buyButton.textContent = canceled ? "Restart Strata+ →" : "Subscribe to Strata+ →";
      panel.setAttribute("aria-busy", String(state.busy || state.awaitingAccess));

      if (state.busy && state.awaitingAccess) {
        setStatus("Your checkout completed. STRATA is securely confirming access…", "warn");
        return;
      }
      if (state.busy) {
        setStatus("Checking your account and secure checkout…");
        return;
      }
      if (state.accountStatus === "rechecking") {
        setStatus("Checking which account is signed in…");
        return;
      }
      if (state.accountStatus === "unavailable") {
        setStatus(
          "STRATA could not recheck your account. Check your connection, then refresh this page.",
          "warn",
        );
        return;
      }
      if (
        checkoutAccountChanged &&
        (state.checkoutOpen || state.awaitingAccess || state.checkoutPrepared)
      ) {
        setStatus(
          "This checkout belongs to another signed-in session. Sign back in to the account that started it to confirm Strata+ access.",
          "warn",
        );
        return;
      }
      if (state.checkoutPrepared) {
        setStatus(
          "Your secure checkout is ready for this account. Reload this page to open it safely.",
          "warn",
        );
        return;
      }
      if (state.awaitingAccess) {
        setStatus(
          "Your subscription checkout completed. Access is still being confirmed; check again before opening another checkout.",
          "warn",
        );
        return;
      }
      if (state.actionError) {
        setStatus(state.actionError, "error");
        return;
      }
      if (state.checkoutOpen) {
        setStatus("Secure checkout is open. Complete it with Paddle to unlock Strata+.");
        return;
      }
      if (active) {
        if (state.user?.discovery?.adminGrant?.active === true) {
          const grant = state.user.discovery.adminGrant;
          const coexistence = subscription
            ? `Your existing ${plan} subscription remains separate and is not canceled by this grant; manage it from Profile.`
            : apple
              ? "Your App Store subscription remains separate and is not canceled by this grant; manage it with your App Store subscriptions."
              : play
                ? "Your Google Play subscription remains separate and is not canceled by this grant; manage it in your Google Play subscriptions."
                : grandfathered
                  ? "Your grandfathered lifetime access remains separate and does not renew."
                  : "It did not create a paid subscription.";
          setStatus(
            `You have complimentary Strata+ ${grant?.expiresAt == null ? "with no end date" : `until ${new Date(grant.expiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`}. This grant never charges you. ${coexistence}`,
            "good",
          );
          return;
        }
        if (apple || play) {
          const status = apple ? logic.appleStatus(apple) : logic.googlePlayStatus(play);
          setStatus(status.message, status.tone);
        } else if (grandfathered)
          setStatus(
            "Your prior lifetime Strata+ purchase is grandfathered. It stays active and never renews or charges you.",
            "good",
          );
        else if (subscription?.scheduledChange?.action === "cancel")
          setStatus(
            `Your ${plan} subscription remains active until ${logic.billingDate(subscription.scheduledChange.effectiveAt)}, when its cancellation takes effect. It will not renew after that date.`,
            "warn",
          );
        else if (subscription?.scheduledChange?.action === "pause")
          setStatus(
            `Your ${plan} subscription remains active until ${logic.billingDate(subscription.scheduledChange.effectiveAt)}, when its scheduled pause takes effect and paid access stops.`,
            "warn",
          );
        else if (subscription?.pastDue || subscriptionStatus === "past_due")
          setStatus(
            `Your ${plan} subscription is past due. Strata+ remains available for now; update your payment method from Profile to avoid interruption.`,
            "warn",
          );
        else if (subscription)
          setStatus(
            `Your ${plan} subscription is active and renews on ${logic.billingDate(subscription.currentPeriodEndsAt)} unless canceled.`,
            "good",
          );
        else setStatus("Strata+ access is active on this account.", "good");
        return;
      }
      if (!signedIn) {
        const note = upsell(pageReason),
          message = note
            ? `${note} Create an account or sign in, then subscribe to ${featureReason ? "use it" : "continue"}.`
            : "Create an account or sign in to subscribe, so access follows you across devices.";
        setStatus(message);
        return;
      }
      if (held) {
        setStatus(held.message, "warn");
        return;
      }
      if (paused) {
        setStatus(
          `Your ${plan} subscription is paused and paid access is inactive. Open Profile to manage it in Paddle.`,
          "warn",
        );
        return;
      }
      if (canceled) {
        setStatus(
          `Your previous ${plan} subscription is canceled and will not renew. You can explicitly start a new subscription whenever you choose.`,
          "warn",
        );
        return;
      }
      if (!online) {
        setStatus("You are offline. Reconnect before opening secure checkout.", "warn");
        return;
      }
      if (checkoutBlocked) {
        setStatus(
          "New payment sessions are disabled for this account. Contact STRATA for help.",
          "warn",
        );
        return;
      }
      // Why the member arrived stays visible even when checkout cannot open right now.
      const reasonNote = upsell(pageReason);
      if (state.configError) {
        setStatus(`${reasonNote ? `${reasonNote} ` : ""}${state.configError}`, "warn");
        return;
      }
      if (pageReason === "access-revoked") {
        setStatus(
          "Strata+ access is no longer active, usually because a subscription ended or a charge was refunded or reversed. You may subscribe again or contact STRATA if this is unexpected.",
          "warn",
        );
        return;
      }
      if (reasonNote) {
        setStatus(`${reasonNote} Subscribe to ${featureReason ? "use it" : "continue"}.`);
        return;
      }
      setStatus("Signed in and ready for secure Paddle checkout.");
    }

    return { renderPurchaseState, setStatus };
  }

  return { createRenderer };
});
