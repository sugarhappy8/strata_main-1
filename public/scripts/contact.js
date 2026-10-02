"use strict";

const supportForm = document.getElementById("supportForm");

if (supportForm) {
  const supportStatus = document.getElementById("supportStatus");
  const supportSubmit = document.getElementById("supportSubmit");
  const supportSubmitLabel = document.getElementById("supportSubmitLabel");
  const supportName = document.getElementById("supportName");
  const supportEmail = document.getElementById("supportEmail");
  const supportEmailHelp = document.getElementById("supportEmailHelp");
  const supportFields = [
    ...supportForm.querySelectorAll("input:not([name='website']), select, textarea"),
  ];
  let submitting = false;
  let accountIdentity = null;

  function applyAccountIdentity() {
    if (!accountIdentity) return;
    supportName.value = accountIdentity.name;
    supportEmail.value = accountIdentity.email;
    supportName.readOnly = true;
    supportEmail.readOnly = true;
    supportName.dataset.accountIdentity = "true";
    supportEmail.dataset.accountIdentity = "true";
    if (supportEmailHelp)
      supportEmailHelp.textContent = `Signed in as ${accountIdentity.email}. Replies will go to this registered address.`;
  }

  async function bindSignedInIdentity() {
    try {
      const response = await globalThis.fetch("/api/me", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const data = await response.json();
      const user = data?.user;
      if (!user?.id || !user.name || !user.email) return;
      accountIdentity = { name: String(user.name), email: String(user.email) };
      applyAccountIdentity();
    } catch {
      // The form remains available to signed-out users and during transient account checks.
    }
  }

  function clearFieldState(field) {
    field.removeAttribute("aria-invalid");
  }

  function setStatus(message, state, { focus = false } = {}) {
    supportStatus.textContent = String(message || "");
    supportStatus.classList.remove("support-status-success", "support-status-error");
    if (state) supportStatus.classList.add(`support-status-${state}`);
    supportStatus.setAttribute("role", state === "error" ? "alert" : "status");
    supportStatus.hidden = !message;
    if (message && focus)
      requestAnimationFrame(() => supportStatus.focus({ preventScroll: false }));
  }

  function setSubmitting(value) {
    submitting = value;
    supportSubmit.disabled = value;
    supportForm.setAttribute("aria-busy", value ? "true" : "false");
    supportSubmitLabel.textContent = value ? "Sending…" : "Send request";
  }

  function friendlyError(error) {
    const code = String(error?.code || "").toUpperCase();
    if (code === "SUPPORT_RATE_LIMIT" || error?.status === 429)
      return "Too many support requests were sent. Please wait before trying again, or use the email option.";
    if (code === "SENSITIVE_SUPPORT_CONTENT")
      return "Remove passwords, verification codes, private links, API keys, tokens, and payment-card numbers before sending.";
    if (code === "INVALID_SUPPORT_REQUEST" || error?.status === 400)
      return "Check the required details and try again. The message must contain at least 10 characters.";
    if (
      code === "ORIGIN_REQUIRED" ||
      code === "JSON_REQUIRED" ||
      error?.status === 403 ||
      error?.status === 415
    )
      return "The security check failed. Refresh this page and try again.";
    if (error?.status === 404 || error?.status === 405)
      return "The support form is not available on this deployment. Please use the email option instead.";
    if (error?.code === "NETWORK_ERROR")
      return "STRATA could not be reached. Check your connection and try again, or use the email option.";
    return "Your request could not be sent right now. Nothing was lost from your account; please try again or use the email option.";
  }

  async function responseJson(response) {
    let data = null;
    try {
      data = await response.json();
    } catch {}
    if (!response.ok) {
      throw Object.assign(new Error("Support request failed."), {
        status: Number(response.status) || 500,
        code: typeof data?.code === "string" ? data.code : "SUPPORT_REQUEST_FAILED",
      });
    }
    if (!data || data.ok !== true || data.accepted !== true || typeof data.reference !== "string") {
      throw Object.assign(new Error("Unexpected support response."), {
        status: 502,
        code: "INVALID_RESPONSE",
      });
    }
    return data;
  }

  supportForm.addEventListener(
    "invalid",
    (event) => {
      event.target?.setAttribute?.("aria-invalid", "true");
    },
    true,
  );

  supportFields.forEach((field) => {
    field.addEventListener("input", () => {
      clearFieldState(field);
      if (!supportStatus.hidden) setStatus("", "");
    });
    field.addEventListener("change", () => clearFieldState(field));
  });

  // A post made without JavaScript comes back here with its outcome in the query string.
  {
    const params = new URLSearchParams(location.search),
      sent = String(params.get("sent") || "")
        .trim()
        .slice(0, 40),
      error = String(params.get("error") || "")
        .trim()
        .slice(0, 40);
    if (sent)
      setStatus(
        `Your support request was sent. Reference: ${sent}. Keep this number for follow-up.`,
        "success",
        { focus: true },
      );
    else if (error)
      setStatus(
        friendlyError({ code: error, status: error === "SUPPORT_RATE_LIMIT" ? 429 : 400 }),
        "error",
        { focus: true },
      );
    if (sent || error) history.replaceState(null, "", location.pathname);
  }

  supportForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!supportForm.checkValidity()) {
      supportForm.reportValidity();
      setStatus("Complete the required fields before sending your request.", "error");
      return;
    }

    supportFields.forEach(clearFieldState);
    setStatus("", "");
    const data = new FormData(supportForm);
    const payload = {
      name: String(data.get("name") || "").trim(),
      email: String(data.get("email") || "").trim(),
      category: String(data.get("category") || ""),
      subject: String(data.get("subject") || "").trim(),
      referenceId: String(data.get("referenceId") || "").trim(),
      message: String(data.get("message") || "").trim(),
      website: String(data.get("website") || "").trim(),
    };

    setSubmitting(true);
    try {
      let response;
      try {
        response = await globalThis.fetch("/api/support", {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (cause) {
        throw Object.assign(new Error("Network error."), { code: "NETWORK_ERROR", cause });
      }
      const result = await responseJson(response);
      const reference = result.reference.trim().slice(0, 40);
      supportForm.reset();
      applyAccountIdentity();
      supportFields.forEach(clearFieldState);
      const deliveryNote =
        result.emailSent === false
          ? " It was saved, but the email confirmation may be delayed."
          : " Keep this number for follow-up.";
      setStatus(
        `Your support request was sent. Reference: ${reference}.${deliveryNote}`,
        "success",
        { focus: true },
      );
    } catch (error) {
      setStatus(friendlyError(error), "error", { focus: true });
    } finally {
      setSubmitting(false);
    }
  });

  void bindSignedInIdentity();
}
