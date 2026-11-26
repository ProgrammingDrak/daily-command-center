// New journals open empty and ready for typing. The vault's journal template
// may carry prompt headings; only its frontmatter is applied to a daily note.
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fsp = require("fs/promises");
const path = require("path");
const VaultStore = require("./vault-store");

test("POST /api/vault/daily keeps template frontmatter but leaves the body empty", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "journal-empty-"));
  const store = new VaultStore({ vaultDir: dir, indexFile: null });
  try {
    await fsp.mkdir(path.join(dir, ".mycelium", "lib"), { recursive: true });
    await fsp.mkdir(path.join(dir, ".mycelium", "templates"), { recursive: true });
    await fsp.writeFile(path.join(dir, ".mycelium", "lib", "parse.js"),
      "module.exports = { loadSchema: () => ({ types: { journal: { template: 'journal.md' } } }) };");
    await fsp.writeFile(path.join(dir, ".mycelium", "templates", "journal.md"),
      "---\nmood: \"\"\ntags: [\"journal\"]\n---\n## What happened\n\n## Grateful for\n");
    await store.init();
    const routes = {};
    const app = { get() {}, post: (p, h) => { routes["POST " + p] = h; }, put() {}, delete() {}, patch() {}, use() {} };
    require("./routes/vault")(app, { vault: store, syncMgr: null, getTodayStr: () => "2026-11-25" });
    const res = await new Promise((resolve, reject) => {
      const out = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(body) { this.body = body; resolve(this); } };
      Promise.resolve(routes["POST /api/vault/daily"]({ body: { date: "2026-11-25" }, session: {}, headers: {} }, out)).catch(reject);
    });
    assert.equal(res.statusCode, 201);
    const node = store.get("journal/2026/2026-11-25");
    assert.equal((node.body || "").trim(), "", "no template headings in a new journal");
    assert.deepEqual(node.frontmatter.tags, ["journal"], "template frontmatter still applies");
    assert.equal(node.frontmatter.type, "journal");
  } finally {
    try { await store.close(); } catch { /* ignore */ }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
