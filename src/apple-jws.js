"use strict";

// Verifies data the App Store signs: StoreKit 2 transactions and renewal info sent by the iOS app, and App Store Server
// Notifications V2. Each is a compact JWS (ES256) whose x5c header carries Apple's three-certificate chain. The chain must
// end in Apple Root CA - G3 (pinned by SHA-256 fingerprint), each certificate must be issued and signed by the next, the
// leaf and intermediate must carry Apple's marker extensions, and the signature must verify with the leaf's key.
// No network access and no dependencies: node:crypto does the X.509 and ECDSA work.
const { X509Certificate, verify: verifySignature } = require("node:crypto");

// SHA-256 fingerprint of "Apple Root CA - G3" (https://www.apple.com/certificateauthority/).
const APPLE_ROOT_CA_G3_FINGERPRINT =
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";
// DER-encoded OBJECT IDENTIFIERs Apple places in the chain: 1.2.840.113635.100.6.11.1 (App Store receipt signing leaf)
// and 1.2.840.113635.100.6.2.1 (Apple Worldwide Developer Relations intermediate).
const LEAF_MARKER = Buffer.from([
  0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x0b, 0x01,
]);
const INTERMEDIATE_MARKER = Buffer.from([
  0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x02, 0x01,
]);
const MAX_TOKEN_LENGTH = 64 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

class AppleJwsError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = "APPLE_SIGNATURE_INVALID") {
    super(message);
    this.name = "AppleJwsError";
    this.code = code;
    this.status = 400;
  }
}

/** @param {string} message @param {string} [code] @returns {never} */
function fail(message, code) {
  throw new AppleJwsError(message, code);
}

/** @param {unknown} segment @param {string} label */
function decodeSegment(segment, label) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]*$/.test(segment))
    fail(`The signed ${label} is not base64url.`);
  return Buffer.from(segment, "base64url");
}

/** @param {Buffer} buffer @param {string} label @returns {Record<string, any>} */
function parseJson(buffer, label) {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return value;
  } catch {
    return fail(`The signed ${label} is not a JSON object.`);
  }
}

/** @param {unknown} base64 @returns {X509Certificate} */
function certificateFrom(base64) {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/=]+$/.test(base64))
    fail("The signing certificate chain is malformed.");
  try {
    return new X509Certificate(Buffer.from(base64, "base64"));
  } catch {
    return fail("The signing certificate chain is malformed.");
  }
}

/** @param {X509Certificate} certificate @param {number} time */
function validAt(certificate, time) {
  return Date.parse(certificate.validFrom) <= time && time <= Date.parse(certificate.validTo);
}

// Checks the chain and returns the leaf's public key. `at` is the moment the data was signed, so data signed while the
// chain was valid (for example a renewal Apple signed months ago and the app restores today) still verifies.
/** @param {unknown} x5c @param {{rootFingerprint: string, at: number}} options */
function verifyChain(x5c, { rootFingerprint, at }) {
  if (!Array.isArray(x5c) || x5c.length !== 3)
    fail("The signing certificate chain must have three certificates.");
  const [leaf, intermediate, root] =
    /** @type {[X509Certificate,X509Certificate,X509Certificate]} */ (x5c.map(certificateFrom));
  if (root.fingerprint256 !== rootFingerprint)
    fail("The data was not signed by the App Store.", "APPLE_ROOT_UNTRUSTED");
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey))
    fail("The signing certificate chain is broken.");
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey))
    fail("The signing certificate chain is broken.");
  if (!root.checkIssued(root) || !root.verify(root.publicKey))
    fail("The signing certificate chain is broken.");
  if (!intermediate.ca || !root.ca) fail("The signing certificate chain is broken.");
  if (!leaf.raw.includes(LEAF_MARKER) || !intermediate.raw.includes(INTERMEDIATE_MARKER))
    fail("The signing certificates are not the App Store's.");
  for (const certificate of [leaf, intermediate, root]) {
    if (!validAt(certificate, at))
      fail(
        "A signing certificate was not valid when the data was signed.",
        "APPLE_CERTIFICATE_EXPIRED",
      );
  }
  return leaf.publicKey;
}

/**
 * Verifies one App Store JWS and returns its payload.
 * @param {string} token Compact JWS (header.payload.signature).
 * @param {{rootFingerprint?: string, now?: number}} [options] rootFingerprint is overridable for tests only.
 * @returns {Record<string, any>}
 */
function verifyAppleJws(
  token,
  { rootFingerprint = APPLE_ROOT_CA_G3_FINGERPRINT, now = Date.now() } = {},
) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
    fail("The signed data is missing or too large.");
  const parts = token.split(".");
  if (parts.length !== 3) fail("The signed data is not a compact JWS.");
  const [headerSegment, payloadSegment, signatureSegment] = /** @type {[string,string,string]} */ (
    parts
  );
  const header = parseJson(decodeSegment(headerSegment, "header"), "header");
  if (header.alg !== "ES256") fail("The signed data must use ES256.");
  const payload = parseJson(decodeSegment(payloadSegment, "payload"), "payload");
  const signedDate = Number(payload.signedDate);
  const at = Number.isFinite(signedDate) && signedDate > 0 ? signedDate : now;
  if (at > now + CLOCK_SKEW_MS) fail("The signed data is dated in the future.");
  const key = verifyChain(header.x5c, { rootFingerprint, at });
  const signature = decodeSegment(signatureSegment, "signature");
  if (signature.length !== 64) fail("The ES256 signature has the wrong length.");
  const signedInput = Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii");
  if (!verifySignature("sha256", signedInput, { key, dsaEncoding: "ieee-p1363" }, signature))
    fail("The App Store signature does not match the data.");
  return payload;
}

module.exports = { APPLE_ROOT_CA_G3_FINGERPRINT, AppleJwsError, verifyAppleJws };
