"use strict";

(() => {
  // Inside the iOS app Strata+ is sold through the App Store (app-paywall.js); Paddle never loads or opens there.
  if (globalThis.StrataApp) return;
  const PADDLE_SCRIPT = "https://cdn.paddle.com/paddle/v2/paddle.js";
  const logic = globalThis.StrataPricingLogic;
  const state = globalThis.StrataPricingState.createState();
  const requestJson = globalThis.StrataPricingApi.createRequestJson();
  const el = (id) => document.getElementById(id);
  const nodes = {
    panel: el("purchasePanel"),
    statusNode: el("purchaseStatus"),
    signupLink: el("purchaseSignup"),
    loginLink: el("purchaseLogin"),
    buyButton: el("buyDiscovery"),
    openLink: el("openDiscovery"),
    manageLink: el("manageSubscription"),
    checkButton: el("checkAccess"),
    planChoice: el("planChoice"),
    yearlyOption: el("planYearlyOption"),
  };
  const signal = (name) => globalThis.StrataSignals?.record?.(name);
  const { renderPurchaseState, setStatus } = globalThis.StrataPricingRender.createRenderer({
    state,
    nodes,
    logic,
  });
  let accountRequestId = 0,
    accountRecheck = null;

  function closeCheckoutOverlay() {
    if (!state.checkoutOpen) return;
    try {
      globalThis.Paddle?.Checkout?.close?.();
    } catch {
      /* The local view still locks if Paddle cannot close cleanly. */
    }
    state.checkoutOpen = false;
  }

  // Paddle.js is requested by this page on the website only, alongside the account and billing checks.
  function loadPaddle() {
    if (globalThis.StrataApp)
      return Promise.reject(new Error("Checkout is not available in the STRATA app."));
    if (globalThis.Paddle) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PADDLE_SCRIPT;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(
          new Error("Secure Paddle checkout could not load. Check your connection and try again."),
        );
      document.head.append(script);
    });
  }

  function initializePaddle() {
    if (state.paddleReady) return;
    if (!globalThis.Paddle?.Initialize || !globalThis.Paddle?.Checkout?.open)
      throw new Error(
        "Secure Paddle checkout could not load. Check your connection and try again.",
      );
    logic.validateConfig(state.config);
    if (state.config.environment === "sandbox") {
      if (!globalThis.Paddle.Environment?.set)
        throw new Error("Sandbox checkout could not initialize safely.");
      globalThis.Paddle.Environment.set("sandbox");
    }
    globalThis.Paddle.Initialize({
      token: state.config.clientToken,
      // STRATA does not know a Paddle customer ID before a first subscription.
      // An empty object is Paddle's documented safe Retain value.
      pwCustomer: {},
      eventCallback: (event) => {
        void handleCheckoutEvent(event);
      },
    });
    state.paddleReady = true;
  }

  async function readAccount() {
    const requestId = ++accountRequestId;
    try {
      const data = await requestJson("/api/me");
      if (requestId !== accountRequestId) return state.user;
      state.user = data.user || null;
      state.csrfToken = String(data.csrfToken || data.csrf_token || data.user?.csrfToken || "");
      state.accountStatus = state.user ? "authenticated" : "anonymous";
      return state.user;
    } catch (error) {
      if (requestId !== accountRequestId) return state.user;
      if (error.status === 401) {
        state.user = null;
        state.csrfToken = "";
        state.accountStatus = "anonymous";
        return null;
      }
      throw error;
    }
  }

  function recheckAccount() {
    if (accountRecheck) return accountRecheck;
    state.user = null;
    state.csrfToken = "";
    state.accountStatus = "rechecking";
    renderPurchaseState();
    accountRecheck = readAccount()
      .then(() => {
        if (state.currentCheckoutUserId && checkoutIdentityChanged()) {
          closeCheckoutOverlay();
          state.awaitingAccess = true;
          return;
        }
        if (
          state.awaitingAccess &&
          state.currentCheckoutUserId &&
          !checkoutIdentityChanged() &&
          logic.paidAccessReady(state.user)
        ) {
          state.awaitingAccess = false;
          state.checkoutPrepared = false;
          state.currentCheckoutUserId = "";
          state.currentTransactionId = "";
          signal("upgrade_activated");
        }
      })
      .catch(() => {
        if (state.currentCheckoutUserId) {
          closeCheckoutOverlay();
          state.awaitingAccess = true;
        }
        state.accountStatus = "unavailable";
      })
      .finally(() => {
        accountRecheck = null;
        renderPurchaseState();
      });
    return accountRecheck;
  }

  async function loadPageState() {
    state.busy = true;
    renderPurchaseState();
    const [accountResult, configResult, paddleResult] = await Promise.allSettled([
      readAccount(),
      requestJson("/api/billing/config"),
      loadPaddle(),
    ]);
    if (accountResult.status === "rejected") {
      state.user = null;
      state.csrfToken = "";
      state.configError =
        "Your account status could not be checked. Refresh this page and try again.";
    }
    if (configResult.status === "fulfilled") {
      try {
        state.config = logic.normalizedConfig(configResult.value);
        logic.validateConfig(state.config);
        if (paddleResult.status === "rejected") throw paddleResult.reason;
        initializePaddle();
      } catch (error) {
        state.configError = error.message;
      }
    } else
      state.configError =
        configResult.reason?.message || "Secure checkout is temporarily unavailable.";
    state.busy = false;
    renderPurchaseState();
  }

  async function openCheckout() {
    if (globalThis.StrataApp || state.busy || state.awaitingAccess) return;
    if (!state.user?.id) {
      location.assign("/account.html?mode=signup&next=pricing");
      return;
    }
    const checkoutUserId = String(state.user.id),
      checkoutEmail = String(state.user.email || "");
    const subscription = logic.subscriptionFor(state.user);
    if (logic.discoveryIsActive(state.user) || subscription?.status === "paused") {
      renderPurchaseState();
      return;
    }
    if (!state.csrfToken) {
      setStatus(
        "Your session needs to be refreshed before checkout. Reload this page and try again.",
        "error",
        { focus: true },
      );
      return;
    }
    try {
      state.actionError = "";
      state.checkoutOpen = false;
      state.busy = true;
      renderPurchaseState();
      setStatus("Preparing your secure checkout…");
      const result = await requestJson("/api/billing/checkout", {
        method: "POST",
        headers: { "X-CSRF-Token": state.csrfToken },
        body: JSON.stringify({ plan: state.plan }),
      });
      const transactionId = logic.checkoutTransactionId(result);
      if (!/^txn_[a-z0-9]{26}$/.test(transactionId))
        throw Object.assign(new Error("STRATA could not prepare a valid checkout."), {
          code: "INVALID_TRANSACTION",
        });
      state.currentTransactionId = transactionId;
      state.currentCheckoutUserId = checkoutUserId;
      await readAccount();
      if (checkoutIdentityChanged()) {
        state.awaitingAccess = true;
        state.checkoutPrepared = true;
        return;
      }
      initializePaddle();
      globalThis.Paddle.Checkout.open({
        transactionId,
        ...(checkoutEmail ? { customer: { email: checkoutEmail } } : {}),
        settings: {
          displayMode: "overlay",
          variant: "one-page",
          theme: "light",
          allowLogout: false,
          showAddDiscounts: true,
        },
      });
      state.checkoutOpen = true;
      signal("checkout_opened");
    } catch (error) {
      if (error.status === 401) {
        location.assign("/account.html?mode=login&next=pricing");
        return;
      }
      if (
        error.code === "ALREADY_ENTITLED" ||
        error.code === "ALREADY_ENTITLED_APP_STORE" ||
        error.code === "DISCOVERY_ALREADY_ACTIVE" ||
        error.code === "CHECKOUT_PENDING_CONFIRMATION"
      ) {
        state.currentCheckoutUserId = checkoutUserId;
        await refreshAccess({ focus: true });
        return;
      }
      if (error.code === "CHECKOUT_PREPARING") {
        state.actionError =
          error.message || "Another checkout is being prepared. Try again in a moment.";
        return;
      }
      state.actionError =
        error.status === 403
          ? "Your secure session expired. Refresh this page before trying checkout again."
          : error.message || "Secure checkout could not open. Please try again.";
    } finally {
      state.busy = false;
      renderPurchaseState();
      if (state.actionError)
        requestAnimationFrame(() => nodes.statusNode.focus({ preventScroll: false }));
    }
  }

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  function checkoutIdentityChanged() {
    return (
      Boolean(state.currentCheckoutUserId) &&
      String(state.user?.id || "") !== state.currentCheckoutUserId
    );
  }
  async function pollForAccess() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await readAccount();
        if (checkoutIdentityChanged()) return "identity-changed";
        if (logic.paidAccessReady(state.user)) return "confirmed";
      } catch {
        /* A temporary read failure does not invalidate a completed checkout. */
      }
      await wait(attempt < 4 ? 1000 : 1800);
    }
    return "pending";
  }

  async function refreshAccess({ focus = false } = {}) {
    state.busy = true;
    renderPurchaseState();
    try {
      await readAccount();
      if (checkoutIdentityChanged()) {
        state.awaitingAccess = true;
        setStatus(
          "This checkout belongs to the account that started it, but this tab is no longer signed in to that account. Sign back in to the original account to confirm its Strata+ access.",
          "warn",
          { focus },
        );
      } else if (logic.paidAccessReady(state.user)) {
        state.awaitingAccess = false;
        state.checkoutPrepared = false;
        state.currentCheckoutUserId = "";
        state.currentTransactionId = "";
        setStatus(
          logic.subscriptionFor(state.user)
            ? "Your monthly Strata+ subscription is confirmed."
            : "Strata+ is unlocked on this account.",
          "good",
          { focus },
        );
        signal("upgrade_activated");
      } else {
        state.awaitingAccess = true;
        setStatus(
          "Access is still being confirmed. Wait a moment, then check again. You will not be charged twice.",
          "warn",
          { focus },
        );
      }
    } catch {
      state.awaitingAccess = true;
      setStatus(
        "STRATA could not check access yet. Your Paddle transaction is not affected; try again shortly.",
        "warn",
        { focus },
      );
    } finally {
      state.busy = false;
      renderPurchaseState();
      if (focus) requestAnimationFrame(() => nodes.statusNode.focus({ preventScroll: false }));
    }
  }

  async function handleCheckoutEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.name === "checkout.error") {
      state.busy = false;
      state.checkoutOpen = false;
      state.actionError =
        "Paddle could not complete checkout. Review the checkout message or try again.";
      renderPurchaseState();
      requestAnimationFrame(() => nodes.statusNode.focus({ preventScroll: false }));
      return;
    }
    if (event.name === "checkout.closed") {
      state.checkoutOpen = false;
      renderPurchaseState();
      if (!nodes.buyButton.hidden) nodes.buyButton.focus({ preventScroll: true });
      return;
    }
    if (event.name !== "checkout.completed") return;
    if (!state.currentCheckoutUserId) return;
    const eventTransaction = String(event.data?.transaction_id || event.data?.transactionId || "");
    if (
      state.currentTransactionId &&
      eventTransaction &&
      eventTransaction !== state.currentTransactionId
    )
      return;
    state.busy = true;
    state.checkoutOpen = false;
    state.actionError = "";
    state.awaitingAccess = true;
    renderPurchaseState();
    setStatus("Payment completed. STRATA is securely confirming your Strata+ access…", "warn", {
      focus: true,
    });
    const outcome = await pollForAccess();
    state.busy = false;
    state.awaitingAccess = outcome !== "confirmed";
    renderPurchaseState();
    if (outcome === "confirmed") {
      state.checkoutPrepared = false;
      state.currentCheckoutUserId = "";
      state.currentTransactionId = "";
      setStatus("Subscription confirmed. Strata+ is now unlocked on this account.", "good", {
        focus: true,
      });
      signal("upgrade_activated");
    } else if (outcome === "identity-changed")
      setStatus(
        "Payment completed for the account that started checkout, but this tab is no longer signed in to that account. Sign back in to the original account to confirm its Strata+ access.",
        "warn",
        { focus: true },
      );
    else
      setStatus(
        "Paddle completed the checkout, but access is still processing. Wait a moment, then choose Check access. Do not purchase again.",
        "warn",
        { focus: true },
      );
  }

  function choosePlan(value) {
    state.plan =
      value === "yearly" && logic.planAvailable(state.config, "yearly") ? "yearly" : "monthly";
    renderPurchaseState();
  }

  globalThis.StrataPricingEvents.bind({
    ...nodes,
    actions: { openCheckout, refreshAccess, recheckAccount, renderPurchaseState, choosePlan },
  });
  signal("upgrade_viewed");
  void loadPageState();
})();
