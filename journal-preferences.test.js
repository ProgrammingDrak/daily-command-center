// Account-level "last journal paper": the store validates and upserts one block per
// workspace, and the route maps a bad value to a 400.
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("./journal-preferences-store");

function fakeDB() {
  const rows = [];
  return {
    rows,
    getBlocksByKind: async (kind, ws) => rows.filter((r) => r.properties.kind === kind && r.workspace_id === ws),
    createBlock: async (block) => { rows.push({ id: rows.length + 1, ...block }); },
    updateBlock: async (id, patch) => { Object.assign(rows.find((r) => r.id === id), patch); },
  };
}

test("no stored preference reads as defaults", async () => {
  const deps = { blockDB: fakeDB() };
  assert.deepEqual(await store.getJournalPreferences("ws-1", deps), { lastPaper: null, _source: "defaults" });
});

test("classic and ink papers round-trip, one row per workspace", async () => {
  const db = fakeDB(), deps = { blockDB: db };
  let out = await store.updateJournalPreferences("ws-1", 7, { lastPaper: { paper: "graph" } }, deps);
  assert.deepEqual(out.lastPaper, { paper: "graph", paperSettings: null });
  out = await store.updateJournalPreferences("ws-1", 7, { lastPaper: { paper: "dotted", paperSettings: { type: "grid", tint: "cream" } } }, deps);
  assert.equal(out.lastPaper.paperSettings.type, "grid");
  assert.equal(out.lastPaper.paperSettings.tint, "cream");
  assert.equal(db.rows.length, 1);
  assert.deepEqual((await store.getJournalPreferences("ws-2", deps)).lastPaper, null, "other accounts are unaffected");
});

test("unknown papers are rejected and an unreadable row reads as defaults", async () => {
  const db = fakeDB(), deps = { blockDB: db };
  for (const lastPaper of [null, { paper: "nope" }, { paperSettings: { type: "nope" } }, "graph"])
    await assert.rejects(store.updateJournalPreferences("ws-1", 7, { lastPaper }, deps), /Invalid journal paper/);
  db.rows.push({ id: 9, workspace_id: "ws-1", properties: { kind: store.KIND, lastPaper: { paper: "<script>" } } });
  assert.equal((await store.getJournalPreferences("ws-1", deps)).lastPaper, null);
});

test("route answers 400 on an invalid paper", async () => {
  const routes = {};
  require("./routes/journal-preferences")({ get: (p, h) => { routes["GET " + p] = h; }, patch: (p, h) => { routes["PATCH " + p] = h; } });
  const out = {};
  const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  await routes["PATCH /api/journal/preferences"]({ workspaceId: "ws-x", session: {}, body: { lastPaper: { paper: "nope" } } }, res);
  assert.equal(out.code, 400);
});
