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

const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

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
    // Inverted facet indexes for the timeline (B4a): facet value -> Set(slug),
    // maintained incrementally at the same mutation sites as backlinks so thread
    // derivation is O(matches-in-range), not O(corpus) per request.
    this.tagIndex = new Map();
    this.personIndex = new Map();
    this.eventIndex = new Map();
    this.ready = false;
    this.watcher = null;
    this._debounceTimers = new Map();
  }

  async init() {
    if (!fs.existsSync(this.vaultDir)) {
      await fsp.mkdir(this.vaultDir, { recursive: true });
    }
    await this._sweepTmpFiles();
    const persisted = await this._loadPersistedIndex();
    await this._buildIndex(persisted);
    this._startWatcher();
    this.ready = true;
    this.emit("ready", { count: this.nodes.size });
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
    const payload = { version: 1, builtAt: Date.now(), nodes: {} };
    for (const [slug, node] of this.nodes) {
      payload.nodes[slug] = { path: node.path, mtime: node.mtime, size: node.size, hash: node.hash };
    }
    try {
      await fsp.writeFile(this.indexFile + ".tmp", JSON.stringify(payload), "utf8");
      await fsp.rename(this.indexFile + ".tmp", this.indexFile);
    } catch {}
  }

  async _buildIndex(persisted) {
    const files = await this._walkMarkdown(this.vaultDir);
    const persistedNodes = (persisted && persisted.nodes) || {};
    for (const file of files) {
      const slug = this._slugFromPath(file);
      const stat = await fsp.stat(file);
      const prev = persistedNodes[slug];
      if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size) {
        const raw = await fsp.readFile(file, "utf8");
        this._ingest(slug, file, raw, stat);
        continue;
      }
      const raw = await fsp.readFile(file, "utf8");
      this._ingest(slug, file, raw, stat);
    }
    this._rebuildBacklinks();
    this._rebuildFacets();
  }

  async _walkMarkdown(dir) {
    const out = [];
    const walk = async (d) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(d, entry.name);
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
  _isIgnored(p) {
    if (p.endsWith(".tmp") || p.endsWith(".sync-queue.json")) return true;
    const rel = path.relative(this.vaultDir, p);
    if (!rel || rel.startsWith("..")) return false; // the root itself / outside
    return rel.split(path.sep).some((seg) => seg.startsWith("."));
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

  async write(slug, { frontmatter, body, expectedHash } = {}) {
    if (!slug || typeof slug !== "string") throw new Error("slug required");
    const safeSlug = this.normalizeSlug(slug);
    // Optimistic lock: when the caller passes the hash it loaded, refuse the
    // write if the on-disk node has moved on (concurrent Obsidian/other-tab
    // edit). null current + a non-null expected = the node was deleted under us,
    // also a conflict. Omitting expectedHash (create, or force) skips the check.
    if (expectedHash != null) {
      const cur = this.nodes.get(safeSlug);
      const curHash = cur ? cur.hash : null;
      if (curHash !== expectedHash) throw new StaleWriteError(curHash);
    }
    const file = this._pathFromSlug(safeSlug);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const serialized = matter.stringify(body || "", frontmatter || {});
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, serialized, "utf8");
    await fsp.rename(tmp, file);
    const stat = await fsp.stat(file);
    const prevLinks = this.outlinks.get(safeSlug) || [];
    const prevFacets = this._currentFacets(safeSlug);
    this._ingest(safeSlug, file, serialized, stat);
    const newLinks = this.outlinks.get(safeSlug) || [];
    this._updateBacklinksForNode(safeSlug, prevLinks, newLinks);
    this._updateFacetsForNode(safeSlug, prevFacets, this._currentFacets(safeSlug));
    this.emit("vault-changed", { action: "update", slug: safeSlug, source: "local" });
    return this.get(safeSlug);
  }

  async delete(slug) {
    const safeSlug = this.normalizeSlug(slug);
    const file = this._pathFromSlug(safeSlug);
    if (!fs.existsSync(file)) return false;
    await fsp.unlink(file);
    const prevLinks = this.outlinks.get(safeSlug) || [];
    const prevFacets = this._currentFacets(safeSlug);
    this._updateBacklinksForNode(safeSlug, prevLinks, []);
    this._updateFacetsForNode(safeSlug, prevFacets, { tag: [], person: [], event: [] });
    this.nodes.delete(safeSlug);
    this.outlinks.delete(safeSlug);
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
