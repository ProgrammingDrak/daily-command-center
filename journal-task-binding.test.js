// Journal task pages on the client: one page, one task. Pages are keyed by
// journalId on the device, so these pin what happens when two task rows carry
// one journalId (a copy before the server re-mints it, a concurrent create, a
// legacy duplicate): no page is read, written or sent for the wrong task, and
// both pages stay exactly as they were. Also pins the legitimate local -> server
// id remap that quick add relies on.
const test = require("node:test");
const assert = require("node:assert/strict");
const Binding = require("./public/js/journal-task/binding.js");
const Store = require("./public/js/journal-task/page-store.js");
const Sync = require("./public/js/journal-task/page-sync.js");

const row = (id, localId, journalId, extra = {}) => ({ id, type: "block", properties: Object.assign({ local_id: localId, type: "journal", journalId }, extra) });
const page = (...xs) => ({ v: 1, w: 100, h: 100, strokes: xs.map(x => ({ tool: "ballpoint", color: "#111111", size: 2, pts: [x, 2, 0.5] })) });
const xs = rec => rec.ink.strokes.map(s => s.pts[0]);
// beforeUpdate(key) runs before each transaction (to inject another tab's write
// between adopt's two steps); failOn(key) aborts that transaction, writing nothing.
function memoryBackend() {
  const rows = new Map();
  const copy = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const b = { rows, beforeUpdate: null, failOn: null,
    async read(k) { return copy(rows.get(k) || null); },
    async list() { return [...rows.values()].map(copy); },
    async update(k, fn) {
      if (b.beforeUpdate) await b.beforeUpdate(k);
      const next = fn(copy(rows.get(k) || null));
      if (b.failOn && b.failOn(k)) throw new Error("QuotaExceededError");
      if (next) rows.set(k, copy(next));
      return copy(next || rows.get(k) || null);
    } };
  return b;
}
const makeStore = (backend = memoryBackend()) => { let n = 0; return Store.create({ backend, account: { userId: 1, workspaceId: "ws-1" }, makeId: () => "m" + (++n) }); };

// ── binding.resolve ─────────────────────────────────────────────────────────
test("legitimate local -> server remap: a task opened by its local id resolves to its server row", () => {
  const rows = [row("srv-A", "qa-A", "jr_aaaaaaaa"), row("srv-B", "qa-B", "jr_bbbbbbbb")];
  const r = Binding.resolve(rows, "jr_aaaaaaaa", ["qa-A"]);
  assert.equal(r.state, "ok"); assert.equal(r.taskId, "srv-A");
  assert.deepEqual(r.keys.sort(), ["qa-A", "srv-A"]);
  assert.equal(Binding.resolve(rows, "jr_aaaaaaaa", ["srv-A"]).taskId, "srv-A", "and by its server id");
});

test("a task not yet in the block store is pending, not routed to some other row", () => {
  const rows = [row("srv-B", "qa-B", "jr_bbbbbbbb")];
  assert.equal(Binding.resolve(rows, "jr_aaaaaaaa", ["qa-A"]).state, "pending");
});

test("two task rows carrying one journalId (client duplicate before server sync) are ambiguous for BOTH tasks", () => {
  const rows = [row("srv-A", "qa-A", "jr_shared0001"), row("srv-B", "qa-B", "jr_shared0001")];
  for (const keys of [["qa-A"], ["srv-A"], ["qa-B"], ["srv-B"]]) {
    assert.equal(Binding.resolve(rows, "jr_shared0001", keys).state, "ambiguous", JSON.stringify(keys));
  }
  // Ambiguous still names each task's OWN row (to ask the server who owns the id),
  // never the other task's, and never as a send target.
  assert.equal(Binding.resolve(rows, "jr_shared0001", ["qa-B"]).ownTaskId, "srv-B");
  assert.equal(Binding.resolve(rows, "jr_shared0001", ["qa-A"]).ownTaskId, "srv-A");
  assert.equal(Binding.resolve(rows, "jr_shared0001", ["qa-B"]).taskId, undefined);
  // The old rule ("first block carrying the journalId") would have routed B's page to A:
  const firstMatch = rows.find(b => b.properties.journalId === "jr_shared0001").id;
  assert.equal(firstMatch, "srv-A");
  assert.notEqual(Binding.resolve(rows, "jr_shared0001", ["qa-B"]).taskId, "srv-A", "never routed to A");
});

test("legacy ambiguous cache: a duplicate on a loaded row (even a removed one) is still ambiguous", () => {
  const rows = [row("srv-A", "qa-A", "jr_legacy0001"), row("srv-old", "qa-old", "jr_legacy0001", {}), { ...row("srv-gone", "qa-gone", "jr_legacy0001"), deleted_at: "2026-10-01" }];
  assert.equal(Binding.resolve(rows, "jr_legacy0001", ["srv-A"]).state, "ambiguous");
});

test("a task whose own row now carries a different id (server re-mint) is a mismatch for the old id", () => {
  const rows = [row("srv-B", "qa-B", "jr_reminted01")];
  const r = Binding.resolve(rows, "jr_original01", ["qa-B"]);
  assert.equal(r.state, "mismatch"); assert.equal(r.actualJournalId, "jr_reminted01");
});

test("aliases are joined only through one row's own ids, never through a shared journalId", () => {
  const rows = [row("srv-A", "qa-A", "jr_shared0002"), row("srv-B", "qa-B", "jr_shared0002")];
  assert.deepEqual(Binding.expand(rows, ["qa-A"]).sort(), ["qa-A", "srv-A"]);
});

// ── page store binding ──────────────────────────────────────────────────────
test("wrong-task local write is refused (content AND draft paths) and both pages stay unchanged", async () => {
  const store = makeStore();
  const a = await store.saveEdit("jr_shared0001", { taskId: "qa-A", taskKeys: ["qa-A", "srv-A"], ink: page(10), body: "A writes" }, 0);
  assert.equal(a.stale, false);
  const before = await store.load("jr_shared0001");
  // B carries the same journalId: up-to-date version, then a stale version.
  await assert.rejects(store.saveEdit("jr_shared0001", { taskId: "qa-B", taskKeys: ["qa-B", "srv-B"], ink: page(99), body: "B writes" }, before.localRev), { code: "TASK_MISMATCH" });
  await assert.rejects(store.saveEdit("jr_shared0001", { taskId: "qa-B", taskKeys: ["qa-B"], ink: page(98), body: "B draft" }, 0, "draft-B"), { code: "TASK_MISMATCH" });
  const after = await store.load("jr_shared0001");
  assert.deepEqual(after, before, "A's page byte-identical, no B draft added");
  assert.equal(store.belongsTo(after, ["qa-B", "srv-B"]), false, "B may not even read it for editing");
  assert.equal(store.belongsTo(after, ["srv-A"]), true);
});

test("wrong-task server copy cannot be seeded into another task's page", async () => {
  const store = makeStore();
  await store.saveEdit("jr_shared0001", { taskKeys: ["qa-A", "srv-A"], ink: page(10), body: "A" }, 0);
  const before = await store.load("jr_shared0001");
  await assert.rejects(store.seed("jr_shared0001", { taskId: "srv-B", journalId: "jr_shared0001", revision: 5, ink: page(55), body: "B" }, ["qa-B", "srv-B"]), { code: "TASK_MISMATCH" });
  await assert.rejects(store.seed("jr_shared0001", { taskId: "srv-B", journalId: "jr_shared0001", revision: 5, ink: page(55), body: "B" }, ["srv-A"]), { code: "TASK_MISMATCH" }, "a server copy for another task id is refused");
  await assert.rejects(store.seed("jr_shared0001", { taskId: "srv-A", journalId: "jr_other00001", revision: 5, ink: page(55) }, ["srv-A"]), { code: "TASK_MISMATCH" });
  assert.deepEqual(await store.load("jr_shared0001"), before);
});

test("local -> server alias is learned on the same page; disjoint ids are never merged", async () => {
  const store = makeStore();
  await store.saveEdit("jr_aaaaaaaa", { taskId: "qa-A", taskKeys: ["qa-A"], ink: page(10) }, 0);
  const bound = await store.bindKeys("jr_aaaaaaaa", ["qa-A", "srv-A"]);
  assert.deepEqual(bound.taskKeys.sort(), ["qa-A", "srv-A"]);
  const next = await store.saveEdit("jr_aaaaaaaa", { taskId: "srv-A", taskKeys: ["srv-A"], ink: page(10, 20) }, bound.localRev);
  assert.equal(next.stale, false); assert.deepEqual(xs(next.record), [10, 20], "opening by server id keeps editing the same page");
  await assert.rejects(store.bindKeys("jr_aaaaaaaa", ["srv-B"]), { code: "TASK_MISMATCH" });
  assert.deepEqual((await store.load("jr_aaaaaaaa")).taskKeys.sort(), ["qa-A", "srv-A"]);
});

test("a legacy record bound only by taskId keeps that binding", async () => {
  const backend = memoryBackend(); const store = makeStore(backend);
  backend.rows.set("jr_legacy0002", { journalId: "jr_legacy0002", taskId: "srv-A", owner: "u1:ws-1", ink: page(10), body: "", localRev: 1, baseRevision: 1, dirty: false, drafts: [], recoveries: [] });
  await assert.rejects(store.saveEdit("jr_legacy0002", { taskKeys: ["srv-B"], ink: page(99) }, 1), { code: "TASK_MISMATCH" });
  assert.equal((await store.saveEdit("jr_legacy0002", { taskKeys: ["srv-A"], ink: page(10, 11) }, 1)).stale, false);
});

// ── re-mint adoption: version-safe, idempotent, never hides uncopied writing ─
const OLD = "jr_original01", NEW = "jr_reminted01", KEYS = ["qa-B", "srv-B"];
const bodies = rec => (rec.recoveries || []).map(r => r.body).sort();
const discoverable = async store => (await store.boundElsewhere(NEW, KEYS)).map(r => r.journalId);

test("re-minted task: writing left under the old id becomes a recovery copy of the new page; nothing deleted; old copy stops syncing", async () => {
  const store = makeStore();
  await store.saveEdit(OLD, { taskId: "qa-B", taskKeys: ["qa-B"], ink: page(30), body: "B offline" }, 0);
  assert.deepEqual(await discoverable(store), [OLD]);
  assert.deepEqual(await store.boundElsewhere(NEW, ["qa-A", "srv-A"]), [], "another task never sees it");
  await store.adopt(NEW, OLD, KEYS);
  const now = await store.load(NEW);
  assert.deepEqual(bodies(now), ["B offline"]); assert.equal(now.recoveries[0].fromJournalId, OLD);
  const old = await store.load(OLD);
  assert.equal(old.dirty, false); assert.equal(old.body, "B offline", "kept, not deleted");
  assert.deepEqual(await discoverable(store), []);
  assert.deepEqual((await store.listDirty()).map(r => r.journalId), [], "the old copy no longer tries to sync");
});

// Review repro: another tab's write to the source between adopt's destination
// step and its source step used to be marked clean and hidden without a copy.
test("a write to the source DURING the handoff stays dirty and discoverable, and is copied on the next open", async () => {
  const backend = memoryBackend(); const store = makeStore(backend); const otherTab = makeStore(backend);
  await store.saveEdit(OLD, { taskKeys: ["task-A"], ink: page(1), body: "original synthetic text" }, 0);
  let injected = false;
  backend.beforeUpdate = async key => {
    if (key === OLD && !injected) {            // destination already written; source step not yet
      injected = true;
      const cur = await otherTab.load(OLD);
      await otherTab.saveEdit(OLD, { taskKeys: ["task-A"], ink: page(1, 2), body: "newer synthetic text during adoption" }, cur.localRev);
    }
  };
  await store.adopt(NEW, OLD, ["task-A"]);
  backend.beforeUpdate = null;
  const src = await store.load(OLD);
  assert.equal(src.body, "newer synthetic text during adoption");
  assert.equal(src.dirty, true, "the uncopied write keeps its dirty marker");
  assert.deepEqual((await store.boundElsewhere(NEW, ["task-A"])).map(r => r.journalId), [OLD], "still discoverable");
  assert.deepEqual(bodies(await store.load(NEW)), ["original synthetic text"]);
  // Next open copies the newer content too; only then is the source settled.
  await store.adopt(NEW, OLD, ["task-A"]);
  assert.deepEqual(bodies(await store.load(NEW)), ["newer synthetic text during adoption", "original synthetic text"]);
  assert.equal((await store.load(OLD)).dirty, false);
  assert.deepEqual(await store.boundElsewhere(NEW, ["task-A"]), []);
});

test("an old tab saving AFTER adoption makes the source discoverable again, and the new writing is copied", async () => {
  const backend = memoryBackend(); const store = makeStore(backend); const oldTab = makeStore(backend);
  await store.saveEdit(OLD, { taskKeys: KEYS, ink: page(1), body: "before" }, 0);
  await store.adopt(NEW, OLD, KEYS);
  assert.deepEqual(await discoverable(store), []);
  const cur = await oldTab.load(OLD);
  await oldTab.saveEdit(OLD, { taskKeys: KEYS, ink: page(1, 5), body: "after adoption" }, cur.localRev);
  assert.deepEqual(await discoverable(store), [OLD], "found again");
  assert.equal((await store.load(OLD)).dirty, true);
  // A stale draft written into the source later is found too.
  await oldTab.saveEdit(OLD, { taskKeys: KEYS, ink: page(9), body: "late draft" }, 0, "late-draft");
  await store.adopt(NEW, OLD, KEYS);
  assert.deepEqual(bodies(await store.load(NEW)), ["after adoption", "before", "late draft"]);
  assert.deepEqual(await discoverable(store), []);
});

test("the source's drafts AND its existing recovery copies are all carried over; repeated opens never multiply them", async () => {
  const backend = memoryBackend(); const store = makeStore(backend);
  backend.rows.set(OLD, { journalId: OLD, owner: "u1:ws-1", taskKeys: KEYS, taskId: "qa-B", ink: page(1), body: "content", localRev: 3, baseRevision: 0, dirty: true,
    drafts: [{ id: "d1", ink: page(2), body: "draft one", basedOn: 1 }, { id: "d2", ink: page(3), body: "draft two", basedOn: 2 }],
    recoveries: [{ id: "r1", ink: page(4), body: "recovery one", reason: "unsaved-draft" }, { id: "r2", ink: page(5), body: "recovery two", reason: "device-copy-replaced" }] });
  for (let i = 0; i < 4; i++) await store.adopt(NEW, OLD, KEYS);
  assert.deepEqual(bodies(await store.load(NEW)), ["content", "draft one", "draft two", "recovery one", "recovery two"]);
  const src = await store.load(OLD);
  assert.equal(src.drafts.length, 2); assert.equal(src.recoveries.length, 2, "source copies kept, not moved out");
  assert.deepEqual(await discoverable(store), []);
});

test("a failed destination transaction changes nothing; a failed source transaction leaves the source discoverable and the retry adds no duplicates", async () => {
  const backend = memoryBackend(); const store = makeStore(backend);
  await store.saveEdit(OLD, { taskKeys: KEYS, ink: page(1), body: "precious" }, 0);
  backend.failOn = key => key === NEW;
  await assert.rejects(store.adopt(NEW, OLD, KEYS), /QuotaExceeded/);
  assert.equal(await store.load(NEW), null); assert.equal((await store.load(OLD)).dirty, true);
  assert.deepEqual(await discoverable(store), [OLD]);
  backend.failOn = key => key === OLD;
  await assert.rejects(store.adopt(NEW, OLD, KEYS), /QuotaExceeded/);
  assert.deepEqual(bodies(await store.load(NEW)), ["precious"], "destination copy is durable");
  assert.equal((await store.load(OLD)).dirty, true); assert.deepEqual(await discoverable(store), [OLD], "source not hidden");
  backend.failOn = null;
  await store.adopt(NEW, OLD, KEYS);
  assert.deepEqual(bodies(await store.load(NEW)), ["precious"], "replay deduplicated");
  assert.deepEqual(await discoverable(store), []);
});

test("adopted writing reopens and is restored through the task's NEW id, and only ever routes to that task", async () => {
  const store = makeStore();
  await store.saveEdit(OLD, { taskKeys: ["qa-B"], ink: page(30), body: "offline writing" }, 0);
  await store.adopt(NEW, OLD, KEYS);
  const dest = await store.load(NEW);
  const restored = await store.restoreRecovery(NEW, dest.recoveries[0].id, dest.localRev);
  assert.equal(restored.body, "offline writing"); assert.deepEqual(xs(restored), [30]); assert.equal(restored.dirty, true);
  // Send target for the restored page: task B's own row (which carries NEW).
  const rows = [row("srv-A", "qa-A", "jr_aaaaaaaa"), row("srv-B", "qa-B", NEW)];
  assert.deepEqual(Binding.resolve(rows, NEW, store.boundKeys(restored)), { state: "ok", taskId: "srv-B", keys: Binding.resolve(rows, NEW, store.boundKeys(restored)).keys });
  // The old record is never sent anywhere: its id is no longer the task's.
  assert.equal(Binding.resolve(rows, OLD, store.boundKeys(await store.load(OLD))).state, "mismatch");
  // And task A can neither see nor adopt it.
  assert.deepEqual(await store.boundElsewhere("jr_aaaaaaaa", ["qa-A", "srv-A"]), []);
  await assert.rejects(store.adopt("jr_aaaaaaaa", OLD, ["qa-A", "srv-A"]), { code: "TASK_MISMATCH" });
});

test("bindKeys only joins ids reached through one row's own ids; unrelated rows are never joined", async () => {
  const store = makeStore();
  const rows = [row("srv-A", "qa-A", "jr_aaaaaaaa"), row("srv-B", "qa-B", "jr_aaaaaaaa"), row("srv-C", "qa-C", "jr_cccccccc")];
  await store.saveEdit("jr_aaaaaaaa", { taskKeys: ["qa-A"], ink: page(1) }, 0);
  const joined = await store.bindKeys("jr_aaaaaaaa", Binding.expand(rows, ["qa-A"]));
  assert.deepEqual(joined.taskKeys.sort(), ["qa-A", "srv-A"]);
  await assert.rejects(store.bindKeys("jr_aaaaaaaa", Binding.expand(rows, ["qa-B"])), { code: "TASK_MISMATCH" });
  await assert.rejects(store.bindKeys("jr_aaaaaaaa", Binding.expand(rows, ["srv-C"])), { code: "TASK_MISMATCH" });
  // Two rows that share a local_id (the old lost-ack duplicate generator) are
  // joined as one task -- and then refused as ambiguous, never routed.
  const dupLocal = [row("srv-X1", "qa-X", "jr_xxxxxxxx"), row("srv-X2", "qa-X", "jr_xxxxxxxx")];
  assert.equal(Binding.resolve(dupLocal, "jr_xxxxxxxx", ["qa-X"]).state, "ambiguous");
  const dupLocal2 = [row("srv-X1", "qa-X", "jr_xxxxxxxx"), row("srv-X2", "qa-X", "jr_yyyyyyyy")];
  assert.equal(Binding.resolve(dupLocal2, "jr_xxxxxxxx", ["qa-X"]).state, "mismatch");
});

// ── sync refuses to send for an ambiguous/mismatched binding ────────────────
test("sync sends NOTHING when the binding is ambiguous or mismatched, and says why", async () => {
  for (const state of ["ambiguous", "mismatch"]) {
    const store = makeStore();
    await store.saveEdit("jr_shared0001", { taskKeys: ["qa-B"], ink: page(1) }, 0);
    const calls = [], statuses = [];
    const sync = Sync.create({ store, journalId: "jr_shared0001", isOnline: () => true, setTimeout: () => 0, clearTimeout() {},
      fetch: async (...a) => { calls.push(a); return { ok: true, status: 200, json: async () => ({ revision: 1 }) }; },
      resolveTaskId: () => { throw Object.assign(new Error("binding " + state), { code: "JOURNAL_BINDING" }); },
      onStatus: s => statuses.push(s) });
    await sync.flush();
    assert.equal(calls.length, 0); assert.equal(statuses.at(-1).state, "error"); assert.match(statuses.at(-1).message, new RegExp(state));
    assert.equal((await store.load("jr_shared0001")).dirty, true, "kept on the device");
  }
});

test("the editor routes sync through the binding, not the first journalId match", () => {
  const src = require("node:fs").readFileSync("./public/js/journal-task/editor.js", "utf8");
  assert.match(src, /resolveTaskId: rec => serverTaskFor\(journalId, rec\)/);
  assert.doesNotMatch(src, /find\(x => x && !x\.deleted_at && \(x\.properties \|\| \{\}\)\.journalId === journalId\)/);
});
