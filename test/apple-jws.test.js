"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { APPLE_ROOT_CA_G3_FINGERPRINT, AppleJwsError, verifyAppleJws } = require("../src/apple-jws");
const { createAppleTestChain } = require("./support/apple-test-chain");

const chain = createAppleTestChain();
const NOW = Date.now();
const transaction = {
  transactionId: "2000000123",
  originalTransactionId: "2000000100",
  bundleId: "online.stratafitness.app",
  productId: "online.stratafitness.app.plus.monthly",
  signedDate: NOW,
  environment: "Sandbox",
};
const verify = (token, options = {}) =>
  verifyAppleJws(token, { rootFingerprint: chain.rootFingerprint, now: NOW, ...options });
const rejects = (fn, code) =>
  assert.throws(fn, (error) => error instanceof AppleJwsError && (!code || error.code === code));

test("the pinned root is Apple Root CA - G3", () => {
  assert.equal(
    APPLE_ROOT_CA_G3_FINGERPRINT,
    "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
  );
});

test("a correctly signed App Store payload verifies and decodes", () => {
  assert.deepEqual(verify(chain.signJws(transaction)), transaction);
});

test("data whose chain does not end at the pinned root is refused, even if otherwise valid", () => {
  // The default root is Apple's; the test chain's own root is not it.
  rejects(() => verifyAppleJws(chain.signJws(transaction), { now: NOW }), "APPLE_ROOT_UNTRUSTED");
});

test("tampering with the payload, the signature, or the algorithm is refused", () => {
  const [head, body, signature] = chain.signJws(transaction).split(".");
  const forged = Buffer.from(
    JSON.stringify({ ...transaction, productId: "free.forever" }),
  ).toString("base64url");
  rejects(() => verify(`${head}.${forged}.${signature}`));
  const flipped = Buffer.from(signature, "base64url");
  flipped[10] ^= 1;
  rejects(() => verify(`${head}.${body}.${flipped.toString("base64url")}`));
  rejects(() => verify(chain.signJws(transaction, { header: { alg: "none" } })));
  rejects(() => verify(chain.signJws(transaction, { header: { alg: "HS256" } })));
});

test("a payload signed by a different key than the chain's leaf is refused", () => {
  const other = createAppleTestChain();
  const mixed = other.signJws(transaction, { header: { x5c: chain.x5c } });
  rejects(() => verify(mixed));
});

test("chains without Apple's marker extensions, in the wrong order, or of the wrong length are refused", () => {
  for (const options of [{ leafMarker: false }, { intermediateMarker: false }]) {
    const unmarked = createAppleTestChain(options);
    rejects(() =>
      verifyAppleJws(unmarked.signJws(transaction), {
        rootFingerprint: unmarked.rootFingerprint,
        now: NOW,
      }),
    );
  }
  const [leaf, intermediate, root] = chain.x5c;
  rejects(() =>
    verify(chain.signJws(transaction, { header: { x5c: [intermediate, leaf, root] } })),
  );
  rejects(() => verify(chain.signJws(transaction, { header: { x5c: [leaf, root] } })));
  rejects(() => verify(chain.signJws(transaction, { header: { x5c: "nope" } })));
});

test("malformed, oversized, and future-dated tokens are refused", () => {
  for (const token of ["", "a.b", "a.b.c.d", "%%%.e30.e30", 42, null, `${"a".repeat(70_000)}.b.c`])
    rejects(() => verify(/** @type {any} */ (token)));
  rejects(() => verify(chain.signJws("[1,2]")));
  rejects(() => verify(chain.signJws({ ...transaction, signedDate: NOW + 60 * 60 * 1000 })));
});

test("data dated outside the certificates' validity is refused", () => {
  rejects(
    () => verify(chain.signJws({ ...transaction, signedDate: NOW - 24 * 60 * 60 * 1000 })),
    "APPLE_CERTIFICATE_EXPIRED",
  );
});
