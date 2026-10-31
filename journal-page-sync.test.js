// Journal task pages: device -> server outbox (public/js/journal-task/page-sync.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("./public/js/journal-task/page-store.js");
const Sync = require("./public/js/journal-task/page-sync.js");

function memoryBackend() {
  const rows = new Map();
  const copy = v => v == null ? v : JSON.parse(JSON.stringify(v));
  return {
    rows,
    async read(k) { return copy(rows.get(k) || null); },
    async list() { return [...rows.values()].map(copy); },
    async update(k, fn) { const next = fn(copy(rows.get(k) || null)); if (next) rows.set(k, copy(next)); return copy(next || rows.get(k) || null); },
  };
}
const page = n => ({ v: 1, w: 100, h: 100, strokes: Array.from({ length: n }, () => ({ tool: "ballpoint", color: "#111111", size: 2, pts: [1, 2, 0.5] })) });
// An editor that is up to date: it saves against the content version it just read.
async function edit(store, journalId, e) {
  const cur = await store.load(journalId);
  const out = await store.saveEdit(journalId, e, cur ? cur.localRev : 0);
  assert.equal(out.stale, false, "an up-to-date editor's save is never a draft");
  return out.record;
}

// A scripted server: each request takes the next queued response (or a function).
function harness(opts = {}) {
  let n = 0;
  const store = Store.create({ backend: memoryBackend(), account: { userId: 1, workspaceId: "ws-1" }, makeId: () => "m" + (++n) });
  const calls = [], timers = [], statuses = [];
  const responses = [];
  let online = true;
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response");
    const r = typeof next === "function" ? await next(calls.at(-1)) : next;
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const sync = Sync.create({
    store, journalId: opts.journalId || "jr_aaaaaaaa", fetch, isOnline: () => online,
    onStatus: s => statuses.push(s), isBusy: opts.isBusy,
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  return { store, sync, calls, timers, statuses, responses, setOnline: v => { online = v; }, last: () => statuses.at(-1) };
}
const ok = (revision, extra) => ({ status: 200, body: Object.assign({ revision }, extra) });

test("sends expectedRevision and mutation id, and marks clean only after acceptance", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(1), body: "x" });
  h.responses.push(ok(1));
  await h.sync.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/journal/tasks/task-1");
  assert.equal(h.calls[0].init.method, "PUT");
  assert.deepEqual({ ...h.calls[0].body, ink: undefined }, { journalId: "jr_aaaaaaaa", ink: undefined, body: "x", expectedRevision: 0, mutationId: "m1" });
  const rec = await h.store.load("jr_aaaaaaaa");
  assert.equal(rec.dirty, false); assert.equal(rec.baseRevision, 1);
  assert.equal(h.last().state, "synced");
});

test("accepted-version queue: strokes drawn while a save is in flight go next, on the accepted revision", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(1) });  // m1
  h.responses.push(async () => {
    await edit(h.store,"jr_aaaaaaaa", { ink: page(2) });                  // m2 lands mid-request
    return ok(1);
  });
  h.responses.push(ok(2));
  await h.sync.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.expectedRevision, 1, "builds on what the server accepted");
  assert.equal(h.calls[1].body.mutationId, "m2");
  assert.equal(h.calls[1].body.ink.strokes.length, 2);
  const rec = await h.store.load("jr_aaaaaaaa");
  assert.equal(rec.dirty, false); assert.equal(rec.baseRevision, 2);
});

test("a 500 or network failure keeps the page dirty and retries the SAME mutation with backoff", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(1) });
  h.responses.push({ status: 500, body: { error: "boom" } });
  await h.sync.flush();
  assert.equal(h.last().state, "retrying"); assert.match(h.last().message, /Saved on this device/);
  assert.equal(h.timers.at(-1).ms, Sync.BACKOFF[0]);
  assert.equal((await h.store.load("jr_aaaaaaaa")).dirty, true);
  h.responses.push(new TypeError("Failed to fetch"));
  await h.sync.flush();
  assert.equal(h.timers.at(-1).ms, Sync.BACKOFF[1]);
  h.responses.push(ok(1));
  await h.sync.flush();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map(c => c.body.mutationId), ["m1", "m1", "m1"], "retries are idempotent");
  assert.equal((await h.store.load("jr_aaaaaaaa")).dirty, false);
});

test("401 pauses sync with a sign-in message until resume(); nothing is dropped", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(1) });
  h.responses.push({ status: 401, body: { error: "Sign in", code: "SIGNED_OUT" } });
  await h.sync.flush();
  assert.equal(h.last().state, "signed-out"); assert.equal(h.sync.paused, "signed-out");
  await h.sync.flush();
  assert.equal(h.calls.length, 1, "paused sync does not hammer the server");
  h.responses.push(ok(1));
  await h.sync.resume();
  assert.equal(h.calls.length, 2); assert.equal((await h.store.load("jr_aaaaaaaa")).dirty, false);
});

test("offline: no request is made; reconnecting sends the queued page", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(1) });
  h.setOnline(false);
  await h.sync.flush();
  assert.equal(h.calls.length, 0); assert.equal(h.last().state, "offline");
  h.setOnline(true); h.responses.push(ok(1));
  await h.sync.resume();
  assert.equal(h.calls.length, 1); assert.equal(h.last().state, "synced");
});

test("a stale revision is a conflict: local page kept, server copy recorded, no overwrite", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(2) });
  h.responses.push({ status: 409, body: { error: "changed", code: "JOURNAL_CONFLICT" } });
  h.responses.push({ status: 200, body: { journalId: "jr_aaaaaaaa", revision: 5, ink: page(9), body: "remote" } });
  await h.sync.flush();
  assert.equal(h.last().state, "conflict");
  const rec = await h.store.load("jr_aaaaaaaa");
  assert.equal(rec.ink.strokes.length, 2); assert.equal(rec.dirty, true); assert.equal(rec.conflict.revision, 5);
  await h.sync.flush();
  assert.equal(h.calls.length, 2, "no automatic retry over a conflict");
  await h.store.keepLocal("jr_aaaaaaaa", (await h.store.load("jr_aaaaaaaa")).localRev);
  h.responses.push(ok(6));
  await h.sync.resume();
  assert.equal(h.calls.at(-1).body.expectedRevision, 5);
});

test("conflict whose saved copy cannot be fetched stays retryable, then resolves into a real conflict", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(2) });
  h.responses.push({ status: 409, body: { code: "JOURNAL_CONFLICT" } });
  h.responses.push({ status: 500, body: { error: "db down" } });             // GET of the server copy fails
  await h.sync.flush();
  assert.equal(h.last().state, "retrying"); assert.equal(h.sync.paused, null, "not parked in an unrecoverable conflict");
  assert.equal((await h.store.load("jr_aaaaaaaa")).conflict, null);
  // A wrong-journal or malformed GET body is not accepted as the comparison copy.
  h.responses.push({ status: 409, body: { code: "JOURNAL_CONFLICT" } });
  h.responses.push({ status: 200, body: { journalId: "jr_other000", revision: 5, ink: page(9) } });
  await h.sync.flush();
  assert.equal(h.last().state, "retrying");
  h.responses.push({ status: 409, body: { code: "JOURNAL_CONFLICT" } });
  h.responses.push({ status: 200, body: { journalId: "jr_aaaaaaaa", revision: 5, ink: page(9), body: "" } });
  await h.sync.flush();
  assert.equal(h.last().state, "conflict"); assert.equal((await h.store.load("jr_aaaaaaaa")).conflict.revision, 5);
  assert.equal((await h.store.load("jr_aaaaaaaa")).ink.strokes.length, 2);
});

test("a rejected page (bad format or too large) is reported with the server's reason and kept", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(1) });
  h.responses.push({ status: 400, body: { error: "ink must match the version 1 stroke format" } });
  await h.sync.flush();
  assert.equal(h.last().state, "error"); assert.match(h.last().message, /version 1 stroke format/);
  assert.equal((await h.store.load("jr_aaaaaaaa")).dirty, true);
  h.responses.push({ status: 413, body: { error: "Handwritten page is too large" } });
  await h.sync.resume();
  assert.match(h.last().message, /too large/);
});

// Regression (browser run): timers were called as methods of a wrapper object,
// which a browser's setTimeout rejects with "Illegal invocation", so no save
// ever left the device.
test("timers are invoked as plain functions, as browsers require", async () => {
  let n = 0;
  const store = Store.create({ backend: memoryBackend(), account: { userId: 1, workspaceId: "ws-1" }, makeId: () => "m" + (++n) });
  const scheduled = [];
  const strictSet = function (fn, ms) { "use strict"; if (this !== undefined) throw new TypeError("Illegal invocation"); scheduled.push(ms); return 1; };
  const strictClear = function () { "use strict"; if (this !== undefined) throw new TypeError("Illegal invocation"); };
  const sync = Sync.create({ store, journalId: "jr_aaaaaaaa", fetch: async () => { throw new Error("offline"); }, isOnline: () => true, setTimeout: strictSet, clearTimeout: strictClear });
  await edit(store,"jr_aaaaaaaa", { taskId: "t", ink: page(1) });
  sync.nudge(); sync.nudge();
  await sync.flush();
  assert.ok(scheduled.length >= 2);
});

test("a task known by its local id is sent to the server row resolved from the journal id", async () => {
  let n = 0;
  const store = Store.create({ backend: memoryBackend(), account: { userId: 1, workspaceId: "ws-1" }, makeId: () => "m" + (++n) });
  const urls = [];
  const sync = Sync.create({ store, journalId: "jr_aaaaaaaa", isOnline: () => true, setTimeout: () => 0, clearTimeout() {},
    resolveTaskId: rec => rec.taskId === "qa-local-1" ? "server-row-9" : rec.taskId,
    fetch: async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({ revision: 1 }) }; } });
  await edit(store,"jr_aaaaaaaa", { taskId: "qa-local-1", ink: page(1) });
  await sync.flush();
  assert.deepEqual(urls, ["/api/journal/tasks/server-row-9"]);
});

test("an account switch in another tab stops the queue without discarding the page", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(1) });
  h.responses.push({ status: 409, body: { error: "This tab belongs to another account", code: "ACCOUNT_CHANGED" } });
  await h.sync.flush();
  assert.equal(h.last().state, "error"); assert.equal((await h.store.load("jr_aaaaaaaa")).dirty, true);
});

test("a not-yet-created task (404) is retried, not dropped", async () => {
  const h = harness();
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-new", ink: page(1) });
  h.responses.push({ status: 404, body: { error: "Task not found" } });
  await h.sync.flush();
  assert.equal(h.last().state, "retrying"); assert.equal(h.timers.length, 1);
});

test("sync waits while the pen is down", async () => {
  let down = true;
  const h = harness({ isBusy: () => down });
  await edit(h.store,"jr_aaaaaaaa", { taskId: "task-1", ink: page(1) });
  await h.sync.flush();
  assert.equal(h.calls.length, 0); assert.equal(h.timers.length, 1);
  down = false; h.responses.push(ok(1));
  await h.sync.flush();
  assert.equal(h.calls.length, 1);
});

test("rapid A->B switching with delayed responses: each ack lands on its own page only", async () => {
  let n = 0;
  const store = Store.create({ backend: memoryBackend(), account: { userId: 1, workspaceId: "ws-1" }, makeId: () => "m" + (++n) });
  const pending = [];
  const fetch = (url, init) => new Promise(resolve => pending.push({ url, body: JSON.parse(init.body), resolve }));
  const mk = id => Sync.create({ store, journalId: id, fetch, isOnline: () => true, setTimeout: () => 0, clearTimeout() {} });
  await edit(store,"jr_aaaaaaaa", { taskId: "A", ink: page(1) });
  const a = mk("jr_aaaaaaaa").flush();
  await new Promise(r => setTimeout(r, 0));
  await edit(store,"jr_bbbbbbbb", { taskId: "B", ink: page(3) });
  const b = mk("jr_bbbbbbbb").flush();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(pending.map(p => p.url), ["/api/journal/tasks/A", "/api/journal/tasks/B"]);
  // B answers first, then A's slow response arrives.
  pending[1].resolve({ ok: true, status: 200, json: async () => ({ revision: 1 }) });
  await b;
  pending[0].resolve({ ok: true, status: 200, json: async () => ({ revision: 7 }) });
  await a;
  const A = await store.load("jr_aaaaaaaa"), B = await store.load("jr_bbbbbbbb");
  assert.equal(A.baseRevision, 7); assert.equal(A.ink.strokes.length, 1); assert.equal(A.taskId, "A");
  assert.equal(B.baseRevision, 1); assert.equal(B.ink.strokes.length, 3); assert.equal(B.taskId, "B");
});
