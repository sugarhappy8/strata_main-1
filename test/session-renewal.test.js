"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  SESSION_MAX_LIFETIME_MS,
  appendSetCookie,
  renewedSessionExpiry,
} = require("../src/session-renewal");
const { json, redirect } = require("../src/http");

const HOUR = 60 * 60 * 1000,
  WEEK = 7 * 24 * HOUR;

test("a session slides forward only past half its life, never beyond the absolute cap", () => {
  const now = 10 * WEEK;
  assert.equal(
    renewedSessionExpiry(
      { expires_at: now + 4 * 24 * HOUR, session_created_at: now - 3 * 24 * HOUR },
      { now, sessionMs: WEEK },
    ),
    null,
  );
  assert.equal(
    renewedSessionExpiry(
      { expires_at: now + 3 * 24 * HOUR, session_created_at: now - 4 * 24 * HOUR },
      { now, sessionMs: WEEK },
    ),
    now + WEEK,
  );
  const nearCap = now - SESSION_MAX_LIFETIME_MS + 2 * 24 * HOUR;
  assert.equal(
    renewedSessionExpiry(
      { expires_at: now + HOUR, session_created_at: nearCap },
      { now, sessionMs: WEEK },
    ),
    nearCap + SESSION_MAX_LIFETIME_MS,
  );
  assert.equal(
    renewedSessionExpiry(
      { expires_at: now + HOUR, session_created_at: now - SESSION_MAX_LIFETIME_MS + HOUR },
      { now, sessionMs: WEEK },
    ),
    null,
  );
  assert.equal(
    renewedSessionExpiry(
      { expires_at: now + HOUR, session_created_at: now - WEEK },
      { now, sessionMs: WEEK, maxLifetimeMs: WEEK },
    ),
    null,
  );
  assert.equal(
    renewedSessionExpiry(
      { expires_at: now - 1, session_created_at: now - WEEK },
      { now, sessionMs: WEEK },
    ),
    null,
  );
  assert.equal(renewedSessionExpiry({ expires_at: now + HOUR }, { now, sessionMs: WEEK }), null);
  assert.equal(
    renewedSessionExpiry(
      { expires_at: "later", session_created_at: now },
      { now, sessionMs: WEEK },
    ),
    null,
  );
});

test("a cookie added before the handler writes goes out with every response, unless the route sets the same cookie", async () => {
  const server = http.createServer((req, res) => {
    const mode = new URL(req.url, "http://cookie.test").pathname.slice(1);
    // What the session lookup does when it slides a session forward: add the cookie before any handler writes.
    if (mode !== "none") {
      appendSetCookie(res, "strata_session=old; Path=/");
      appendSetCookie(res, "strata_session=renewed; Path=/; HttpOnly");
    }
    if (mode === "json" || mode === "none") json(res, 200, { ok: true });
    else if (mode === "other")
      json(res, 200, { ok: true }, { "set-cookie": "strata_signup=; Max-Age=0" });
    else if (mode === "replaced")
      json(res, 200, { ok: true }, { "Set-Cookie": ["strata_session=; Max-Age=0"] });
    else if (mode === "plain") res.end("plain");
    else if (mode === "status-message") {
      res.writeHead(204, "No Content", { "X-Mode": "message" });
      res.end();
    } else if (mode === "redirect")
      redirect(res, "/next", { "Set-Cookie": "strata_polar_return=; Max-Age=0" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(),
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const cookies = async (path) =>
    (await fetch(`${base}${path}`, { redirect: "manual" })).headers.getSetCookie();
  try {
    assert.deepEqual(
      await cookies("/json"),
      ["strata_session=renewed; Path=/; HttpOnly"],
      "a later cookie of the same name replaces the earlier one",
    );
    assert.deepEqual(await cookies("/none"), []);
    assert.deepEqual(
      await cookies("/other"),
      ["strata_session=renewed; Path=/; HttpOnly", "strata_signup=; Max-Age=0"],
      "a route's other cookie does not drop the renewal",
    );
    assert.deepEqual(
      await cookies("/replaced"),
      ["strata_session=; Max-Age=0"],
      "sign-out replaces the session cookie",
    );
    assert.deepEqual(await cookies("/plain"), ["strata_session=renewed; Path=/; HttpOnly"]);
    assert.deepEqual(await cookies("/status-message"), [
      "strata_session=renewed; Path=/; HttpOnly",
    ]);
    assert.deepEqual(await cookies("/redirect"), [
      "strata_session=renewed; Path=/; HttpOnly",
      "strata_polar_return=; Max-Age=0",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the response object keeps its own writeHead", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "session-renewal.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\.writeHead\s*=/, "no module replaces res.writeHead");
  assert.doesNotMatch(
    require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "src", "server.js"),
      "utf8",
    ),
    /deliverQueuedCookies/,
  );
});
