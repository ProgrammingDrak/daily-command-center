// Extracted from server.js. `ctx.vault` / `ctx.syncMgr` are accessed live (they are
// initialized during startup after routes mount), via getters on ctx.

const path = require("path");

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

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) {
  return escHtml(s).replace(/"/g, "&quot;");
}

// Sensitive-dir set (mirrors CONVENTIONS.md and the client's SENSITIVE_PREFIXES).
// The client renders a locked placeholder for these, but that is only cosmetic:
// this server-side guard is what actually keeps sensitive plaintext from leaving
// the host until B2's PIN gate (and A2's git-crypt at rest) land. Path is
// authoritative. Enforced two ways below: the node body is refused (403), and a
// sensitive source's body never leaks as a backlink context snippet on a
// non-sensitive note.
const SENSITIVE_PREFIXES = ["health/therapy/", "health/moments/", "health/medical/", "journal/private/"];
function isSensitiveSlug(slug) {
  return SENSITIVE_PREFIXES.some((p) => (slug + "/").startsWith(p) || slug.startsWith(p));
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

function mount(app, ctx) {
  const { VAULT_REPO_URL } = ctx;

// ── Vault API (Phase 1) ──
// The vault is a git-backed markdown store that holds long-term memory.
// Postgres is working memory (intraday state). These endpoints expose the
// in-memory VaultStore index and typed graph; writes route through the
// SyncManager for durable commit+push.
function vaultReady(res) {
  if (!ctx.vault || !ctx.vault.ready) { res.status(503).json({ error: "vault not ready" }); return false; }
  return true;
}

app.get("/api/vault/status", (req, res) => {
  const sync = ctx.syncMgr ? ctx.syncMgr.getStatus() : { status: "disabled" };
  res.json({
    vault: ctx.vault && ctx.vault.ready ? ctx.vault.indexSummary() : { ready: false },
    sync,
    remote: VAULT_REPO_URL ? "configured" : "none",
  });
});

app.get("/api/vault/nodes", (req, res) => {
  if (!vaultReady(res)) return;
  const { type, subtype, has, since } = req.query;
  res.json(ctx.vault.list({ type, subtype, hasField: has, sinceDate: since }));
});

app.get("/api/vault/node/*", (req, res) => {
  if (!vaultReady(res)) return;
  const slug = req.params[0];
  // Never serve a sensitive note's body. The client shows a locked placeholder
  // and does not fetch, so this only ever fires on a direct API hit — the
  // backstop that makes "contents stay locked" true, not just a UI affordance.
  if (isSensitiveSlug(slug)) return res.status(403).json({ error: "locked", sensitive: true });
  const node = ctx.vault.get(slug);
  if (!node) return res.status(404).json({ error: "not found" });
  const parse = loadParse(ctx);
  if (parse && parse.WIKILINK_RE) {
    node.renderedBody = renderWikilinks(node.body, parse, ctx.vault);
  }
  // A sensitive source note links to this (public) one: show that the mention
  // EXISTS but strip its context snippet, which would otherwise leak a slice of
  // the sensitive note's body through this non-sensitive endpoint.
  for (const b of node.backlinks || []) {
    if (b && b.source && isSensitiveSlug(b.source)) b.context = null;
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
  catch (e) { return res.json(fallback); }
  const tagColors = {};
  if (ctx.vault && ctx.vault.ready) {
    for (const n of ctx.vault.list()) {
      const raw = (n.frontmatter && n.frontmatter.tags) || [];
      const list = Array.isArray(raw) ? raw : [raw];
      for (const t of list) {
        if (typeof t !== "string" || tagColors[t]) continue;
        try { tagColors[t] = parse.colorForTags([t], ontology).hex; } catch (e) { /* skip */ }
      }
    }
  }
  const render = ontology.render || {};
  res.json({ tagColors, unmapped: render.unmapped || "#9ca3af", available: true });
});

app.put("/api/vault/node/*", async (req, res) => {
  if (!vaultReady(res)) return;
  const slug = req.params[0];
  const { frontmatter, body, message } = req.body || {};
  try {
    const node = await ctx.vault.write(slug, { frontmatter: frontmatter || {}, body: body || "" });
    if (ctx.syncMgr) ctx.syncMgr.notifyChange({ slug, message });
    res.json(node);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/vault/node/*", async (req, res) => {
  if (!vaultReady(res)) return;
  const slug = req.params[0];
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

app.post("/api/vault/flush", async (req, res) => {
  if (!ctx.syncMgr) return res.status(503).json({ error: "sync disabled" });
  try { await ctx.syncMgr.flushAndPush(); res.json(ctx.syncMgr.getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

}

module.exports = mount;
// Exposed for unit tests (vault-b1.test.js).
module.exports.renderWikilinks = renderWikilinks;
module.exports.isSensitiveSlug = isSensitiveSlug;
