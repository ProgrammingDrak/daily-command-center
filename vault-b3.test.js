"use strict";

// Phase B3: media serving v2 + rich render. Unit coverage for the pure
// resolution/render helpers (mediaKind, mediaCandidates, isLfsPointer,
// renderMediaRefs, r2ConfigFromEnv, presignWarm) and the SyncManager LFS fetch
// shape; plus integration coverage of the media route + node.media annotation
// against a temp fixture vault (mounted with a fake app/ctx, no real server).
// The in-browser render matrix (img/audio/video/iframe/album/lightbox) is
// exercised in live local QA per the phase plan.

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fsp = require("fs/promises");
const path = require("path");
const { once } = require("events");
const { Writable } = require("stream");

const SyncManager = require("./sync-manager");
const {
  mediaKind, mediaCandidates, isLfsPointer, renderMediaRefs, r2ConfigFromEnv, presignWarm,
} = require("./routes/vault");

// ── mediaKind ──
test("mediaKind: maps mime -> element kind, file fallback", () => {
  assert.strictEqual(mediaKind("image/png"), "image");
  assert.strictEqual(mediaKind("image/heic"), "image");
  assert.strictEqual(mediaKind("audio/mpeg"), "audio");
  assert.strictEqual(mediaKind("video/mp4"), "video");
  assert.strictEqual(mediaKind("application/pdf"), "pdf");
  assert.strictEqual(mediaKind("application/zip"), "file");
  assert.strictEqual(mediaKind(null), "file");
});

// ── isLfsPointer ──
test("isLfsPointer: spec-URL head is a pointer; real bytes are not", () => {
  assert.ok(isLfsPointer("version https://git-lfs.github.com/spec/v1\noid sha256:...\n"));
  assert.ok(!isLfsPointer("\x89PNG\r\n\x1a\n")); // real png header
  assert.ok(!isLfsPointer(""));
  assert.ok(!isLfsPointer(null));
});

// ── mediaCandidates: resolution order per variant ──
test("mediaCandidates: auto prefers original -> warm -> lowres", () => {
  const m = { inline: "media/blobs/2026/x.png", warm: { key: "k" }, lowres: { path: "media/blobs/2026/x-lowres.jpg" } };
  assert.deepStrictEqual(mediaCandidates(m, "auto").map((c) => c.tier), ["inline", "warm", "lowres"]);

  const lfsOnly = { lfs: "media/lfs/2026/x.jpg", lowres: { path: "media/blobs/2026/x-lowres.jpg" } };
  assert.deepStrictEqual(mediaCandidates(lfsOnly, "auto").map((c) => c.tier), ["lfs", "lowres"]);
});

test("mediaCandidates: original = the inline/lfs home only; cold falls back to the frozen note", () => {
  assert.deepStrictEqual(mediaCandidates({ inline: "a", warm: { key: "k" }, lowres: { path: "l" } }, "original").map((c) => c.tier), ["inline"]);
  // Original lives in cold (no inline/lfs) -> the sole candidate is the cold note.
  assert.deepStrictEqual(mediaCandidates({ cold: { key: "k" }, warm: { key: "w" } }, "original").map((c) => c.tier), ["cold"]);
});

test("mediaCandidates: lowres prefers lowres -> warm -> original", () => {
  const m = { inline: "a", warm: { key: "w" }, lowres: { path: "l" } };
  assert.deepStrictEqual(mediaCandidates(m, "lowres").map((c) => c.tier), ["lowres", "warm", "inline"]);
});

test("mediaCandidates: cloud tiers null (dormant) degrades to what's local; empty when truly nothing", () => {
  // Track C ships warm/cold dormant (null) — auto must still resolve from inline.
  assert.deepStrictEqual(mediaCandidates({ inline: "a", warm: null, cold: null, lowres: null }, "auto").map((c) => c.tier), ["inline"]);
  assert.deepStrictEqual(mediaCandidates({ inline: null, lfs: null, warm: null, lowres: null, cold: null }, "auto"), []);
});

test("mediaCandidates: sensitive is inline-only and NEVER presigns to R2", () => {
  const sensitive = { visibility: "sensitive", inline: "media/blobs/private/2026/x.png", warm: { key: "leak" }, cold: { key: "leak" } };
  assert.deepStrictEqual(mediaCandidates(sensitive, "auto").map((c) => c.tier), ["inline"], "warm/cold ignored for sensitive");
  assert.deepStrictEqual(mediaCandidates(sensitive, "lowres").map((c) => c.tier), ["inline"]);
  // A sensitive manifest with no inline copy resolves to nothing (never leaks).
  assert.deepStrictEqual(mediaCandidates({ visibility: "sensitive", warm: { key: "leak" } }, "auto"), []);
});

// ── renderMediaRefs ──
test("renderMediaRefs: rewrites embeds to placeholder spans, escapes alt, ignores non-media", () => {
  const out = renderMediaRefs("intro\n![My pic](media:sha256:3580b71a64e370bca52e846f71e14a45a8e62aa331c34f14dc3b6f93dc7c3cd7)\ntail");
  assert.match(out, /<div class="vault-media" data-media-hash="3580b71a64e370bca52e846f71e14a45a8e62aa331c34f14dc3b6f93dc7c3cd7" data-media-alt="My pic"><\/div>/);
  // Alt with a double-quote must be attribute-escaped (no attribute break-out).
  assert.match(renderMediaRefs('![a"b](media:sha256:aabbccddeeff)'), /data-media-alt="a&quot;b"/);
  // A normal image / external link is left alone.
  assert.strictEqual(renderMediaRefs("![x](https://ex.com/a.png)"), "![x](https://ex.com/a.png)");
  assert.strictEqual(renderMediaRefs("no media here"), "no media here");
});

// ── r2ConfigFromEnv ──
test("r2ConfigFromEnv: null unless all three secrets present, else the config object", () => {
  const save = { ...process.env };
  try {
    delete process.env.MYCELIUM_R2_ACCESS_KEY_ID; delete process.env.MYCELIUM_R2_SECRET_ACCESS_KEY; delete process.env.MYCELIUM_R2_ENDPOINT;
    assert.strictEqual(r2ConfigFromEnv(), null, "unconfigured -> null (warm tier degrades)");
    process.env.MYCELIUM_R2_ACCESS_KEY_ID = "AK"; process.env.MYCELIUM_R2_SECRET_ACCESS_KEY = "SK"; process.env.MYCELIUM_R2_ENDPOINT = "https://acc.r2.cloudflarestorage.com";
    const cfg = r2ConfigFromEnv();
    assert.strictEqual(cfg.accessKeyId, "AK");
    assert.strictEqual(cfg.region, "auto", "R2 default region");
    assert.strictEqual(cfg.warmBucket, "mycelium-warm", "default warm bucket");
  } finally {
    for (const k of ["MYCELIUM_R2_ACCESS_KEY_ID", "MYCELIUM_R2_SECRET_ACCESS_KEY", "MYCELIUM_R2_ENDPOINT", "MYCELIUM_R2_REGION", "MYCELIUM_R2_WARM_BUCKET"]) delete process.env[k];
    Object.assign(process.env, save);
  }
});

// ── presignWarm (real aws-sdk v3, offline: signing is local crypto) ──
test("presignWarm: null when unconfigured; a 10-min signed URL when configured", async () => {
  assert.strictEqual(await presignWarm({ key: "k" }, null), null, "no r2 config -> null");
  assert.strictEqual(await presignWarm(null, { accessKeyId: "a", secretAccessKey: "b", endpoint: "https://x" }), null, "no warm block -> null");

  const url = await presignWarm(
    { provider: "r2", bucket: "mycelium-warm", key: "sha256/35/3580.jpg" },
    { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secretexample", endpoint: "https://acc.r2.cloudflarestorage.com", region: "auto", warmBucket: "mycelium-warm" }
  );
  assert.match(url, /^https:\/\/acc\.r2\.cloudflarestorage\.com\//);
  assert.match(url, /mycelium-warm/, "bucket in the path");
  assert.match(url, /sha256%2F35%2F3580\.jpg|sha256\/35\/3580\.jpg/, "key in the URL");
  assert.match(url, /X-Amz-Expires=600/, "10-minute expiry");
  assert.match(url, /X-Amz-Signature=/, "signed");
});

// ── SyncManager.lfsFetch shape ──
test("lfsFetch: runs `git lfs pull --include <path> --exclude ''`", async () => {
  const sm = new SyncManager({ vaultDir: "/v" });
  const calls = [];
  sm._runGit = async (fn) => fn();
  sm.git = { raw: async (args) => { calls.push(args); return ""; } };
  await sm.lfsFetch("media/lfs/2026/deadbeef.jpg");
  assert.deepStrictEqual(calls[0], ["lfs", "pull", "--include", "media/lfs/2026/deadbeef.jpg", "--exclude", ""]);
});

// ── Media route + node.media integration (temp fixture vault) ──
function mountVault(vaultDir) {
  const routes = {};
  const app = {
    get: (p, ...h) => { routes["GET " + p] = h[h.length - 1]; },
    post: () => {}, put: () => {}, delete: () => {},
  };
  const ctx = {
    VAULT_REPO_URL: null,
    syncMgr: null,
    vault: {
      ready: true,
      vaultDir,
      normalizeSlug: (s) => String(s || "").replace(/\.\./g, "").replace(/^\/+/, ""),
      get: (slug) => (ctx._nodes && ctx._nodes[slug]) || null,
      has: () => false,
    },
    _nodes: {},
  };
  require("./routes/vault")(app, ctx);
  return { routes, ctx };
}

function makeReq({ hash, query = {}, unlocked = false, params } = {}) {
  return {
    params: params || { hash },
    query,
    headers: {},
    session: unlocked ? { vaultUnlockedUntil: Date.now() + 60000 } : {},
  };
}

function makeRes() {
  const res = new Writable({ write(chunk, _enc, cb) { res._chunks.push(Buffer.from(chunk)); cb(); } });
  res._chunks = [];
  res.headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  const settle = (body) => { res.headersSent = true; res.body = body; res.emit("finish"); return res; };
  res.json = (o) => settle(o);
  res.send = (b) => settle(b);
  res.redirect = (code, url) => { res.statusCode = code; res.redirectedTo = url; return settle(null); };
  return res;
}

async function callRoute(handler, req) {
  const res = makeRes();
  const done = once(res, "finish");
  await handler(req, res);
  await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
  return res;
}

async function makeFixtureVault() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb3-"));
  const write = async (rel, data) => { await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fsp.writeFile(path.join(dir, rel), data); };
  // Inline image.
  const pngHash = "3580b71a64e370bca52e846f71e14a45a8e62aa331c34f14dc3b6f93dc7c3cd7";
  await write("media/blobs/2026/3580b71a64e3.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  await write("media/manifests/2026/3580b71a64e3.json", JSON.stringify({
    schema_version: 2, hash: "sha256:" + pngHash, filename: "pic.png", mime: "image/png", bytes: 8,
    inline: "media/blobs/2026/3580b71a64e3.png", lfs: null, lowres: null, warm: null, cold: null, visibility: null,
  }));
  // Cold-only (dormant original).
  await write("media/manifests/2026/cccccccccccc.json", JSON.stringify({
    schema_version: 2, hash: "sha256:cccccccccccc0000000000000000000000000000000000000000000000000000", filename: "vid.mp4", mime: "video/mp4",
    inline: null, lfs: null, lowres: null, warm: null, cold: { provider: "s3", bucket: "mycelium-cold", key: "sha256/cc/x", class: "DEEP_ARCHIVE" }, visibility: null,
  }));
  // Sensitive inline (private subtree).
  await write("media/blobs/private/2026/bbbbbbbbbbbb.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
  await write("media/manifests/private/2026/bbbbbbbbbbbb.json", JSON.stringify({
    schema_version: 2, hash: "sha256:bbbbbbbbbbbb0000000000000000000000000000000000000000000000000000", filename: "private.png", mime: "image/png",
    inline: "media/blobs/private/2026/bbbbbbbbbbbb.png", lfs: null, lowres: null, warm: null, cold: null, visibility: "sensitive",
  }));
  return { dir, pngHash };
}

test("media route: inline 200 w/ content-type, bad-hash 400, missing 404, cold 409", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];

    const ok = await callRoute(h, makeReq({ hash: "3580b71a64e3" }));
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.headers["content-type"], "image/png");
    assert.strictEqual(ok.headers["accept-ranges"], "bytes");
    assert.strictEqual(Buffer.concat(ok._chunks).length, 8, "streamed the inline blob");

    const bad = await callRoute(h, makeReq({ hash: "ZZZZ" }));
    assert.strictEqual(bad.statusCode, 400);

    const miss = await callRoute(h, makeReq({ hash: "ffffffffffff" }));
    assert.strictEqual(miss.statusCode, 404);

    const cold = await callRoute(h, makeReq({ hash: "cccccccccccc" }));
    assert.strictEqual(cold.statusCode, 409);
    assert.strictEqual(cold.body.tier, "cold");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media route: sensitive 403 while locked, 200 once unlocked", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];

    const locked = await callRoute(h, makeReq({ hash: "bbbbbbbbbbbb", unlocked: false }));
    assert.strictEqual(locked.statusCode, 403);
    assert.strictEqual(locked.body.sensitive, true);

    const open = await callRoute(h, makeReq({ hash: "bbbbbbbbbbbb", unlocked: true }));
    assert.strictEqual(open.statusCode, 200);
    assert.strictEqual(open.headers["content-type"], "image/png");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media route: HTTP Range yields a 206 partial", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];
    const req = makeReq({ hash: "3580b71a64e3" });
    req.headers.range = "bytes=2-5";
    const res = await callRoute(h, req);
    assert.strictEqual(res.statusCode, 206);
    assert.strictEqual(res.headers["content-range"], "bytes 2-5/8");
    assert.strictEqual(Buffer.concat(res._chunks).length, 4);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media route: suffix Range bytes=-N returns the LAST N bytes", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];
    const req = makeReq({ hash: "3580b71a64e3" }); // 8-byte inline blob
    req.headers.range = "bytes=-3";
    const res = await callRoute(h, req);
    assert.strictEqual(res.statusCode, 206);
    assert.strictEqual(res.headers["content-range"], "bytes 5-7/8", "last 3 bytes, not the first 4");
    assert.strictEqual(Buffer.concat(res._chunks).length, 3);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media route: unsatisfiable Range yields 416", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];
    const req = makeReq({ hash: "3580b71a64e3" });
    req.headers.range = "bytes=100-200"; // past EOF (size 8)
    const res = await callRoute(h, req);
    assert.strictEqual(res.statusCode, 416);
    assert.strictEqual(res.headers["content-range"], "bytes */8");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media route: LFS pointer smudges ONCE for concurrent viewers, then streams", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes, ctx } = mountVault(dir);
    const h12 = "dddddddddddd";
    const hash = h12 + "0".repeat(52);
    const rel = "media/lfs/2026/dddddddddddd.pdf";
    await fsp.mkdir(path.join(dir, "media/lfs/2026"), { recursive: true });
    // The working-tree file is still an LFS pointer (skip-smudge clone).
    await fsp.writeFile(path.join(dir, rel), "version https://git-lfs.github.com/spec/v1\noid sha256:x\nsize 3\n");
    await fsp.writeFile(path.join(dir, "media/manifests/2026/dddddddddddd.json"), JSON.stringify({
      schema_version: 2, hash: "sha256:" + hash, mime: "application/pdf", inline: null, lfs: rel, visibility: null,
    }));
    // Deferred fetch: resolving it materializes the real blob (the smudge).
    let calls = 0, doResolve;
    ctx.syncMgr = {
      lfsFetch: () => { calls++; return new Promise((res) => { doResolve = async () => { await fsp.writeFile(path.join(dir, rel), Buffer.from("PDF")); res(); }; }); },
    };
    const route = routes["GET /api/vault/media/:hash"];
    const p1 = callRoute(route, makeReq({ hash: h12 }));
    const p2 = callRoute(route, makeReq({ hash: h12 }));
    await new Promise((r) => setTimeout(r, 60)); // let both reach the fetch
    assert.strictEqual(calls, 1, "concurrent viewers of one un-smudged object share ONE git lfs pull");
    await doResolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.statusCode, 200);
    assert.strictEqual(r2.statusCode, 200);
    assert.strictEqual(r1.headers["content-type"], "application/pdf");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media route: an LFS fetch failure degrades (no other tier -> 404)", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes, ctx } = mountVault(dir);
    const h12 = "eeeeeeeeeeee";
    const rel = "media/lfs/2026/eeeeeeeeeeee.pdf";
    await fsp.mkdir(path.join(dir, "media/lfs/2026"), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), "version https://git-lfs.github.com/spec/v1\noid sha256:y\nsize 3\n");
    await fsp.writeFile(path.join(dir, "media/manifests/2026/eeeeeeeeeeee.json"), JSON.stringify({
      schema_version: 2, hash: "sha256:" + h12 + "0".repeat(52), mime: "application/pdf", lfs: rel, visibility: null,
    }));
    ctx.syncMgr = { lfsFetch: () => Promise.reject(new Error("lfs offline")) };
    const res = await callRoute(routes["GET /api/vault/media/:hash"], makeReq({ hash: h12 }));
    assert.strictEqual(res.statusCode, 404, "fetch failed, no other tier -> degrade to 404");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media index: a deleted manifest is evicted (404), not served stale", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];
    const before = await callRoute(h, makeReq({ hash: "3580b71a64e3" })); // caches it
    assert.strictEqual(before.statusCode, 200);
    await fsp.rm(path.join(dir, "media/manifests/2026/3580b71a64e3.json")); // git pull removes it
    const after = await callRoute(h, makeReq({ hash: "3580b71a64e3" }));
    assert.strictEqual(after.statusCode, 404, "stale cache entry evicted, not served");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media index: an in-place manifest update is re-read (mtime change)", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];
    const mf = path.join(dir, "media/manifests/2026/cccccccccccc.json"); // starts cold-only -> 409
    const cold = await callRoute(h, makeReq({ hash: "cccccccccccc" }));
    assert.strictEqual(cold.statusCode, 409);
    // Provisioning writes an inline copy into the same manifest; bump mtime so the
    // change is detectable regardless of sub-ms write resolution.
    await fsp.mkdir(path.join(dir, "media/blobs/2026"), { recursive: true });
    await fsp.writeFile(path.join(dir, "media/blobs/2026/cccccccccccc.png"), Buffer.from([1, 2, 3, 4]));
    await fsp.writeFile(mf, JSON.stringify({
      schema_version: 2, hash: "sha256:cccccccccccc" + "0".repeat(52), mime: "image/png",
      inline: "media/blobs/2026/cccccccccccc.png", cold: { provider: "s3", bucket: "mycelium-cold", key: "k", class: "DEEP_ARCHIVE" }, visibility: null,
    }));
    const future = new Date(Date.now() + 5000);
    await fsp.utimes(mf, future, future);
    const after = await callRoute(h, makeReq({ hash: "cccccccccccc" }));
    assert.strictEqual(after.statusCode, 200, "updated manifest re-read; now serves the inline tier");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("cacheManifest: a private-subtree manifest is sensitive by LOCATION even without the field", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];
    // A private manifest whose visibility field is null/missing must STILL gate.
    await fsp.mkdir(path.join(dir, "media/blobs/private/2026"), { recursive: true });
    await fsp.writeFile(path.join(dir, "media/blobs/private/2026/faceface0001.png"), Buffer.from([9, 9, 9]));
    await fsp.writeFile(path.join(dir, "media/manifests/private/2026/faceface0001.json"), JSON.stringify({
      schema_version: 2, hash: "sha256:faceface0001" + "0".repeat(52), mime: "image/png",
      inline: "media/blobs/private/2026/faceface0001.png", warm: { provider: "r2", bucket: "mycelium-warm", key: "k" }, visibility: null,
    }));
    const locked = await callRoute(h, makeReq({ hash: "faceface0001", unlocked: false }));
    assert.strictEqual(locked.statusCode, 403, "private-location manifest gates even with visibility:null");
    assert.strictEqual(locked.body.sensitive, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("media index: a manifest that arrives after the first request is found by the walk fallback", async () => {
  const { dir } = await makeFixtureVault();
  try {
    const { routes } = mountVault(dir);
    const h = routes["GET /api/vault/media/:hash"];
    // First request builds the index without the new manifest.
    const before = await callRoute(h, makeReq({ hash: "aaaaaaaaaaaa" }));
    assert.strictEqual(before.statusCode, 404);
    // Simulate a git pull landing a new manifest+blob (not seen by the .md watcher).
    await fsp.mkdir(path.join(dir, "media/blobs/2026"), { recursive: true });
    await fsp.writeFile(path.join(dir, "media/blobs/2026/aaaaaaaaaaaa.png"), Buffer.from([1, 2, 3]));
    await fsp.writeFile(path.join(dir, "media/manifests/2026/aaaaaaaaaaaa.json"), JSON.stringify({
      schema_version: 2, hash: "sha256:aaaaaaaaaaaa0000000000000000000000000000000000000000000000000000", mime: "image/png",
      inline: "media/blobs/2026/aaaaaaaaaaaa.png", visibility: null,
    }));
    const after = await callRoute(h, makeReq({ hash: "aaaaaaaaaaaa" }));
    assert.strictEqual(after.statusCode, 200, "self-heals via the lazy walk fallback");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("node route: node.media annotates each embed with kind + tiers; locked private ref reported unavailable", async () => {
  const { dir, pngHash } = await makeFixtureVault();
  try {
    const { routes, ctx } = mountVault(dir);
    ctx._nodes["notes/withmedia"] = {
      slug: "notes/withmedia",
      frontmatter: { type: "note" },
      body: `Here is a pic:\n![shot](media:sha256:${pngHash})\nand a private one ![x](media:sha256:bbbbbbbbbbbb0000000000000000000000000000000000000000000000000000)`,
      backlinks: [], outlinks: [], hash: "h",
    };
    const h = routes["GET /api/vault/node/*"];
    const res = await callRoute(h, makeReq({ params: { 0: "notes/withmedia" }, unlocked: false }));
    assert.strictEqual(res.statusCode, 200);
    const media = res.body.media;
    assert.strictEqual(media[pngHash].kind, "image");
    assert.strictEqual(media[pngHash].available, true);
    assert.strictEqual(media[pngHash].tiers.inline, true);
    // The private embed on this (public) note, while locked, is reported locked, not leaked.
    assert.strictEqual(media["bbbbbbbbbbbb0000000000000000000000000000000000000000000000000000"].available, false);
    assert.strictEqual(media["bbbbbbbbbbbb0000000000000000000000000000000000000000000000000000"].locked, true);
    // The body was rewritten to placeholder divs the client upgrades.
    assert.match(res.body.renderedBody, /<div class="vault-media" data-media-hash="/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
