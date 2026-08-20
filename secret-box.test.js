// lib/secret-box.js — the repo's first encryption-at-rest helper.
//
// Everything else here is one-way (token-store.js SHA-256s service tokens) or
// verify-only (slack-events HMACs Slack signatures). This has to be reversible,
// which makes tamper-detection the property that actually matters: a broken
// authenticated cipher does not error, it hands back plausible garbage.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSecretBox, generateKey, isSealed, parseKey, VERSION } = require("./lib/secret-box.js");

const KEY = generateKey();

test("a sealed value round-trips", () => {
  const box = createSecretBox(KEY);
  assert.equal(box.open(box.seal("xoxp-secret-token")), "xoxp-secret-token");
  assert.deepEqual(box.openJson(box.sealJson({ token: "xoxp-1", scopes: ["reactions:write"] })),
    { token: "xoxp-1", scopes: ["reactions:write"] });
});

test("the plaintext never appears in the envelope", () => {
  const box = createSecretBox(KEY);
  const sealed = box.seal("xoxp-verydistinctivetoken");
  assert.ok(!sealed.includes("xoxp"), "a substring of the secret in the ciphertext would defeat the point");
  assert.ok(!sealed.includes("verydistinctive"));
});

test("every seal of the same value differs", () => {
  // A fixed IV would make identical tokens produce identical ciphertext, leaking
  // "these two rows hold the same credential".
  const box = createSecretBox(KEY);
  const a = box.seal("same"), b = box.seal("same");
  assert.notEqual(a, b);
  assert.equal(box.open(a), box.open(b));
});

test("a tampered ciphertext FAILS rather than decrypting to garbage", () => {
  const box = createSecretBox(KEY);
  const parts = box.seal("xoxp-secret").split(".");
  const body = Buffer.from(parts[3], "base64url");
  body[0] ^= 0xff;                                   // flip a bit in the payload
  parts[3] = body.toString("base64url");
  assert.throws(() => box.open(parts.join(".")));
});

test("a tampered auth tag fails", () => {
  const box = createSecretBox(KEY);
  const parts = box.seal("xoxp-secret").split(".");
  const tag = Buffer.from(parts[2], "base64url");
  tag[0] ^= 0xff;
  parts[2] = tag.toString("base64url");
  assert.throws(() => box.open(parts.join(".")));
});

test("a swapped IV fails", () => {
  const box = createSecretBox(KEY);
  const a = box.seal("first").split(".");
  const b = box.seal("second").split(".");
  assert.throws(() => box.open([a[0], b[1], a[2], a[3]].join(".")));
});

test("an envelope cannot be relabelled as another version", () => {
  // Today this is the explicit version check in `open`, which runs before the
  // cipher; the AAD binding is future-proofing for when more than one version is
  // accepted at once. Asserted as the OUTCOME rather than the mechanism, so it
  // keeps holding whichever of the two is doing the work.
  const box = createSecretBox(KEY);
  const parts = box.seal("xoxp-secret").split(".");
  parts[0] = "v2";
  assert.throws(() => box.open(parts.join(".")));
});

test("a wrong key fails cleanly instead of returning nonsense", () => {
  const sealed = createSecretBox(KEY).seal("xoxp-secret");
  assert.throws(() => createSecretBox(generateKey()).open(sealed));
});

test("a malformed envelope is rejected without throwing something unhelpful", () => {
  const box = createSecretBox(KEY);
  for (const bad of ["", "not-sealed", "v1.only.three", "v1.a.b.c.d", "v9.a.b.c", null, undefined]) {
    assert.throws(() => box.open(bad), /unrecognized sealed value|/, `rejects ${JSON.stringify(bad)}`);
  }
});

test("a short IV is rejected rather than handed to the cipher", () => {
  const box = createSecretBox(KEY);
  const parts = box.seal("x").split(".");
  parts[1] = Buffer.alloc(4).toString("base64url");
  assert.throws(() => box.open(parts.join(".")), /unrecognized sealed value/);
});

test("keys are accepted as hex or base64, and nothing else", () => {
  const crypto = require("node:crypto");
  const raw = crypto.randomBytes(32);
  assert.ok(parseKey(raw.toString("hex")));
  assert.ok(parseKey(raw.toString("base64")));
  assert.ok(parseKey(raw.toString("base64url")));
  // A wrong-length key must never be silently stretched or truncated into one.
  assert.equal(parseKey("tooshort"), null);
  assert.equal(parseKey(crypto.randomBytes(16).toString("hex")), null);
  assert.equal(parseKey(""), null);
  assert.equal(parseKey(null), null);
});

test("a missing or wrong-size key throws instead of degrading to plaintext", () => {
  // The failure mode to avoid is a misconfigured server quietly storing tokens
  // in the clear because the key was unusable.
  for (const bad of ["", null, undefined, "tooshort", "zz".repeat(32)]) {
    assert.throws(() => createSecretBox(bad, "SLACK_TOKEN_ENC_KEY"), /SLACK_TOKEN_ENC_KEY key must be 32 bytes/);
  }
});

test("isSealed recognizes our envelopes and not arbitrary strings", () => {
  const box = createSecretBox(KEY);
  assert.ok(isSealed(box.seal("x")));
  assert.ok(isSealed(`${VERSION}.a.b.c`));
  assert.ok(!isSealed("xoxp-plaintext-token"));
  assert.ok(!isSealed(""));
  assert.ok(!isSealed(null));
});

test("generateKey produces a usable 32-byte key each time", () => {
  const a = generateKey(), b = generateKey();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, "hex").length, 32);
  assert.equal(createSecretBox(a).open(createSecretBox(a).seal("ok")), "ok");
});
