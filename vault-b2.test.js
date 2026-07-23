"use strict";

// Unit coverage for Phase B2: the git-crypt magic-byte ingest guard and the
// optimistic-lock write path (vault-store.js), plus the route-layer pure helpers
// (PIN constant-time compare, slug/type-dir placement, media gate-v2 band
// routing). The HTTP wiring (403/409/unlock session flow, attach round-trips) is
// exercised in live local QA per the phase plan.

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fsp = require("fs/promises");
const path = require("path");

const VaultStore = require("./vault-store");
const SyncManager = require("./sync-manager");
const { pinMatches, slugify, typeDirOk, dirRegex, mediaPlacement, isSensitiveSlug } = require("./routes/vault");

const MAGIC = VaultStore.GITCRYPT_MAGIC;
const stat = (raw) => ({ mtimeMs: 1, size: raw.length });

// ── git-crypt magic-byte ingest guard ──
test("_ingest: a git-crypt-encrypted file is never indexed", () => {
  const vs = new VaultStore({ vaultDir: "/v" });
  const ok = vs._ingest("health/therapy/x", "/v/health/therapy/x.md", MAGIC + "\x01\x02binary", stat(MAGIC));
  assert.strictEqual(ok, false, "_ingest reports it skipped the file");
  assert.strictEqual(vs.has("health/therapy/x"), false, "ciphertext must not enter the graph");
});

test("_ingest: a node that re-locks (becomes ciphertext) is dropped from the index", () => {
  const vs = new VaultStore({ vaultDir: "/v" });
  vs._ingest("health/therapy/x", "/v/health/therapy/x.md", "---\ntype: therapy\n---\nplain", stat("x"));
  vs._rebuildBacklinks();
  assert.ok(vs.has("health/therapy/x"), "plaintext indexes normally");
  // Now the same path comes back as ciphertext (unlock lost).
  vs._ingest("health/therapy/x", "/v/health/therapy/x.md", MAGIC + "garbage", stat("x"));
  assert.strictEqual(vs.has("health/therapy/x"), false, "re-locked node disappears cleanly");
  assert.deepStrictEqual(vs.get("health/therapy/x"), null);
});

// ── Optimistic lock (write precondition) ──
test("write: stale expectedHash throws StaleWriteError (no disk touch), matching hash succeeds", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb2-"));
  try {
    const vs = new VaultStore({ vaultDir: dir });
    // Create (no expectedHash).
    const created = await vs.write("notes/a", { frontmatter: { type: "note", title: "A" }, body: "one" });
    assert.ok(created.hash, "get() returns the content hash for the lock token");

    // Stale write: wrong expectedHash must 409 before writing anything.
    await assert.rejects(
      () => vs.write("notes/a", { frontmatter: { type: "note" }, body: "two", expectedHash: "deadbeef" }),
      (e) => e.code === "STALE_WRITE",
      "a mismatched expectedHash throws STALE_WRITE"
    );
    assert.strictEqual(vs.get("notes/a").body, created.body, "the stale write did not touch disk/index");

    // Correct expectedHash: succeeds and returns a fresh hash.
    const edited = await vs.write("notes/a", { frontmatter: { type: "note", title: "A" }, body: "two", expectedHash: created.hash });
    assert.strictEqual(edited.body.trim(), "two");
    assert.notStrictEqual(edited.hash, created.hash, "hash advances after a successful edit");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("write: expectedHash on a node that was deleted under us is a conflict", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb2-"));
  try {
    const vs = new VaultStore({ vaultDir: dir });
    await assert.rejects(
      () => vs.write("notes/ghost", { frontmatter: { type: "note" }, body: "x", expectedHash: "somehash" }),
      (e) => e.code === "STALE_WRITE",
      "expectedHash set but node absent = stale"
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── Sensitive-gate normalization (the `..` bypass regression) ──
test("normalizeSlug closes the `..` sensitive-gate bypass", () => {
  const vs = new VaultStore({ vaultDir: "/v" });
  const raw = "health/the..rapy/2026-01-01";
  // The naive check on the RAW slug misses it — that was the bug.
  assert.ok(!isSensitiveSlug(raw), "raw `..` slug dodges the naive isSensitiveSlug check");
  // The store normalizes it INTO a sensitive dir, so the gate must normalize first.
  assert.strictEqual(vs.normalizeSlug(raw), "health/therapy/2026-01-01");
  assert.ok(isSensitiveSlug(vs.normalizeSlug(raw)), "normalized slug is caught — routes gate on the normalized slug");
  // Leading-slash + `..` combinations also normalize safely.
  assert.strictEqual(vs.normalizeSlug("/../journal/private/x"), "journal/private/x");
  assert.ok(isSensitiveSlug(vs.normalizeSlug("/../journal/private/x")));
});

// ── PIN constant-time compare ──
test("pinMatches: exact match only; empty/wrong/different-length all fail", () => {
  assert.ok(pinMatches("1379", "1379"));
  assert.ok(!pinMatches("1379", "1378"));
  assert.ok(!pinMatches("1379", "13790"), "different length still fails (hashed, no length leak)");
  assert.ok(!pinMatches("", "1379"));
  assert.ok(!pinMatches("1379", ""), "no configured PIN never matches");
  assert.ok(!pinMatches(null, "1379"));
});

// ── Slug + type->dir placement ──
test("slugify: lowercases, strips punctuation, collapses separators", () => {
  assert.strictEqual(slugify("My Cool Note! (v2)"), "my-cool-note-v2");
  assert.strictEqual(slugify("  Trailing/Slashes  "), "trailing-slashes");
  assert.strictEqual(slugify(""), "untitled");
  assert.strictEqual(slugify("émigré café"), "migr-caf", "non-ascii is dropped (ascii slug only)");
});

test("typeDirOk / dirRegex: home-dir guard tolerates YYYY across years, blocks the wrong dir", () => {
  const schema = { types: { journal: { dir: "journal/YYYY/" }, note: { dir: "notes/" }, session: { dir: "dnd/<campaign>/" } } };
  assert.ok(typeDirOk(schema, "journal/2026/2026-07-23", "journal"));
  assert.ok(typeDirOk(schema, "journal/2019/old-entry", "journal"), "editing a prior-year journal validates");
  assert.ok(!typeDirOk(schema, "people/bob", "note"), "a note cannot live in people/");
  assert.ok(typeDirOk(schema, "dnd/dragonlance/s1", "session"), "placeholder dirs are not blocked");
  assert.ok(typeDirOk(schema, "anywhere/x", "unknowntype"), "unknown/legacy types are not blocked");
  assert.ok(dirRegex("journal/YYYY/").test("journal/2026/x"));
  assert.ok(!dirRegex("journal/YYYY/").test("journal/x"));
});

// ── Media gate v2 band routing ──
test("mediaPlacement: size/kind picks the band; sensitive is inline-private; deep tier throws", () => {
  assert.strictEqual(mediaPlacement({ bytes: 1.5e6, mime: "image/png", sensitive: false }).band, "inline");
  assert.strictEqual(mediaPlacement({ bytes: 5e6, mime: "image/jpeg", sensitive: false }).band, "lfs");
  assert.strictEqual(mediaPlacement({ bytes: 9e6, mime: "image/heic", sensitive: true }).band, "inline-private");
  assert.throws(() => mediaPlacement({ bytes: 11e6, mime: "image/jpeg", sensitive: false }), (e) => e.code === "TOO_BIG");
  assert.throws(() => mediaPlacement({ bytes: 1e6, mime: "video/mp4", sensitive: false }), (e) => e.code === "TOO_BIG");
  // Sensitive bypasses the size/video gate entirely (inline-only, never leaves the machine).
  assert.strictEqual(mediaPlacement({ bytes: 11e6, mime: "video/mp4", sensitive: true }).band, "inline-private");
  // Pin the exact band boundaries (2MB / 10MB) so a < -> <= refactor can't silently misclassify.
  assert.strictEqual(mediaPlacement({ bytes: 2097151, mime: "image/png", sensitive: false }).band, "inline", "just under 2MB stays inline");
  assert.strictEqual(mediaPlacement({ bytes: 2097152, mime: "image/png", sensitive: false }).band, "lfs", "exactly 2MB crosses to lfs");
  assert.strictEqual(mediaPlacement({ bytes: 10485760, mime: "image/jpeg", sensitive: false }).band, "lfs", "exactly 10MB is allowed (lfs), not TOO_BIG");
  assert.throws(() => mediaPlacement({ bytes: 10485761, mime: "image/jpeg", sensitive: false }), (e) => e.code === "TOO_BIG", "one byte over 10MB is the deep tier");
});

// ── git-crypt unlock state machine (sync-manager.js) ──
test("_gitCryptUnlock: no-key / short-key / already / success / failure", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb2-gc-"));
  try {
    // No key configured -> no-key (early return, before any git work).
    const a = new SyncManager({ vaultDir: dir });
    await a._gitCryptUnlock();
    assert.strictEqual(a.gitcryptState, "no-key");

    // Key decodes to < 16 bytes -> failed (the security-relevant short-key guard).
    const b = new SyncManager({ vaultDir: dir, gitcryptKeyB64: Buffer.from("short").toString("base64") });
    b._runGit = async (fn) => fn();
    b.git = { raw: async () => "" };
    await b._gitCryptUnlock();
    assert.strictEqual(b.gitcryptState, "failed");

    // A clone whose key is already installed is left alone.
    const keysDir = path.join(dir, ".git", "git-crypt", "keys");
    await fsp.mkdir(keysDir, { recursive: true });
    await fsp.writeFile(path.join(keysDir, "default"), "x");
    const c = new SyncManager({ vaultDir: dir, gitcryptKeyB64: Buffer.alloc(32, 1).toString("base64") });
    await c._gitCryptUnlock();
    assert.strictEqual(c.gitcryptState, "already");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // Valid key + stubbed git -> unlocked; a rejecting git -> failed (non-fatal).
  const d2 = await fsp.mkdtemp(path.join(os.tmpdir(), "vb2-gc2-"));
  const good = new SyncManager({ vaultDir: d2, gitcryptKeyB64: Buffer.alloc(32, 2).toString("base64") });
  good._runGit = async (fn) => fn();
  good.git = { raw: async () => "" };
  await good._gitCryptUnlock();
  assert.strictEqual(good.gitcryptState, "unlocked");
  await fsp.rm(d2, { recursive: true, force: true });

  const d3 = await fsp.mkdtemp(path.join(os.tmpdir(), "vb2-gc3-"));
  const bad = new SyncManager({ vaultDir: d3, gitcryptKeyB64: Buffer.alloc(32, 3).toString("base64") });
  bad._runGit = async (fn) => fn();
  bad.git = { raw: async () => { throw new Error("git-crypt not installed"); } };
  await bad._gitCryptUnlock();
  assert.strictEqual(bad.gitcryptState, "failed");
  await fsp.rm(d3, { recursive: true, force: true });
});
