// The CLIENT half of the task-group double-book contract (public/js/task-groups.js
// addGroupToDay), which is exposed as window.addTaskGroupToDay.
//
// A2 added a server-side dedupe guard to POST /api/task-groups/:id/schedule. That guard
// is only as good as the client that reads its answer: the first cut of it returned a
// shape addGroupToDay ignored, so every deduped add toasted "Group had no tasks" -- false,
// and a dead end, because `force` was the only way past the guard and nothing sent it.
// These pin the three branches that fix depends on.
//
// Harness pattern: block-store-tombstone.test.js -- raw source in a node:vm context with
// stubbed globals. task-groups.js is an IIFE that publishes onto window.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/task-groups.js"), "utf8");

// `respond` answers the schedule POST. `confirmAnswer` drives the re-add prompt.
function mountClient({ respond, confirmAnswer = false } = {}) {
  const posts = [];
  const toasts = [];
  const confirms = [];
  // Held requests, keyed by the group id in the URL. Per-id on purpose: a gate that
  // holds EVERY request cannot express "A is in flight while B goes through", which is
  // the case that distinguishes a per-id guard from a single-slot one.
  const held = new Map();

  const context = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    clearTimeout: () => {},
    document: { addEventListener: () => {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    viewDate: "2026-07-30",
    fetch: async (url, init) => {
      const method = (init && init.method) || "GET";
      const body = init && init.body ? JSON.parse(init.body) : null;
      if (method === "POST" && /\/schedule$/.test(String(url))) {
        posts.push({ url: String(url), body });
        // Holding a POST open lets a test fire a second click while the first is
        // genuinely still in flight -- the only way to exercise an in-flight guard.
        for (const [id, gate] of held) {
          if (String(url).includes(id) && gate.promise) { await gate.promise; break; }
        }
        const payload = typeof respond === "function" ? respond(posts.length, body) : respond;
        return { ok: true, status: 200, json: async () => payload };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    },
  };
  context.window = context;
  context.globalThis = context;
  context.confirm = (msg) => { confirms.push(msg); return confirmAnswer; };
  context.DCC = {
    esc: (s) => String(s == null ? "" : s),
    toast: (msg, kind) => toasts.push({ msg, kind }),
  };
  // refreshSchedule is a global the itinerary owns; the sidebar just calls it.
  context.refreshSchedule = async () => {};
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    add: context.window.addTaskGroupToDay,
    posts, toasts, confirms,
    hold(id) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      held.set(id, { promise, resolve });
    },
    release(id) {
      const gate = held.get(id);
      held.delete(id);
      if (gate) gate.resolve();
    },
  };
}

test("a normal add reports how many tasks landed", async () => {
  const { add, toasts } = mountClient({ respond: { created: [{ id: "a" }, { id: "b" }] } });
  await add("grp-1");
  assert.match(toasts.at(-1).msg, /Added 2 tasks/);
});

test("a LIVE duplicate says so instead of 'Group had no tasks'", async () => {
  // The exact regression. The server answers `duplicate: true` with an empty `created`,
  // and a client reading only created.length reports the preset group is empty.
  const { add, toasts, confirms } = mountClient({
    respond: { created: [], duplicate: true, deleted: false, task: { id: "tg-live" } },
  });
  await add("grp-1");
  assert.equal(confirms.length, 0, "a live duplicate is not worth a prompt");
  assert.match(toasts.at(-1).msg, /already on this day/);
  assert.doesNotMatch(toasts.at(-1).msg, /had no tasks/);
});

test("a DELETED duplicate offers a re-add, and declining sends no second POST", async () => {
  const { add, posts, toasts, confirms } = mountClient({
    respond: { created: [], duplicate: true, deleted: true, task: { id: "tg-gone" } },
    confirmAnswer: false,
  });
  await add("grp-1");
  assert.equal(confirms.length, 1, "a tombstone is a dead end without the prompt");
  assert.equal(posts.length, 1, "declining must not re-post");
  assert.match(toasts.at(-1).msg, /deleted/);
});

test("accepting the re-add re-POSTs with force:true", async () => {
  // force is the ONLY way past the server guard, and this is the only path in the UI
  // that sends it. The retry also has to dodge the in-flight guard, which it does by
  // recursing into the inner function -- an innocent rename to the outer one silently
  // no-ops every re-add, and nothing but this test would notice.
  const { add, posts } = mountClient({
    respond: (n) => (n === 1
      ? { created: [], duplicate: true, deleted: true, task: { id: "tg-gone" } }
      : { created: [{ id: "a" }, { id: "b" }] }),
    confirmAnswer: true,
  });
  await add("grp-1");
  assert.equal(posts.length, 2, "the retry must actually reach the server");
  assert.equal(posts[0].body.force, undefined, "the first attempt is not forced");
  assert.equal(posts[1].body.force, true);
});

test("a double-click issues ONE POST", async () => {
  // The server guard is check-then-act, so two concurrent POSTs can both read an empty
  // day and both plant the group. Holding the first request open is the only honest way
  // to test this: without the gate the first await resolves before the second click.
  const c = mountClient({ respond: { created: [{ id: "a" }] } });
  c.hold("grp-1");
  const first = c.add("grp-1");
  const second = c.add("grp-1");
  await second;
  assert.equal(c.posts.length, 1, "the second click must be swallowed while the first is in flight");
  c.release("grp-1");
  await first;
});

test("the guard is PER GROUP, so a second group is not blocked or unblocked by the first", async () => {
  // A single-slot guard gets this wrong twice: group B proceeds (right) but clears A's
  // guard on the way (wrong), so A's double-click gets through after all.
  const c = mountClient({ respond: { created: [{ id: "a" }] } });
  c.hold("grp-A");                  // only A is held; B flows straight through
  const a1 = c.add("grp-A");
  await c.add("grp-B");             // different id: must be allowed through
  // NOT awaited: with a single-slot guard this call is let through, and its POST is
  // held, so awaiting it would hang the suite until the runner's timeout instead of
  // failing on the assertion below. Flush the microtask queue and inspect instead.
  const a2 = c.add("grp-A");        // A is still in flight: must still be swallowed
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.posts.length, 2, "one POST for A, one for B, and A's repeat swallowed");
  assert.deepEqual(c.posts.map((p) => p.url.includes("grp-A")), [true, false]);
  c.release("grp-A");
  await Promise.all([a1, a2]);
});
