/**
 * VaultStore — in-memory index + graph over the markdown vault.
 *
 * Disk is source of truth. Index is a derived cache kept live by chokidar.
 * Atomic writes via tmpfile + rename. Emits events for SSE broadcast.
 *
 * Query shape:
 *   list({type, subtype, hasField, sinceDate}) -> [{slug, frontmatter, mtime}]
 *   get(slug) -> {slug, frontmatter, body, outlinks, backlinks}
 *   write(slug, {frontmatter, body}) -> {slug, ...}
 *   delete(slug)
 *   graph(slug) -> {outlinks, backlinks, neighbors}
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const matter = require("gray-matter");
const chokidar = require("chokidar");
const { EventEmitter } = require("events");
// Vendored MiniSearch (pure JS, zero native deps) — the ONE full-text engine (B5).
// The UMD build is CJS-requireable here (module.exports = the class) and doubles
// as the browser bundle in the tab. Pinned file; no npm dependency added.
const MiniSearch = require("./public/js/vendor/minisearch.7.1.0.umd.js");

const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
// Media embed refs in a body (`![alt](media:sha256:<hex>)`), so a node's search
// text can pull in the extracted `text_sidecar` of what it embeds (B5). Kept in
// lockstep with routes/vault.js MEDIA_REF_RE (disjoint concern, same syntax).
const MEDIA_REF_RE = /!\[[^\]]*\]\(media:sha256:([a-fA-F0-9]{12,64})\)/g;

// Sensitive-dir set — mirrors CONVENTIONS.md, routes/vault.js SENSITIVE_PREFIXES,
// and the client's SENSITIVE_PREFIXES (path is authoritative). VaultStore needs
// its own copy to route a node into the SENSITIVE search index, which search()
// only queries when the caller passes includeSensitive (the PIN-unlock flag). One
// more mirror in a codebase that already keeps three; all four must move together.
const SENSITIVE_PREFIXES = ["health/therapy/", "health/moments/", "health/medical/", "journal/private/"];
function isSensitivePath(slug) {
  return SENSITIVE_PREFIXES.some((p) => (slug + "/").startsWith(p) || slug.startsWith(p));
}

// MiniSearch config. Bodies are NOT stored in the index (snippets read the live
// body from this.nodes), only title/type for cheap result rows. A fresh instance
// per (re)build so a rebuild can't inherit stale docs.
const SEARCH_FIELDS = ["title", "body", "tags", "aliases", "sidecar"];
function newSearchIndex() {
  return new MiniSearch({ idField: "id", fields: SEARCH_FIELDS, storeFields: ["title", "type"] });
}

// Split the body out of a frontmatter doc WITHOUT parsing the YAML — the cheap
// half of gray-matter, used by the boot cache to skip re-parsing unchanged files.
// Verified byte-identical to matter().content across the corpus; the non-greedy
// YAML capture stops at the FIRST closing `---` so a `\n---\n` rule in the body is
// safe. Callers must NOT use this for a file that failed YAML parse (gray-matter
// puts the WHOLE raw in .content then) — the boot cache guards on that.
function splitBody(raw) {
  if (typeof raw !== "string" || !raw.startsWith("---")) return raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return m ? m[2] : raw;
}

// A single frontmatter facet field (tags/people/event) may hold a scalar or an
// array, and each value may be a bare string or a wikilink. Collapse wikilinks
// to their target so "[[people/collins]]" and "people/collins" thread together;
// de-dupe within the node. Kept case-sensitive (the ontology tag keys are), so a
// personal vault's stable casing groups cleanly. Exported for the timeline's
// facet math + tests.
function facetValues(raw) {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const seen = new Set();
  for (const v of list) {
    if (typeof v !== "string") continue;
    let s = v.trim();
    const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(s);
    if (m) s = m[1].trim();
    if (s) seen.add(s);
  }
  return Array.from(seen);
}

// Canonical timeline date for a node: date -> created -> scheduled_at, as
// YYYY-MM-DD. Handles the js-yaml Date object an UNquoted `date:` parses to
// (D2's shared-parser note) as well as quoted ISO strings. Null when no
// resolvable date exists — such a node simply can't be placed on the axis.
function nodeDate(fm) {
  const d = fm && (fm.date || fm.created || fm.scheduled_at);
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// A short plain-text preview of a body for the review/resurface lists: drop
// media embeds (long `![alt](media:sha256:<hex>)` refs are hash noise), collapse
// whitespace, trim, cap. Shared by resurface() + inbox() so previews read the same.
function plainExcerpt(body, max = 180) {
  return String(body || "")
    .replace(/!\[[^\]]*\]\(media:sha256:[a-fA-F0-9]{12,64}\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Resurfacing weights (B6). ONE tunable object — the whole heuristic dials from
// here rather than scattered constants. `age` fades in over `ageHalfLifeDays`
// (saturating); `ageStaleDays` is only the threshold for showing an "Nd untouched"
// reason. `shortlist` caps how many top candidates get the (costlier) unlinked
// scan so a lifelong vault can't turn one resurface into a corpus×corpus walk.
const RESURFACE_WEIGHTS = {
  base: 0.5,          // floor so every note keeps a small chance
  age: 1.0,           // old + never-revisited
  ageHalfLifeDays: 120,
  ageStaleDays: 45,   // reason-string threshold only
  orphan: 2.5,        // no links in or out
  unlinked: 2.0,      // has pending unlinked mentions
  onThisDay: 3.0,     // same month-day in a past year
  shortlist: 50,      // unlinked scan budget (top-N by base weight)
};

// Deterministic seeded RNG (mulberry32) + a stable string→uint32 seed (FNV-1a),
// so a day's resurface/digest is reproducible across refreshes without Math.random
// (which would reshuffle the picks on every call and break a cached digest).
function hashSeed(s) {
  let h = 2166136261 >>> 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// git-crypt encrypted files begin with the bytes \0 G I T C R Y P T \0. When
// A2's git-crypt encrypts the sensitive dirs, a clone that has NOT unlocked
// (missing key, missing binary, or a mis-ordered boot that indexed before the
// unlock hook ran) reads those files as ciphertext. Indexing that would poison
// the graph with binary garbage, so _ingest skips any file still carrying this
// header — matching what D1's MCP server already does. Prefix-only string
// check: the leading bytes are ASCII/NUL and decode 1:1 even from a utf8 read
// of an otherwise-binary blob.
const GITCRYPT_MAGIC = "\u0000GITCRYPT";

// Thrown by write() when an optimistic-lock precondition fails: the caller
// loaded content at one hash and the on-disk node has since changed. The route
// layer maps .code === "STALE_WRITE" to HTTP 409.
class StaleWriteError extends Error {
  constructor(currentHash) {
    super("stale write: node changed since it was loaded");
    this.code = "STALE_WRITE";
    this.currentHash = currentHash;
  }
}

class VaultStore extends EventEmitter {
  constructor({ vaultDir, indexFile }) {
    super();
    this.vaultDir = vaultDir;
    this.indexFile = indexFile;
    this.nodes = new Map();
    this.outlinks = new Map();
    this.backlinks = new Map();
    // Serialize in-process writes per slug. Besides preserving optimistic-lock
    // semantics across the whole read/check/write sequence, this prevents two
    // writers from sharing an atomic-write temp path and leaving disk and the
    // live index out of sync.
    this._writeQueues = new Map();
    // Inverted facet indexes for the timeline (B4a): facet value -> Set(slug),
    // maintained incrementally at the same mutation sites as backlinks so thread
    // derivation is O(matches-in-range), not O(corpus) per request.
    this.tagIndex = new Map();
    this.personIndex = new Map();
    this.eventIndex = new Map();
    // Full-text search (B5). Two MiniSearch indexes: `searchMain` holds every
    // non-sensitive node; `searchSensitive` holds the four sensitive dirs and is
    // queried ONLY when the caller passes includeSensitive (the PIN-unlock flag),
    // so a locked session can never surface sensitive titles/bodies. `_indexedIn`
    // records which index a slug landed in so incremental removal discards from
    // the right one. Locked git-crypt ciphertext never reaches _searchDoc (it's
    // not a node — _ingest's magic-byte guard drops it).
    this.searchMain = newSearchIndex();
    this.searchSensitive = newSearchIndex();
    this._indexedIn = new Map(); // slug -> "main" | "sensitive"
    // hash12 -> absolute path of a media text sidecar (extracted doc/PDF text),
    // and a small read-through cache of the sidecar text, so a node embedding
    // that media indexes its extracted text too. Built best-effort at (re)index.
    this._sidecarMap = new Map();
    this._sidecarTextCache = new Map();
    this.ready = false;
    this.watcher = null;
    this._debounceTimers = new Map();
    // Scale telemetry surfaced in /api/vault/status (B5 sentinel).
    this.initMs = null;      // last full init() wall time
    this.diskBytes = 0;      // working-tree size (excl .git), boot snapshot
  }

  async init() {
    const t0 = Date.now();
    if (!fs.existsSync(this.vaultDir)) {
      await fsp.mkdir(this.vaultDir, { recursive: true });
    }
    await this._sweepTmpFiles();
    const persisted = await this._loadPersistedIndex();
    await this._buildIndex(persisted);
    await this.buildSearchIndex();
    this.diskBytes = await this._measureDiskBytes();
    this._startWatcher();
    this.ready = true;
    this.initMs = Date.now() - t0;
    // Boot budget: the plan's frontmatter cache exists to keep this under ~2s at
    // decade scale. Log loudly when we blow past it so a slow cold boot is visible.
    if (this.initMs > 2000) console.warn(`[vault] slow init: ${this.initMs}ms for ${this.nodes.size} nodes`);
    else console.log(`[vault] init ${this.initMs}ms (${this.nodes.size} nodes)`);
    this.emit("ready", { count: this.nodes.size, initMs: this.initMs });
  }

  async close() {
    if (this.watcher) await this.watcher.close();
    await this._persistIndex();
  }

  async _sweepTmpFiles() {
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (entry.name.endsWith(".tmp")) {
          try { await fsp.unlink(full); } catch {}
        }
      }
    };
    await walk(this.vaultDir);
  }

  async _loadPersistedIndex() {
    if (!this.indexFile || !fs.existsSync(this.indexFile)) return null;
    try {
      const raw = await fsp.readFile(this.indexFile, "utf8");
      return JSON.parse(raw);
    } catch { return null; }
  }

  async _persistIndex() {
    if (!this.indexFile) return;
    // version 2 caches the parsed frontmatter + outlinks so the next boot skips
    // gray-matter + link extraction for files whose mtime+size are unchanged (the
    // decade-scale boot guard). A v1 cache (path/mtime/size/hash only) is treated
    // as a miss by _buildIndex and simply re-parsed — safe forward/backward.
    const payload = { version: 2, builtAt: Date.now(), nodes: {} };
    for (const [slug, node] of this.nodes) {
      payload.nodes[slug] = {
        path: node.path, mtime: node.mtime, size: node.size, hash: node.hash,
        frontmatter: node.frontmatter, outlinks: this.outlinks.get(slug) || [],
      };
    }
    try {
      await fsp.writeFile(this.indexFile + ".tmp", JSON.stringify(payload), "utf8");
      await fsp.rename(this.indexFile + ".tmp", this.indexFile);
    } catch {}
  }

  async _buildIndex(persisted) {
    const files = await this._walkMarkdown(this.vaultDir);
    const usable = persisted && persisted.version === 2 && persisted.nodes;
    const persistedNodes = usable ? persisted.nodes : {};
    let cached = 0;
    for (const file of files) {
      const slug = this._slugFromPath(file);
      const stat = await fsp.stat(file);
      const raw = await fsp.readFile(file, "utf8");
      const prev = persistedNodes[slug];
      // Cache hit: same file (mtime+size), a v2 entry carrying parsed frontmatter
      // + outlinks, and NOT a prior parse-error (whose cached body would diverge
      // from a fresh parse). Reconstruct without gray-matter + link extraction.
      if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size &&
          prev.frontmatter && !prev.frontmatter._parseError && Array.isArray(prev.outlinks)) {
        if (this._ingestCached(slug, file, raw, stat, prev)) cached++;
      } else {
        this._ingest(slug, file, raw, stat);
      }
    }
    if (cached) console.log(`[vault] boot cache: ${cached}/${files.length} nodes reused (skipped re-parse)`);
    this._rebuildBacklinks();
    this._rebuildFacets();
  }

  // Cache-fast ingest: trust the persisted frontmatter + outlinks, split the body
  // cheaply (no YAML parse), recompute the content hash. Still honors the git-crypt
  // magic-byte guard on the fresh read (a file locked since the cache was written
  // must not index as ciphertext). Returns true when a node was added.
  _ingestCached(slug, file, raw, stat, prev) {
    if (typeof raw === "string" && raw.startsWith(GITCRYPT_MAGIC)) return false;
    const hash = crypto.createHash("md5").update(raw).digest("hex");
    this.nodes.set(slug, {
      slug, path: file, frontmatter: prev.frontmatter, body: splitBody(raw),
      mtime: stat.mtimeMs, size: stat.size, hash,
    });
    this.outlinks.set(slug, prev.outlinks);
    return true;
  }

  // Defers to _isIgnored rather than carrying its own inline dot-check. It used to
  // have one, which meant the boot scan and the chokidar watcher enforced two
  // separate ignore rules -- so teaching the watcher to skip node_modules did
  // nothing to the initial index, and 152 package READMEs still landed as nodes.
  // One rule, both readers.
  async _walkMarkdown(dir) {
    const out = [];
    const walk = async (d) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (this._isIgnored(full)) continue;
        if (entry.isDirectory()) { await walk(full); continue; }
        if (entry.name.endsWith(".md")) out.push(full);
      }
    };
    await walk(dir);
    return out;
  }

  _slugFromPath(file) {
    const rel = path.relative(this.vaultDir, file);
    return rel.replace(/\.md$/, "").split(path.sep).join("/");
  }

  _pathFromSlug(slug) {
    return path.join(this.vaultDir, slug + ".md");
  }

  // Canonical slug normalization. write()/delete() strip `..` and leading
  // slashes so a request can't escape the vault; callers that make a security
  // decision on the slug (e.g. the routes' sensitive-dir gate) MUST normalize
  // with this FIRST, or a slug like `health/the..rapy/x` dodges the gate and
  // then normalizes to `health/therapy/x` inside the store. Kept as one method
  // so the gate and the write can never disagree.
  normalizeSlug(slug) {
    return String(slug || "").replace(/\.\./g, "").replace(/^\/+/, "");
  }

  _ingest(slug, file, raw, stat) {
    // git-crypt magic-byte guard (A2/B2). A file still carrying the git-crypt
    // header is ciphertext — the unlock hook did not run (no key/binary) or the
    // boot mis-ordered. Refuse to index it: don't add a node, and drop any prior
    // index entry so a node that just got re-locked disappears cleanly rather
    // than serving stale plaintext. This makes a locked sensitive file invisible
    // (like a 404), never binary garbage in the graph.
    if (typeof raw === "string" && raw.startsWith(GITCRYPT_MAGIC)) {
      if (this.nodes.has(slug)) {
        const prevLinks = this.outlinks.get(slug) || [];
        this._updateBacklinksForNode(slug, prevLinks, []);
        this.nodes.delete(slug);
        this.outlinks.delete(slug);
      }
      return false;
    }
    let parsed;
    try { parsed = matter(raw); }
    catch (e) { parsed = { data: { _parseError: e.message }, content: raw }; }
    const frontmatter = parsed.data || {};
    const body = parsed.content || "";
    const outlinks = this._extractLinks(frontmatter, body);
    const hash = crypto.createHash("md5").update(raw).digest("hex");
    this.nodes.set(slug, {
      slug,
      path: file,
      frontmatter,
      body,
      mtime: stat.mtimeMs,
      size: stat.size,
      hash,
    });
    this.outlinks.set(slug, outlinks);
    return true;
  }

  _extractLinks(frontmatter, body) {
    const links = [];
    let m;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(body)) !== null) {
      links.push({ target: m[1].trim(), type: "body" });
    }
    for (const [key, value] of Object.entries(frontmatter)) {
      const candidates = Array.isArray(value) ? value : [value];
      for (const v of candidates) {
        if (typeof v !== "string") continue;
        WIKILINK_RE.lastIndex = 0;
        let mm;
        while ((mm = WIKILINK_RE.exec(v)) !== null) {
          links.push({ target: mm[1].trim(), type: key });
        }
      }
    }
    return links;
  }

  _rebuildBacklinks() {
    this.backlinks.clear();
    for (const [source, links] of this.outlinks) {
      for (const { target, type } of links) {
        if (!this.backlinks.has(target)) this.backlinks.set(target, []);
        this.backlinks.get(target).push({ source, type });
      }
    }
  }

  // A node's timeline facets from its frontmatter (undefined-safe so the
  // git-crypt re-lock path, which deletes the node, resolves to empty).
  _facetsOf(fm) {
    fm = fm || {};
    return { tag: facetValues(fm.tags), person: facetValues(fm.people), event: facetValues(fm.event) };
  }

  // Facets of whatever node currently sits at `slug` (empty if none) — used to
  // snapshot before/after an _ingest at the mutation sites, exactly like the
  // outlinks snapshots that feed _updateBacklinksForNode.
  _currentFacets(slug) {
    const n = this.nodes.get(slug);
    return this._facetsOf(n && n.frontmatter);
  }

  // Add/remove one slug across the three inverted facet maps by diffing its old
  // vs new facet sets — mirrors _updateBacklinksForNode. Empty postings are
  // dropped so a facet nobody carries anymore stops appearing in the timeline.
  _updateFacetsForNode(slug, oldF, newF) {
    const apply = (map, oldVals, newVals) => {
      const newSet = new Set(newVals);
      const oldSet = new Set(oldVals);
      for (const v of oldVals) {
        if (newSet.has(v)) continue;
        const s = map.get(v);
        if (s) { s.delete(slug); if (!s.size) map.delete(v); }
      }
      for (const v of newVals) {
        if (oldSet.has(v)) continue;
        if (!map.has(v)) map.set(v, new Set());
        map.get(v).add(slug);
      }
    };
    apply(this.tagIndex, oldF.tag, newF.tag);
    apply(this.personIndex, oldF.person, newF.person);
    apply(this.eventIndex, oldF.event, newF.event);
  }

  _rebuildFacets() {
    this.tagIndex.clear();
    this.personIndex.clear();
    this.eventIndex.clear();
    const empty = { tag: [], person: [], event: [] };
    for (const node of this.nodes.values()) {
      this._updateFacetsForNode(node.slug, empty, this._facetsOf(node.frontmatter));
    }
  }

  _updateBacklinksForNode(slug, oldLinks, newLinks) {
    const oldSet = new Set((oldLinks || []).map((l) => l.target + "\0" + l.type));
    const newSet = new Set((newLinks || []).map((l) => l.target + "\0" + l.type));
    for (const { target, type } of (oldLinks || [])) {
      if (newSet.has(target + "\0" + type)) continue;
      const list = this.backlinks.get(target);
      if (!list) continue;
      const idx = list.findIndex((b) => b.source === slug && b.type === type);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.backlinks.delete(target);
    }
    for (const { target, type } of (newLinks || [])) {
      if (oldSet.has(target + "\0" + type)) continue;
      if (!this.backlinks.has(target)) this.backlinks.set(target, []);
      this.backlinks.get(target).push({ source: slug, type });
    }
  }

  // Chokidar ignore predicate. Ignore atomic-write temp files, the sync queue,
  // and dotfiles/dirs — but evaluate the dot rule on the path RELATIVE to the
  // vault root. A plain /(^|[\/\\])\../ regex matches the full path, so a
  // dot-named ANCESTOR (e.g. a `.wt-*` git worktree, how DCC features are
  // developed) would make chokidar ignore the whole tree and silently kill live
  // sync. Relative evaluation watches the vault wherever it lives; prod (no
  // dot-ancestor) behaves exactly as before. Extracted for unit testing.
  // Dot-segments (.git, .mycelium) were the original rule. node_modules had to
  // join them: tools/mcp-server/ and tools/media/ install dependencies INSIDE the
  // vault, and every npm package ships a README.md, so a local clone with deps
  // installed indexed 152 package READMEs as vault nodes -- 46% of the corpus,
  // every one of them an orphan, polluting list/search/orphans/timeline and
  // burying the real graph. Prod never showed it (its clone is --depth 1 and
  // node_modules is gitignored), which is exactly why it went unnoticed.
  //
  // The MCP server's own walker and .mycelium/lint/*.js already skip node_modules;
  // VaultStore was the one reader that did not. A dependency's README is not a note.
  _isIgnored(p) {
    if (p.endsWith(".tmp") || p.endsWith(".sync-queue.json")) return true;
    const rel = path.relative(this.vaultDir, p);
    if (!rel || rel.startsWith("..")) return false; // the root itself / outside
    return rel.split(path.sep).some((seg) => seg.startsWith(".") || seg === "node_modules");
  }

  _startWatcher() {
    this.watcher = chokidar.watch(this.vaultDir, {
      ignored: (p) => this._isIgnored(p),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const handle = (type, file) => {
      if (!file.endsWith(".md")) return;
      const key = file;
      clearTimeout(this._debounceTimers.get(key));
      this._debounceTimers.set(key, setTimeout(() => {
        this._debounceTimers.delete(key);
        this._onWatcherEvent(type, file).catch((e) => {
          console.error("[vault] watcher handler error:", e.message);
        });
      }, 200));
    };
    this.watcher.on("add", (f) => handle("add", f));
    this.watcher.on("change", (f) => handle("change", f));
    this.watcher.on("unlink", (f) => handle("unlink", f));
  }

  async _onWatcherEvent(type, file) {
    const slug = this._slugFromPath(file);
    if (type === "unlink") {
      const prev = this.nodes.get(slug);
      if (prev) {
        const prevLinks = this.outlinks.get(slug) || [];
        const prevFacets = this._facetsOf(prev.frontmatter);
        this._updateBacklinksForNode(slug, prevLinks, []);
        this._updateFacetsForNode(slug, prevFacets, { tag: [], person: [], event: [] });
        this.nodes.delete(slug);
        this.outlinks.delete(slug);
        this._removeFromSearch(slug);
        this.emit("vault-changed", { action: "delete", slug });
      }
      return;
    }
    let stat;
    try { stat = await fsp.stat(file); }
    catch { return; }
    const raw = await fsp.readFile(file, "utf8");
    const newHash = crypto.createHash("md5").update(raw).digest("hex");
    const prev = this.nodes.get(slug);
    // Suppress chokidar echoes of our own atomic writes: the index already
    // reflects the new content (write() called _ingest synchronously), so
    // the hash already matches. Only emit when the on-disk content diverges
    // from what we have in the index — that's a genuine external edit.
    if (prev && prev.hash === newHash) return;
    const prevLinks = this.outlinks.get(slug) || [];
    const prevFacets = this._currentFacets(slug);
    this._ingest(slug, file, raw, stat);
    const newLinks = this.outlinks.get(slug) || [];
    this._updateBacklinksForNode(slug, prevLinks, newLinks);
    this._updateFacetsForNode(slug, prevFacets, this._currentFacets(slug));
    await this._reindexNode(slug);
    this.emit("vault-changed", { action: prev ? "update" : "create", slug });
  }

  // ── Public API ──

  list({ type, subtype, hasField, sinceDate } = {}) {
    const out = [];
    for (const node of this.nodes.values()) {
      const fm = node.frontmatter || {};
      if (type && fm.type !== type) continue;
      if (subtype && fm.subtype !== subtype) continue;
      if (hasField && !(hasField in fm)) continue;
      if (sinceDate) {
        const created = fm.created || fm.date || fm.scheduled_at;
        if (!created || String(created).slice(0, 10) < sinceDate) continue;
      }
      out.push({
        slug: node.slug,
        frontmatter: fm,
        mtime: node.mtime,
      });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  // Timeline data (B4a): the dated nodes in [from,to] that pass the type/tag/
  // person filters, plus the relevance THREADS among them — a thread being a
  // tag/person/event shared by >= 2 in-range nodes. Pure graph/index output:
  // NO colors and NO sensitivity gating (the route owns presentation + the
  // security boundary). Threads come from the inverted maps intersected with the
  // in-range set, so cost is O(matches in range), not O(corpus) — the F10 win.
  // Thread members are slugs (the caller already holds the node list); threads
  // are returned most-connected first so the route can density-cap by rank.
  timeline({ from, to, types, tags, people } = {}) {
    const typeSet = types && types.length ? new Set(types) : null;
    const tagSet = tags && tags.length ? new Set(tags) : null;
    const personSet = people && people.length ? new Set(people) : null;

    const inRange = new Map(); // slug -> node view
    for (const node of this.nodes.values()) {
      const fm = node.frontmatter || {};
      const date = nodeDate(fm);
      if (!date) continue;
      if (from && date < from) continue;
      if (to && date > to) continue;
      if (typeSet && !typeSet.has(fm.type || "untyped")) continue;
      const f = this._facetsOf(fm);
      if (tagSet && !f.tag.some((t) => tagSet.has(t))) continue;
      if (personSet && !f.person.some((p) => personSet.has(p))) continue;
      inRange.set(node.slug, {
        slug: node.slug,
        title: fm.title || node.slug.split("/").pop(),
        type: fm.type || "untyped",
        date,
        tags: f.tag,
        people: f.person,
        event: f.event,
      });
    }

    // Only the facet VALUES that actually appear on an in-range node can seed a
    // thread — collect them from the in-range set (O(matches)), then intersect
    // each one's posting list with the in-range set.
    const tagVals = new Set(), personVals = new Set(), eventVals = new Set();
    for (const n of inRange.values()) {
      n.tags.forEach((t) => tagVals.add(t));
      n.people.forEach((p) => personVals.add(p));
      n.event.forEach((e) => eventVals.add(e));
    }
    const byDateThenSlug = (a, b) => {
      const da = inRange.get(a).date, db = inRange.get(b).date;
      return da < db ? -1 : da > db ? 1 : a < b ? -1 : 1;
    };
    const threads = [];
    const collect = (kind, map, values) => {
      for (const val of values) {
        const posting = map.get(val);
        if (!posting) continue;
        const members = [];
        for (const slug of posting) if (inRange.has(slug)) members.push(slug);
        if (members.length < 2) continue;
        members.sort(byDateThenSlug);
        threads.push({ key: `${kind}:${val}`, kind, value: val, members });
      }
    };
    collect("tag", this.tagIndex, tagVals);
    collect("person", this.personIndex, personVals);
    collect("event", this.eventIndex, eventVals);
    threads.sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1));

    const nodes = Array.from(inRange.values()).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.slug < b.slug ? -1 : 1);
    return { nodes, threads };
  }

  // ── Search (B5): pure-JS full text over title/body/tags/aliases + media sidecars ──

  // { hash12 -> sidecar .txt path } from the media manifest tree, so a node
  // embedding `media:sha256:<hex>` folds that media's extracted text into its
  // search doc. Best-effort: absent dirs skipped. A single recursive descent of
  // media/manifests finds every <hash12>.txt at any depth (year dirs AND private/)
  // and visits private/ exactly once — so, unlike the media route's two-root
  // eachManifestDir, it needs no private-skip and stays correct if the manifest
  // layout ever changes (no silent-empty coupling to the route's dir constants).
  async _buildSidecarMap() {
    this._sidecarMap.clear();
    this._sidecarTextCache.clear();
    const root = path.join(this.vaultDir, "media", "manifests");
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        if (e.name.endsWith(".txt")) this._sidecarMap.set(e.name.replace(/\.txt$/, ""), full);
      }
    };
    await walk(root);
  }

  // Concatenated sidecar text for whatever media a node embeds ("" when none).
  // Read-through cached per hash12; one sidecar's contribution is capped so a huge
  // OCR dump can't dominate a node's relevance.
  async _sidecarTextForNode(node) {
    const body = node.body || "";
    if (!this._sidecarMap.size || body.indexOf("media:sha256:") < 0) return "";
    const parts = [];
    const seen = new Set();
    let m;
    MEDIA_REF_RE.lastIndex = 0;
    while ((m = MEDIA_REF_RE.exec(body)) !== null) {
      const hash12 = m[1].slice(0, 12).toLowerCase();
      if (seen.has(hash12)) continue;
      seen.add(hash12);
      const p = this._sidecarMap.get(hash12);
      if (!p) continue;
      if (this._sidecarTextCache.has(hash12)) { parts.push(this._sidecarTextCache.get(hash12)); continue; }
      let txt = "";
      try { txt = await fsp.readFile(p, "utf8"); } catch { txt = ""; }
      if (txt.length > 200000) txt = txt.slice(0, 200000);
      this._sidecarTextCache.set(hash12, txt);
      parts.push(txt);
    }
    return parts.join("\n");
  }

  // The MiniSearch document for a node. tags/aliases flattened to strings; body is
  // indexed but NOT stored (snippets read the live body). Async only for the
  // sidecar read.
  async _searchDoc(node) {
    const fm = node.frontmatter || {};
    const tags = facetValues(fm.tags).join(" ");
    const aliases = (Array.isArray(fm.aliases) ? fm.aliases : fm.aliases ? [fm.aliases] : [])
      .filter((x) => typeof x === "string").join(" ");
    return {
      id: node.slug,
      title: fm.title || node.slug.split("/").pop(),
      type: fm.type || "untyped",
      body: node.body || "",
      tags,
      aliases,
      sidecar: await this._sidecarTextForNode(node),
    };
  }

  // (Re)build BOTH indexes from scratch. Cheap (MiniSearch add is in-memory), so
  // it's also the /api/vault/reindex path. Rebuilds the sidecar map first so
  // freshly-pulled extracted text is picked up.
  //
  // Builds into LOCAL index objects and swaps them in only after the loop
  // finishes. buildSearchIndex awaits (sidecar reads) between adds, and post-boot
  // a concurrent write()/watcher _reindexNode targets the LIVE index; if we added
  // into the live index here, that concurrent add of a not-yet-reached slug would
  // make our loop's later add() throw duplicate-ID (and hang /reindex). Isolating
  // the build keeps the loop's adds collision-free; the concurrent mutation lands
  // on the old index and is simply superseded by the swap.
  async buildSearchIndex() {
    await this._buildSidecarMap();
    const main = newSearchIndex();
    const sensitive = newSearchIndex();
    const indexedIn = new Map();
    for (const node of this.nodes.values()) {
      const doc = await this._searchDoc(node);
      const where = isSensitivePath(node.slug) ? "sensitive" : "main";
      (where === "sensitive" ? sensitive : main).add(doc);
      indexedIn.set(node.slug, where);
    }
    this.searchMain = main;
    this.searchSensitive = sensitive;
    this._indexedIn = indexedIn;
    return main.documentCount + sensitive.documentCount;
  }

  // Drop a slug from whichever index holds it (id-based; safe if absent).
  _removeFromSearch(slug) {
    const where = this._indexedIn.get(slug);
    if (!where) return;
    const idx = where === "sensitive" ? this.searchSensitive : this.searchMain;
    try { idx.discard(slug); } catch { /* already gone */ }
    this._indexedIn.delete(slug);
  }

  // Re-index one slug after a write/edit/external change: remove any prior doc
  // (possibly from the OTHER index if its sensitivity flipped), then add the
  // current node. A slug whose node vanished (git-crypt re-lock) is just removed.
  async _reindexNode(slug) {
    this._removeFromSearch(slug);
    const node = this.nodes.get(slug);
    if (!node) return;
    const doc = await this._searchDoc(node);
    const where = isSensitivePath(slug) ? "sensitive" : "main";
    (where === "sensitive" ? this.searchSensitive : this.searchMain).add(doc);
    this._indexedIn.set(slug, where);
  }

  // Query. `includeSensitive` (the PIN-unlock flag) is the ONLY door to sensitive
  // nodes — a locked session queries searchMain alone. `mode:"title"` restricts
  // matching to title+aliases (the quick-switcher). A short plain-text snippet
  // around the first query hit is attached per result (route escapes it).
  search(q, { includeSensitive = false, limit = 30, offset = 0, mode = "full" } = {}) {
    const query = String(q || "").trim();
    if (!query) return { results: [], total: 0 };
    const opts = {
      prefix: true,
      fuzzy: (term) => (term.length >= 4 ? 0.2 : 0),
      boost: { title: mode === "title" ? 8 : 3, aliases: mode === "title" ? 6 : 4, tags: 2 },
      combineWith: "AND",
    };
    if (mode === "title") opts.fields = ["title", "aliases"];
    let hits = this.searchMain.search(query, opts);
    if (includeSensitive) hits = hits.concat(this.searchSensitive.search(query, opts));
    hits.sort((a, b) => b.score - a.score);
    const total = hits.length;
    const page = hits.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));
    const results = page.map((h) => {
      const node = this.nodes.get(h.id);
      return {
        slug: h.id,
        title: h.title || h.id.split("/").pop(),
        type: h.type || "untyped",
        score: h.score,
        sensitive: isSensitivePath(h.id),
        // The node's one-line summary, when it has one. A result row can then say
        // what a note IS rather than only showing the matched fragment -- the
        // snippet tells you WHERE your term hit, the summary tells you whether the
        // note is worth opening. Both ship; the client prefers the summary.
        summary: node && node.frontmatter && typeof node.frontmatter.summary === "string"
          ? node.frontmatter.summary.trim() || null : null,
        snippet: node ? this._searchSnippet(node.body, h.terms) : "",
      };
    });
    return { results, total };
  }

  // ±90 chars around the first matched term (whitespace-collapsed, ellipsized).
  // A title-only hit (no body match) shows the body head. Raw text; route escapes.
  // Slices the window out of the RAW body FIRST and normalizes only that window
  // (matching _backlinkContext) — never allocates a normalized/lowercased copy of
  // the whole body, since this runs per result on every debounced keystroke.
  _searchSnippet(body, terms) {
    const raw = String(body || "");
    if (!raw) return "";
    let at = -1;
    for (const t of terms || []) {
      const term = String(t || "");
      if (!term) continue;
      // Case-insensitive locate without lowercasing the whole body: a literal
      // (regex-escaped) /term/i search over the raw string.
      const i = raw.search(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0) {
      const head = raw.slice(0, 200).replace(/\s+/g, " ").trim();
      return head.length > 180 ? head.slice(0, 180) + " …" : head + (raw.length > 200 ? " …" : "");
    }
    const start = Math.max(0, at - 90);
    const end = Math.min(raw.length, at + 110);
    let s = raw.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) s = "… " + s;
    if (end < raw.length) s = s + " …";
    return s;
  }

  // Unlinked mentions of `slug`: other nodes whose BODY contains this node's
  // title or an alias, but which don't already link to it. Runs on the search
  // index (title/alias terms), not a corpus re-walk. Sensitive sources are hidden
  // unless includeSensitive. Returns [{slug,title,term,snippet}].
  unlinked(slug, { includeSensitive = false, limit = 20 } = {}) {
    const target = this.nodes.get(slug);
    if (!target) return [];
    const fm = target.frontmatter || {};
    const names = [fm.title, ...(Array.isArray(fm.aliases) ? fm.aliases : fm.aliases ? [fm.aliases] : [])]
      .filter((n) => typeof n === "string" && n.trim().length >= 3);
    if (!names.length) return [];
    // Sources that already link here (any edge type) are not "unlinked".
    const linked = new Set((this.backlinks.get(slug) || []).map((b) => b.source));
    const out = new Map(); // source slug -> hit (first winning term)
    for (const name of names) {
      const opts = { prefix: false, fuzzy: false, fields: ["body"], combineWith: "AND" };
      let hits = this.searchMain.search(name, opts);
      if (includeSensitive) hits = hits.concat(this.searchSensitive.search(name, opts));
      for (const h of hits) {
        if (h.id === slug || linked.has(h.id) || out.has(h.id)) continue;
        const src = this.nodes.get(h.id);
        if (!src) continue;
        // Confirm the raw name actually appears in the body (MiniSearch tokenizes,
        // so "fox" would match "foxes"; require the literal phrase for a mention).
        if (String(src.body || "").toLowerCase().indexOf(name.toLowerCase()) < 0) continue;
        out.set(h.id, {
          slug: h.id,
          title: (src.frontmatter && src.frontmatter.title) || h.id.split("/").pop(),
          term: name,
          sensitive: isSensitivePath(h.id),
          snippet: this._searchSnippet(src.body, [name]),
        });
        if (out.size >= limit) break;
      }
      if (out.size >= limit) break;
    }
    return Array.from(out.values());
  }

  // ── Orphans (B5 discovery): nodes with zero in AND out edges, excluding the
  // inbox/fleeting staging area (expected to be unlinked). Sensitive orphans are
  // withheld unless includeSensitive, mirroring search.
  // A node whose outlinks are GENERATED, not curated: weekly-review digests and
  // folder hub notes. Their backlinks must not count as evidence that a note is
  // connected, and they must not be resurfaced as "worth re-seeing" -- they are
  // derived artifacts, not thinking.
  //
  // Retro F2, measured: generating 11 hub notes over this corpus dropped the orphan
  // count from 108 to 20 without a single human linking anything. Unguarded, the
  // resurfacing engine would lose the orphan signal entirely and the weekly review
  // would stop showing genuinely disconnected notes -- silently, and forever.
  _isGenerated(slug) {
    const s = String(slug);
    if (s.startsWith("notes/reviews/")) return true;
    const n = this.nodes.get(s);
    return !!(n && n.frontmatter && n.frontmatter.type === "hub");
  }

  orphans({ includeSensitive = false } = {}) {
    const out = [];
    for (const node of this.nodes.values()) {
      const slug = node.slug;
      const fm = node.frontmatter || {};
      if (fm.type === "fleeting" || slug.startsWith("inbox/")) continue;
      if (fm.type === "hub") continue;   // a hub is a map, not a note that can be orphaned
      if (!includeSensitive && isSensitivePath(slug)) continue;
      const outN = (this.outlinks.get(slug) || []).length;
      // Ignore backlinks whose SOURCE is a weekly review note: the digest auto-
      // links every orphan it lists (so the review is itself in the graph), which
      // would otherwise "de-orphan" a note nobody actually curated — silently
      // shrinking next week's orphan set and killing its resurface signal.
      const inN = (this.backlinks.get(slug) || []).filter((b) => !this._isGenerated(b.source)).length;
      if (outN === 0 && inN === 0) {
        out.push({ slug, title: fm.title || slug.split("/").pop(), type: fm.type || "untyped", sensitive: isSensitivePath(slug) });
      }
    }
    out.sort((a, b) => (a.slug < b.slug ? -1 : 1));
    return out;
  }

  // ── Resurfacing (B6): make forgotten notes come back ──
  // The whole vault ethos is "a brain for HAVING ideas" — ideas only help if they
  // come BACK. resurface() draws a weighted sample favoring the notes most worth
  // re-seeing: old + untouched, orphaned (no links in/out), under-connected (has
  // unlinked mentions someone never wired up), and same-week-in-past-years ("on
  // this day"). Fleeting/inbox scratch and the review notes themselves are excluded;
  // sensitive notes only when includeSensitive (mirrors search/orphans). The pick
  // is DETERMINISTIC per (dayKey, corpus) via a seeded RNG — a cached digest stays
  // stable across a day's refreshes — instead of raw Math.random.
  //
  // Weights live in ONE tunable object (not scattered constants), so the heuristic
  // can be dialed without hunting the code. Cost is O(pool) + O(shortlist unlinked
  // scans); the unlinked signal is only computed for the top `shortlist` base-weight
  // candidates so a lifelong vault can't turn one resurface into a full-corpus scan.
  resurface({ n = 5, dayKey = "", now, includeSensitive = false } = {}) {
    const W = RESURFACE_WEIGHTS;
    // "Deterministic per day" must be exact: when the caller doesn't pin `now`,
    // snap it to the dayKey's midnight so the age term (and thus the seeded ES
    // keys) can't drift between a morning and an evening view. Wall-clock only
    // as a last resort (dayKey not a date).
    if (now == null) {
      const t = Date.parse(String(dayKey).slice(0, 10) + "T00:00:00Z");
      now = Number.isNaN(t) ? Date.now() : t;
    }
    const today = /^\d{4}-\d{2}-\d{2}/.test(String(dayKey)) ? String(dayKey).slice(0, 10) : null;
    const todayMD = today ? today.slice(5) : null;   // MM-DD
    const todayY = today ? today.slice(0, 4) : null;
    const orphanSet = new Set(this.orphans({ includeSensitive }).map((o) => o.slug));

    // Candidate pool: real long-term notes, in a STABLE order (slug-sorted) so the
    // seeded draw is reproducible regardless of Map insertion order.
    const cands = [];
    for (const node of this.nodes.values()) {
      const slug = node.slug;
      const fm = node.frontmatter || {};
      if (fm.type === "fleeting" || slug.startsWith("inbox/")) continue;
      if (this._isGenerated(slug)) continue;   // digests AND hubs: derived, not thinking
      if (!includeSensitive && isSensitivePath(slug)) continue;
      cands.push(node);
    }
    cands.sort((a, b) => (a.slug < b.slug ? -1 : 1));

    // Base weight per candidate (age + orphan + on-this-day + a floor).
    const scored = cands.map((node) => {
      const fm = node.frontmatter || {};
      const ageD = Math.max(0, (now - (node.mtime || now)) / 86400000);
      const ageScore = ageD / (ageD + W.ageHalfLifeDays);   // saturating 0→1, older=higher
      const isOrphan = orphanSet.has(node.slug) ? 1 : 0;
      const nd = nodeDate(fm);
      const onThisDay = (todayMD && nd && nd.slice(5) === todayMD && nd.slice(0, 4) !== todayY) ? 1 : 0;
      const reasons = [];
      if (ageD >= W.ageStaleDays) reasons.push({ kind: "age", note: `${Math.round(ageD)}d untouched`, days: Math.round(ageD) });
      if (isOrphan) reasons.push({ kind: "orphan", note: "no links in or out" });
      if (onThisDay) reasons.push({ kind: "onthisday", note: `on this day, ${nd.slice(0, 4)}`, year: nd.slice(0, 4) });
      return {
        node, slug: node.slug, date: nd,
        weight: W.base + W.age * ageScore + W.orphan * isOrphan + W.onThisDay * onThisDay,
        reasons, ageD, isOrphan, onThisDay, hasUnlinked: false,
      };
    });

    // Under-connected signal (bounded): only the top-`shortlist` base-weight
    // candidates get an unlinked scan, so this never becomes a corpus×corpus walk.
    const shortlist = scored.slice().sort((a, b) => b.weight - a.weight).slice(0, W.shortlist);
    for (const s of shortlist) {
      const u = this.unlinked(s.slug, { includeSensitive, limit: 3 });
      if (u.length) {
        s.hasUnlinked = true;
        s.unlinkedCount = u.length;
        s.weight += W.unlinked;
        s.reasons.push({ kind: "unlinked", note: `${u.length} unlinked mention${u.length === 1 ? "" : "s"}`, count: u.length });
      }
    }

    // Weighted sampling WITHOUT replacement (Efraimidis–Spirakis): key = r^(1/w),
    // take the top n keys. One seeded draw per candidate in the stable order above
    // ⇒ same (dayKey, corpus) ⇒ same picks.
    const rng = mulberry32(hashSeed("resurface:" + (dayKey || "")));
    for (const s of scored) {
      const r = rng() || Number.MIN_VALUE;
      s._key = Math.pow(r, 1 / Math.max(s.weight, 1e-6));
    }
    const picks = scored.sort((a, b) => b._key - a._key).slice(0, Math.max(0, n));
    return {
      pool: scored.length,
      picks: picks.map((s) => {
        const fm = s.node.frontmatter || {};
        return {
          slug: s.slug,
          title: fm.title || s.slug.split("/").pop(),
          type: fm.type || "untyped",
          date: s.date,
          sensitive: isSensitivePath(s.slug),
          reasons: s.reasons,
          excerpt: plainExcerpt(s.node.body, 180),
        };
      }),
    };
  }

  // Timeline-thread neighbors of a node (B4a inverted maps): other notes that
  // share a tag/person/event with it, so a resurfaced note comes back WITH the
  // things it connects to. Deterministic (slug-sorted), self- and sensitive-gated,
  // capped. Returns [{slug, title, type, via:{kind,value}}].
  threadNeighbors(slug, { limit = 4, includeSensitive = false } = {}) {
    const node = this.nodes.get(slug);
    if (!node) return [];
    const f = this._facetsOf(node.frontmatter);
    const maps = [["tag", this.tagIndex, f.tag], ["person", this.personIndex, f.person], ["event", this.eventIndex, f.event]];
    const seen = new Set([slug]);
    const out = [];
    for (const [kind, map, values] of maps) {
      for (const value of values) {
        const posting = map.get(value);
        if (!posting) continue;
        for (const other of Array.from(posting).sort()) {
          if (seen.has(other)) continue;
          if (!includeSensitive && isSensitivePath(other)) continue;
          const on = this.nodes.get(other);
          if (!on) continue;
          seen.add(other);
          const ofm = on.frontmatter || {};
          out.push({ slug: other, title: ofm.title || other.split("/").pop(), type: ofm.type || "untyped", via: { kind, value } });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  // Inbox review queue (B6): the `inbox/` fleeting notes, OLDEST first (the ones
  // rotting longest surface first), with a short excerpt for the review list. Inbox
  // is never a sensitive dir, so no gating is needed. `created` (frontmatter) is the
  // sort key, falling back to mtime for a note that somehow lacks it.
  inbox() {
    const out = [];
    for (const node of this.nodes.values()) {
      if (!node.slug.startsWith("inbox/")) continue;
      const fm = node.frontmatter || {};
      const created = fm.created ? String(fm.created) : new Date(node.mtime || 0).toISOString();
      // Sort on a numeric epoch, not the raw string: `created` values arrive in
      // mixed formats (ISO from capture, but a JS Date.toString() from some
      // hand/tool writes), so a lexical compare would mis-order them. Unparseable
      // → fall back to mtime so a note still sorts sanely.
      const ts = Number.isNaN(Date.parse(created)) ? (node.mtime || 0) : Date.parse(created);
      out.push({
        slug: node.slug,
        title: fm.title || node.slug.split("/").pop(),
        type: fm.type || "fleeting",
        created,
        mtime: node.mtime,
        _ts: ts,
        excerpt: plainExcerpt(node.body, 160),
      });
    }
    out.sort((a, b) => a._ts - b._ts || (a.slug < b.slug ? -1 : 1));
    return out.map(({ _ts, ...rest }) => rest);
  }

  // Working-tree size (bytes), excluding .git — a boot snapshot for the scale
  // sentinel. One walk; symlinks/errors skipped. Not kept live (a warning gauge).
  async _measureDiskBytes() {
    let total = 0;
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        if (!e.isFile()) continue;
        try { const st = await fsp.stat(full); total += st.size; } catch {}
      }
    };
    await walk(this.vaultDir);
    return total;
  }

  // Cheap existence check (no body/backlink-context work) — used to flag
  // dangling wikilinks at render time.
  has(slug) { return this.nodes.has(slug); }

  get(slug) {
    const node = this.nodes.get(slug);
    if (!node) return null;
    const backlinks = (this.backlinks.get(slug) || []).map((b) => ({
      ...b,
      context: this._backlinkContext(b.source, slug, b.type),
    }));
    return {
      slug: node.slug,
      frontmatter: node.frontmatter,
      body: node.body,
      // Content hash the editor round-trips as the optimistic-lock token: it
      // sends this back on PUT so write() can 409 if the node changed meanwhile.
      hash: node.hash,
      outlinks: this.outlinks.get(slug) || [],
      backlinks,
    };
  }

  // Context snippet for one backlink: the text around where `source` links to
  // `targetSlug`. Core Zettelkasten navigation — you see WHY something links
  // here without opening it. Body links get ±120 chars around the wikilink
  // (whitespace collapsed, ellipsized); frontmatter links show that field's
  // value. Returns { text, field } or null if the source is gone / no match.
  _backlinkContext(source, targetSlug, type) {
    const node = this.nodes.get(source);
    if (!node) return null;
    if (type !== "body") {
      const v = node.frontmatter ? node.frontmatter[type] : undefined;
      if (v == null) return null;
      const s = Array.isArray(v) ? v.join(", ") : String(v);
      return { text: s.replace(/\s+/g, " ").trim().slice(0, 280), field: type };
    }
    const body = node.body || "";
    WIKILINK_RE.lastIndex = 0;
    let m;
    while ((m = WIKILINK_RE.exec(body)) !== null) {
      if (m[1].trim() !== targetSlug) continue;
      const start = Math.max(0, m.index - 120);
      const end = Math.min(body.length, m.index + m[0].length + 120);
      let snippet = body.slice(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) snippet = "… " + snippet;
      if (end < body.length) snippet = snippet + " …";
      return { text: snippet, field: null };
    }
    return null;
  }

  async _withWriteLock(slug, fn) {
    const previous = this._writeQueues.get(slug) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this._writeQueues.set(slug, gate);
    await previous.catch(() => {});
    try { return await fn(); }
    finally {
      release();
      if (this._writeQueues.get(slug) === gate) this._writeQueues.delete(slug);
    }
  }

  async write(slug, { frontmatter, body, expectedHash, expectAbsent = false } = {}) {
    if (!slug || typeof slug !== "string") throw new Error("slug required");
    const safeSlug = this.normalizeSlug(slug);
    return this._withWriteLock(safeSlug, () => this._writeUnlocked(safeSlug, { frontmatter, body, expectedHash, expectAbsent }));
  }

  // Atomic read-modify-write for append-style callers. The updater runs while
  // the same per-slug lock used by write() is held, so it always sees the latest
  // in-process value and cannot lose a concurrent edit.
  async mutate(slug, updater) {
    if (!slug || typeof slug !== "string") throw new Error("slug required");
    if (typeof updater !== "function") throw new Error("updater required");
    const safeSlug = this.normalizeSlug(slug);
    return this._withWriteLock(safeSlug, async () => {
      const next = await updater(this.nodes.get(safeSlug) || null);
      if (!next || typeof next !== "object") throw new Error("updater must return a write record");
      return this._writeUnlocked(safeSlug, next);
    });
  }

  async _writeUnlocked(safeSlug, { frontmatter, body, expectedHash, expectAbsent = false } = {}) {
    // Optimistic lock: when the caller passes the hash it loaded, refuse the
    // write if the on-disk node has moved on (concurrent Obsidian/other-tab
    // edit). null current + a non-null expected = the node was deleted under us,
    // also a conflict. Omitting expectedHash (create, or force) skips the check.
    const cur = this.nodes.get(safeSlug);
    const curHash = cur ? cur.hash : null;
    if (expectAbsent) {
      if (curHash !== null) throw new StaleWriteError(curHash);
    } else if (expectedHash != null) {
      if (curHash !== expectedHash) throw new StaleWriteError(curHash);
    }
    const file = this._pathFromSlug(safeSlug);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const serialized = matter.stringify(body || "", frontmatter || {});
    // Keep the established .tmp suffix so startup sweeping and the vault's
    // existing *.tmp gitignore both cover crash residue. The pid/random segment
    // makes concurrent writers use distinct paths.
    const tmp = `${file}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fsp.writeFile(tmp, serialized, "utf8");
      await fsp.rename(tmp, file);
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
    const stat = await fsp.stat(file);
    const prevLinks = this.outlinks.get(safeSlug) || [];
    const prevFacets = this._currentFacets(safeSlug);
    this._ingest(safeSlug, file, serialized, stat);
    const newLinks = this.outlinks.get(safeSlug) || [];
    this._updateBacklinksForNode(safeSlug, prevLinks, newLinks);
    this._updateFacetsForNode(safeSlug, prevFacets, this._currentFacets(safeSlug));
    await this._reindexNode(safeSlug);
    this.emit("vault-changed", { action: "update", slug: safeSlug, source: "local" });
    return this.get(safeSlug);
  }

  async delete(slug) {
    const safeSlug = this.normalizeSlug(slug);
    return this._withWriteLock(safeSlug, () => this._deleteUnlocked(safeSlug));
  }

  async _deleteUnlocked(safeSlug) {
    const file = this._pathFromSlug(safeSlug);
    if (!fs.existsSync(file)) return false;
    await fsp.unlink(file);
    const prevLinks = this.outlinks.get(safeSlug) || [];
    const prevFacets = this._currentFacets(safeSlug);
    this._updateBacklinksForNode(safeSlug, prevLinks, []);
    this._updateFacetsForNode(safeSlug, prevFacets, { tag: [], person: [], event: [] });
    this.nodes.delete(safeSlug);
    this.outlinks.delete(safeSlug);
    this._removeFromSearch(safeSlug);
    this.emit("vault-changed", { action: "delete", slug: safeSlug, source: "local" });
    return true;
  }

  graph(slug) {
    const outlinks = this.outlinks.get(slug) || [];
    const backlinks = this.backlinks.get(slug) || [];
    const neighborSet = new Set();
    outlinks.forEach((l) => neighborSet.add(l.target));
    backlinks.forEach((l) => neighborSet.add(l.source));
    return {
      slug,
      outlinks,
      backlinks,
      neighbors: Array.from(neighborSet),
    };
  }

  // Whole-corpus graph for the global graph view. graph(slug) above is the 1-hop
  // neighbourhood the reading pane's Linked-mentions panel wants; this is every
  // node and every edge at once, laid out client-side by d3-force.
  //
  // Edge resolution matches routes/vault.js renderWikilinks() EXACTLY: an exact
  // slug hit is a real edge, anything else is dangling. DCC deliberately has no
  // basename fallback (the MCP server does), so `[[collins]]` against a node at
  // `people/collins-quaintance` is dangling here just as it renders dimmed in the
  // note. If the graph resolved links the reading pane calls dead, the two
  // surfaces would disagree about the same link and neither would be trustworthy.
  //
  // Dangling targets come back separately as `ghosts` with their inbound count,
  // never mixed into `nodes` -- they have no file, so they have no type, date or
  // tags, and letting them into the node list would corrupt every count derived
  // from it. The client draws them only on request. They are worth drawing at
  // least once: the folded journal import carries ~50 links into the OLD vault's
  // folder names, and this view is the only place that decay is visible.
  //
  // Sensitive nodes on a locked session are dropped ENTIRELY, not collapsed to
  // anonymous dots the way the timeline does it. A dateless grey dot on an axis
  // leaks nothing; a graph node leaks structure -- its degree plus its visible
  // neighbours' titles narrow down what it is. Their edges go with them.
  graphAll({ includeSensitive = false } = {}) {
    const visible = (slug) => includeSensitive || !isSensitivePath(slug);

    const nodes = [];
    const index = new Map();            // slug -> position in nodes
    for (const node of this.nodes.values()) {
      const slug = node.slug;
      if (!visible(slug)) continue;
      const fm = node.frontmatter || {};
      index.set(slug, nodes.length);
      nodes.push({
        id: slug,
        slug,
        title: fm.title || slug.split("/").pop(),
        type: fm.type || "untyped",
        date: nodeDate(fm),
        tags: facetValues(fm.tags),
        // Weekly-review notes are GENERATED and link every note they surface, so
        // they read as hubs they did not earn (the F2 lesson: an artifact that
        // links into the graph it describes corrupts its own signal). Flagged so
        // the client can hide them; orphans() already discounts their backlinks.
        generated: this._isGenerated(slug),
        sensitive: isSensitivePath(slug),
        // Carried so the graph can say what a node IS on hover, not just its
        // title. Escaped at the route boundary like every other authored string.
        summary: typeof fm.summary === "string" && fm.summary.trim() ? fm.summary.trim() : null,
        deg: 0,
      });
    }

    const edges = [];
    const ghostMap = new Map();         // unresolved target -> {srcs:Set, links:n}
    // Every outlink not drawn because an ENDPOINT is outside the visible node set
    // -- a hidden sensitive node at either end, or a stale outlinks entry whose
    // source node is gone. indexSummary().totalEdges counts raw outlinks including
    // those, so they have to be counted here too or the lossless identity breaks.
    // (It did: skipping a hidden SOURCE with a bare `continue` silently dropped
    // its whole link list, which is what the B7 identity assertion caught.)
    let hiddenEdges = 0;
    for (const [source, links] of this.outlinks) {
      if (!index.has(source)) { hiddenEdges += links.length; continue; }
      for (const { target, type } of links) {
        if (index.has(target)) {
          edges.push({ s: source, t: target, type: type || "body" });
          nodes[index.get(source)].deg++;
          nodes[index.get(target)].deg++;
        } else if (this.nodes.has(target)) {
          // Resolves to a real node we are deliberately hiding (sensitive on a
          // locked session). NOT a dangling link -- do not report it as decay,
          // and do not leak the target slug. Counted only in aggregate.
          hiddenEdges++;
        } else {
          if (!ghostMap.has(target)) ghostMap.set(target, { srcs: new Set(), links: 0 });
          const g = ghostMap.get(target);
          g.srcs.add(source);
          g.links++;
        }
      }
    }

    // Ghosts carry their SOURCES, not just a count: the graph draws a dangling
    // target as a hollow satellite wired to the notes pointing at it, which is
    // the only way the view answers "which notes have rot in them". A bare count
    // renders an unattached dot nobody can act on.
    //
    // Two counts on purpose. `inbound` is DISTINCT notes (what the UI says out
    // loud, and what sources.length is); `links` is raw wikilink occurrences,
    // which is higher when one note points at the same dead target twice. Both
    // are here so the totals below can be audited against the store's own
    // totalEdges -- a graph that quietly loses edges is worse than no graph.
    const ghosts = Array.from(ghostMap, ([target, g]) => ({
      target,
      inbound: g.srcs.size,
      links: g.links,
      sources: Array.from(g.srcs).sort(),
    })).sort((a, b) => b.inbound - a.inbound || (a.target < b.target ? -1 : 1));

    return {
      nodes,
      edges,
      ghosts,
      counts: {
        nodes: nodes.length,
        edges: edges.length,
        ghosts: ghosts.length,
        // Raw dangling wikilink occurrences, and edges suppressed because one end
        // is a hidden sensitive node. With these,
        //   edges + danglingLinks + hiddenEdges === indexSummary().totalEdges
        // for a locked session, so the view is provably lossless. The graph-store
        // test asserts exactly that identity.
        danglingLinks: ghosts.reduce((s, g) => s + g.links, 0),
        hiddenEdges,
        // Deliberately NOT `deg === 0`. Hub notes and weekly digests link everything
        // they list, so by raw degree almost nothing is an orphan once hubs exist
        // (measured: 108 -> 20). The legend calls this "orphans in the vault", so it
        // has to mean the same thing orphans() means -- one definition, both
        // surfaces, or the graph quietly contradicts the weekly review.
        // `deg` itself stays raw: visually a hub-linked node DOES have edges, and it
        // is what sizes the dot.
        orphans: this.orphans({ includeSensitive }).length,
        hidden: includeSensitive ? 0 : this.nodes.size - nodes.length,
      },
    };
  }

  indexSummary() {
    const byType = {};
    for (const node of this.nodes.values()) {
      const t = (node.frontmatter && node.frontmatter.type) || "untyped";
      byType[t] = (byType[t] || 0) + 1;
    }
    return {
      totalNodes: this.nodes.size,
      totalEdges: Array.from(this.outlinks.values()).reduce((s, l) => s + l.length, 0),
      byType,
    };
  }

  // Decade-scale sentinel for /api/vault/status. Warns when the vault crosses the
  // planning thresholds so the levers in docs/vault-scale-notes.md (sparse
  // checkout, blob:none, index sharding) get pulled BEFORE boots degrade.
  scaleStatus() {
    const nodes = this.nodes.size;
    const diskBytes = this.diskBytes;
    const warnReasons = [];
    if (nodes > 20000) warnReasons.push(`${nodes} nodes (>20k)`);
    if (diskBytes > 3 * 1024 * 1024 * 1024) warnReasons.push(`${(diskBytes / 1073741824).toFixed(1)} GB working tree (>3 GB)`);
    return { nodes, diskBytes, initMs: this.initMs, searchDocs: this._indexedIn.size, warn: warnReasons.length > 0, warnReasons };
  }
}

module.exports = VaultStore;
// Exposed so consumers/tests can reuse the exact edge regex (must stay
// byte-identical to .mycelium/lib/parse.js WIKILINK_RE).
module.exports.WIKILINK_RE = WIKILINK_RE;
// Optimistic-lock error (routes map .code === "STALE_WRITE" -> 409) and the
// git-crypt header, exposed for the route layer and unit tests.
module.exports.StaleWriteError = StaleWriteError;
module.exports.GITCRYPT_MAGIC = GITCRYPT_MAGIC;
// Facet + date helpers behind the timeline (B4a), exposed for the route + tests.
module.exports.facetValues = facetValues;
module.exports.nodeDate = nodeDate;
// B5 search/scale helpers, exposed for the route + tests.
module.exports.isSensitivePath = isSensitivePath;
module.exports.splitBody = splitBody;
module.exports.SENSITIVE_PREFIXES = SENSITIVE_PREFIXES;
// B6 resurfacing: the tunable weights + seeded-RNG helpers, exposed for tests.
module.exports.RESURFACE_WEIGHTS = RESURFACE_WEIGHTS;
module.exports.hashSeed = hashSeed;
module.exports.mulberry32 = mulberry32;
