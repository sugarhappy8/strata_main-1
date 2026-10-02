// @ts-check
"use strict";

// Provider-neutral chat client for Strata AI. Groq's OpenAI-compatible API is the default; any compatible
// provider can be configured. It only talks to the configured base URL, always sends the configured key, and
// never lets a slow model hold a request open indefinitely.

const { aiResponseFormat } = require("./ai-response-schema");
const REASONING = /<think>[\s\S]*?<\/think>/gi;
// Gateway timeouts, including Cloudflare's 100-second limit (524), mean the model was too slow.
const TIMEOUT_STATUSES = new Set([408, 504, 522, 524]);
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** @param {string} code @param {string} message @param {number} [status] */
function providerError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}
/** Releases the connection of a response STRATA will not read, such as a rejected JSON mode. @param {Response} response */ function discard(
  response,
) {
  void response.body?.cancel().catch(() => {});
}

/** Removes reasoning blocks some models emit before their answer. @param {unknown} value */
function stripReasoning(value) {
  return String(value ?? "")
    .replace(REASONING, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

/** Reads the first JSON object from a model answer, tolerating code fences and surrounding prose. @param {unknown} value @returns {any} */
function extractJson(value) {
  const text = stripReasoning(value)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the outermost braces */
  }
  const start = text.indexOf("{"),
    end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/** How long a rate-limited model rests: Retry-After in seconds or as a date, bounded to an hour. @param {Response} response @param {number} now */
function retryAfterMs(response, now) {
  const raw = response.headers.get("retry-after");
  if (!raw) return 60000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(3600000, Math.max(1000, seconds * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(3600000, Math.max(1000, date - now)) : 60000;
}

/** STRATA's schema request in the provider's structured-output form. @param {any} responseFormat @param {"schema"|"object"|"plain"} mode */
function structuredFormat(responseFormat, mode) {
  if (mode === "plain") return null;
  if (mode === "object" || !responseFormat?.schema) return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: String(responseFormat.name || "strata_response"),
      strict: true,
      schema: responseFormat.schema,
    },
  };
}

/**
 * Provider-neutral chat client. The primary model answers; when it is rate limited (respecting Retry-After),
 * retired, or overloaded, the fallback model, which has its own quota at the provider, answers instead.
 * @param {{baseUrl?:string,apiKey?:string,model?:string,fallbackModel?:string,timeoutMs?:number,fetchImpl?:typeof fetch,now?:()=>number}} [options]
 */
function createAiProvider({
  baseUrl = "",
  apiKey = "",
  model = "",
  fallbackModel = "",
  timeoutMs = 60000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const base = String(baseUrl || "")
      .trim()
      .replace(/\/+$/, ""),
    primary = String(model || "").trim(),
    fallback = String(fallbackModel || "").trim();
  const models = [primary, ...(fallback && fallback !== primary ? [fallback] : [])],
    key = String(apiKey || "");
  const configured = Boolean(
    /^https?:\/\/[^\s]+$/i.test(base) && primary && (key || base !== GROQ_BASE_URL),
  );
  /** The strongest structured-output mode each model accepted, and when a rate-limited model may be tried again. */
  const modes = /** @type {Map<string,"schema"|"object"|"plain">} */ (new Map()),
    blockedUntil = /** @type {Map<string,number>} */ (new Map());
  /** @returns {Record<string,string>} */
  function headers() {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }
  /** @param {string} path @param {RequestInit} init @param {number} ms */
  async function send(path, init, ms) {
    if (!configured)
      throw providerError("AI_NOT_CONFIGURED", "Strata AI is not set up on this server yet.");
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        headers: headers(),
        signal: AbortSignal.timeout(ms),
      });
    } catch (error) {
      const timedOut = /** @type {Error} */ (error)?.name === "TimeoutError";
      throw providerError(
        timedOut ? "AI_TIMEOUT" : "AI_OFFLINE",
        timedOut
          ? "Strata AI took too long to answer. Try a shorter request."
          : "Strata AI is offline right now. Try again soon.",
      );
    }
  }
  /** @param {Response} response */
  function assertOk(response) {
    if (!response.ok) discard(response);
    if (response.status === 401 || response.status === 403)
      throw providerError(
        "AI_AUTH",
        "Strata AI refused this server's key. The owner needs to check the AI settings.",
      );
    if (TIMEOUT_STATUSES.has(response.status))
      throw providerError(
        "AI_TIMEOUT",
        "Strata AI took too long to answer. Try a shorter request.",
      );
    if (response.status === 400 || response.status === 413)
      throw providerError(
        "AI_TOO_LARGE",
        "Strata AI could not take a request that large. Start a new conversation or ask something shorter.",
        502,
      );
    if (!response.ok)
      throw providerError("AI_UNAVAILABLE", "Strata AI is unavailable right now. Try again soon.");
  }
  /** Lists the provider's models so the owner can see whether both configured models are still offered. */
  async function health() {
    const response = await send("/models", { method: "GET" }, 8000);
    assertOk(response);
    const body = await response.json().catch(() => null),
      ids = Array.isArray(body?.data)
        ? body.data.map((/** @type {any} */ item) => String(item?.id ?? ""))
        : [];
    return {
      ok: true,
      modelListed: ids.includes(primary),
      fallbackListed: fallback ? ids.includes(fallback) : null,
    };
  }
  /** One model, starting from the strongest structured-output mode it has accepted. @param {string} name @param {any} request */
  async function attempt(
    name,
    { messages, maxTokens, temperature, responseFormat, reasoningEffort },
  ) {
    const body = {
      model: name,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };
    const post = (/** @type {"schema"|"object"|"plain"} */ mode) => {
      const format = structuredFormat(responseFormat, mode);
      return send(
        "/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(format ? { ...body, response_format: format } : body),
        },
        timeoutMs,
      );
    };
    let mode = modes.get(name) || "schema",
      response = await post(mode);
    // A provider that rejects a strict schema still gets JSON mode, then plain text; STRATA validates every answer itself.
    while (response.status === 400 && mode !== "plain") {
      discard(response);
      mode = mode === "schema" ? "object" : "plain";
      response = await post(mode);
      if (response.ok) modes.set(name, mode);
    }
    return response;
  }
  /** @param {{messages:Array<{role:string,content:string}>,maxTokens?:number,temperature?:number,responseFormat?:any,reasoningEffort?:string|null}} request */
  async function complete({
    messages,
    maxTokens = 1100,
    temperature = 0.3,
    responseFormat = aiResponseFormat(),
    reasoningEffort = null,
  }) {
    let retryAt = 0;
    for (const [index, name] of models.entries()) {
      const blocked = blockedUntil.get(name) || 0;
      if (blocked > now()) {
        retryAt = retryAt ? Math.min(retryAt, blocked) : blocked;
        continue;
      }
      const response = await attempt(name, {
          messages,
          maxTokens,
          temperature,
          responseFormat,
          reasoningEffort,
        }),
        last = index === models.length - 1;
      if (response.status === 429) {
        discard(response);
        const until = now() + retryAfterMs(response, now());
        blockedUntil.set(name, until);
        retryAt = retryAt ? Math.min(retryAt, until) : until;
        continue;
      }
      if (!last && (response.status === 404 || response.status === 503)) {
        discard(response);
        continue;
      }
      assertOk(response);
      const payload = await response.json().catch(() => null),
        choice = payload?.choices?.[0],
        content = choice?.message?.content,
        usage = payload?.usage;
      if (typeof content !== "string" || !stripReasoning(content))
        throw providerError("AI_EMPTY", "Strata AI returned an empty answer. Try again.", 502);
      return {
        text: stripReasoning(content),
        data: extractJson(content),
        truncated: choice?.finish_reason === "length",
        model: name,
        usage: {
          promptTokens: Number(usage?.prompt_tokens) || 0,
          completionTokens: Number(usage?.completion_tokens) || 0,
          totalTokens: Number(usage?.total_tokens) || 0,
        },
      };
    }
    if (retryAt)
      throw Object.assign(
        providerError("AI_RATE_LIMIT", "Strata AI is resting for a moment. Try again shortly."),
        { retryAt },
      );
    throw providerError("AI_UNAVAILABLE", "Strata AI is unavailable right now. Try again soon.");
  }
  return { configured, model: primary, fallbackModel: fallback || null, complete, health };
}

/**
 * Reads Strata AI settings from the environment. Groq's OpenAI-compatible API is the default provider;
 * STRATA_AI_BASE_URL swaps in any compatible provider. Models are always configured, never hard-coded.
 * In production a plain-HTTP address other than this machine is refused so the key never travels unencrypted.
 * @param {Record<string,string|undefined>} env
 */
function aiSettings(env) {
  const number = (
    /** @type {string|undefined} */ value,
    /** @type {number} */ fallback,
    /** @type {number} */ min,
    /** @type {number} */ max,
  ) => {
    const parsed = Number(value);
    return value !== undefined &&
      value !== "" &&
      Number.isFinite(parsed) &&
      parsed >= min &&
      parsed <= max
      ? Math.floor(parsed)
      : fallback;
  };
  const share = Number(env.STRATA_AI_BRIEF_SHARE),
    briefShare =
      env.STRATA_AI_BRIEF_SHARE !== undefined &&
      env.STRATA_AI_BRIEF_SHARE !== "" &&
      Number.isFinite(share) &&
      share >= 0 &&
      share <= 0.9
        ? share
        : 0.4;
  const base = String(env.STRATA_AI_BASE_URL || GROQ_BASE_URL).trim(),
    local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(base);
  const insecure = env.NODE_ENV === "production" && /^http:\/\//i.test(base) && !local;
  return {
    insecure,
    provider: {
      baseUrl: insecure ? "" : base,
      apiKey: String(env.GROQ_API_KEY || env.STRATA_AI_API_KEY || ""),
      model: String(env.STRATA_AI_MODEL || ""),
      fallbackModel: String(env.STRATA_AI_FALLBACK_MODEL || ""),
      timeoutMs: number(env.STRATA_AI_TIMEOUT_MS, 60000, 5000, 300000),
    },
    limits: {
      maxConcurrent: number(env.STRATA_AI_MAX_CONCURRENT, 3, 1, 16),
      maxQueue: number(env.STRATA_AI_MAX_QUEUE, 20, 1, 200),
      userDaily: number(env.STRATA_AI_USER_DAILY_LIMIT, 30, 1, 1000),
      dailyRequests: number(env.STRATA_AI_DAILY_REQUESTS, 900, 1, 1000000),
      perMinute: number(env.STRATA_AI_REQUESTS_PER_MINUTE, 25, 1, 10000),
      briefShare,
    },
    brief: {
      enabled: env.STRATA_AI_DAILY_BRIEF !== "false",
      hour: number(env.STRATA_AI_BRIEF_HOUR, 5, 0, 23),
    },
  };
}

module.exports = {
  GROQ_BASE_URL,
  aiSettings,
  createAiProvider,
  extractJson,
  retryAfterMs,
  stripReasoning,
  structuredFormat,
};
