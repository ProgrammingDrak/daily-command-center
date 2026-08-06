// Extracted from server.js. `ctx.vault` / `ctx.syncMgr` are accessed live (they are
// initialized during startup after routes mount), via getters on ctx.

const path = require("path");
const fs = require("fs");
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

// ontology.yml (the tag color wheel) via the shared parser, cached per-dir like
// loadSchema so the timeline endpoint doesn't readFileSync + parse YAML on every
// request. Returns null when the parser/ontology is unavailable (colors degrade).
let _ontology = { dir: null, val: null };
function loadOntology(ctx) {
  const dir = ctx.vault && ctx.vault.vaultDir;
  const parse = loadParse(ctx);
  if (!dir || !parse || !parse.loadOntology) return null;
  if (_ontology.dir === dir && _ontology.val) return _ontology.val;
  let val = null;
  try { val = parse.loadOntology(dir); } catch (e) { console.warn("[vault] ontology load failed:", e.message); }
  _ontology = { dir, val };
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

// ── Media serving v2 (B3): resolution + render helpers ──
// The editor embeds attachments as `![alt](media:sha256:<hex>)`. These helpers
// turn a manifest into (a) the element kind the client should render and (b) the
// ordered list of tiers the media route tries. All pure + exported for tests.

// Which HTML element a mime maps to. `file` = a download link fallback.
function mediaKind(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  return "file";
}

// A git-LFS pointer file is a tiny text blob whose first line is the spec URL.
// The vault clones with GIT_LFS_SKIP_SMUDGE=1, so an un-viewed lfs original is
// still a pointer on disk; the route smudges it on first view. Check only the
// head bytes (pointers are ~130 bytes; a real media file won't start with this).
function isLfsPointer(head) {
  return typeof head === "string" && /^version https:\/\/git-lfs\.github\.com\/spec\//.test(head);
}

// The ordered tiers the media route should try for a given variant, honoring the
// frozen spec's render resolution order. Server has no local disk, so it never
// tries `local_copies` (step 1). Sensitive media is inline-only by spec (never
// LFS/warm/cold, which would put plaintext off-machine) — so a `sensitive`
// manifest resolves to its inline copy alone and NEVER presigns to R2.
//   auto     -> original (inline|lfs) -> warm (R2) -> lowres
//   original -> the inline|lfs original only (else cold, i.e. "in deep freeze")
//   lowres   -> lowres -> warm -> original
// If nothing is servable but a `cold` locator exists, the single {tier:"cold"}
// candidate is returned so the route can emit the deep-freeze note.
function mediaCandidates(m, variant) {
  const v = variant || "auto";
  if (m.visibility === "sensitive") {
    return m.inline ? [{ tier: "inline", path: m.inline }] : [];
  }
  const original = m.inline ? { tier: "inline", path: m.inline }
    : (m.lfs ? { tier: "lfs", path: m.lfs } : null);
  const warm = m.warm ? { tier: "warm", warm: m.warm } : null;
  const lowres = (m.lowres && m.lowres.path) ? { tier: "lowres", path: m.lowres.path } : null;
  const cold = m.cold ? { tier: "cold" } : null;
  let out;
  if (v === "original") out = [original];
  else if (v === "lowres") out = [lowres, warm, original];
  else out = [original, warm, lowres]; // auto
  out = out.filter(Boolean);
  if (!out.length && cold) out = [cold];
  return out;
}

// Rewrite `![alt](media:sha256:<hex>)` embeds to a placeholder the client
// upgrades (via node.media) into the right element. A block-level <div> (not an
// inline <span>) is used deliberately: marked wraps loose inline HTML in a <p>,
// which for an album would nest every figure inside ONE paragraph and break the
// CSS grid — a block <div> stays a top-level child of .vault-body-md, so the
// figures become real grid items. Kept separate from renderWikilinks (disjoint
// syntax) and run after it. alt is attribute-escaped; hex is validated by the
// regex. Plain `[text](media:...)` links are left alone (the editor only emits
// the image-embed form).
const MEDIA_REF_RE = /!\[([^\]]*)\]\(media:sha256:([a-fA-F0-9]{12,64})\)/g;
function renderMediaRefs(body) {
  if (typeof body !== "string" || !body) return body;
  return body.replace(MEDIA_REF_RE, (full, alt, hex) =>
    `<div class="vault-media" data-media-hash="${String(hex).toLowerCase()}" data-media-alt="${escAttr(alt || "")}"></div>`);
}

// R2 (warm tier) config from env. Null when unset -> the warm branch degrades to
// the next candidate. Provisioning (Drake, no date) sets these; until then every
// manifest's `warm` block is null anyway (Track C ships the cloud tiers dormant).
// NOTE: these deliberately use the cross-tool `MYCELIUM_R2_*` namespace (matching
// the brain secret keys `mycelium.r2_*` and the mycelium-media CLI/MCP that owns
// the buckets), NOT this server's `VAULT_*` convention — do not "align" them.
function r2ConfigFromEnv() {
  const e = process.env;
  if (!e.MYCELIUM_R2_ACCESS_KEY_ID || !e.MYCELIUM_R2_SECRET_ACCESS_KEY || !e.MYCELIUM_R2_ENDPOINT) return null;
  return {
    accessKeyId: e.MYCELIUM_R2_ACCESS_KEY_ID,
    secretAccessKey: e.MYCELIUM_R2_SECRET_ACCESS_KEY,
    endpoint: e.MYCELIUM_R2_ENDPOINT,
    region: e.MYCELIUM_R2_REGION || "auto",
    warmBucket: e.MYCELIUM_R2_WARM_BUCKET || "mycelium-warm",
  };
}

// Presign a 10-minute GET against the R2 warm bucket and return the URL (the
// browser fetches R2 directly -> zero Node egress). aws-sdk v3 is lazy-required
// so a vault-less / cloud-less DCC boots without loading it. Presigning is a
// local crypto op (no network). Client is cached (creds/endpoint are stable).
// Returns null when R2 is unconfigured or the SDK is absent (caller degrades).
let _r2client = null;
async function presignWarm(warm, r2cfg) {
  if (!warm || !warm.key || !r2cfg) return null;
  let S3Client, GetObjectCommand, getSignedUrl;
  try {
    ({ S3Client, GetObjectCommand } = require("@aws-sdk/client-s3"));
    ({ getSignedUrl } = require("@aws-sdk/s3-request-presigner"));
  } catch (e) {
    console.warn("[vault] aws-sdk not installed; warm (R2) tier unavailable:", e.message);
    return null;
  }
  if (!_r2client) {
    _r2client = new S3Client({
      region: r2cfg.region || "auto",
      endpoint: r2cfg.endpoint,
      credentials: { accessKeyId: r2cfg.accessKeyId, secretAccessKey: r2cfg.secretAccessKey },
      forcePathStyle: true,
    });
  }
  const cmd = new GetObjectCommand({ Bucket: warm.bucket || r2cfg.warmBucket, Key: warm.key });
  return getSignedUrl(_r2client, cmd, { expiresIn: 600 });
}

// ── Timeline colors (B4a) ──
// A locked sensitive node shows as this neutral gray dot (no facets to color by).
const LOCKED_COLOR = "#6b7280";

// Hash a person/event key into a hue that sits BETWEEN the ontology's 8 fixed
// category hues (0/40/80/140/200/260/300/340), so a relationship arc never reads
// as a tag color. Fixed sat/light so the whole thread family is one visual
// language. djb2 for a stable, dependency-free spread. Pure (tested directly).
const GAP_HUES = [20, 60, 110, 170, 225, 282, 320, 352];
function gapHueColor(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `hsl(${GAP_HUES[h % GAP_HUES.length]}, 55%, 55%)`;
}

// A node's dot color = the circular-mean ontology color of its tag set (the ONE
// color algorithm, parse.colorForTags). Degrades to the unmapped gray when the
// shared parser/ontology is absent or the node is tagless.
function nodeColor(tags, ontology, parse, unmapped) {
  if (!parse || !parse.colorForTags || !ontology || !tags || !tags.length) return unmapped;
  try { return parse.colorForTags(tags, ontology).hex || unmapped; } catch { return unmapped; }
}

// A thread's arc color: tag threads borrow the ontology tag color (shared visual
// language with the dots); person/event threads hash into the gap hues.
function threadColor(kind, value, ontology, parse, unmapped) {
  if (kind === "tag") return nodeColor([value], ontology, parse, unmapped);
  return gapHueColor(`${kind}:${value}`);
}

// ── Weekly review helpers (B6), top-level + pure so they're unit-testable ──
// ISO-8601 week label (YYYY-Www) for a YYYY-MM-DD date. The digest node is named
// notes/reviews/<week>.md, so regenerating the same week overwrites (idempotent).
function isoWeek(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "unknown";
  const day = (d.getUTCDay() + 6) % 7;                 // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3);              // nearest Thursday
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Render a digest object as a self-contained markdown note. Uses [[wikilinks]] so
// the saved review is ITSELF in the graph (it links to every note it surfaces).
function renderDigestMarkdown(d) {
  const link = (slug, title) => (title && title !== slug ? `[[${slug}|${title}]]` : `[[${slug}]]`);
  const L = [];
  L.push(`# Weekly review — ${d.week}`, "");
  L.push(`_Generated ${String(d.generatedAt).slice(0, 10)}. A 10-minute loop: skim what came back, clear the inbox, follow one thread._`, "");

  L.push(`## Resurfaced`, "");
  if (d.resurfaced.length) {
    for (const p of d.resurfaced) {
      const why = (p.reasons || []).map((r) => r.note).join(" · ");
      L.push(`- ${link(p.slug, p.title)}${why ? ` — ${why}` : ""}`);
      if (p.excerpt) L.push(`  > ${p.excerpt}`);
      if (p.neighbors && p.neighbors.length) {
        L.push(`  - connects to ${p.neighbors.map((nb) => link(nb.slug, nb.title)).join(", ")}`);
      }
    }
  } else {
    L.push(`_Nothing to resurface yet — the vault is still young._`);
  }
  L.push("");

  L.push(`## Orphans (${d.orphans.count})`, "");
  if (d.orphans.top.length) {
    L.push(`Notes with no links in or out — give the top ones a home:`, "");
    for (const o of d.orphans.top) L.push(`- ${link(o.slug, o.title)}`);
  } else {
    L.push(`No orphans — every note is connected. 🎉`);
  }
  L.push("");

  L.push(`## Unlinked mentions`, "");
  if (d.unlinked.length) {
    L.push(`Named without a link — one click wires them up in the Review panel:`, "");
    for (const s of d.unlinked) {
      L.push(`- **${link(s.target.slug, s.target.title)}** mentioned in ${link(s.source.slug, s.source.title)}${s.snippet ? `: "${s.snippet}"` : ""}`);
    }
  } else {
    L.push(`No pending unlinked mentions.`);
  }
  L.push("");

  L.push(`## Inbox`, "");
  L.push(d.inboxBacklog
    ? `${d.inboxBacklog} fleeting note${d.inboxBacklog === 1 ? "" : "s"} waiting to be filed — open the Review panel to promote, merge, or clear them.`
    : `Inbox zero. Nothing waiting. 🎉`);
  L.push("");
  return L.join("\n");
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
    // Decade-scale sentinel (B5): node count + working-tree size + boot time, and
    // a warn flag the status pill surfaces when a threshold is crossed.
    scale: ctx.vault && ctx.vault.ready ? ctx.vault.scaleStatus() : null,
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
  const all = ctx.vault.list({ type, subtype, hasField: has, sinceDate: since });
  // Pagination (B5 scale guard). Back-compat: no `limit` -> the bare array the
  // explorer tree has always consumed. With `limit`, return a paged envelope the
  // client can infinite-scroll. offset/limit are clamped so a bad param can't
  // slice out of range.
  const rawLimit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) return res.json(all);
  const limit = Math.min(rawLimit, 1000);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.json({ nodes: all.slice(offset, offset + limit), total: all.length, offset, limit });
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

app.get("/api/vault/node/*", async (req, res) => {
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
  // Render the body (wikilinks + media embeds) and build the media map via the
  // ONE shared render path — also used by POST /api/vault/nodes/bodies, so the
  // canvas cards and the reading pane render byte-identical bodies.
  await renderNodeForClient(node, req);
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

// The shared server-side render path: rewrite [[wikilinks]] (needs the shared
// parser) then media embeds (doesn't) into `renderedBody`, and build the
// { hex -> meta } media map. renderedBody is always set so the client renders a
// single, consistent body. Mutates + returns `node`. Kept as the ONE place both
// the single-node GET and the batch bodies POST render through, so a card on the
// B4b canvas and the full reading pane never drift.
async function renderNodeForClient(node, req) {
  let rendered = node.body;
  const parse = loadParse(ctx);
  if (parse && parse.WIKILINK_RE) rendered = renderWikilinks(rendered, parse, ctx.vault);
  node.renderedBody = renderMediaRefs(rendered);
  // Metadata for each media embed so the client renders the right element
  // (img/audio/video/iframe) and degrades cloud-only tiers gracefully.
  node.media = await nodeMedia(node, req);
  return node;
}

// ── Batch bodies (B4b): the thread canvas's data ──
// One POST returns the rendered body + media map + card-header fields for a list
// of slugs, so a 60-note thread opens as ONE request, not 60. Same per-slug
// sensitive gate as GET /api/vault/node/*: a locked/expired session gets
// { locked:true } with NO body for a sensitive slug — the security backstop, so
// "contents stay locked" holds on a direct API hit regardless of how the client
// got the slug list. Unknown slugs return { missing:true }. Slugs are normalized
// BEFORE the gate (a `..` segment must not dodge it then resolve into a sensitive
// dir), de-duped, and capped.
const BODIES_MAX = 500;
app.post("/api/vault/nodes/bodies", async (req, res) => {
  if (!vaultReady(res)) return;
  const raw = (req.body && req.body.slugs);
  if (!Array.isArray(raw)) return res.status(400).json({ error: "slugs must be an array" });
  const slugs = [];
  const seen = new Set();
  let truncated = false;
  for (const s of raw) {
    if (typeof s !== "string" || !s) continue;
    const slug = ctx.vault.normalizeSlug(s);
    if (seen.has(slug)) continue;
    if (slugs.length >= BODIES_MAX) { truncated = true; break; }
    seen.add(slug);
    slugs.push(slug);
  }
  const bodies = {};
  for (const slug of slugs) {
    if (isSensitiveSlug(slug) && !isUnlocked(req)) { bodies[slug] = { slug, sensitive: true, locked: true }; continue; }
    const node = ctx.vault.get(slug);
    if (!node) { bodies[slug] = { slug, missing: true }; continue; }
    await renderNodeForClient(node, req);
    const fm = node.frontmatter || {};
    const tags = Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []);
    bodies[slug] = {
      slug,
      title: fm.title || slug.split("/").pop(),
      type: fm.type || "untyped",
      tags,
      sensitive: isSensitiveSlug(slug),
      renderedBody: node.renderedBody,
      media: node.media,
    };
  }
  res.json({ bodies, count: slugs.length, cap: BODIES_MAX, truncated });
});

// Build the { hex -> meta } map the client uses to upgrade media placeholders.
// One manifest lookup per distinct embed; sensitive media on a locked session
// (or a public note embedding a private ref) is reported unavailable, not leaked.
async function nodeMedia(node, req) {
  const out = {};
  const body = node.body || "";
  // Warm (R2) is only actually serveable when R2 is configured on THIS server;
  // until Drake provisions it, a warm-only manifest must read as "not yet
  // available" so the client degrades to a placeholder instead of a broken tag.
  const r2ok = !!r2ConfigFromEnv();
  // Collect all embed hashes SYNCHRONOUSLY before any await. MEDIA_REF_RE is a
  // shared /g regex; driving its stateful .exec across the awaits below would let
  // concurrent /api/vault/node/* requests corrupt each other's lastIndex and
  // silently drop embeds. matchAll snapshots the matches up front.
  const hexes = [...body.matchAll(MEDIA_REF_RE)].map((mm) => mm[2].toLowerCase());
  const seen = new Set();
  for (const hex of hexes) {
    if (seen.has(hex)) continue;
    seen.add(hex);
    const found = await findManifest(hex.slice(0, 12));
    if (!found) { out[hex] = { hash: hex, available: false, missing: true }; continue; }
    const m = found.manifest;
    if (m.visibility === "sensitive" && !isUnlocked(req)) { out[hex] = { hash: hex, available: false, locked: true }; continue; }
    const lowres = !!(m.lowres && m.lowres.path);
    const warm = !!m.warm && r2ok;
    out[hex] = {
      hash: hex,
      kind: mediaKind(m.mime),
      mime: m.mime || null,
      filename: m.filename || null,
      bytes: m.bytes || null,
      dims: m.dims || null,
      duration_s: m.duration_s || null,
      album: m.album || "",
      tiers: { inline: !!m.inline, lfs: !!m.lfs, warm, lowres, cold: !!m.cold },
      available: !!(m.inline || m.lfs || warm || lowres),
      visibility: m.visibility || null,
    };
  }
  return out;
}

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

// ── Timeline (B4a): the signature visualization's data ──
// Dated nodes + relevance threads (a tag/person/event shared by >=2 in-range
// nodes), colored for the client. The client fetches the FULL corpus once (no
// from/to) and windows client-side during zoom/pan; from/to/tags/types/people
// are optional server filters. Sensitivity mirrors GET /api/vault/node/*: a
// locked session gets sensitive nodes as bare, date-only "locked" dots — no
// slug/title/facets — and they never appear as thread members.
app.get("/api/vault/timeline", (req, res) => {
  if (!vaultReady(res)) return;
  const q = req.query || {};
  const csv = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
  const from = isDate(q.from) ? String(q.from) : null;
  const to = isDate(q.to) ? String(q.to) : null;
  const types = csv(q.types);
  const tags = csv(q.tags);
  const people = csv(q.people);
  let cap = parseInt(q.cap, 10);
  if (!Number.isFinite(cap) || cap <= 0) cap = 40;   // thread-explosion guard (param to raise)
  cap = Math.min(cap, 500);

  const { nodes, threads } = ctx.vault.timeline({ from, to, types, tags, people });
  const locked = !isUnlocked(req);

  // Ontology for colors — best-effort (cached per-dir); degrades to gray/gap-hues.
  const parse = loadParse(ctx);
  const ontology = loadOntology(ctx);
  let unmapped = "#9ca3af";
  if (ontology && ontology.render && ontology.render.unmapped) unmapped = ontology.render.unmapped;

  const redacted = new Set(); // sensitive slugs collapsed to locked dots this response
  let lockedCount = 0;
  const outNodes = nodes.map((n, i) => {
    if (locked && isSensitiveSlug(n.slug)) {
      redacted.add(n.slug);
      lockedCount++;
      return { id: `locked:${n.date}:${i}`, date: n.date, type: "locked", sensitive: true, color: LOCKED_COLOR };
    }
    return {
      id: n.slug, slug: n.slug, title: n.title, type: n.type, date: n.date,
      tags: n.tags, people: n.people, event: n.event,
      sensitive: isSensitiveSlug(n.slug),
      color: nodeColor(n.tags, ontology, parse, unmapped),
    };
  });

  // Drop redacted members; a thread that falls below 2 members disappears. Every
  // surviving member slug is guaranteed present as a slug-bearing node above.
  let live = threads;
  if (locked && redacted.size) {
    live = threads
      .map((t) => (t.members.some((s) => redacted.has(s)) ? { ...t, members: t.members.filter((s) => !redacted.has(s)) } : t))
      .filter((t) => t.members.length >= 2);
  }
  live.sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1));
  const threadsTotal = live.length;
  const outThreads = live.slice(0, cap).map((t) => ({
    key: t.key, kind: t.kind, value: t.value,
    label: t.kind === "person" ? t.value.split("/").pop() : t.value,
    color: threadColor(t.kind, t.value, ontology, parse, unmapped),
    members: t.members,
  }));

  res.json({
    range: { from, to },
    counts: { nodes: outNodes.length, locked: lockedCount, threads: threadsTotal, threadsShown: outThreads.length, cap },
    unmapped,
    ontologyAvailable: !!ontology,
    nodes: outNodes,
    threads: outThreads,
  });
});

// ── Search + discovery + saved views (B5) ──

// Full-text search over title/body/tags/aliases + media text sidecars. The
// sensitive index is queried ONLY for a PIN-unlocked session (VaultStore.search
// gates on includeSensitive), so a locked session can't surface sensitive
// titles/bodies/snippets. ?mode=title powers the quick-switcher (title+alias
// weighted). Snippets are plain text; HTML-escaped here for the client.
app.get("/api/vault/search", (req, res) => {
  if (!vaultReady(res)) return;
  const q = String(req.query.q || "").trim();
  const mode = req.query.mode === "title" ? "title" : "full";
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 30;
  limit = Math.min(limit, 100);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const t0 = Date.now();
  const { results, total } = ctx.vault.search(q, { includeSensitive: isUnlocked(req), limit, offset, mode });
  res.json({
    q, mode, total, offset, limit, tookMs: Date.now() - t0,
    results: results.map((r) => ({ ...r, snippet: escHtml(r.snippet || "") })),
  });
});

// Rebuild the search index on demand (e.g., after a bulk external sync the
// per-file watcher may have coalesced). Cheap — in-memory MiniSearch adds.
app.post("/api/vault/reindex", async (req, res) => {
  if (!vaultReady(res)) return;
  const t0 = Date.now();
  try {
    const docs = await ctx.vault.buildSearchIndex();
    res.json({ ok: true, docs, tookMs: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unlinked mentions of a node: other notes whose body names this node (title or
// alias) with no existing link. Runs on the search index. Sensitive sources are
// hidden while locked, and a sensitive TARGET's mentions aren't revealed at all
// while locked. The client's one-click "link it" appends the wikilink to the
// SOURCE via the optimistic-lock PUT.
app.get("/api/vault/unlinked", (req, res) => {
  if (!vaultReady(res)) return;
  const slug = ctx.vault.normalizeSlug(req.query.slug || "");
  if (!slug) return res.status(400).json({ error: "slug required" });
  if (isSensitiveSlug(slug) && !isUnlocked(req)) return res.status(403).json({ error: "locked", sensitive: true });
  const mentions = ctx.vault.unlinked(slug, { includeSensitive: isUnlocked(req) });
  res.json({ slug, mentions: mentions.map((m) => ({ ...m, snippet: escHtml(m.snippet || "") })) });
});

// Orphans: nodes with zero in/out edges (excluding inbox/fleeting). Sensitive
// orphans withheld while locked.
app.get("/api/vault/orphans", (req, res) => {
  if (!vaultReady(res)) return;
  res.json({ orphans: ctx.vault.orphans({ includeSensitive: isUnlocked(req) }) });
});

// Recent notes — the "Today + recent" default view's data. list() is already
// mtime-desc, so today's edits sort to the top. Paginated (infinite scroll) and
// sensitive-gated like search: a locked session never sees sensitive rows.
app.get("/api/vault/recent", (req, res) => {
  if (!vaultReady(res)) return;
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 30;
  limit = Math.min(limit, 100);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const unlocked = isUnlocked(req);
  const all = ctx.vault.list().filter((n) => unlocked || !isSensitiveSlug(n.slug));
  const results = all.slice(offset, offset + limit).map((n) => {
    const fm = n.frontmatter || {};
    return { slug: n.slug, title: fm.title || n.slug.split("/").pop(), type: fm.type || "untyped", sensitive: isSensitiveSlug(n.slug) };
  });
  res.json({ total: all.length, offset, limit, results });
});

// ── Resurfacing + weekly review (B6): close the north-star loop ──
// Capture → organize → RESURFACE → connect → have ideas. Nothing before B6
// brought a forgotten note back; these endpoints do.

function dayKeyOf() {
  return ctx.getTodayStr ? ctx.getTodayStr() : new Date().toISOString().slice(0, 10);
}

// GET /api/vault/resurface?n=5 — the weighted "notes worth re-seeing" sample.
// Deterministic per day (VaultStore seeds on the app-tz date). Sensitive notes
// only for a PIN-unlocked session (the tab is an authed surface); the WEEKLY
// DIGEST below never includes them regardless (it becomes a public vault node).
app.get("/api/vault/resurface", (req, res) => {
  if (!vaultReady(res)) return;
  let n = parseInt(req.query.n, 10);
  if (!Number.isFinite(n) || n <= 0) n = 5;
  n = Math.min(n, 25);
  const out = ctx.vault.resurface({ n, dayKey: dayKeyOf(), includeSensitive: isUnlocked(req) });
  res.json({
    dayKey: dayKeyOf(), pool: out.pool,
    picks: out.picks.map((p) => ({ ...p, excerpt: escHtml(p.excerpt || "") })),
  });
});

// GET /api/vault/inbox — the inbox review queue (fleeting notes, oldest first).
// Inbox is never a sensitive dir, so no gate; excerpts are escaped for the client.
app.get("/api/vault/inbox", (req, res) => {
  if (!vaultReady(res)) return;
  const items = ctx.vault.inbox();
  res.json({ count: items.length, items: items.map((i) => ({ ...i, excerpt: escHtml(i.excerpt || "") })) });
});

// Escape the body-derived text (snippets/excerpts) the client injects RAW, at
// the JSON boundary — exactly like the sibling endpoints (/resurface, /inbox,
// /search all escHtml their snippet/excerpt). Titles/slugs are escaped
// client-side, so they stay raw here to avoid double-escaping. renderDigest-
// Markdown always gets the UNescaped digest (a .md must not carry HTML entities).
function digestForClient(digest) {
  return {
    ...digest,
    resurfaced: digest.resurfaced.map((p) => ({ ...p, excerpt: escHtml(p.excerpt || "") })),
    unlinked: digest.unlinked.map((s) => ({ ...s, snippet: escHtml(s.snippet || "") })),
  };
}

// Per-day digest memo. The digest is deterministic per (dayKey, corpus) and
// always computed includeSensitive:false, so it is safe to cache and drop on any
// write. VaultStore emits vault-changed on every mutation; subscribe lazily (the
// store is null at mount, live by first call). Keyed by dayKey so a day rollover
// recomputes without an explicit clear.
let _digestCache = null;      // { dayKey, digest }
let _digestSubscribed = false;

// Build the weekly-review digest object (pure of persistence). ALWAYS excludes
// sensitive content — the digest is destined for a public vault node AND the DCC
// brief band, so it mirrors the "no sensitive content" constraint by never asking
// for it. Resurfaced picks carry their timeline-thread neighbors (B4a maps).
function computeDigest() {
  const dayKey = dayKeyOf();
  if (!_digestSubscribed && ctx.vault && ctx.vault.on) {
    ctx.vault.on("vault-changed", () => { _digestCache = null; });
    _digestSubscribed = true;
  }
  if (_digestCache && _digestCache.dayKey === dayKey) return _digestCache.digest;
  const week = isoWeek(dayKey);
  const res = ctx.vault.resurface({ n: 5, dayKey, includeSensitive: false });
  const resurfaced = res.picks.map((p) => ({
    ...p,
    neighbors: ctx.vault.threadNeighbors(p.slug, { limit: 4, includeSensitive: false }),
  }));

  const orphansAll = ctx.vault.orphans({ includeSensitive: false });

  // Unlinked-mention suggestions: scan nameable target nodes (bounded) for the
  // first notes that name them without a link. Top 5 across the corpus.
  const NAMEABLE = new Set(["person", "project", "note", "idea", "book", "goal", "place", "recipe", "trip"]);
  const suggestions = [];
  let scanned = 0;
  for (const n of ctx.vault.list()) {
    if (suggestions.length >= 5 || scanned >= 300) break;
    const fm = n.frontmatter || {};
    if (!NAMEABLE.has(fm.type) || !fm.title || isSensitiveSlug(n.slug)) continue;
    scanned++;
    const u = ctx.vault.unlinked(n.slug, { includeSensitive: false, limit: 1 });
    if (u.length) {
      suggestions.push({
        target: { slug: n.slug, title: fm.title },
        source: { slug: u[0].slug, title: u[0].title },
        term: u[0].term, snippet: u[0].snippet || "",
      });
    }
  }

  const digest = {
    week, generatedAt: new Date().toISOString(), dayKey,
    resurfaced,
    orphans: { count: orphansAll.length, top: orphansAll.slice(0, 3) },
    unlinked: suggestions,
    inboxBacklog: ctx.vault.inbox().length,
    poolSize: res.pool,
  };
  _digestCache = { dayKey, digest };
  return digest;
}

// GET /api/vault/digest — the live weekly digest (computed, NOT saved). The tab's
// Review panel + a preview use this; the brief-band hook uses POST to persist.
app.get("/api/vault/digest", (req, res) => {
  if (!vaultReady(res)) return;
  const digest = computeDigest();
  const week = digest.week;
  const savedSlug = `notes/reviews/${week}`;
  res.json({ ...digestForClient(digest), markdown: renderDigestMarkdown(digest), saved: ctx.vault.has(savedSlug), slug: savedSlug });
});

// POST /api/vault/digest — generate + SAVE this week's review as notes/reviews/
// <YYYY-Www>.md (idempotent: regenerating the same week overwrites). Called by the
// weekly heartbeat hook and by the tab's "Save this week's review" button.
app.post("/api/vault/digest", async (req, res) => {
  if (!vaultReady(res)) return;
  const digest = computeDigest();
  const week = digest.week;
  const slug = `notes/reviews/${week}`;
  const markdown = renderDigestMarkdown(digest);
  const fm = { type: "note", title: `Weekly review ${week}`, date: digest.dayKey, tags: ["review", "weekly"] };
  try {
    const node = await writeNode(slug, fm, markdown, { message: `weekly review ${week}` });
    res.status(201).json({ ...digestForClient(digest), slug, markdown, node: { slug: node.slug, hash: node.hash } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Saved views: {id,name,icon,surface,query,sort}[] persisted in the REPO at
// .mycelium/views.json so they sync across every device like a node write. It is
// NOT a .md, so VaultStore never indexes it (its walker skips dot-dirs); DATA_DIR
// is not involved — the repo file is the single source of truth. Writes commit +
// push through the SyncManager (same durability as any node).
function viewsFile() { return path.join(ctx.vault.vaultDir, ".mycelium", "views.json"); }
const VIEW_SURFACES = ["explorer", "timeline"];
function sanitizeView(v) {
  if (!v || typeof v !== "object") return null;
  const name = String(v.name || "").trim().slice(0, 60);
  if (!name) return null;
  return {
    // A view that already carries an id keeps it; a new (id-less) view gets a
    // collision-free random token. NOT index/name-derived: after a delete the
    // surviving views shift index, so `v${i}-${len}` could re-mint an id an
    // existing view holds, and the client keys apply/rename/delete on id — a
    // collision would drop or mis-target a saved view.
    id: (typeof v.id === "string" && v.id) ? v.id.slice(0, 40) : `v${crypto.randomBytes(6).toString("hex")}`,
    name,
    icon: String(v.icon || "").slice(0, 8),
    surface: VIEW_SURFACES.includes(v.surface) ? v.surface : "explorer",
    query: (v.query && typeof v.query === "object" && !Array.isArray(v.query)) ? v.query : {},
    sort: typeof v.sort === "string" ? v.sort.slice(0, 40) : "",
  };
}
app.get("/api/vault/views", async (req, res) => {
  if (!vaultReady(res)) return;
  let views = [];
  try { views = JSON.parse(await fsp.readFile(viewsFile(), "utf8")); } catch { views = []; }
  if (!Array.isArray(views)) views = [];
  res.json({ views });
});
app.put("/api/vault/views", async (req, res) => {
  if (!vaultReady(res)) return;
  const incoming = req.body && req.body.views;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: "views must be an array" });
  if (incoming.length > 100) return res.status(400).json({ error: "too many views" });
  const clean = incoming.map(sanitizeView).filter(Boolean);
  const file = viewsFile();
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, file);
    if (ctx.syncMgr) ctx.syncMgr.notifyChange({ slug: ".mycelium/views.json", message: "update saved views" });
    res.json({ views: clean });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// Whole-corpus graph for the global graph view. Registered BEFORE the /graph/*
// per-slug route below: Express matches in order, and `/graph` with no trailing
// segment would not hit `/graph/*` anyway, but keeping them adjacent in this
// order makes the pair obvious to the next reader.
//
// Nodes arrive pre-colored through the same nodeColor() the timeline uses, so
// both views resolve a node to the same hue from one ontology implementation
// (parse.js colorForTags) rather than two. Sensitive nodes are dropped by
// graphAll() on a locked session, not redacted -- see the note there.
app.get("/api/vault/graph", (req, res) => {
  if (!vaultReady(res)) return;

  const g = ctx.vault.graphAll({ includeSensitive: isUnlocked(req) });

  const parse = loadParse(ctx);
  const ontology = loadOntology(ctx);
  let unmapped = "#9ca3af";
  if (ontology && ontology.render && ontology.render.unmapped) unmapped = ontology.render.unmapped;

  res.json({
    counts: g.counts,
    unmapped,
    ontologyAvailable: !!ontology,
    nodes: g.nodes.map((n) => ({ ...n, color: nodeColor(n.tags, ontology, parse, unmapped) })),
    edges: g.edges,
    ghosts: g.ghosts,
  });
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
  // Keep the media index warm: a just-attached blob is renderable immediately,
  // without waiting for a rescan (manifests aren't watched — see findManifest).
  // cacheManifest re-reads from disk so the cached mtime matches the file.
  await cacheManifest(hash12, manifestAbs);

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

// ── Media serving v2 ──
// In-memory hash12 -> {path, mtimeMs, manifest} index, replacing B2's per-request
// walk. Built lazily on first use (routes mount before vault init, so there's no
// ready-event to hook here) and kept warm incrementally: attach adds its manifest
// directly. A manifest that arrives OR is updated in place via `git pull` is NOT
// caught by the VaultStore watcher (that only fires on .md), so findManifest
// re-reads on an mtime change, drops + re-walks a vanished hash, and walks once
// (caching the hit) for a hash it has never seen — the index self-heals.
const mediaIndex = new Map();
let _mediaIndexBuild = null;

const MANIFEST_ROOTS = () => [
  path.join(ctx.vault.vaultDir, "media", "manifests"),
  path.join(ctx.vault.vaultDir, "media", "manifests", "private"),
];
const PRIVATE_MANIFEST_DIR = () => path.resolve(ctx.vault.vaultDir, "media", "manifests", "private") + path.sep;

// Read + parse a manifest, cache it with its mtime, and stamp visibility=sensitive
// when it lives under the private/ subtree. The storage LOCATION is authoritative
// for sensitivity: a private manifest with a missing/null `visibility` field must
// still hit the PIN gate and never presign to R2, so the security boundary can't
// hinge on a self-declared field. Returns the cache entry, or null if unreadable.
async function cacheManifest(hash12, absPath) {
  let stat, manifest;
  try {
    stat = await fsp.stat(absPath);
    manifest = JSON.parse(await fsp.readFile(absPath, "utf8"));
  } catch { return null; }
  if (path.resolve(absPath).startsWith(PRIVATE_MANIFEST_DIR())) manifest.visibility = "sensitive";
  const entry = { path: absPath, mtimeMs: stat.mtimeMs, manifest };
  mediaIndex.set(hash12, entry);
  return entry;
}

// Walk each manifest year-dir once, invoking cb(dirAbs); return true from cb to
// stop early. `media/manifests/private` is also listed under `media/manifests`,
// so skip that pseudo-year and let it be scanned via its own root (no double
// visit). Shared by the eager build and the targeted findManifest fallback so
// the dir layout lives in exactly one place.
async function eachManifestDir(cb) {
  for (const root of MANIFEST_ROOTS()) {
    let years;
    try { years = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const y of years) {
      if (!y.isDirectory()) continue;
      if (root.endsWith(path.join("media", "manifests")) && y.name === "private") continue;
      if (await cb(path.join(root, y.name))) return;
    }
  }
}

async function buildMediaIndex() {
  mediaIndex.clear();
  await eachManifestDir(async (dir) => {
    let files;
    try { files = await fsp.readdir(dir); } catch { return false; }
    for (const fn of files) {
      if (fn.endsWith(".json")) await cacheManifest(fn.replace(/\.json$/, ""), path.join(dir, fn));
    }
    return false;
  });
  return mediaIndex.size;
}

function ensureMediaIndex() {
  if (!_mediaIndexBuild) {
    _mediaIndexBuild = buildMediaIndex().catch((e) => {
      console.warn("[vault] media index build failed:", e.message);
      _mediaIndexBuild = null; // let a later request retry the build
      return 0;
    });
  }
  return _mediaIndexBuild;
}

async function findManifest(hash12) {
  await ensureMediaIndex();
  const hit = mediaIndex.get(hash12);
  if (hit) {
    // A pull could have removed OR updated the manifest in place (a warm/cold tier
    // written at provisioning) since it was cached. Re-read on an mtime change;
    // drop + re-walk if it's gone.
    try {
      const st = await fsp.stat(hit.path);
      if (st.mtimeMs === hit.mtimeMs) return hit;
      const fresh = await cacheManifest(hash12, hit.path);
      if (fresh) return fresh;
    } catch { mediaIndex.delete(hash12); }
  }
  let found = null;
  await eachManifestDir(async (dir) => {
    const entry = await cacheManifest(hash12, path.join(dir, `${hash12}.json`));
    if (entry) { found = entry; return true; }
    return false;
  });
  return found;
}

// Per-hash LFS fetch de-dupe: concurrent viewers of the same un-smudged object
// share ONE `git lfs pull`, so a burst of <img> requests can't spawn N fetches.
const _lfsFetches = new Map();
function lfsFetchOnce(hash12, relPath) {
  if (_lfsFetches.has(hash12)) return _lfsFetches.get(hash12);
  const run = ctx.syncMgr ? ctx.syncMgr.lfsFetch(relPath) : Promise.reject(new Error("sync disabled"));
  const p = run.finally(() => _lfsFetches.delete(hash12));
  _lfsFetches.set(hash12, p);
  return p;
}

// Stream a working-tree blob (inline / smudged-LFS / lowres — all small by
// construction) with a single-range handler so <audio>/<video> can seek. R2
// (warm) is never streamed through Node; it 302-redirects.
async function streamFile(req, res, abs, mime) {
  const stat = await fsp.stat(abs);
  res.setHeader("Content-Type", mime || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Accept-Ranges", "bytes");
  const mr = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim());
  if (mr) {
    let start, end;
    if (mr[1] === "" && mr[2] !== "") {
      // Suffix range `bytes=-N` = the final N bytes (RFC 7233). Media clients
      // (e.g. QuickTime fetching an MP4's trailing moov atom) rely on this.
      const n = parseInt(mr[2], 10);
      end = stat.size - 1;
      start = Number.isNaN(n) ? 0 : Math.max(0, stat.size - n);
    } else {
      start = mr[1] ? parseInt(mr[1], 10) : 0;
      end = mr[2] ? parseInt(mr[2], 10) : stat.size - 1;
    }
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      res.status(416).setHeader("Content-Range", `bytes */${stat.size}`);
      return res.end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    const s = fs.createReadStream(abs, { start, end });
    s.on("error", () => res.destroy());
    return s.pipe(res);
  }
  res.setHeader("Content-Length", stat.size);
  const s = fs.createReadStream(abs);
  s.on("error", () => { if (!res.headersSent) res.status(404).json({ error: "blob missing" }); else res.destroy(); });
  return s.pipe(res);
}

// Serve media by hash across all tiers, honoring the manifest resolution order.
//   ?variant=auto (default) | original | lowres  — see mediaCandidates().
// Sensitive (private/) media needs an unlocked session and never presigns to R2.
app.get("/api/vault/media/:hash", async (req, res) => {
  if (!vaultReady(res)) return;
  const hex = String(req.params.hash).replace(/^sha256:/, "").toLowerCase();
  if (!/^[a-f0-9]{12,64}$/.test(hex)) return res.status(400).json({ error: "bad hash" });
  const variant = ["auto", "original", "lowres"].includes(String(req.query.variant)) ? String(req.query.variant) : "auto";
  const hash12 = hex.slice(0, 12);
  const found = await findManifest(hash12);
  if (!found) return res.status(404).json({ error: "not found" });
  const m = found.manifest;
  if (m.visibility === "sensitive" && !isUnlocked(req)) return res.status(403).json({ error: "locked", sensitive: true });

  for (const c of mediaCandidates(m, variant)) {
    if (c.tier === "warm") {
      let url = null;
      try { url = await presignWarm(c.warm, r2ConfigFromEnv()); } catch (e) { console.warn("[vault] presign failed:", e.message); }
      if (url) {
        res.setHeader("Cache-Control", "private, no-store"); // the URL itself is a 10-min bearer
        return res.redirect(302, url);
      }
      continue; // R2 unconfigured / presign failed -> degrade to next candidate
    }
    if (c.tier === "cold") {
      return res.status(409).json({ error: "in deep freeze; restore via the mycelium-media CLI", tier: "cold" });
    }
    // Repo-path tiers: inline / lfs / lowres. Defense-in-depth containment: the
    // path comes from the manifest JSON, so reject any that resolves outside the
    // vault dir (a `../` blob path streaming arbitrary file content) even though
    // manifests are server-generated and vault write access is already trusted.
    const abs = path.resolve(ctx.vault.vaultDir, c.path);
    if (!abs.startsWith(path.resolve(ctx.vault.vaultDir) + path.sep)) continue;
    try {
      if (c.tier === "lfs") {
        let head = "";
        try {
          const fh = await fsp.open(abs, "r");
          try { const b = Buffer.alloc(128); const { bytesRead } = await fh.read(b, 0, 128, 0); head = b.slice(0, bytesRead).toString("utf8"); }
          finally { await fh.close(); }
        } catch { /* missing file handled by streamFile below */ }
        if (isLfsPointer(head)) {
          try { await lfsFetchOnce(hash12, c.path); }
          catch (e) { console.warn("[vault] lfs fetch failed:", e.message); continue; } // degrade
        }
      }
      const mime = c.tier === "lowres" ? "image/jpeg" : m.mime;
      return await streamFile(req, res, abs, mime);
    } catch { continue; } // file missing on this tier -> try the next
  }
  return res.status(404).json({
    error: "no servable media tier",
    tiers: { inline: !!m.inline, lfs: !!m.lfs, warm: !!m.warm, lowres: !!(m.lowres && m.lowres.path), cold: !!m.cold },
  });
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
// B3 media-serving pure helpers (vault-b3.test.js).
module.exports.mediaKind = mediaKind;
module.exports.mediaCandidates = mediaCandidates;
module.exports.isLfsPointer = isLfsPointer;
module.exports.renderMediaRefs = renderMediaRefs;
module.exports.presignWarm = presignWarm;
module.exports.r2ConfigFromEnv = r2ConfigFromEnv;
// B4a timeline color helpers (vault-b4a.test.js).
module.exports.gapHueColor = gapHueColor;
module.exports.nodeColor = nodeColor;
module.exports.threadColor = threadColor;
// B6 resurfacing/digest pure helpers (vault-b6.test.js).
module.exports.isoWeek = isoWeek;
module.exports.renderDigestMarkdown = renderDigestMarkdown;
