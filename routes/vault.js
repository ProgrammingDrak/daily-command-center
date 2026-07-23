// Extracted from server.js. `ctx.vault` / `ctx.syncMgr` are accessed live (they are
// initialized during startup after routes mount), via getters on ctx.

const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const multer = require("multer");
const matter = require("gray-matter");

// The shared vault parser (.mycelium/lib/parse.js) is the ONE source of truth
// for the wikilink regex + tag color math (Track A owns it; B/C/D require it,
// never fork it). It lives inside the cloned vault, so we resolve it lazily
// from the live VaultStore's vaultDir and cache per-dir. gray-matter resolves
// up-tree from either the vault's own .mycelium/node_modules (local) or DCC's
// node_modules (prod, where VAULT_DIR is a subdir of the app).
//
// TRUST BOUNDARY: require()-ing code out of the git-synced vault means push
// access to VAULT_REPO_URL is equivalent to code execution on the DCC host.
// This is a deliberate consequence of A1's "one shared parser" mandate. Keep
// the vault repo's write access (and any CI/collaborator token on it) inside
// the same trust boundary as the server; it must be as trusted as DCC itself.
let _parse = { dir: null, mod: null };
function loadParse(ctx) {
  const dir = ctx.vault && ctx.vault.vaultDir;
  if (!dir) return null;
  if (_parse.dir === dir) return _parse.mod;
  let mod = null;
  try {
    mod = require(path.join(dir, ".mycelium", "lib", "parse.js"));
  } catch (e) {
    console.warn("[vault] shared parser unavailable at", dir, "-", e.message);
  }
  _parse = { dir, mod };
  return mod;
}

// Schema (.mycelium/schema.yml) drives the type picker, per-type home dirs, and
// which fields a type requires. Loaded via the shared parser's loadSchema (no
// fork) and cached per-dir. Returns null when the parser/schema is unavailable.
let _schema = { dir: null, val: null };
function loadSchema(ctx) {
  const dir = ctx.vault && ctx.vault.vaultDir;
  const parse = loadParse(ctx);
  if (!dir || !parse || !parse.loadSchema) return null;
  if (_schema.dir === dir && _schema.val) return _schema.val;
  let val = null;
  try { val = parse.loadSchema(dir); } catch (e) { console.warn("[vault] schema load failed:", e.message); }
  _schema = { dir, val };
  return val;
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) {
  return escHtml(s).replace(/"/g, "&quot;");
}

// Sensitive-dir set (mirrors CONVENTIONS.md and the client's SENSITIVE_PREFIXES).
// Path is authoritative. Enforced below: sensitive node bodies are refused (403)
// unless the session is PIN-unlocked; a sensitive source's body never leaks as a
// backlink context snippet on a non-sensitive note while locked; and sensitive
// WRITES (create/edit/attach) are refused while locked. git-crypt (A2) keeps
// these dirs encrypted at rest; the PIN here is UI-level gating (see UNLOCK.md).
const SENSITIVE_PREFIXES = ["health/therapy/", "health/moments/", "health/medical/", "journal/private/"];
function isSensitiveSlug(slug) {
  return SENSITIVE_PREFIXES.some((p) => (slug + "/").startsWith(p) || slug.startsWith(p));
}

// ── Sensitive PIN unlock (session-scoped, 30 min) ──
// Constant-time compare of the submitted PIN against VAULT_SENSITIVE_PIN. Both
// sides are sha256'd to a fixed 32 bytes first so timingSafeEqual never sees a
// length mismatch (which would itself leak the PIN length). The unlock is honest
// UI gating only: once git-crypt has decrypted the dirs, the plaintext is on the
// server disk regardless (documented tradeoff, UNLOCK.md §2).
const UNLOCK_MS = 30 * 60 * 1000;
function pinMatches(input, expected) {
  if (!expected || input == null) return false;
  const a = crypto.createHash("sha256").update(String(input)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
function isUnlocked(req) {
  return !!(req.session && req.session.vaultUnlockedUntil && req.session.vaultUnlockedUntil > Date.now());
}

// Rewrite [[wikilinks]] in the body to inline anchors the tab can click through,
// using parse.js's canonical WIKILINK_RE so link detection matches the graph
// exactly. Unknown targets get a `dangling` class (dimmed in the UI). The client
// runs marked + DOMPurify over the result; DOMPurify keeps class + data-slug.
// Known limitation (B1): wikilinks inside code spans/fences are linkified too,
// which mirrors how VaultStore already counts them as edges.
function renderWikilinks(body, parse, vault) {
  if (typeof body !== "string" || !body) return body;
  return body.replace(parse.WIKILINK_RE, (full, target) => {
    const inner = full.slice(2, -2);
    const pipe = inner.indexOf("|");
    const t = String(target).trim();
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : t;
    const cls = "wikilink" + (vault.has && !vault.has(t) ? " dangling" : "");
    return `<a class="${cls}" data-slug="${escAttr(t)}">${escHtml(alias)}</a>`;
  });
}

// ── Slug + placement helpers (schema-driven) ──
function slugify(s) {
  return String(s || "")
    .toLowerCase().trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}
function currentYear() { return String(new Date().getFullYear()); }
function typeDir(schema, type) {
  const t = schema && schema.types && schema.types[type];
  return t && t.dir ? t.dir : null;
}
function hasPlaceholder(dir) { return /<[^>]+>/.test(dir); }
// dir with YYYY expanded to the current year (for NEW-node placement).
function expandDir(dir) { return String(dir).replace(/YYYY/g, currentYear()).replace(/\/+$/, ""); }
// Regex that matches any slug living under a type's dir, treating YYYY as any
// 4-digit year and <...> as any single segment — so editing an OLD year's
// journal still validates. Used by PUT's type->dir guard.
function dirRegex(dir) {
  const rx = String(dir).replace(/\/+$/, "").split("/").map((seg) => {
    if (seg === "YYYY") return "\\d{4}";
    if (/^<.+>$/.test(seg)) return "[^/]+";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return new RegExp("^" + rx + "(/|$)");
}
// Does `slug` live in the home dir that `type` mandates? Unknown/untyped/
// placeholder-dir types are not blocked (legacy + Obsidian-authored nodes).
function typeDirOk(schema, slug, type) {
  if (!type) return true;
  const dir = typeDir(schema, type);
  if (!dir || hasPlaceholder(dir)) return true;
  const base = String(dir).replace(/\/+$/, "");
  if (!base) return true;
  return dirRegex(dir).test(slug);
}

function ext(filename, mime) {
  const fromName = (String(filename || "").match(/\.([a-z0-9]{1,8})$/i) || [])[1];
  if (fromName) return fromName.toLowerCase();
  const m = String(mime || "").split("/")[1];
  return (m ? m.replace(/[^a-z0-9]/gi, "") : "bin").toLowerCase();
}

const INLINE_MAX = 2 * 1024 * 1024;
const LFS_MAX = 10 * 1024 * 1024;

// Media gate v2 (frozen media-manifest-spec). Picks an original's band from size
// + kind. Sensitive media is inline-only under private/ (never LFS/cold, which
// would leak plaintext off-machine). Throws a TOO_BIG error for the deep-archive
// tier (>10 MB or any video) — not this phase. Pure + exported so the band
// routing is unit-testable without buffering a real file. Callers build the
// blob/manifest paths from the returned band + the content hash.
function mediaPlacement({ bytes, mime, sensitive }) {
  if (sensitive) return { band: "inline-private" };
  if (String(mime || "").startsWith("video/") || bytes > LFS_MAX) {
    const err = new Error("big media goes through mycelium-media ingest");
    err.code = "TOO_BIG";
    throw err;
  }
  return bytes < INLINE_MAX ? { band: "inline" } : { band: "lfs" };
}

function mount(app, ctx) {
  const { VAULT_REPO_URL } = ctx;

  // multer: in-memory, 12 MB request cap (the gate-v2 hard error fires above 10
  // MB inside the handler; multer rejects >12 MB before we ever buffer it).
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 10 } });

// ── Vault API (Phase 1) ──
// The vault is a git-backed markdown store that holds long-term memory.
// Postgres is working memory (intraday state). These endpoints expose the
// in-memory VaultStore index and typed graph; writes route through the
// SyncManager for durable commit+push.
function vaultReady(res) {
  if (!ctx.vault || !ctx.vault.ready) { res.status(503).json({ error: "vault not ready" }); return false; }
  return true;
}

// Commit a node to disk (VaultStore.write) + queue the durable push. Never logs
// the body — the commit message carries slugs only.
async function writeNode(slug, frontmatter, body, { message, expectedHash } = {}) {
  const node = await ctx.vault.write(slug, { frontmatter: frontmatter || {}, body: body || "", expectedHash });
  if (ctx.syncMgr) ctx.syncMgr.notifyChange({ slug, message: message || `update ${slug}` });
  return node;
}

app.get("/api/vault/status", (req, res) => {
  const sync = ctx.syncMgr ? ctx.syncMgr.getStatus() : { status: "disabled" };
  res.json({
    vault: ctx.vault && ctx.vault.ready ? ctx.vault.indexSummary() : { ready: false },
    sync,
    remote: VAULT_REPO_URL ? "configured" : "none",
    // Client uses these to decide the unlock affordance + whether to fetch
    // sensitive bodies. pinConfigured=false hides "Unlock" entirely.
    sensitiveUnlocked: isUnlocked(req),
    pinConfigured: !!ctx.VAULT_SENSITIVE_PIN,
  });
});

// PIN unlock: sets a 30-min session flag that opens sensitive gets/writes.
// Throttled: the PIN is short + numeric, so an authenticated session must not
// get unlimited online guesses. After 5 misses the endpoint locks for this
// session with escalating backoff (30s doubling, capped at 15 min).
app.post("/api/vault/unlock", (req, res) => {
  if (!ctx.VAULT_SENSITIVE_PIN) return res.status(503).json({ error: "sensitive unlock not configured" });
  const now = Date.now();
  const s = req.session;
  if (s && s.vaultUnlockLockUntil && s.vaultUnlockLockUntil > now) {
    return res.status(429).json({ error: `too many attempts, try again in ${Math.ceil((s.vaultUnlockLockUntil - now) / 1000)}s` });
  }
  const pin = req.body && req.body.pin;
  if (!pinMatches(pin, ctx.VAULT_SENSITIVE_PIN)) {
    if (s) {
      const fails = (s.vaultUnlockFails || 0) + 1;
      s.vaultUnlockFails = fails;
      if (fails >= 5) s.vaultUnlockLockUntil = now + Math.min(30_000 * 2 ** (fails - 5), 15 * 60_000);
    }
    return res.status(401).json({ error: "incorrect PIN" });
  }
  if (s) { s.vaultUnlockedUntil = now + UNLOCK_MS; s.vaultUnlockFails = 0; s.vaultUnlockLockUntil = 0; }
  res.json({ unlocked: true, until: (s && s.vaultUnlockedUntil) || null });
});

app.post("/api/vault/lock", (req, res) => {
  if (req.session) req.session.vaultUnlockedUntil = 0;
  res.json({ unlocked: false });
});

app.get("/api/vault/nodes", (req, res) => {
  if (!vaultReady(res)) return;
  const { type, subtype, has, since } = req.query;
  res.json(ctx.vault.list({ type, subtype, hasField: has, sinceDate: since }));
});

// Schema for the editor: type list + each type's home dir, template, required
// fields, and sensitive flag. Placeholder-dir types (dnd sessions, meetings)
// are flagged `needsPath` so the client can hide them from quick-create.
app.get("/api/vault/schema", (req, res) => {
  const schema = loadSchema(ctx);
  if (!schema || !schema.types) return res.json({ available: false, types: [] });
  const types = Object.entries(schema.types).map(([name, def]) => ({
    type: name,
    dir: def.dir || null,
    template: def.template || null,
    required: def.required || schema.frontmatter?.required || [],
    sensitive: !!def.sensitive || isSensitiveSlug((expandDir(def.dir || "") + "/x")),
    external: !!def.external_writer,
    needsPath: def.dir ? hasPlaceholder(def.dir) : true,
  }));
  res.json({
    available: true,
    schema_version: schema.schema_version || null,
    frontmatter: schema.frontmatter || {},
    types,
  });
});

// Parsed starter template for a type (frontmatter + body scaffold). The editor
// prefills from this; date/created are stamped client-side to today.
app.get("/api/vault/template/:type", async (req, res) => {
  const schema = loadSchema(ctx);
  const def = schema && schema.types && schema.types[req.params.type];
  if (!def) return res.status(404).json({ error: "unknown type" });
  if (!def.template) return res.json({ frontmatter: { type: req.params.type }, body: "" });
  const file = path.join(ctx.vault.vaultDir, ".mycelium", "templates", def.template);
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = matter(raw);
    res.json({ frontmatter: parsed.data || {}, body: parsed.content || "" });
  } catch {
    res.json({ frontmatter: { type: req.params.type }, body: "" });
  }
});

app.get("/api/vault/node/*", (req, res) => {
  if (!vaultReady(res)) return;
  // Normalize BEFORE the sensitive check so it matches the store's own slug
  // (a `..` inside a segment would otherwise dodge the gate then normalize into
  // a sensitive dir). See VaultStore.normalizeSlug.
  const slug = ctx.vault.normalizeSlug(req.params[0]);
  // Sensitive bodies are served only to a PIN-unlocked session; otherwise 403.
  // The client shows a locked placeholder and does not fetch, so this fires on a
  // direct API hit — the backstop that makes "contents stay locked" real.
  if (isSensitiveSlug(slug) && !isUnlocked(req)) {
    return res.status(403).json({ error: "locked", sensitive: true });
  }
  const node = ctx.vault.get(slug);
  if (!node) return res.status(404).json({ error: "not found" });
  const parse = loadParse(ctx);
  if (parse && parse.WIKILINK_RE) {
    node.renderedBody = renderWikilinks(node.body, parse, ctx.vault);
  }
  // A sensitive source note links to this one: show the mention exists but strip
  // its context snippet while locked (it would leak a slice of the sensitive
  // body through this endpoint). Unlocked sessions keep the context.
  if (!isUnlocked(req)) {
    for (const b of node.backlinks || []) {
      if (b && b.source && isSensitiveSlug(b.source)) b.context = null;
    }
  }
  res.json(node);
});

// Ontology-driven tag colors. Precomputes a hex per tag currently in the vault
// via parse.colorForTags (single source of truth for the color math) so the
// client renders colored chips without porting the algorithm. Degrades to an
// empty map when the shared parser or ontology.yml is absent.
app.get("/api/vault/ontology", (req, res) => {
  const parse = loadParse(ctx);
  const fallback = { tagColors: {}, unmapped: "#9ca3af", available: false };
  if (!parse || !parse.loadOntology || !parse.colorForTags) return res.json(fallback);
  let ontology;
  try { ontology = parse.loadOntology(ctx.vault.vaultDir); }
  catch { return res.json(fallback); }
  const tagColors = {};
  if (ctx.vault && ctx.vault.ready) {
    for (const n of ctx.vault.list()) {
      const raw = (n.frontmatter && n.frontmatter.tags) || [];
      const list = Array.isArray(raw) ? raw : [raw];
      for (const t of list) {
        if (typeof t !== "string" || tagColors[t]) continue;
        try { tagColors[t] = parse.colorForTags([t], ontology).hex; } catch { /* skip */ }
      }
    }
  }
  const render = ontology.render || {};
  res.json({ tagColors, unmapped: render.unmapped || "#9ca3af", available: true });
});

// Create a new node. Server owns slug placement (schema home dir + slugified
// title + collision suffix) so the dir rule can't be bypassed. Sensitive types
// require an unlocked session.
app.post("/api/vault/create", async (req, res) => {
  if (!vaultReady(res)) return;
  const { type, title, frontmatter, body } = req.body || {};
  const schema = loadSchema(ctx);
  if (!type || typeof type !== "string") return res.status(400).json({ error: "type required" });
  const def = schema && schema.types && schema.types[type];
  if (!def) return res.status(400).json({ error: `unknown type: ${type}` });
  if (hasPlaceholder(def.dir || "")) {
    return res.status(400).json({ error: `type "${type}" needs an explicit path — create it in Obsidian` });
  }
  const base = expandDir(def.dir || "");
  const leaf = slugify(title || (frontmatter && frontmatter.title) || "untitled");
  let slug = base ? `${base}/${leaf}` : leaf;
  for (let i = 2; ctx.vault.has(slug); i++) slug = `${base ? base + "/" : ""}${leaf}-${i}`;
  if (isSensitiveSlug(slug) && !isUnlocked(req)) return res.status(403).json({ error: "locked", sensitive: true });
  const fm = Object.assign({}, frontmatter || {}, { type });
  if (title && !fm.title) fm.title = title;
  try {
    const node = await writeNode(slug, fm, body, { message: `create ${slug}` });
    res.status(201).json({ slug, node });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Zero-friction capture -> a `fleeting` node in inbox/ with only `created`
// stamped. Title optional; slug is title-or-timestamp based.
app.post("/api/vault/capture", async (req, res) => {
  if (!vaultReady(res)) return;
  const { text, title } = req.body || {};
  if (!text && !title) return res.status(400).json({ error: "text required" });
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const leaf = title ? slugify(title) : `note-${stamp}`;
  let slug = `inbox/${leaf}`;
  for (let i = 2; ctx.vault.has(slug); i++) slug = `inbox/${leaf}-${i}`;
  const fm = { type: "fleeting", created: now.toISOString() };
  if (title) fm.title = title;
  try {
    const node = await writeNode(slug, fm, text || "", { message: `capture ${slug}` });
    res.status(201).json({ slug, node });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One-tap daily note: today's journal. Idempotent — returns the existing note if
// it's already there (never duplicates), else creates it from the journal template.
app.post("/api/vault/daily", async (req, res) => {
  if (!vaultReady(res)) return;
  // "Today" must use the app timezone (getTodayStr -> APP_TIME_ZONE), not UTC:
  // an evening-ET UTC date has already rolled to tomorrow, which would open/
  // create the wrong day's journal. Derive the year from the same string so the
  // two segments can never disagree (New Year's Eve).
  const iso = ctx.getTodayStr ? ctx.getTodayStr() : new Date().toISOString().slice(0, 10);
  const y = iso.slice(0, 4);
  const slug = `journal/${y}/${iso}`;
  if (ctx.vault.has(slug)) return res.json({ slug, node: ctx.vault.get(slug), created: false });
  let tpl = { data: {}, content: "" };
  const schema = loadSchema(ctx);
  const def = schema && schema.types && schema.types.journal;
  if (def && def.template) {
    try { tpl = matter(await fsp.readFile(path.join(ctx.vault.vaultDir, ".mycelium", "templates", def.template), "utf8")); }
    catch {}
  }
  const fm = Object.assign({}, tpl.data || {}, { type: "journal", title: iso, date: iso });
  try {
    const node = await writeNode(slug, fm, tpl.content || "", { message: `daily ${slug}` });
    res.status(201).json({ slug, node, created: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/vault/node/*", async (req, res) => {
  if (!vaultReady(res)) return;
  // Normalize before the sensitive gate so `..` can't smuggle a write into a
  // sensitive dir while locked (the store normalizes identically on write).
  const slug = ctx.vault.normalizeSlug(req.params[0]);
  const { frontmatter, body, message, expectedHash } = req.body || {};
  // Sensitive writes need an unlocked session (mirrors the read gate + the MCP
  // MYCELIUM_ALLOW_SENSITIVE rule from D2's conventions).
  if (isSensitiveSlug(slug) && !isUnlocked(req)) return res.status(403).json({ error: "locked", sensitive: true });
  // type -> home-dir guard: a node's frontmatter type must match its location.
  const schema = loadSchema(ctx);
  const t = frontmatter && frontmatter.type;
  if (!typeDirOk(schema, slug, t)) {
    return res.status(400).json({ error: `type "${t}" does not belong in ${slug}` });
  }
  try {
    const node = await writeNode(slug, frontmatter, body, { message, expectedHash });
    res.json(node);
  } catch (e) {
    if (e && e.code === "STALE_WRITE") {
      return res.status(409).json({ error: "conflict", currentHash: e.currentHash });
    }
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/vault/node/*", async (req, res) => {
  if (!vaultReady(res)) return;
  // Normalize before the sensitive gate (see PUT) — a locked session must not be
  // able to DELETE a sensitive note via a `..` slug.
  const slug = ctx.vault.normalizeSlug(req.params[0]);
  if (isSensitiveSlug(slug) && !isUnlocked(req)) return res.status(403).json({ error: "locked", sensitive: true });
  try {
    const removed = await ctx.vault.delete(slug);
    if (!removed) return res.status(404).json({ error: "not found" });
    if (ctx.syncMgr) ctx.syncMgr.notifyChange({ slug, message: `delete ${slug}` });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/vault/graph/*", (req, res) => {
  if (!vaultReady(res)) return;
  const slug = req.params[0];
  res.json(ctx.vault.graph(slug));
});

// ── Attachments (media gate v2) ──
// Write an original into the right band, drop a spec-v2 manifest beside it, and
// queue the commit. Returns the content-addressed ref the editor inserts.
async function ingestMedia(buf, filename, mime, { sensitive } = {}) {
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const hash12 = sha256.slice(0, 12);
  const year = currentYear();
  const bytes = buf.length;
  const e = ext(filename, mime);

  const { band } = mediaPlacement({ bytes, mime, sensitive }); // throws TOO_BIG for the deep tier
  let inline = null, lfs = null;
  if (band === "inline-private") inline = `media/blobs/private/${year}/${hash12}.${e}`;
  else if (band === "inline") inline = `media/blobs/${year}/${hash12}.${e}`;
  else lfs = `media/lfs/${year}/${hash12}.${e}`;

  const blobRel = inline || lfs;
  const blobAbs = path.join(ctx.vault.vaultDir, blobRel);
  await fsp.mkdir(path.dirname(blobAbs), { recursive: true });
  await fsp.writeFile(blobAbs, buf);

  const manifestRel = sensitive
    ? `media/manifests/private/${year}/${hash12}.json`
    : `media/manifests/${year}/${hash12}.json`;
  const manifest = {
    schema_version: 2,
    hash: `sha256:${sha256}`,
    filename: filename || `${hash12}.${e}`,
    mime: mime || "application/octet-stream",
    bytes,
    created: new Date().toISOString(),
    dims: null,
    duration_s: null,
    inline,
    lfs,
    lowres: null,
    warm: null,
    cold: null,
    local_copies: [],
    album: "",
    exif: {},
    text_sidecar: null,
    visibility: sensitive ? "sensitive" : null,
  };
  const manifestAbs = path.join(ctx.vault.vaultDir, manifestRel);
  await fsp.mkdir(path.dirname(manifestAbs), { recursive: true });
  await fsp.writeFile(manifestAbs, JSON.stringify(manifest, null, 2) + "\n");

  // Commit both files together (git add . via the sync queue). Message carries
  // the hash only — never the filename of sensitive media.
  if (ctx.syncMgr) ctx.syncMgr.notifyChange({ slug: blobRel, message: `attach ${hash12} (${band})` });
  return { hash: sha256, ref: `media:sha256:${sha256}`, band, filename: manifest.filename, mime: manifest.mime, bytes };
}

app.post("/api/vault/attach", (req, res) => {
  if (!vaultReady(res)) return;
  upload.single("file")(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "big media goes through mycelium-media ingest" });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: "no file" });
    // Attaching to a sensitive node routes the media into the encrypted private/
    // subtree and requires an unlocked session. Normalize first so `..` can't
    // both dodge the unlock check AND land the blob outside the private tree.
    const targetSlug = ctx.vault.normalizeSlug((req.body && req.body.slug) || "");
    const sensitive = isSensitiveSlug(targetSlug);
    if (sensitive && !isUnlocked(req)) return res.status(403).json({ error: "locked", sensitive: true });
    try {
      const out = await ingestMedia(req.file.buffer, req.file.originalname, req.file.mimetype, { sensitive });
      res.status(201).json(out);
    } catch (e) {
      if (e.code === "TOO_BIG") return res.status(413).json({ error: e.message });
      res.status(400).json({ error: e.message });
    }
  });
});

// Serve an INLINE media blob by hash (v1). LFS + warm/cold serving is B3; this
// route grows there. Sensitive (private/) blobs need an unlocked session.
async function findManifest(hash12) {
  const roots = [
    path.join(ctx.vault.vaultDir, "media", "manifests"),
    path.join(ctx.vault.vaultDir, "media", "manifests", "private"),
  ];
  for (const root of roots) {
    let years;
    try { years = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const y of years) {
      if (!y.isDirectory()) continue;
      const f = path.join(root, y.name, `${hash12}.json`);
      try { return { path: f, manifest: JSON.parse(await fsp.readFile(f, "utf8")) }; } catch { /* keep looking */ }
    }
  }
  return null;
}

app.get("/api/vault/media/:hash", async (req, res) => {
  if (!vaultReady(res)) return;
  const hex = String(req.params.hash).replace(/^sha256:/, "").toLowerCase();
  if (!/^[a-f0-9]{12,64}$/.test(hex)) return res.status(400).json({ error: "bad hash" });
  const found = await findManifest(hex.slice(0, 12));
  if (!found) return res.status(404).json({ error: "not found" });
  const m = found.manifest;
  if (m.visibility === "sensitive" && !isUnlocked(req)) return res.status(403).json({ error: "locked", sensitive: true });
  if (!m.inline) return res.status(415).json({ error: "not an inline blob (LFS/cold serving lands in B3)" });
  const abs = path.join(ctx.vault.vaultDir, m.inline);
  try {
    const buf = await fsp.readFile(abs);
    res.setHeader("Content-Type", m.mime || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(buf);
  } catch {
    res.status(404).json({ error: "blob missing" });
  }
});

// PWA share_target (manifest action=/api/vault/share, method POST, enctype
// multipart). Turns a share into a fleeting inbox note; shared files route
// through the attach bands and get appended as media refs. Redirects back into
// the app so the share sheet closes cleanly.
app.post("/api/vault/share", (req, res) => {
  if (!vaultReady(res)) { return res.redirect(303, "/?vault_share=err"); }
  upload.any()(req, res, async (err) => {
    if (err) return res.redirect(303, "/?vault_share=err");
    try {
      const b = req.body || {};
      const parts = [];
      if (b.title) parts.push(`# ${b.title}`);
      if (b.text) parts.push(b.text);
      if (b.url) parts.push(b.url);
      let body = parts.join("\n\n");
      for (const f of req.files || []) {
        try {
          const out = await ingestMedia(f.buffer, f.originalname, f.mimetype, { sensitive: false });
          body += `\n\n![${(out.filename || "attachment").replace(/[[\]]/g, "")}](${out.ref})`;
        } catch { /* skip oversize/video shares; the text note still lands */ }
      }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      let slug = `inbox/share-${stamp}`;
      for (let i = 2; ctx.vault.has(slug); i++) slug = `inbox/share-${stamp}-${i}`;
      await writeNode(slug, { type: "fleeting", created: new Date().toISOString() }, body, { message: `share ${slug}` });
      res.redirect(303, "/?vault_share=ok");
    } catch {
      res.redirect(303, "/?vault_share=err");
    }
  });
});

app.post("/api/vault/flush", async (req, res) => {
  if (!ctx.syncMgr) return res.status(503).json({ error: "sync disabled" });
  try { await ctx.syncMgr.flushAndPush(); res.json(ctx.syncMgr.getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

}

module.exports = mount;
// Exposed for unit tests (vault-b1.test.js, vault-b2.test.js).
module.exports.renderWikilinks = renderWikilinks;
module.exports.isSensitiveSlug = isSensitiveSlug;
module.exports.pinMatches = pinMatches;
module.exports.slugify = slugify;
module.exports.typeDirOk = typeDirOk;
module.exports.dirRegex = dirRegex;
module.exports.mediaPlacement = mediaPlacement;
