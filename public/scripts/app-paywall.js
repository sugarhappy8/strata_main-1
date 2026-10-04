/* global module, require */
/* Strata+ in the STRATA app is sold through the app's store, never Paddle: the App Store on iPhone and Google Play on
   Android. On /pricing inside the app, app-mode.js loads this file and pricing.js stands down. The paywall shows what
   Strata+ includes (the page's own copy), the website's two plans (monthly and yearly) at the prices and periods the
   store reports for this storefront, and the auto-renewal terms. A purchase carries the signed-in STRATA user id (the
   App Store's appAccountToken, Google Play's obfuscated account id). On iPhone the signed transaction goes to STRATA
   and the app finishes it only after STRATA accepted it, so a rejected or unreachable confirmation is retried by
   StoreKit instead of being lost; on Android the purchase token goes to STRATA, which checks it with Google Play and
   acknowledges it there. */
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
  // On Android: one Google Play subscription, with a base plan for each of the website's plans.
  const PLAY_PRODUCT_ID = "online.stratafitness.app.plus";
  const PLAY_BASE_PLANS = Object.freeze({ monthly: "monthly", yearly: "yearly" });
  const MANAGE_PATH = "Settings › Apple Account › Subscriptions";
  const PLAY_MANAGE_PATH = "Google Play › Payments & subscriptions › Subscriptions";
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
    if (discovery.accessType === "google") return "google";
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

  // What stops a new store purchase on this account, as the website's checkout does. A Google Play subscription that is
  // paused or on hold gives no access but bills again once it resumes, so it is resumed rather than bought twice.
  function purchaseBlocked(user) {
    const discovery = user?.discovery || {},
      play = discovery.googlePlay;
    if (discovery.checkoutBlocked === true)
      return "New Strata+ purchases are turned off for this account. Contact STRATA from Profile for help.";
    if (discovery.subscription?.status === "paused")
      return "Your Strata+ subscription is paused. Resume it where you bought it rather than subscribing again.";
    if (play?.onHold === true && play.testPurchase !== true)
      return "Your Strata+ subscription through Google Play is on hold because Google could not collect a payment. Update your payment method in Google Play instead of subscribing again.";
    if (play?.paused === true && play.testPurchase !== true)
      return "Your Strata+ subscription through Google Play is paused. Resume it in Google Play instead of subscribing again.";
    return "";
  }

  // How each store sells Strata+: what to ask it for, what STRATA needs to see a purchase, and what to call things.
  const STORES = Object.freeze({
    apple: Object.freeze({
      accessType: "apple",
      name: "the App Store",
      label: "App Store",
      account: "Apple Account",
      managePath: MANAGE_PATH,
      request: () => ({ productIds: Object.values(PRODUCT_IDS) }),
      plans: (found) =>
        Object.entries(PRODUCT_IDS).flatMap(([plan, id]) => {
          const product = found.find((item) => item?.id === id);
          return product ? [{ ...product, plan }] : [];
        }),
      purchaseOptions: (product, user) => ({
        productId: product.id,
        appAccountToken: String(user.id),
      }),
      summary: (discovery) => discovery?.apple || null,
      // A test purchase still inside its period that STRATA keeps locked, not one that ran out or was refunded.
      lockedTest: (apple) =>
        apple?.environment === "Sandbox" &&
        !apple.revoked &&
        !(Number(apple.expiresAt) <= Date.now()),
      testText: "This was an App Store test purchase. Test purchases do not unlock Strata+.",
      ended: (apple) =>
        apple.revoked
          ? "Your App Store subscription was refunded or revoked, so Strata+ is off."
          : "Your App Store subscription has ended. Subscribe again whenever you like.",
      pending:
        "Your purchase is waiting for approval. Strata+ unlocks on its own once it is approved.",
      // StoreKit's proof of a purchase: the signed transaction, finished once STRATA accepted it.
      proof: (result) =>
        result?.transactionId && typeof result.signedTransaction === "string"
          ? { items: [result.signedTransaction], id: String(result.transactionId) }
          : null,
      send: (billing, items) => billing.submit(items),
      found: async (native) => (await native.restore())?.signedTransactions || [],
      async finish(native, result) {
        try {
          await native.finishTransaction({ transactionId: String(result.transactionId) });
        } catch {
          /* StoreKit redelivers it; STRATA accepts it again. */
        }
      },
      terms: (lead) =>
        `${lead} Payment is charged to your Apple Account when you confirm the purchase. The subscription renews automatically unless it is canceled at least 24 hours before the end of the current period, and your Apple Account is charged for the renewal within 24 hours before the period ends. Manage or cancel it anytime in ${MANAGE_PATH}.`,
    }),
    google: Object.freeze({
      accessType: "google",
      name: "Google Play",
      label: "Google Play",
      account: "Google Account",
      managePath: PLAY_MANAGE_PATH,
      request: () => ({ productIds: [PLAY_PRODUCT_ID] }),
      plans: (found) =>
        Object.entries(PLAY_BASE_PLANS).flatMap(([plan, basePlanId]) => {
          const product = found.find(
            (item) => item?.id === PLAY_PRODUCT_ID && item?.basePlanId === basePlanId,
          );
          return product ? [{ ...product, plan }] : [];
        }),
      purchaseOptions: (product, user) => ({
        productId: product.id,
        basePlanId: product.basePlanId,
        accountId: String(user.id),
      }),
      summary: (discovery) => discovery?.googlePlay || null,
      lockedTest: (play) =>
        play?.testPurchase === true &&
        ["ACTIVE", "IN_GRACE_PERIOD", "CANCELED"].includes(play.state) &&
        !(Number(play.expiresAt) <= Date.now()),
      testText: "This was a Google Play test purchase. Test purchases do not unlock Strata+.",
      ended: (play) =>
        play.onHold
          ? "Google Play could not collect your payment, so Strata+ is on hold. Update your payment method in Google Play to restore it."
          : play.paused
            ? "Your Google Play subscription is paused. Resume it in Google Play to use Strata+ again."
            : play.pending
              ? "Your Google Play payment is still being processed. Strata+ unlocks on its own once it goes through."
              : "Your Google Play subscription has ended. Subscribe again whenever you like.",
      pending:
        "Your payment is still being processed by Google Play. Strata+ unlocks on its own once it goes through.",
      // Google Play's proof of a purchase: its token, which STRATA checks with Google and acknowledges itself.
      proof: (result) =>
        typeof result?.purchaseToken === "string" && result.purchaseToken
          ? {
              items: [{ purchaseToken: result.purchaseToken, productId: result.productId }],
              id: result.purchaseToken,
            }
          : null,
      send: (billing, items) => billing.submitPlay(items),
      found: async (native) => (await native.restore())?.purchases || [],
      finish: async () => {},
      terms: (lead) =>
        `${lead} Payment is charged to your Google Play account when you confirm the purchase. The subscription renews automatically unless you cancel it before the end of the current period. Manage or cancel it anytime in ${PLAY_MANAGE_PATH}.`,
    }),
  });
  /** The store this app sells through: Google Play on Android, the App Store on iPhone. */
  const storeFor = (platform) => (platform === "android" ? STORES.google : STORES.apple);

  function disclosure(product, store = STORES.apple) {
    const price = product ? `${product.displayPrice} ${periodLabel(product.period)}` : "";
    const every =
      Number(product?.period?.value || 1) === 1 ? RENEWAL[product?.period?.unit] || "" : "";
    return store.terms(
      `Strata+ is an auto-renewing ${every ? `${every} ` : ""}subscription${price ? ` at ${price}` : ""}.`,
    );
  }

  function serverMessage(error, { purchased = false, store = STORES.apple } = {}) {
    const safe = purchased ? " Your payment is safe and you will not be charged twice." : "";
    const code = String(error?.code || "");
    if (code === "SIGN_IN_REQUIRED" || error?.status === 401)
      return `Your STRATA session ended. Sign in again, then choose Restore Purchases.${safe}`;
    if (code === "APPLE_ACCOUNT_MISMATCH" || code === "GOOGLE_PLAY_ACCOUNT_MISMATCH")
      return `This ${store.label} purchase belongs to a different STRATA account. Sign in to the account that bought it, then choose Restore Purchases.${safe}`;
    if (code === "APPLE_PURCHASE_OTHER_ACCOUNT" || code === "GOOGLE_PLAY_PURCHASE_OTHER_ACCOUNT")
      return `This ${store.account}’s Strata+ subscription is already linked to another STRATA account. Sign in to that account to use it.`;
    if (code === "APPLE_FAMILY_SHARED")
      return "Strata+ isn’t shared through Family Sharing. Subscribe with your own Apple Account to unlock it.";
    if (code === "GOOGLE_PLAY_NOT_CONFIGURED" || code === "GOOGLE_PLAY_UNAVAILABLE")
      return `STRATA could not reach Google Play to check this purchase. Choose Restore Purchases in a moment.${safe}`;
    if (code.startsWith("APPLE_") || code.startsWith("GOOGLE_PLAY_"))
      return `STRATA could not verify this ${store.label} purchase. Contact STRATA from Profile so we can help.${safe}`;
    if (error?.code === "NETWORK_ERROR")
      return `Could not reach STRATA. Reconnect, then choose Restore Purchases.${safe}`;
    if (error?.status === 403)
      return `Your session needs refreshing. Leave this screen and come back, then choose Restore Purchases.${safe}`;
    return `STRATA could not confirm the purchase yet. Try Restore Purchases in a moment.${safe}`;
  }

  function storeMessage(error, store = STORES.apple) {
    const name = store.name.replace(/^the /, "The ");
    if (error?.code === "PRODUCT_NOT_FOUND")
      return `Strata+ is not available from ${store.name} right now. Try again later.`;
    if (error?.code === "VERIFICATION_FAILED")
      return `${name} could not verify this purchase, so nothing was unlocked. Try again, or contact STRATA from Profile.`;
    if (error?.code === "PURCHASE_NOT_ALLOWED")
      return "Purchases are turned off on this iPhone (Screen Time › Content & Privacy Restrictions). Ask whoever manages it, then try again.";
    if (error?.code === "PRODUCTS_FAILED")
      return `${name} could not be reached. Check your connection, then try again.`;
    if (error?.code === "BILLING_UNAVAILABLE")
      return "Google Play can’t take payments on this device right now. Check that the Play Store is installed and signed in, then try again.";
    if (error?.code === "ALREADY_OWNED")
      return "This Google Account already has Strata+. Choose Restore Purchases to unlock it here.";
    return `${name} could not complete the purchase. Try again.`;
  }

  // The paywall's behavior without the DOM: every change calls onChange(model) with what to show.
  function createController({
    native = null,
    billing,
    reason = "",
    haptic = () => {},
    onChange = () => {},
    upsell = (value) => globalThis.StrataEntitlements?.upsell?.(value) || "",
    store = storeFor(root.StrataApp?.platform),
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
        store,
        summary: store.summary(model.user?.discovery),
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
        native?.getProducts ? native.getProducts(store.request()) : Promise.resolve(null),
      ]);
      if (account.status === "fulfilled") model.user = account.value.user;
      const found = products.status === "fulfilled" ? products.value?.products || [] : [],
        summary = store.summary(model.user?.discovery);
      model.products = store.plans(found);
      select(model.plan);
      model.phase = "ready";
      if (account.status === "rejected")
        say(
          "STRATA could not check your account. Check your connection, then reopen this screen.",
          "error",
        );
      else if (!native && !ownership(model.user))
        say(`Update STRATA from ${store.name} to subscribe.`, "warn");
      else if (native && !model.product && !ownership(model.user))
        say(
          ["BILLING_UNAVAILABLE", "PRODUCTS_FAILED"].includes(products.reason?.code)
            ? storeMessage(products.reason, store)
            : `Strata+ is not available from ${store.name} right now. Try again later.`,
          "warn",
        );
      else if (summary && !ownership(model.user) && !purchaseBlocked(model.user))
        say(store.lockedTest(summary) ? store.testText : store.ended(summary), "warn");
      else emit();
    }

    // STRATA kept the purchase but it does not unlock Strata+: a TestFlight, App Review, or Play license-tester
    // purchase on an account that is not on the test list, or one STRATA cannot match to an active period yet.
    function lockedMessage(discovery) {
      return store.lockedTest(store.summary(discovery))
        ? store.testText
        : "STRATA saved your purchase, but Strata+ is not on yet. Reopen this screen in a minute, or contact support if it stays locked.";
    }

    /** Welcomes the member only once STRATA says Strata+ is on for this account. */
    async function confirm(result) {
      const proof = store.proof(result);
      if (!proof) {
        say(storeMessage(null, store), "error");
        return "failed";
      }
      say("Confirming your subscription with STRATA…");
      try {
        const { discovery, accepted } = await store.send(billing, proof.items);
        if (!accepted.includes(proof.id))
          throw Object.assign(new Error("Not accepted"), { code: "NOT_ACCEPTED" });
        setDiscovery(discovery);
        await store.finish(native, result);
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
        say(serverMessage(error, { purchased: true, store }), "error");
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
      say(`Opening ${store.name}…`);
      try {
        let result;
        try {
          result = await native.purchase(store.purchaseOptions(model.product, model.user));
        } catch (error) {
          say(storeMessage(error, store), "error");
          return "failed";
        }
        if (result?.status === "cancelled") {
          say("");
          return "cancelled";
        }
        if (result?.status === "pending") {
          say(store.pending, "warn");
          return "pending";
        }
        if (result?.status !== "purchased") {
          say(storeMessage(null, store), "error");
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
      say(`Restoring your ${store.label} purchases…`);
      try {
        let found;
        try {
          found = await store.found(native);
        } catch (error) {
          // The member closed the store's sign-in: nothing went wrong.
          if (error?.code === "RESTORE_CANCELLED") {
            say("");
            return "cancelled";
          }
          say(
            error?.code === "RESTORE_FAILED"
              ? `${store.name.replace(/^the /, "The ")} could not be reached. Check your connection, then try again.`
              : "Restoring did not finish. Try again.",
            "error",
          );
          return "failed";
        }
        if (!found.length) {
          say(`No ${store.label} purchases were found for this ${store.account}.`, "warn");
          return "empty";
        }
        try {
          const { discovery } = await store.send(billing, found);
          setDiscovery(discovery);
        } catch (error) {
          say(serverMessage(error, { store }), "error");
          return "rejected";
        }
        if (ownership(model.user)) {
          haptic("success");
          say("Purchases restored. You have Strata+.", "good");
          await refreshAccount();
          return "restored";
        }
        say(
          store.lockedTest(store.summary(model.user?.discovery))
            ? lockedMessage(model.user.discovery)
            : `No active Strata+ subscription was found on this ${store.account}.`,
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
        say(`Open ${store.managePath} to manage Strata+.`, "warn");
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
      store = view.store || STORES.apple,
      summary = view.summary,
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
      if (owned === store.accessType) {
        const date = formatDate(summary?.expiresAt);
        detail = summary?.inGracePeriod
          ? `There is a billing problem with your ${store.account}. Update your payment method in ${store.managePath} to keep Strata+.`
          : date
            ? summary?.autoRenew === false
              ? `Your ${store.label} subscription ends ${date} and will not renew.`
              : `Your ${store.label} subscription renews ${date}.`
            : `Your ${store.label} subscription is active.`;
        actions = html`${open}<button class="app-button" type="button" data-paywall-action="manage">Manage subscription</button>`;
      } else {
        // Bought elsewhere: it is managed where it was bought.
        detail =
          owned === "paddle"
            ? "Your Strata+ subscription is billed on stratafitness.online."
            : owned === "apple"
              ? "Your Strata+ subscription is billed by the App Store. Manage it on the iPhone or iPad you bought it on."
              : owned === "google"
                ? "Your Strata+ subscription is billed by Google Play. Manage it in the Play Store on your Android phone."
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
    return html`${view.note ? html`<p class="app-paywall-note">${view.note}</p>` : ""}<p class="app-paywall-kicker">Strata+</p><h2 id="appPaywallTitle" tabindex="-1">${owned ? "You have Strata+" : "Unlock Strata+"}</h2>${owned ? "" : price}${detail ? html`<p class="app-paywall-detail">${detail}</p>` : ""}<div class="app-paywall-actions">${actions}${restore}</div>`;
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
      terms.textContent =
        view.owned || !view.nativeAvailable ? "" : disclosure(view.product, view.store);
      if (focused) {
        // A control that went away or is busy (Subscribe after a purchase) hands focus to the heading, not the page.
        const target = body.querySelector(`[data-paywall-action="${focused}"]`);
        (target && !target.disabled ? target : body.querySelector("#appPaywallTitle"))?.focus({
          preventScroll: true,
        });
      } else if (focusedPlan)
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
    PLAY_PRODUCT_ID,
    PLAY_BASE_PLANS,
    STORES,
    storeFor,
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
