// Extracted from server.js. `ctx.vault` / `ctx.syncMgr` are accessed live (they are
// initialized during startup after routes mount), via getters on ctx.

module.exports = function mount(app, ctx) {
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
  const node = ctx.vault.get(slug);
  if (!node) return res.status(404).json({ error: "not found" });
  res.json(node);
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

};
