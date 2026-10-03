/* global module, require */
(function (root, factory) {
  const logic =
    typeof module === "object" && module.exports
      ? require("./account-logic")
      : root.StrataAccountLogic;
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(logic, StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAccountRender = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (logic, StrataHtml) {
  "use strict";
  const { html } = StrataHtml;

  function createRenderer({
    documentImpl = globalThis.document,
    frame = globalThis.requestAnimationFrame,
    now = () => new Date(),
    app = Boolean(globalThis.StrataApp),
  } = {}) {
    const el = (id) => documentImpl.getElementById(id);

    function clearFormError(authMode) {
      const message = el(`${authMode}Message`);
      message.hidden = true;
      message.textContent = "";
      const fields =
        authMode === "signup"
          ? [el("signupName"), el("signupEmail"), el("signupPassword")]
          : [el("loginEmail"), el("loginPassword")];
      fields.forEach((field) => field.removeAttribute("aria-invalid"));
    }

    function clearAllFormErrors() {
      clearFormError("signup");
      clearFormError("login");
    }

    function setButtonBusy(button, busy, label = "") {
      if (!button) return;
      if (busy) {
        button.dataset.busy = "true";
        if (label) button.setAttribute("aria-label", label);
      } else {
        delete button.dataset.busy;
        button.removeAttribute("aria-label");
      }
    }

    function showFormError(authMode, message, { status, focus = false } = {}) {
      const node = el(`${authMode}Message`);
      node.textContent = message;
      node.hidden = false;
      if (status === 401 && authMode === "login")
        [el("loginEmail"), el("loginPassword")].forEach((field) =>
          field.setAttribute("aria-invalid", "true"),
        );
      if (status === 409 && authMode === "signup")
        el("signupEmail").setAttribute("aria-invalid", "true");
      if (focus) (frame || ((callback) => callback()))(() => node.focus({ preventScroll: false }));
    }

    function showRequestedPanel({ requestedMode, preferredPanel }) {
      if (requestedMode !== "login" && requestedMode !== "signup") return;
      (frame || ((callback) => callback()))(() => {
        preferredPanel.scrollIntoView?.({ block: "start" });
        el(`${requestedMode}Title`).focus({ preventScroll: true });
      });
    }

    function clearPrivateData() {
      const textIds = [
        "accountGreeting",
        "signedInIdentity",
        "accountPlanCount",
        "accountWorkoutDays",
        "accountAccessState",
        "accountAccessDetail",
        "accountMemberSince",
        "accountDiscoveryStatus",
        "accountBillingTitle",
        "accountBillingBadge",
        "accountBillingDetail",
        "accountBillingStatus",
        "accountSessionStatus",
        "accountExportStatus",
        "signedInMessage",
        "accountDiscoveryAction",
        "accountSecurityStatus",
      ];
      for (const id of textIds) el(id).textContent = "";
      el("accountSessionList").textContent = "";
      for (const id of [
        "signedInCard",
        "accountBilling",
        "signedInMessage",
        "accountAdminAction",
        "accountDeleteCancel",
        "accountRevokeOtherSessions",
        "accountManageSubscription",
        "accountUpdatePayment",
        "accountCancelSubscription",
        "accountManageApple",
        "accountBillingWebNote",
        "accountSecurityAppleLink",
      ])
        el(id).hidden = true;
      for (const id of [
        "accountRevokeOtherSessions",
        "accountManageSubscription",
        "accountUpdatePayment",
        "accountCancelSubscription",
        "accountExportData",
        "accountPasswordReset",
        "accountDeleteRequest",
        "accountDeleteCancel",
        "accountLogout",
      ]) {
        const node = el(id);
        node.disabled = false;
        setButtonBusy(node, false);
      }
      el("accountRevokeOtherSessions").disabled = true;
      el("accountSessionList").setAttribute("aria-busy", "false");
      el("signedInCard").setAttribute("aria-busy", "false");
      for (const id of [
        "accountBillingStatus",
        "accountSessionStatus",
        "accountExportStatus",
        "accountSecurityStatus",
      ])
        el(id).classList.remove("bad");
      el("accountDiscoveryAction").href = "/pricing";
      documentImpl.body?.classList.remove("account-signed-in");
    }

    // The tab names the page a visitor sees: Sign in until an account is open, then Profile.
    function showAccess({ message = "", mode, requestedMode, preferredPanel }) {
      documentImpl.title = "Sign in — STRATA";
      clearPrivateData();
      el("accountLoading").hidden = true;
      el("accountAccess").hidden = false;
      el("accountPage").setAttribute("aria-busy", "false");
      if (message) showFormError(mode, message, { focus: true });
      else showRequestedPanel({ requestedMode, preferredPanel });
    }

    // An App Store subscription (bought in the iOS app) is managed by Apple: the app opens Apple's own sheet, and the
    // website links to Apple's subscriptions page and points to the iPhone's Settings. It never offers Paddle's portal.
    // Inside the app, a Paddle subscription is read-only and named as billed on the website, with no link out.
    function renderAppleBilling(apple) {
      const date = Number(apple.expiresAt) > 0 ? logic.billingDate(apple.expiresAt) : "";
      el("accountBillingTitle").textContent = "Strata+ through the App Store";
      el("accountBillingBadge").textContent =
        apple.active !== true
          ? apple.revoked === true
            ? "Revoked"
            : "Ended"
          : apple.inGracePeriod === true
            ? "Billing issue"
            : apple.autoRenew === false
              ? "Canceling"
              : "Active";
      el("accountBillingDetail").textContent =
        apple.active !== true
          ? "This App Store subscription no longer provides Strata+. You can subscribe again in the STRATA app."
          : `Billed to your Apple Account through the App Store. ${apple.inGracePeriod === true ? "Apple could not collect the latest payment; update your payment method to keep Strata+." : apple.autoRenew === false ? (date ? `It ends ${date} and will not renew.` : "It will not renew.") : date ? `It renews ${date} unless cancelled at least 24 hours before.` : "It renews monthly until cancelled."}${app ? "" : " Manage it in Settings › Apple Account › Subscriptions on your iPhone."}`;
      el("accountManageApple").hidden = false;
    }

    function renderAccountBilling(user) {
      const section = el("accountBilling"),
        subscription = logic.subscriptionFor(user),
        grandfathered = logic.grandfatheredAccess(user),
        apple = logic.appleSubscriptionFor(user);
      section.hidden = !subscription && !grandfathered && !apple;
      el("accountBillingStatus").textContent = "";
      el("accountBillingStatus").classList.remove("bad");
      el("accountManageApple").hidden = true;
      el("accountBillingWebNote").hidden = true;
      if (section.hidden) return;
      const manage = el("accountManageSubscription"),
        update = el("accountUpdatePayment"),
        cancel = el("accountCancelSubscription");
      manage.hidden = grandfathered || Boolean(app);
      update.hidden = true;
      cancel.hidden = true;
      if (apple && (!subscription || (apple.active === true && subscription.active !== true))) {
        manage.hidden = true;
        renderAppleBilling(apple);
        return;
      }
      if (grandfathered) {
        el("accountBillingTitle").textContent = "Lifetime access";
        el("accountBillingBadge").textContent = "Grandfathered";
        el("accountBillingDetail").textContent =
          "Your prior lifetime purchase remains active under its original terms. It has no monthly renewal and does not need a subscription.";
        return;
      }
      const status = String(subscription.status || ""),
        scheduled = subscription.scheduledChange;
      el("accountBillingTitle").textContent = "Monthly subscription";
      el("accountBillingBadge").textContent =
        status === "paused"
          ? "Paused"
          : status === "canceled"
            ? "Canceled"
            : subscription.active !== true
              ? "Inactive"
              : scheduled?.action === "cancel"
                ? "Canceling"
                : scheduled?.action === "pause"
                  ? "Pausing"
                  : status === "past_due"
                    ? "Past due"
                    : status.charAt(0).toUpperCase() + status.slice(1);
      if (status === "paused")
        el("accountBillingDetail").textContent = app
          ? "Paid access is inactive while this subscription is paused."
          : "Paid access is inactive while this subscription is paused. Open Paddle to review resumption or cancellation options.";
      else if (status === "canceled")
        el("accountBillingDetail").textContent =
          "This subscription is canceled, paid access is inactive, and there are no future renewals. Your free weekly plan remains available.";
      else if (subscription.active !== true)
        el("accountBillingDetail").textContent = app
          ? "Paid access is inactive because the last verified billing period or scheduled access window has ended."
          : "Paid access is inactive because the last verified billing period or scheduled access window has ended. Open Paddle to review its current state.";
      else if (scheduled?.action === "cancel")
        el("accountBillingDetail").textContent =
          `Cancellation takes effect ${logic.billingDate(scheduled.effectiveAt)}. Access remains available until then, with no renewal afterward.`;
      else if (scheduled?.action === "pause")
        el("accountBillingDetail").textContent =
          `The subscription pauses ${logic.billingDate(scheduled.effectiveAt)}. Access remains available until then and stops when the pause takes effect.`;
      else if (status === "past_due")
        el("accountBillingDetail").textContent = app
          ? "The latest monthly payment could not be collected. Strata+ remains available for now."
          : "Paddle could not collect the latest monthly payment. Update the payment method to avoid losing Strata+ access.";
      else
        el("accountBillingDetail").textContent =
          `Your monthly subscription is active. The next renewal is ${logic.billingDate(subscription.currentPeriodEndsAt)} unless you cancel.`;
      if (app) {
        el("accountBillingWebNote").hidden = false;
        return;
      }
      update.hidden = status !== "past_due";
      cancel.hidden = status === "canceled" || scheduled?.action === "cancel";
    }

    // A deletion notice from the server (an App Store subscription keeps billing) carries Apple's subscriptions link.
    function showSecurityStatus(message, { error = false, appleLink = "" } = {}) {
      const status = el("accountSecurityStatus"),
        link = el("accountSecurityAppleLink");
      status.textContent = message;
      status.classList.remove("bad");
      if (error) status.classList.add("bad");
      link.hidden = !appleLink;
      if (appleLink) link.href = appleLink;
    }

    function showSignedIn(user) {
      documentImpl.title = "Profile — STRATA";
      documentImpl.body?.classList.add("account-signed-in");
      el("accountLoading").hidden = true;
      el("accountAccess").hidden = true;
      el("signedInCard").hidden = false;
      el("signedInCard").setAttribute("aria-busy", "false");
      el("signedInIdentity").textContent = `${user.name} · ${user.email}`;
      const firstName =
          String(user?.name || "")
            .trim()
            .split(/\s+/)[0] || "there",
        hour = now().getHours();
      el("accountGreeting").textContent =
        `Good ${hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}, ${firstName}`;
      const planCount = Math.max(0, Number(user?.planCount) || 0),
        workoutDays = Math.max(0, Number(user?.workoutDays) || 0);
      el("accountPlanCount").textContent = String(planCount);
      el("accountWorkoutDays").textContent = String(workoutDays);
      const createdAt = Number(user?.createdAt),
        createdDate = Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt) : null;
      el("accountMemberSince").textContent =
        createdDate && !Number.isNaN(createdDate.getTime())
          ? new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(
              createdDate,
            )
          : "Member";
      el("accountAdminAction").hidden = user?.isAdmin !== true;
      const discoveryActive = logic.hasPlus(user);
      el("accountSetupAction").hidden = !discoveryActive;
      el("accountNutritionAction").hidden = !discoveryActive;
      const discoveryPending = Number(user?.discovery?.pendingPurchaseCount || 0) > 0,
        subscription = logic.subscriptionFor(user),
        access = logic.accountAccessSummary(user, discoveryPending, { app });
      const discoveryAction = el("accountDiscoveryAction"),
        managedInactive =
          Boolean(subscription) && !discoveryActive && subscription?.status !== "canceled";
      discoveryAction.href = discoveryActive
        ? "/discover.html"
        : managedInactive
          ? "#accountBilling"
          : "/pricing";
      discoveryAction.textContent = discoveryActive
        ? "Open Strata+ studio →"
        : managedInactive
          ? "Manage Strata+ billing →"
          : subscription?.status === "canceled"
            ? "Restart Strata+ →"
            : discoveryPending
              ? "Check Strata+ subscription →"
              : "Unlock Strata+ →";
      el("accountDiscoveryStatus").textContent = access.message;
      el("accountAccessState").textContent = access.state;
      el("accountAccessDetail").textContent = access.detail;
      renderAccountBilling(user);
      const methods = logic.signInMethodsText(user);
      el("accountSignInMethods").textContent = methods;
      el("accountSignInMethods").hidden = !methods;
      const reset = el("accountPasswordReset").querySelector(".button-idle");
      if (reset)
        reset.textContent = logic.hasPassword(user)
          ? "Email password-reset link"
          : "Email a link to set a password";
      const deletionPending = user?.accountDeletion?.pending === true;
      el("accountDeleteCancel").hidden = !deletionPending;
      showSecurityStatus(
        deletionPending
          ? "An account-deletion confirmation is pending. You can use the emailed link or cancel the request here."
          : "",
      );
      el("accountPage").setAttribute("aria-busy", "false");
    }

    function showChangedAccount() {
      clearPrivateData();
      el("accountAccess").hidden = true;
      el("accountLoading").hidden = false;
      el("accountLoadingTitle").textContent = "Account access changed.";
      el("accountLoadingMessage").textContent =
        "The signed-in account or its security boundary changed. Reload to open the current account without mixing private training data.";
      el("accountReload").hidden = false;
      el("accountPage").setAttribute("aria-busy", "false");
    }

    function showAccountControlStatus(id, message, { error = false, focus = false } = {}) {
      const status = el(id);
      status.textContent = message;
      status.classList.remove("bad");
      if (error) status.classList.add("bad");
      if (focus) status.focus({ preventScroll: false });
    }

    function renderAccountSessions(sessions) {
      const list = el("accountSessionList"),
        others = sessions.filter((session) => session?.current !== true);
      StrataHtml.setHtml(
        list,
        sessions.length
          ? sessions.map((session) => {
              const current = session?.current === true,
                created = logic.sessionDate(session?.createdAt);
              return html`<li><div><strong>${current ? "This session" : "Other session"}</strong><small>Signed in ${created} · Expires ${logic.sessionDate(session?.expiresAt)}</small></div>${current ? html`<span class="account-current-session">Current</span>` : html`<button type="button" data-revoke-session="${session?.id || ""}" aria-label="Sign out session created ${created}">Sign out</button>`}</li>`;
            })
          : html`<li class="account-session-loading">No active sessions were found. Refresh this page before making account changes.</li>`,
      );
      list.setAttribute("aria-busy", "false");
      const revokeAll = el("accountRevokeOtherSessions");
      revokeAll.disabled = others.length === 0;
      revokeAll.hidden = others.length === 0;
    }

    function showSessionLoading() {
      const list = el("accountSessionList");
      list.setAttribute("aria-busy", "true");
      StrataHtml.setHtml(
        list,
        html`<li class="account-session-loading">Checking active sessions…</li>`,
      );
      el("accountRevokeOtherSessions").disabled = true;
    }
    function showSessionError() {
      const list = el("accountSessionList");
      list.setAttribute("aria-busy", "false");
      StrataHtml.setHtml(
        list,
        html`<li class="account-session-loading">Active sessions could not be loaded. Nothing was changed.</li>`,
      );
      showAccountControlStatus(
        "accountSessionStatus",
        "Could not load signed-in sessions. Refresh to try again.",
        { error: true },
      );
    }
    function showInitialLoading() {
      el("accountPage").setAttribute("aria-busy", "true");
      el("accountAccess").hidden = true;
      el("signedInCard").hidden = true;
      el("accountLoading").hidden = false;
      el("accountLoadingTitle").textContent = "CHECKING YOUR ACCOUNT…";
      el("accountLoadingMessage").textContent = "Confirming whether you are already signed in.";
      el("accountReload").hidden = true;
    }

    return {
      el,
      clearFormError,
      clearAllFormErrors,
      clearPrivateData,
      setButtonBusy,
      showFormError,
      showAccess,
      renderAccountBilling,
      showSecurityStatus,
      showSignedIn,
      showChangedAccount,
      showAccountControlStatus,
      renderAccountSessions,
      showSessionLoading,
      showSessionError,
      showInitialLoading,
    };
  }

  return { createRenderer };
});
