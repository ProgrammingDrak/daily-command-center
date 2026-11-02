// Header sync dot inputs: Working Queue notification order, and the relocated
// commitment and queue recovery rows. Real module code in a VM, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function workingQueue() {
  const store = new Map();
  const docListeners = {};
  const snapshots = [];
  const posts = [];
  const key = "dcc-working-queue:ws-1:1";
  class CustomEvent { constructor(type) { this.type = type; } }
  const context = {
    DCC_ACCOUNT_CONTEXT: { userId: 1, workspaceId: "ws-1" },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    document: {
      getElementById: () => null,
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
      dispatchEvent: (event) => (docListeners[event.type] || []).forEach((fn) => fn(event))
    },
    addEventListener() {},
    setInterval() {},
    navigator: { onLine: true },
    crypto: { randomUUID: () => "uuid-" + posts.length },
    CSS: { escape: String },
    AbortSignal: { timeout: () => undefined },
    CustomEvent,
    console
  };
  context.window = context;
  context.DCC = {
    esc: String, toast() {}, tabs: { register() {} },
    api: (url, opts) => {
      if (opts && opts.method === "POST") { const d = deferred(); posts.push({ body: opts.body, d }); return d.promise; }
      return Promise.resolve({ revision: 0, foreground: [], queue: { items: [], order: [] } });
    }
  };
  vm.createContext(context);
  vm.runInContext(read("public/js/working-queue.js"), context);
  const wq = context.DCCWorkingQueue;
  // Every notification must already see the new memory and storage state.
  context.document.addEventListener("dcc:working-queue-sync", () => snapshots.push({
    state: plain(wq.syncState()),
    storedPending: store.has(key + ":pending"),
    storedConflict: store.has(key + ":conflict")
  }));
  const click = (action) => (docListeners.click || []).forEach((fn) => fn({ target: { closest: () => ({ dataset: { queueAction: action, taskId: "" } }) } }));
  return { wq, posts, snapshots, store, key, click };
}

test("queue sync notifications fire after pending and conflict are updated", async () => {
  const q = workingQueue();
  const body = { action: "queue-reorder", sourceEventId: "e1", expectedRevision: 0 };

  // In flight: observers see the pending update, already stored.
  const sent = q.wq.send(body);
  assert.deepEqual(q.snapshots.at(-1), { state: { pending: true, conflict: null }, storedPending: true, storedConflict: false });
  // Success clears it before anyone hears about it.
  q.posts[0].d.resolve({});
  await sent;
  assert.deepEqual(q.snapshots.at(-1), { state: { pending: false, conflict: null }, storedPending: false, storedConflict: false });

  // A transient failure keeps the saved update for retry; no notice claims it cleared.
  const failed = q.wq.send({ ...body, sourceEventId: "e2" });
  const before = q.snapshots.length;
  q.posts[1].d.reject(Object.assign(new Error("Service unavailable"), { status: 503 }));
  await assert.rejects(failed, /Service unavailable/);
  assert.equal(q.snapshots.length, before, "failure changes nothing, so nothing is announced");
  assert.equal(q.wq.syncState().pending, true);
  assert.equal(JSON.parse(q.store.get(q.key + ":pending")).sourceEventId, "e2");

  // Retry sends the exact same saved update, then clears it.
  const retried = q.wq.send(JSON.parse(q.store.get(q.key + ":pending")));
  assert.equal(q.posts[2].body.sourceEventId, "e2");
  q.posts[2].d.resolve({});
  await retried;
  assert.deepEqual(q.snapshots.at(-1).state, { pending: false, conflict: null });

  // A conflict is recorded, then the pending update cleared; each notice sees its own step.
  const conflicted = q.wq.send({ ...body, sourceEventId: "e3" });
  const start = q.snapshots.length;
  q.posts[3].d.reject(Object.assign(new Error("Queue changed elsewhere"), { status: 409 }));
  await assert.rejects(conflicted, /Queue changed elsewhere/);
  assert.deepEqual(q.snapshots.slice(start).map((s) => s.state), [
    { pending: true, conflict: { message: "Queue changed elsewhere" } },
    { pending: false, conflict: { message: "Queue changed elsewhere" } }
  ]);
  assert.equal(JSON.parse(q.store.get(q.key + ":conflict")).body.sourceEventId, "e3", "the attempted change is kept");

  // Clearing is explicit and also notifies with the cleared state.
  q.click("clear-conflict");
  assert.deepEqual(q.snapshots.at(-1), { state: { pending: false, conflict: null }, storedPending: false, storedConflict: false });
});

// ── Recovery rows from shell.js ──

function node(tag) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(), className: "", textContent: "", type: "", disabled: false, dataset: {}, children: [],
    append: (...kids) => { el.children.push(...kids); },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    click: () => Promise.all((listeners.click || []).map((fn) => fn({ target: el })))
  };
  return el;
}
const buttons = (root) => root.children.flatMap((c) => (c.tagName === "BUTTON" ? [c] : buttons(c)));
const texts = (root) => root.children.flatMap((c) => [c.textContent, ...texts(c)]).filter(Boolean);

function recovery({ pending = [], queue = null } = {}) {
  const calls = [], closed = [], navs = [];
  const context = {
    document: { createElement: node, querySelector: () => null },
    setTimeout: (fn) => fn(),
    console
  };
  context.window = context;
  context.DCC = { toast: (m) => calls.push({ op: "toast", m }), nav: { go: (s) => navs.push(s) } };
  context.window.DCCCommitmentSync = {
    pending: async () => pending.slice(),
    retry: async (id) => { calls.push({ op: "retry", id }); },
    discard: async (id) => { calls.push({ op: "discard", id }); }
  };
  context.window.DCCWorkingQueue = { syncState: () => queue || { pending: false, conflict: null } };
  vm.createContext(context);
  const shell = read("public/js/shell.js");
  const start = shell.indexOf("  function queueSync()");
  const end = shell.indexOf("  function saveStatusBody(");
  vm.runInContext(shell.slice(start, end).replace(/\n {2}let lastAnnounced[\s\S]*?\n {2}function queueRecoveryRows/, "\n  function queueRecoveryRows"), context);
  return { context, calls, closed, navs, close: (reason) => closed.push(reason) };
}

test("commitment recovery retries the same action and asks before discarding", async () => {
  const r = recovery({ pending: [
    { actionId: "act-409", status: 409, error: "This changed elsewhere", body: { kind: "check_in", note: "keep me" } },
    { actionId: "act-wait", body: { title: "New commitment" } }
  ] });
  const wrap = node("div");
  await r.context.commitmentRecoveryRows(wrap, r.close);
  const all = texts(wrap);
  assert.ok(all.includes("2 commitment changes are saved on this device. Export before discarding anything you need."));
  assert.ok(all.includes("This changed elsewhere"));
  assert.ok(all.includes("Waiting to sync"));
  const [retry, discardConflict, discardWaiting] = buttons(wrap);
  assert.equal(retry.textContent, "Retry same change");
  assert.equal(discardWaiting.textContent, "Discard…");
  assert.equal(buttons(wrap).filter((b) => b.textContent === "Retry same change").length, 1, "retry only where an error exists");

  await retry.click();
  assert.deepEqual(r.calls, [{ op: "retry", id: "act-409" }]);
  assert.deepEqual(r.closed, ["commitment-retry"]);

  await discardConflict.click();
  assert.equal(discardConflict.textContent, "Confirm discard");
  assert.deepEqual(r.calls, [{ op: "retry", id: "act-409" }], "the first click discards nothing");
  await discardConflict.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(r.calls.at(-1), { op: "discard", id: "act-409" });
  assert.equal(r.calls.filter((c) => c.op === "discard").length, 1, "only the confirmed action is discarded");
});

test("no commitment rows without pending changes", async () => {
  const r = recovery();
  const wrap = node("div");
  await r.context.commitmentRecoveryRows(wrap, r.close);
  assert.equal(wrap.children.length, 0);
});

test("queue conflict recovery opens the queue and its conflict review", async () => {
  const r = recovery({ queue: { pending: false, conflict: { message: "Queue changed elsewhere" } } });
  const wrap = node("div");
  r.context.queueRecoveryRows(wrap, r.close);
  assert.ok(texts(wrap).some((t) => t.includes("Queue changed elsewhere") && t.includes("kept for review")));
  const [open] = buttons(wrap);
  assert.equal(open.textContent, "Review queue update");
  await open.click();
  assert.deepEqual(r.closed, ["queue-review"]);
  assert.deepEqual(plain(r.navs), [{ page: "tasks", view: "queue" }]);
  const waiting = recovery({ queue: { pending: true, conflict: null } });
  const w = node("div");
  waiting.context.queueRecoveryRows(w, waiting.close);
  assert.equal(buttons(w)[0].textContent, "Open Working Queue");
  const none = recovery();
  const n = node("div");
  none.context.queueRecoveryRows(n, none.close);
  assert.equal(n.children.length, 0);
});
