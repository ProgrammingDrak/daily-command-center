"use strict";

// Authenticated encryption for credentials the DCC must be able to REPLAY, as
// opposed to merely verify.
//
// This is the repo's first encryption-at-rest helper, and it exists because of a
// naming promise: `slack_identities.user_token_enc` says `_enc`, and its comment
// says "Tier 2 will decrypt row.user_token_enc here". The rest of the codebase
// only ever does one-way or verify-only crypto — `token-store.js` SHA-256s service
// tokens (deliberately unrecoverable) and `routes/slack-events.js` HMACs Slack
// signatures. Google's refresh tokens, by contrast, sit in
// `gcal_account_tokens.tokens` as plaintext JSONB. That is precedent, not a
// standard to copy: a Slack user token carrying `reactions:write` can act as a
// real person inside their workspace.
//
// AES-256-GCM, so a tampered ciphertext FAILS instead of decrypting to garbage,
// and a random IV per seal so two rows holding the same token do not look alike.
//
// The version tag is also passed as additional authenticated data. That is
// FUTURE-PROOFING, not today's defence: `open` currently accepts exactly one
// version and rejects anything else before the cipher runs, so the explicit check
// is what stops a v1 blob being relabelled v2. The AAD only starts earning its
// keep the day `open` accepts two versions at once — at which point removing it
// would be a silent downgrade. Mutation testing confirmed no current test can
// fail on its absence, so it is documented rather than pretended about.
//
// Format: `v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>`
// Dot-separated and base64url so the whole thing is a single safe TEXT value.

const crypto = require("node:crypto");

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;          // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

// Accepts 64 hex chars, or base64/base64url, so a key can be pasted from
// `openssl rand -hex 32`, `openssl rand -base64 32`, or Node's own output.
function parseKey(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  try {
    const buf = Buffer.from(value, "base64");
    if (buf.length === KEY_BYTES) return buf;
  } catch { /* fall through to the explicit error below */ }
  return null;
}

// A misconfigured key must never degrade to "store it in the clear". Callers get
// a thrown error and decide; `createSecretBox` below is the only place that
// chooses to tolerate an absent key, and only when the feature is switched off.
function createSecretBox(rawKey, label = "secret") {
  const key = parseKey(rawKey);
  if (!key) {
    throw new Error(`${label} key must be 32 bytes, as 64 hex characters or base64`);
  }

  function seal(plaintext) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    // Bind the version tag to the ciphertext so the envelope cannot be relabelled.
    cipher.setAAD(Buffer.from(VERSION, "utf8"));
    const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  function open(envelope) {
    const parts = String(envelope || "").split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unrecognized sealed value");
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const body = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES) throw new Error("unrecognized sealed value");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAAD(Buffer.from(VERSION, "utf8"));
    decipher.setAuthTag(tag);
    // `final()` is what raises on a bad tag, wrong key, or altered ciphertext.
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  // JSON envelope helpers. Everything Tier 2 needs rides in ONE encrypted TEXT
  // column: `user_token_enc` is already in the deployed `CREATE TABLE`, and adding
  // a sibling column later would need an ALTER, which CI's DB-risk guardrail
  // blocks and `CREATE TABLE IF NOT EXISTS` would not apply to an existing table.
  const sealJson = (value) => seal(JSON.stringify(value));
  const openJson = (envelope) => JSON.parse(open(envelope));

  return { seal, open, sealJson, openJson };
}

function isSealed(value) {
  return String(value || "").startsWith(`${VERSION}.`);
}

function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}

module.exports = { createSecretBox, generateKey, isSealed, parseKey, VERSION };
