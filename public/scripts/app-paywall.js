/* global module, require */
/* Strata+ in the iOS app is sold through the App Store, never Paddle. On /pricing inside the app, app-mode.js loads
   this file and pricing.js stands down. The paywall shows what Strata+ includes (the page's own copy), the website's
   two plans (monthly and yearly) at the prices and periods StoreKit reports for this storefront, and the auto-renewal
   terms. A purchase carries the signed-in STRATA
   user id as its appAccountToken; the signed transaction goes to STRATA, and the app finishes it only after STRATA
   accepted it, so a rejected or unreachable confirmation is retried by StoreKit instead of being lost. */
(function (root, factory) {
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(root, StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root.StrataApp && root.document) api.mount();
  root.StrataAppPaywall = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, StrataHtml) {
  "use strict";

  // The website's two plans, sold through the App Store. The paywall offers whichever of them StoreKit returns.
  const PRODUCT_IDS = Object.freeze({
    monthly: "online.stratafitness.app.plus.monthly",
    yearly: "online.stratafitness.app.plus.yearly",
  });
  const PRODUCT_ID = PRODUCT_IDS.monthly;
  const MANAGE_PATH = "Settings › Apple Account › Subscriptions";
  const UNITS = Object.freeze({
    day: ["day", "days"],
    week: ["week", "weeks"],
    month: ["month", "months"],
    year: ["year", "years"],
  });
  // "per month", "every 3 months": always from the product StoreKit returned, never assumed.
  function periodLabel(period) {
    const names = UNITS[period?.unit],
      value = Number(period?.value) || 1;
    if (!names) return "";
    return value === 1 ? `per ${names[0]}` : `every ${value} ${names[1]}`;
  }
  const RENEWAL = Object.freeze({ day: "daily", week: "weekly", month: "monthly", year: "yearly" });
  function formatDate(value) {
    const time = Number(value),
      date = new Date(time);
    return Number.isFinite(time) && time > 0 && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)
      : "";
  }

  // How this account holds Strata+, whichever way it was paid: Paddle on the website, the App Store, or a grant.
  function ownership(user) {
    const discovery = user?.discovery || {};
    // The discovery state from STRATA's latest answer wins over a capability map from an older /api/me read.
    const active =
      typeof discovery.active === "boolean"
        ? discovery.active
        : globalThis.StrataEntitlements?.hasPlus?.(user) === true;
    if (!active) return null;
    if (discovery.accessType === "apple") return "apple";
    if (discovery.accessType === "paid") return "paddle";
    if (discovery.accessType === "grant" || discovery.adminGrant?.active === true) return "grant";
    return "plus";
  }

  // The yearly plan's saving against twelve monthly payments, from this storefront's own prices (0 when unknown).
  function yearlySavings(products) {
    const monthly = (products || []).find((product) => product?.plan === "monthly"),
      yearly = (products || []).find((product) => product?.plan === "yearly"),
      perMonth = Number(monthly?.price),
      perYear = Number(yearly?.price);
    if (!(perMonth > 0 && perYear > 0) || monthly.currencyCode !== yearly.currencyCode) return 0;
    const saving = Math.round((1 - perYear / (perMonth * 12)) * 100);
    return saving >= 5 ? saving : 0;
  }

  // What stops a new App Store purchase on this account, as the website's checkout does.
  function purchaseBlocked(user) {
    const discovery = user?.discovery || {};
    if (discovery.checkoutBlocked === true)
      return "New Strata+ purchases are turned off for this account. Contact STRATA from Profile for help.";
    if (discovery.subscription?.status === "paused")
      return "Your Strata+ subscription is paused. Resume it where you bought it rather than subscribing again.";
    return "";
  }

  function disclosure(product) {
    const price = product ? `${product.displayPrice} ${periodLabel(product.period)}` : "";
    const every =
      Number(product?.period?.value || 1) === 1 ? RENEWAL[product?.period?.unit] || "" : "";
    return `Strata+ is an auto-renewing ${every ? `${every} ` : ""}subscription${price ? ` at ${price}` : ""}. Payment is charged to your Apple Account when you confirm the purchase. The subscription renews automatically unless it is cancelled at least 24 hours before the end of the current period, and your Apple Account is charged for the renewal within 24 hours before the period ends. Manage or cancel it anytime in ${MANAGE_PATH}.`;
  }

  function serverMessage(error, { purchased = false } = {}) {
    const safe = purchased ? " Your payment is safe and you will not be charged twice." : "";
    if (error?.code === "SIGN_IN_REQUIRED" || error?.status === 401)
      return `Your STRATA session ended. Sign in again, then choose Restore Purchases.${safe}`;
    if (error?.code === "APPLE_ACCOUNT_MISMATCH")
      return `This App Store purchase belongs to a different STRATA account. Sign in to the account that bought it, then choose Restore Purchases.${safe}`;
    if (error?.code === "APPLE_PURCHASE_OTHER_ACCOUNT")
      return "This Apple Account’s Strata+ subscription is already linked to another STRATA account. Sign in to that account to use it.";
    if (error?.code === "APPLE_FAMILY_SHARED")
      return "Strata+ isn’t shared through Family Sharing. Subscribe with your own Apple Account to unlock it.";
    if (String(error?.code || "").startsWith("APPLE_"))
      return `STRATA could not verify this App Store purchase. Contact STRATA from Profile so we can help.${safe}`;
    if (error?.code === "NETWORK_ERROR")
      return `Could not reach STRATA. Reconnect, then choose Restore Purchases.${safe}`;
    if (error?.status === 403)
      return `Your session needs refreshing. Leave this screen and come back, then choose Restore Purchases.${safe}`;
    return `STRATA could not confirm the purchase yet. Try Restore Purchases in a moment.${safe}`;
  }

  function storeMessage(error) {
    if (error?.code === "PRODUCT_NOT_FOUND")
      return "Strata+ is not available from the App Store right now. Try again later.";
    if (error?.code === "VERIFICATION_FAILED")
      return "The App Store could not verify this purchase, so nothing was unlocked. Try again, or contact STRATA from Profile.";
    return "The App Store could not complete the purchase. Try again.";
  }

  // The paywall's behavior without the DOM: every change calls onChange(model) with what to show.
  function createController({
    native = null,
    billing,
    reason = "",
    haptic = () => {},
    onChange = () => {},
    upsell = (value) => globalThis.StrataEntitlements?.upsell?.(value) || "",
  }) {
    const model = {
      phase: "loading",
      user: null,
      products: [],
      plan: "monthly",
      product: null,
      busy: false,
      status: "",
      tone: "",
      success: false,
      reason,
      note:
        reason === "access-revoked"
          ? "Strata+ access is no longer active on this account."
          : upsell(reason),
      nativeAvailable: Boolean(native),
    };
    const emit = () =>
      onChange({
        ...model,
        owned: ownership(model.user),
        apple: model.user?.discovery?.apple || null,
        blocked: purchaseBlocked(model.user),
        savings: yearlySavings(model.products),
      });
    // The chosen plan's product, or the first one StoreKit returned if that plan is not for sale.
    const select = (plan) => {
      model.product =
        model.products.find((product) => product.plan === plan) || model.products[0] || null;
      model.plan = model.product?.plan || "monthly";
    };
    const say = (status, tone = "") => {
      model.status = status;
      model.tone = tone;
      emit();
    };
    const setDiscovery = (discovery) => {
      if (model.user && discovery && typeof discovery === "object")
        model.user = { ...model.user, discovery };
    };

    async function refreshAccount() {
      try {
        const { user } = await billing.account({ fresh: true });
        model.user = user;
      } catch {
        /* The last known account state stays on screen. */
      }
      emit();
    }

    async function load() {
      model.phase = "loading";
      emit();
      const [account, products] = await Promise.allSettled([
        billing.account({ fresh: true }),
        native?.getProducts
          ? native.getProducts({ productIds: Object.values(PRODUCT_IDS) })
          : Promise.resolve(null),
      ]);
      if (account.status === "fulfilled") model.user = account.value.user;
      const found = products.status === "fulfilled" ? products.value?.products || [] : [];
      model.products = Object.entries(PRODUCT_IDS).flatMap(([plan, id]) => {
        const product = found.find((item) => item?.id === id);
        return product ? [{ ...product, plan }] : [];
      });
      select(model.plan);
      model.phase = "ready";
      if (account.status === "rejected")
        say(
          "STRATA could not check your account. Check your connection, then reopen this screen.",
          "error",
        );
      else if (!native && !ownership(model.user))
        say("Update STRATA from the App Store to subscribe.", "warn");
      else if (native && !model.product && !ownership(model.user))
        say("Strata+ is not available from the App Store right now. Try again later.", "warn");
      else if (model.user?.discovery?.apple && !ownership(model.user))
        say(
          model.user.discovery.apple.revoked
            ? "Your App Store subscription was refunded or revoked, so Strata+ is off."
            : "Your App Store subscription has ended. Subscribe again whenever you like.",
          "warn",
        );
      else emit();
    }

    // STRATA kept the purchase but it does not unlock Strata+: a TestFlight or App Review purchase on an account
    // that is not on the review list, or one STRATA cannot match to an active period yet.
    // A test purchase still inside its period that STRATA keeps locked, as opposed to one that ran out or was refunded.
    function lockedTestPurchase(apple) {
      return (
        apple?.environment === "Sandbox" &&
        !apple.revoked &&
        !(Number(apple.expiresAt) <= Date.now())
      );
    }
    function lockedMessage(discovery) {
      return lockedTestPurchase(discovery?.apple)
        ? "This was an App Store test purchase. Test purchases do not unlock Strata+."
        : "STRATA saved your purchase, but Strata+ is not on yet. Reopen this screen in a minute, or contact support if it stays locked.";
    }

    /** Welcomes the member only once STRATA says Strata+ is on for this account. */
    async function confirm({ transactionId, signedTransaction }) {
      say("Confirming your subscription with STRATA…");
      try {
        const { discovery, accepted } = await billing.submit([signedTransaction]);
        if (!accepted.includes(String(transactionId)))
          throw Object.assign(new Error("Not accepted"), { code: "NOT_ACCEPTED" });
        setDiscovery(discovery);
        try {
          await native.finishTransaction({ transactionId: String(transactionId) });
        } catch {
          /* StoreKit redelivers it; STRATA accepts it again. */
        }
        if (!ownership(model.user)) {
          say(lockedMessage(discovery), "warn");
          await refreshAccount();
          return "locked";
        }
        model.success = true;
        haptic("success");
        say("Welcome to Strata+. Your subscription is active.", "good");
        await refreshAccount();
        return "purchased";
      } catch (error) {
        say(serverMessage(error, { purchased: true }), "error");
        return "unconfirmed";
      }
    }

    function choosePlan(plan) {
      if (model.busy) return model.plan;
      select(plan);
      emit();
      return model.plan;
    }

    async function subscribe() {
      if (model.busy || !native || !model.product || ownership(model.user)) return "ignored";
      if (purchaseBlocked(model.user)) {
        emit();
        return "blocked";
      }
      if (!model.user?.id) {
        say("Sign in to STRATA first, so Strata+ follows you to every device.", "warn");
        return "signed-out";
      }
      model.busy = true;
      model.success = false;
      say("Opening the App Store…");
      try {
        let result;
        try {
          result = await native.purchase({
            productId: model.product.id,
            appAccountToken: String(model.user.id),
          });
        } catch (error) {
          say(storeMessage(error), "error");
          return "failed";
        }
        if (result?.status === "cancelled") {
          say("");
          return "cancelled";
        }
        if (result?.status === "pending") {
          say(
            "Your purchase is waiting for approval. Strata+ unlocks on its own once it is approved.",
            "warn",
          );
          return "pending";
        }
        if (
          result?.status !== "purchased" ||
          !result.transactionId ||
          typeof result.signedTransaction !== "string"
        ) {
          say(storeMessage(null), "error");
          return "failed";
        }
        return await confirm(result);
      } finally {
        model.busy = false;
        emit();
      }
    }

    async function restore() {
      if (model.busy || !native) return "ignored";
      if (!model.user?.id) {
        say("Sign in to STRATA first, then restore your purchases.", "warn");
        return "signed-out";
      }
      model.busy = true;
      say("Restoring your App Store purchases…");
      try {
        let signedTransactions;
        try {
          ({ signedTransactions = [] } = (await native.restore()) || {});
        } catch {
          say("Restoring did not finish. Try again.", "error");
          return "failed";
        }
        if (!signedTransactions.length) {
          say("No App Store purchases were found for this Apple Account.", "warn");
          return "empty";
        }
        try {
          const { discovery } = await billing.submit(signedTransactions);
          setDiscovery(discovery);
        } catch (error) {
          say(serverMessage(error), "error");
          return "rejected";
        }
        if (ownership(model.user)) {
          haptic("success");
          say("Purchases restored. You have Strata+.", "good");
          await refreshAccount();
          return "restored";
        }
        say(
          lockedTestPurchase(model.user?.discovery?.apple)
            ? lockedMessage(model.user.discovery)
            : "No active Strata+ subscription was found on this Apple Account.",
          "warn",
        );
        return "inactive";
      } finally {
        model.busy = false;
        emit();
      }
    }

    async function manage() {
      try {
        await native?.manageSubscriptions?.();
      } catch {
        say(`Open ${MANAGE_PATH} to manage Strata+.`, "warn");
      }
    }

    // A renewal or an Ask to Buy approval confirmed in the background (app-mode.js) updates the paywall too.
    function billingChanged(discovery) {
      setDiscovery(discovery);
      emit();
    }

    return { model, load, choosePlan, subscribe, restore, manage, refreshAccount, billingChanged };
  }

  // Monthly or yearly, as on the website's pricing page; the chosen plan is the one Subscribe buys.
  function planChoiceHtml(view) {
    const { html } = StrataHtml,
      busy = view.busy || view.phase !== "ready";
    const option = (product) => {
      const yearly = product.plan === "yearly",
        label = yearly ? `Yearly${view.savings ? ` · save ${view.savings}%` : ""}` : "Monthly";
      return html`<label class="app-plan-option"><input type="radio" name="appPlan" value="${product.plan}" data-paywall-plan="${product.plan}"${product.plan === view.plan ? " checked" : ""}${busy ? " disabled" : ""} /><span><strong>${label}</strong>${product.displayPrice} ${periodLabel(product.period)}</span></label>`;
    };
    return html`<fieldset class="app-plan-choice"><legend>Choose a plan</legend>${view.products.map(option)}</fieldset>`;
  }

  function bodyHtml(view) {
    const product = view.product,
      owned = view.owned,
      apple = view.apple,
      signedIn = Boolean(view.user?.id);
    const { html } = StrataHtml;
    const price =
      (view.products?.length || 0) > 1
        ? planChoiceHtml(view)
        : product
          ? html`<p class="app-paywall-price"><strong>${product.displayPrice}</strong><span>${periodLabel(product.period)}</span></p>`
          : "";
    const open =
      view.reason === "ai"
        ? html`<a class="app-button app-button-primary" href="/ai">Open Strata AI</a>`
        : html`<a class="app-button app-button-primary" href="/discover.html">Open Strata+</a>`;
    let detail = "",
      actions = "";
    if (owned) {
      if (owned === "apple") {
        const date = formatDate(apple?.expiresAt);
        detail = apple?.inGracePeriod
          ? `There is a billing problem with your Apple Account. Update your payment method in ${MANAGE_PATH} to keep Strata+.`
          : date
            ? apple?.autoRenew === false
              ? `Your App Store subscription ends ${date} and will not renew.`
              : `Your App Store subscription renews ${date}.`
            : "Your App Store subscription is active.";
        actions = html`${open}<button class="app-button" type="button" data-paywall-action="manage">Manage subscription</button>`;
      } else {
        detail =
          owned === "paddle"
            ? "Your Strata+ subscription is billed on stratafitness.online."
            : owned === "grant"
              ? "You have complimentary Strata+ access. It never charges you."
              : "Strata+ is active on this account.";
        actions = open;
      }
    } else if (!signedIn && view.phase === "ready") {
      actions = html`<a class="app-button app-button-primary" href="/account.html?mode=signup&amp;next=pricing">Create a free account</a><a class="app-button" href="/account.html?mode=login&amp;next=pricing">Sign in to subscribe</a>`;
    } else if (view.blocked) {
      detail = view.blocked;
    } else if (view.nativeAvailable) {
      actions = html`<button class="app-button app-button-primary" type="button" data-paywall-action="subscribe"${!product || view.busy || view.phase !== "ready" ? " disabled" : ""}>Subscribe</button>`;
    }
    const restore =
      !owned && view.nativeAvailable
        ? html`<button class="app-paywall-restore" type="button" data-paywall-action="restore"${view.busy ? " disabled" : ""}>Restore Purchases</button>`
        : "";
    return html`${view.note ? html`<p class="app-paywall-note">${view.note}</p>` : ""}<p class="app-paywall-kicker">Strata+</p><h2 id="appPaywallTitle">${owned ? "You have Strata+" : "Unlock Strata+"}</h2>${owned ? "" : price}${detail ? html`<p class="app-paywall-detail">${detail}</p>` : ""}<div class="app-paywall-actions">${actions}${restore}</div>`;
  }
  // Each benefit is markup read back from the page's own list.
  const benefitsHtml = (benefits) =>
    StrataHtml.html`<ul class="app-paywall-benefits">${benefits.map((item) => StrataHtml.html`<li>${StrataHtml.raw(item)}</li>`)}</ul>`;

  function mount({
    documentImpl = root.document,
    appMode = root.StrataAppMode,
    locationImpl = root.location,
  } = {}) {
    const panel = documentImpl.getElementById("purchasePanel");
    if (!panel || !appMode) return null;
    const benefits = [...documentImpl.querySelectorAll(".plus-benefits li")].map(
      (item) => item.innerHTML,
    );
    const section = documentImpl.createElement("section");
    section.className = "app-paywall";
    section.setAttribute("aria-labelledby", "appPaywallTitle");
    // The price, Subscribe, and Restore come first; what Strata+ includes, the renewal terms, and the legal links follow.
    StrataHtml.setHtml(
      section,
      StrataHtml.html`<div data-paywall-body></div><p class="app-paywall-status" role="status" aria-live="polite" data-paywall-status></p><div data-paywall-benefits>${benefitsHtml(benefits)}</div><p class="app-paywall-terms" data-paywall-terms></p><p class="app-paywall-links"><a href="/terms">Terms of Use</a><a href="/privacy">Privacy Policy</a></p>`,
    );
    panel.before(section);
    const body = section.querySelector("[data-paywall-body]"),
      status = section.querySelector("[data-paywall-status]"),
      terms = section.querySelector("[data-paywall-terms]"),
      included = section.querySelector("[data-paywall-benefits]");
    function render(view) {
      const focused = documentImpl.activeElement?.dataset?.paywallAction,
        focusedPlan = documentImpl.activeElement?.dataset?.paywallPlan;
      section.setAttribute("aria-busy", String(view.phase === "loading" || view.busy));
      StrataHtml.setHtml(body, bodyHtml(view));
      status.textContent = view.status;
      status.dataset.tone = view.tone;
      included.hidden = Boolean(view.owned);
      terms.textContent = view.owned || !view.nativeAvailable ? "" : disclosure(view.product);
      if (focused)
        body.querySelector(`[data-paywall-action="${focused}"]`)?.focus({ preventScroll: true });
      else if (focusedPlan)
        body.querySelector(`[data-paywall-plan="${view.plan}"]`)?.focus({ preventScroll: true });
    }
    const controller = createController({
      native: appMode.plugin(),
      billing: appMode.billing,
      reason: new URLSearchParams(locationImpl.search).get("reason") || "",
      haptic: appMode.haptic,
      onChange: render,
    });
    section.addEventListener("change", (event) => {
      const plan = event.target?.dataset?.paywallPlan;
      if (plan) controller.choosePlan(plan);
    });
    section.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-paywall-action]")?.dataset.paywallAction;
      if (action === "subscribe") void controller.subscribe();
      else if (action === "restore") void controller.restore();
      else if (action === "manage") void controller.manage();
    });
    root.addEventListener?.("strata:app-billing", (event) =>
      controller.billingChanged(event.detail?.discovery),
    );
    // Back from Settings (manage or cancel) or another app: show the current state.
    documentImpl.addEventListener?.("visibilitychange", () => {
      if (documentImpl.visibilityState === "visible" && !controller.model.busy)
        void controller.refreshAccount();
    });
    void controller.load();
    return controller;
  }

  return Object.freeze({
    PRODUCT_ID,
    PRODUCT_IDS,
    periodLabel,
    yearlySavings,
    purchaseBlocked,
    disclosure,
    ownership,
    serverMessage,
    storeMessage,
    createController,
    planChoiceHtml,
    bodyHtml,
    benefitsHtml,
    mount,
  });
});
