"use strict";

const { createHmac, randomInt, timingSafeEqual } = require("node:crypto");

const RESEND_API_BASE = "https://api.resend.com";
const secretsByConfig = new WeakMap();

function clean(value, max = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function normalizedEmail(value) {
  return clean(value, 254).toLowerCase();
}

function mailboxAddress(value) {
  const mailbox = clean(value, 320);
  if (!mailbox || /[\r\n]/.test(mailbox)) return "";
  const bracketed = mailbox.match(/^[^<>]{1,100}<([^<>]+)>$/);
  const address = clean(bracketed ? bracketed[1] : mailbox, 254).toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) ? address : "";
}

function validAppBaseUrl(value, nodeEnv) {
  try {
    const url = new URL(clean(value, 2048));
    const localHttp =
      nodeEnv !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) return "";
    if (url.username || url.password || url.search || url.hash) return "";
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function timeoutSignal(milliseconds) {
  return typeof globalThis.AbortSignal?.timeout === "function"
    ? globalThis.AbortSignal.timeout(milliseconds)
    : undefined;
}

function placeholderCredential(value) {
  return /replace[-_ ]?with|replace-with|<[^>]+>|your[-_ ]?(?:private|secret|key)/i.test(
    String(value || ""),
  );
}

function validResendApiKey(value) {
  const apiKey = clean(value, 1000);
  return apiKey.startsWith("re_") && apiKey.length >= 20 && !placeholderCredential(apiKey);
}

function validEmailVerificationSecret(value) {
  const secret = clean(value, 4096);
  return secret.length >= 32 && !placeholderCredential(secret);
}

function directSignupAllowed(
  config,
  nodeEnv = process.env.NODE_ENV,
  explicitTestOverride = process.env.ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS,
) {
  const runtime = clean(nodeEnv, 40).toLowerCase();
  const allowed = clean(explicitTestOverride, 20).toLowerCase() === "true";
  return runtime === "test" && allowed && config?.requestedEnabled !== true;
}

function getEmailVerificationConfig(env = process.env) {
  const flagValue = clean(env.EMAIL_VERIFICATION_ENABLED, 20).toLowerCase();
  const requestedEnabled = flagValue === "true";
  const flagValid = flagValue === "true" || flagValue === "false";
  const apiKey = clean(env.RESEND_API_KEY, 1000);
  const from = clean(env.EMAIL_FROM, 320);
  const replyTo = clean(env.EMAIL_REPLY_TO, 320);
  const supportEmail = clean(env.SUPPORT_EMAIL || env.EMAIL_REPLY_TO, 320);
  const verificationSecret = clean(env.EMAIL_VERIFICATION_SECRET, 4096);
  const appBaseUrl = validAppBaseUrl(env.APP_BASE_URL, clean(env.NODE_ENV, 40));
  const validApiKey = validResendApiKey(apiKey);
  const validFrom = Boolean(mailboxAddress(from));
  const validReplyTo = !replyTo || Boolean(mailboxAddress(replyTo));
  const validSupportEmail = !supportEmail || Boolean(mailboxAddress(supportEmail));
  const validSecret = validEmailVerificationSecret(verificationSecret);
  const validBaseUrl = Boolean(appBaseUrl);
  const credentialsValid = validApiKey && validFrom && validReplyTo && validSecret && validBaseUrl;
  const missing = [];
  if (requestedEnabled) {
    if (!validApiKey) missing.push("Resend API key");
    if (!validFrom) missing.push("valid sender address");
    if (!validReplyTo) missing.push("valid reply-to address");
    if (!validSecret) missing.push("verification secret of at least 32 characters");
    if (!validBaseUrl) missing.push("valid HTTPS application URL");
  }

  // Only browser-safe operational fields are enumerable. The API key and
  // verification secret are retained privately so accidental JSON encoding
  // cannot disclose either credential.
  const config = Object.freeze({
    requestedEnabled,
    flagValid,
    configured: credentialsValid,
    deliveryConfigured: credentialsValid,
    secretConfigured: validSecret,
    enabled: requestedEnabled && credentialsValid,
    from: validFrom ? from : "",
    replyTo: validReplyTo ? replyTo : "",
    supportEmail: validSupportEmail ? supportEmail : "",
    appBaseUrl: validBaseUrl ? appBaseUrl : "",
    missing: Object.freeze(missing),
  });
  let apiBase = RESEND_API_BASE;
  if (env.NODE_ENV === "test" && validAppBaseUrl(env.RESEND_API_BASE, "test"))
    apiBase = validAppBaseUrl(env.RESEND_API_BASE, "test");
  secretsByConfig.set(config, { apiKey, verificationSecret, apiBase });
  return config;
}

function requireVerificationSecret(config) {
  const secret = secretsByConfig.get(config)?.verificationSecret || "";
  if (secret.length < 32)
    throw Object.assign(new Error("Email verification is not configured."), {
      status: 503,
      code: "EMAIL_VERIFICATION_UNAVAILABLE",
    });
  return secret;
}

function digestParts(secret, purpose, parts) {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${purpose}\0`);
  for (const part of parts) {
    const value = String(part);
    hmac.update(`${Buffer.byteLength(value, "utf8")}:`);
    hmac.update(value);
    hmac.update("\0");
  }
  return hmac.digest("hex");
}

function verificationCodeDigest(config, { challengeId, generation, email, code }) {
  const normalized = normalizedEmail(email);
  const numericGeneration = Number(generation);
  if (
    !challengeId ||
    !Number.isSafeInteger(numericGeneration) ||
    numericGeneration < 1 ||
    !normalized ||
    !/^\d{6}$/.test(String(code || ""))
  ) {
    throw new TypeError("Invalid verification digest input.");
  }
  return digestParts(requireVerificationSecret(config), "verification-code-v1", [
    challengeId,
    numericGeneration,
    normalized,
    String(code),
  ]);
}

function verificationEmailHash(config, email) {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new TypeError("Invalid verification email.");
  return digestParts(requireVerificationSecret(config), "verification-email-v1", [normalized]);
}

function safeDigestEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function generateVerificationCode(randomIntImpl = randomInt) {
  const value = randomIntImpl(0, 1_000_000);
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000_000)
    throw new Error("Secure verification code generation failed.");
  return String(value).padStart(6, "0");
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

// Shows enough of an address for a member to recognize it without exposing it in full.
function maskEmail(value) {
  const email = normalizedEmail(value),
    separator = email.lastIndexOf("@");
  if (separator < 1) return "your email address";
  const local = email.slice(0, separator),
    domain = email.slice(separator + 1);
  const masked =
    local.length === 1
      ? "*"
      : local.length === 2
        ? `${local[0]}*`
        : `${local[0]}${"*".repeat(Math.min(6, local.length - 2))}${local.at(-1)}`;
  return `${masked}@${domain}`;
}

async function sendVerificationEmail(config, message, fetchImpl = globalThis.fetch) {
  const secrets = secretsByConfig.get(config);
  if (!config?.enabled || !config.configured || !secrets?.apiKey) {
    throw Object.assign(new Error("Email verification is not available yet."), {
      status: 503,
      code: "EMAIL_VERIFICATION_UNAVAILABLE",
    });
  }
  const to = normalizedEmail(message?.to);
  const code = String(message?.code || "");
  const challengeId = clean(message?.challengeId, 200);
  const generation = Number(message?.generation);
  const name = clean(message?.name, 80) || "there";
  const purpose = message?.purpose === "login" ? "login" : "signup";
  const expiresInMinutes = Math.max(
    1,
    Math.min(30, Math.ceil(Number(message?.expiresInMinutes) || 10)),
  );
  if (
    !mailboxAddress(to) ||
    !/^\d{6}$/.test(code) ||
    !challengeId ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new TypeError("Invalid verification email input.");
  }

  const verificationUrl = `${config.appBaseUrl}/verify-email`;
  const subject =
    purpose === "login" ? "Verify your STRATA sign-in" : "Your STRATA verification code";
  const action = purpose === "login" ? "sign-in" : "account verification";
  const text = [
    `Hi ${name},`,
    "",
    `Your STRATA ${action} code is ${code}.`,
    `It expires in ${expiresInMinutes} minutes.`,
    "",
    `Return to the STRATA app or the browser where you started ${purpose === "login" ? "signing in" : "signup"} and enter this code. If you did not request this, you can ignore this email.`,
    verificationUrl,
  ].join("\n");
  const heading = purpose === "login" ? "Verify your STRATA sign-in" : "Verify your STRATA email";
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f2ec;color:#10110f;font-family:Arial,sans-serif"><main style="max-width:560px;margin:auto;background:#fff;padding:32px;border:1px solid #bbb"><p>Hi ${escapeHtml(name)},</p><h1 style="font-size:24px">${heading}</h1><p>Your six-digit verification code is:</p><p style="font-size:36px;font-weight:700;letter-spacing:8px">${escapeHtml(code)}</p><p>It expires in ${expiresInMinutes} minutes.</p><p>Enter it in the STRATA app or on the STRATA verification page where you started. If you did not request this, you can ignore this email.</p><p><a href="${escapeHtml(verificationUrl)}">Open email verification</a></p></main></body></html>`;
  const idempotencyDigest = digestParts(
    requireVerificationSecret(config),
    "verification-delivery-v1",
    [challengeId, generation],
  );
  const body = { from: config.from, to: [to], subject, text, html };
  if (config.replyTo) body.reply_to = config.replyTo;

  let response;
  try {
    response = await fetchImpl(`${secrets.apiBase}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secrets.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `strata-${idempotencyDigest}`,
      },
      signal: timeoutSignal(10_000),
      body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("The verification email could not be sent. Please try again."), {
      status: 502,
      code: "EMAIL_DELIVERY_UNAVAILABLE",
    });
  }
  if (!response?.ok) {
    throw Object.assign(new Error("The verification email could not be sent. Please try again."), {
      status: 502,
      code: "EMAIL_DELIVERY_FAILED",
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { messageId: clean(payload?.id, 200) };
}

async function sendAccountActionEmail(config, message, fetchImpl = globalThis.fetch) {
  const secrets = secretsByConfig.get(config);
  if (!config?.enabled || !config.configured || !secrets?.apiKey) {
    throw Object.assign(new Error("Account email is not available yet."), {
      status: 503,
      code: "ACCOUNT_EMAIL_UNAVAILABLE",
    });
  }
  const to = normalizedEmail(message?.to);
  const name = clean(message?.name, 80) || "there";
  const token = clean(message?.token, 200);
  const requestId = clean(message?.requestId, 200);
  const purpose = message?.purpose === "account_delete" ? "account_delete" : "password_reset";
  const expiresInMinutes = Math.max(
    1,
    Math.min(60, Math.ceil(Number(message?.expiresInMinutes) || 30)),
  );
  if (!mailboxAddress(to) || !/^[A-Za-z0-9_-]{43}$/.test(token) || !requestId) {
    throw new TypeError("Invalid account-action email input.");
  }

  const isDeletion = purpose === "account_delete";
  const page = isDeletion ? "delete-account" : "reset-password";
  // The bearer token is kept in the URL fragment. Fragments are not sent in
  // HTTP requests or Referer headers, so Render and third-party assets never
  // receive the raw recovery credential.
  const actionUrl = `${config.appBaseUrl}/${page}#token=${encodeURIComponent(token)}`;
  const subject = isDeletion
    ? "Confirm deletion of your STRATA account"
    : "Reset your STRATA password";
  const heading = isDeletion ? "Confirm account deletion" : "Reset your password";
  const actionText = isDeletion
    ? "Open the secure page below, review what will be erased, and type DELETE. Merely opening this email will not delete anything."
    : "Open the secure page below and choose a new password. Completing the reset signs your account out on every device.";
  const ignoreText = isDeletion
    ? "If you did not request account deletion, ignore this email and your account will remain unchanged."
    : "If you did not request a password reset, ignore this email and your password will remain unchanged.";
  const buttonText = isDeletion ? "Review account deletion" : "Reset password";
  // Apple bills an in-app subscription until the member cancels it with Apple; deleting STRATA does not stop it.
  const appleText =
    isDeletion && message?.appleSubscription === true
      ? "Your Strata+ subscription was bought through Apple. Deleting your STRATA account does not cancel it: Apple keeps billing your Apple Account until you cancel it in Settings › Apple Account › Subscriptions (https://apps.apple.com/account/subscriptions)."
      : "";
  // Google Play does the same for a subscription bought in the Android app.
  const googlePlayText =
    isDeletion && message?.googlePlaySubscription === true
      ? "Your Strata+ subscription was bought through Google Play. Deleting your STRATA account does not cancel it: Google keeps billing your Google Account until you cancel it in Google Play › Payments & subscriptions › Subscriptions (https://play.google.com/store/account/subscriptions)."
      : "";
  const text = [
    `Hi ${name},`,
    "",
    actionText,
    ...(appleText ? ["", appleText] : []),
    ...(googlePlayText ? ["", googlePlayText] : []),
    `This link expires in ${expiresInMinutes} minutes and works once.`,
    "",
    actionUrl,
    "",
    ignoreText,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f2ec;color:#10110f;font-family:Arial,sans-serif"><main style="max-width:560px;margin:auto;background:#fff;padding:32px;border:1px solid #bbb"><p>Hi ${escapeHtml(name)},</p><h1 style="font-size:24px">${heading}</h1><p>${escapeHtml(actionText)}</p>${appleText ? `<p>${escapeHtml(appleText)}</p>` : ""}${googlePlayText ? `<p>${escapeHtml(googlePlayText)}</p>` : ""}<p>This link expires in ${expiresInMinutes} minutes and works once.</p><p style="margin:28px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:14px 20px;background:#10110f;color:#fff;text-decoration:none;font-weight:700">${buttonText}</a></p><p>${escapeHtml(ignoreText)}</p></main></body></html>`;
  const idempotencyDigest = digestParts(
    requireVerificationSecret(config),
    "account-action-delivery-v1",
    [requestId, purpose],
  );
  const body = { from: config.from, to: [to], subject, text, html };
  if (config.replyTo) body.reply_to = config.replyTo;

  let response;
  try {
    response = await fetchImpl(`${secrets.apiBase}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secrets.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `strata-action-${idempotencyDigest}`,
      },
      signal: timeoutSignal(10_000),
      body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("The account email could not be sent. Please try again."), {
      status: 502,
      code: "ACCOUNT_EMAIL_DELIVERY_UNAVAILABLE",
    });
  }
  if (!response?.ok) {
    throw Object.assign(new Error("The account email could not be sent. Please try again."), {
      status: 502,
      code: "ACCOUNT_EMAIL_DELIVERY_FAILED",
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { messageId: clean(payload?.id, 200) };
}

async function sendSupportEmail(config, message, fetchImpl = globalThis.fetch) {
  const secrets = secretsByConfig.get(config);
  if (!config?.enabled || !config.configured || !secrets?.apiKey) {
    throw Object.assign(new Error("Support email is not available yet."), {
      status: 503,
      code: "SUPPORT_EMAIL_UNAVAILABLE",
    });
  }
  const to = normalizedEmail(message?.to);
  const reference = clean(message?.reference, 40);
  const subject = clean(message?.subject, 120);
  const text = clean(message?.text, 6000);
  const html = String(message?.html || "").slice(0, 20_000);
  const purpose = clean(message?.purpose, 40);
  const replyTo = clean(message?.replyTo || config.replyTo, 320);
  if (
    !mailboxAddress(to) ||
    !/^STR-[0-9]{4}-[A-Z0-9]{6}$/.test(reference) ||
    !subject ||
    !text ||
    !html ||
    !purpose ||
    (replyTo && !mailboxAddress(replyTo))
  ) {
    throw new TypeError("Invalid support email input.");
  }
  const idempotencyDigest = digestParts(requireVerificationSecret(config), "support-delivery-v1", [
    reference,
    purpose,
    to,
  ]);
  const body = { from: config.from, to: [to], subject, text, html };
  if (replyTo) body.reply_to = replyTo;
  let response;
  try {
    response = await fetchImpl(`${secrets.apiBase}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secrets.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `strata-support-${idempotencyDigest}`,
      },
      signal: timeoutSignal(10_000),
      body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("The support email could not be sent."), {
      status: 502,
      code: "SUPPORT_EMAIL_DELIVERY_UNAVAILABLE",
    });
  }
  if (!response?.ok) {
    throw Object.assign(new Error("The support email could not be sent."), {
      status: 502,
      code: "SUPPORT_EMAIL_DELIVERY_FAILED",
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { messageId: clean(payload?.id, 200) };
}

function supportEmailContent(kind, ticket, responseText = "", appBaseUrl = "") {
  const name = clean(ticket?.name, 80) || "there";
  const reference = clean(ticket?.reference, 40);
  const subject = clean(ticket?.subject, 100);
  const category = clean(ticket?.category, 40);
  if (kind === "notification") {
    const adminUrl = `${clean(appBaseUrl, 2048)}/admin#support`;
    const text = [
      `New STRATA support request ${reference}`,
      `From: ${name} <${normalizedEmail(ticket?.email)}>`,
      `Category: ${category}`,
      `Subject: ${subject}`,
      ticket?.referenceId ? `Customer reference: ${clean(ticket.referenceId, 80)}` : "",
      "",
      "Open the private STRATA Admin help desk to read and manage the message.",
      adminUrl,
    ]
      .filter(Boolean)
      .join("\n");
    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f2ec;color:#10110f;font-family:Arial,sans-serif"><main style="max-width:620px;margin:auto;background:#fff;padding:32px;border:1px solid #bbb"><p>New STRATA support request</p><h1 style="font-size:24px">${escapeHtml(reference)}</h1><p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(normalizedEmail(ticket?.email))}&gt;<br><strong>Category:</strong> ${escapeHtml(category)}<br><strong>Subject:</strong> ${escapeHtml(subject)}</p><p><a href="${escapeHtml(adminUrl)}">Open the private STRATA Admin help desk</a> to read and manage the message.</p></main></body></html>`;
    return { subject: `[${reference}] ${subject}`, text, html };
  }
  if (kind === "response") {
    const response = clean(responseText, 2000);
    const text = [
      `Hi ${name},`,
      "",
      response,
      "",
      `Support reference: ${reference}`,
      "Reply to this email if you still need help.",
    ].join("\n");
    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f2ec;color:#10110f;font-family:Arial,sans-serif"><main style="max-width:560px;margin:auto;background:#fff;padding:32px;border:1px solid #bbb"><p>Hi ${escapeHtml(name)},</p><p style="white-space:pre-wrap">${escapeHtml(response)}</p><p><strong>Support reference:</strong> ${escapeHtml(reference)}</p><p>Reply to this email if you still need help.</p></main></body></html>`;
    return { subject: `Re: [${reference}] ${subject}`, text, html };
  }
  const text = [
    `Hi ${name},`,
    "",
    `We received your STRATA support request about “${subject}”.`,
    `Your reference is ${reference}.`,
    "",
    `Reply to this email if you need to add information. Never send passwords, verification codes, recovery links, or payment-card details.`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f2ec;color:#10110f;font-family:Arial,sans-serif"><main style="max-width:560px;margin:auto;background:#fff;padding:32px;border:1px solid #bbb"><p>Hi ${escapeHtml(name)},</p><h1 style="font-size:24px">We received your request</h1><p>Your STRATA support reference is <strong>${escapeHtml(reference)}</strong>.</p><p>Reply to this email if you need to add information. Never send passwords, verification codes, recovery links, or payment-card details.</p></main></body></html>`;
  return { subject: `STRATA support received — ${reference}`, text, html };
}

async function sendSupportAcknowledgment(config, ticket, fetchImpl = globalThis.fetch) {
  return sendSupportEmail(
    config,
    {
      to: ticket.email,
      reference: ticket.reference,
      purpose: "acknowledgment",
      ...supportEmailContent("acknowledgment", ticket),
    },
    fetchImpl,
  );
}

async function sendSupportNotification(config, ticket, fetchImpl = globalThis.fetch) {
  if (!config?.supportEmail) return { messageId: "" };
  return sendSupportEmail(
    config,
    {
      to: config.supportEmail,
      replyTo: ticket.email,
      reference: ticket.reference,
      purpose: "notification",
      ...supportEmailContent("notification", ticket, "", config.appBaseUrl),
    },
    fetchImpl,
  );
}

async function sendSupportResponse(config, ticket, response, fetchImpl = globalThis.fetch) {
  const responseDigest = digestParts(requireVerificationSecret(config), "support-response-v1", [
    ticket.reference,
    response,
  ]).slice(0, 12);
  return sendSupportEmail(
    config,
    {
      to: ticket.email,
      reference: ticket.reference,
      purpose: `response-${Number(ticket.updated_at) || 0}-${responseDigest}`,
      ...supportEmailContent("response", ticket, response),
    },
    fetchImpl,
  );
}

module.exports = {
  directSignupAllowed,
  escapeHtml,
  generateVerificationCode,
  getEmailVerificationConfig,
  mailboxAddress,
  maskEmail,
  safeDigestEqual,
  sendAccountActionEmail,
  sendSupportAcknowledgment,
  sendSupportNotification,
  sendSupportResponse,
  sendVerificationEmail,
  verificationCodeDigest,
  verificationEmailHash,
  validAppBaseUrl,
  validEmailVerificationSecret,
  validResendApiKey,
};
