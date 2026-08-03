// Phase C5 — `public/js/slots.js reconcileCompletedTaskCredits` only repairs RECENT
// completions.
//
// WHY THIS EXISTS. The reconciler used to credit every done task in the fold on every
// `dcc:data-ready`, with no age test. That is survivable while completion lives in the
// per-day `_done` overlay and only the browser writes it. It stops being survivable
// the moment the ROW is the source of truth: `migrations/002_completion_status.sql`
// marks 295 rows `status:'done'` in one statement, and measured on a fresh prod
// restore (2026-08-03) 14 of those carry no ledger credit under any equivalent key —
// real May/July work whose completion never reached the ledger. Unnarrowed, the
// reconciler banks ~250-350 retroactive points on the next page load.
//
// Drake's call, 2026-08-03: no retroactive points. Verified on that restore with 002
// applied: all 14 are stamped and all 14 are older than 48h, so the age gate skips
// every one of them and `would_still_credit` reads 0.
//
// The gate is on `completedAt`, NOT on the row's date, because completing a PAST day's
// task stamps completedAt at now() while the date stays in the past — gating on the
// date would drop that legitimate case.
//
// These tests were written because the mutation check found the reconciler had NO
// coverage at all: removing the age gate and removing the unstamped gate both left the
// suite green.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const HOUR = 60 * 60 * 1000;

// Loads slots.js in a vm with the globals it reads off the page, and stubs the ONE
// seam that matters: window.DCC.api, which every credit post funnels through
// (slots.js:489 `api()` delegates to it). Returns the captured posts.
//
// `scheduled`, `isDone`, `doneAt` and `viewDate` are set as CONTEXT PROPERTIES, which
// is what slots.js's `typeof scheduled === "undefined"` guards read. Note C3's vm trap:
// a `function` declaration inside the script would SHADOW a same-named context
// property, so nothing here may collide with a name slots.js declares itself.
function loadReconciler({ scheduled, doneAt, doneIds, viewDate = "2026-08-03" }) {
  const posts = [];
  const logs = [];
  const source = fs.readFileSync(require.resolve("./public/js/slots.js"), "utf8");
  const done = new Set(doneIds);

  const el = () => null;
  const context = {
    console: { log: (...a) => logs.push(a.join(" ")), warn() {}, error() {} },
    setTimeout, clearTimeout, Date, JSON, Math, Number, Set, Map, Array, Object, String, Boolean, Promise, isNaN, parseInt, parseFloat,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: {
      addEventListener() {}, querySelectorAll() { return []; }, querySelector: el,
      getElementById: el, body: { appendChild() {} },
      createElement() { return { className: "", dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, remove() {}, querySelector: el, querySelectorAll() { return []; }, addEventListener() {}, setAttribute() {} }; },
    },
    CSS: { escape: String },
    performance: { now: () => Date.now() },
    requestAnimationFrame(cb) { return setTimeout(() => cb(Date.now()), 0); },
    // The globals the reconciler reads off the page.
    scheduled,
    doneAt,
    viewDate,
    isDone: (ev) => done.has(ev && ev.id),
    manualDone: done,
  };
  context.window = {
    addEventListener() {}, __state: { date: viewDate },
    localStorage: context.localStorage,
    DCC: {
      api(path, opts) {
        posts.push({ path, body: JSON.parse((opts && opts.body) || "{}") });
        return Promise.resolve({ awarded: true, credits: 1 });
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const SlotRewards = context.window.SlotRewards;
  assert.ok(SlotRewards && typeof SlotRewards.reconcileCompletedTaskCredits === "function",
    "harness must actually reach the reconciler — a silent load failure would make every assertion below vacuous");
  return { reconcile: SlotRewards.reconcileCompletedTaskCredits, posts, logs };
}

// WHY THE SKIP REASON IS ASSERTED, NOT JUST THE SKIP. The two guards are masked by
// each other on the "did it credit?" question alone: a missing stamp resolves to
// null, `nowMs - null` is `nowMs`, and the AGE gate then skips it. So deleting the
// stamp guard changes no post count, and the mutation check reported MISSED on a test
// that looked adequate. The reasons are genuinely different intents ("I have no idea
// when this finished" vs "this finished months ago") and the function already counts
// them separately for diagnosis, so asserting the reason is what makes each guard
// independently observable — and what stops the pair from silently collapsing into
// an accidental reliance on null coercing to epoch 0.
function skipReport(logs) {
  const line = logs.find(l => l.includes("reconcile skipped")) || "";
  const stale = /skipped (\d+) completion/.exec(line);
  const unstamped = /and (\d+) with no completedAt/.exec(line);
  return { stale: stale ? Number(stale[1]) : 0, unstamped: unstamped ? Number(unstamped[1]) : 0, line };
}

const ev = (id, title) => ({ id, title, type: "task", durMin: 30 });

test("a completion from minutes ago IS still reconciled", async () => {
  // The counterweight. A gate that skipped everything would satisfy every other test
  // in this file while silently killing the repair path the function exists for.
  const fresh = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { reconcile, posts } = loadReconciler({
    scheduled: [ev("t-fresh", "Just finished")],
    doneAt: { "t-fresh": fresh },
    doneIds: ["t-fresh"],
  });
  await reconcile();
  assert.equal(posts.length, 1, "a recent completion is repaired");
  assert.equal(posts[0].path, "/api/slot/earn-task");
  assert.equal(posts[0].body.task_id, "t-fresh");
  // The stamp is passed through, not replaced with now() — the ledger records when
  // the work finished.
  assert.equal(posts[0].body.completed_at, fresh);
});

test("a completion older than 48h is NOT reconciled — this is migration 002's 14 rows", async () => {
  const { reconcile, posts } = loadReconciler({
    scheduled: [
      ev("t-may", "AMPortal Fix: tooltip"),          // 2026-05-11 on prod
      ev("t-jul", "Email iBuyer with Reviewed Data"), // 2026-07-20 on prod
    ],
    doneAt: {
      "t-may": new Date(Date.now() - 84 * 24 * HOUR).toISOString(),
      "t-jul": new Date(Date.now() - 14 * 24 * HOUR).toISOString(),
    },
    doneIds: ["t-may", "t-jul"],
  });
  await reconcile();
  assert.equal(posts.length, 0, "no retroactive points for months-old work");
});

test("the 48h boundary is honored on both sides", async () => {
  const { reconcile, posts } = loadReconciler({
    scheduled: [ev("t-in", "Inside"), ev("t-out", "Outside")],
    doneAt: {
      "t-in": new Date(Date.now() - 47 * HOUR).toISOString(),
      "t-out": new Date(Date.now() - 49 * HOUR).toISOString(),
    },
    doneIds: ["t-in", "t-out"],
  });
  await reconcile();
  assert.deepEqual(posts.map(p => p.body.task_id), ["t-in"]);
});

test("a done task with NO completedAt stamp is skipped AS UNSTAMPED, not as stale", async () => {
  // The old code defaulted a missing timestamp to `new Date()`, i.e. it read an
  // undated completion as if it had happened this instant — which is precisely how a
  // row marked done by a migration would have looked fresh. Every completion path
  // stamps completedAt from C5 on, so an unstamped done row is pre-C5 history.
  const { reconcile, posts, logs } = loadReconciler({
    scheduled: [ev("t-nostamp", "Overlay-era completion")],
    doneAt: {},
    doneIds: ["t-nostamp"],
  });
  await reconcile();
  assert.equal(posts.length, 0);
  // The reason, not just the outcome — see skipReport's note. Attributing this to the
  // age gate would mean the stamp guard could be deleted undetected.
  assert.deepEqual(skipReport(logs), { stale: 0, unstamped: 1, line: skipReport(logs).line });
});

test("an unparsable completedAt is skipped rather than crediting on a NaN comparison", async () => {
  // `NaN > RECONCILE_MAX_AGE_MS` is false, so a bare arithmetic gate would let a
  // garbage stamp through. Guarded explicitly, and attributed to the stamp guard.
  const { reconcile, posts, logs } = loadReconciler({
    scheduled: [ev("t-junk", "Bad stamp")],
    doneAt: { "t-junk": "not a date" },
    doneIds: ["t-junk"],
  });
  await reconcile();
  assert.equal(posts.length, 0);
  assert.equal(skipReport(logs).unstamped, 1);
  assert.equal(skipReport(logs).stale, 0);
});

test("a stale completion is attributed to the AGE gate, not the stamp gate", async () => {
  // The mirror of the two above: it is what keeps them honest. If both reasons
  // reported the same counter, either guard could absorb the other's job unnoticed.
  const { reconcile, posts, logs } = loadReconciler({
    scheduled: [ev("t-old", "Months ago")],
    doneAt: { "t-old": new Date(Date.now() - 30 * 24 * HOUR).toISOString() },
    doneIds: ["t-old"],
  });
  await reconcile();
  assert.equal(posts.length, 0);
  assert.equal(skipReport(logs).stale, 1);
  assert.equal(skipReport(logs).unstamped, 0);
});

test("a Date object stamp works, not just an ISO string", async () => {
  // schedule.js writes `doneAt[id] = new Date()` on the in-memory path and an ISO
  // string on the hydrated path, so both shapes reach here in production.
  const { reconcile, posts } = loadReconciler({
    scheduled: [ev("t-dateobj", "Date object")],
    doneAt: { "t-dateobj": new Date(Date.now() - HOUR) },
    doneIds: ["t-dateobj"],
  });
  await reconcile();
  assert.equal(posts.length, 1);
});

test("a numeric epoch stamp works — the third documented shape", async () => {
  // _completionMsOf claims Date | number | ISO string. The number arm was the one shape
  // with no test: delete it and a numeric stamp silently becomes "unstamped" and the
  // completion stops being reconciled, with nothing failing.
  const { reconcile, posts, logs } = loadReconciler({
    scheduled: [ev("t-epoch", "Epoch ms")],
    doneAt: { "t-epoch": Date.now() - HOUR },
    doneIds: ["t-epoch"],
  });
  await reconcile();
  assert.equal(posts.length, 1);
  assert.equal(skipReport(logs).unstamped, 0, "a number is a stamp, not a missing one");
});

test("open tasks are never credited, however recently they were touched", async () => {
  const { reconcile, posts } = loadReconciler({
    scheduled: [ev("t-open", "Still open")],
    doneAt: { "t-open": new Date().toISOString() },
    doneIds: [],
  });
  await reconcile();
  assert.equal(posts.length, 0);
});

test("a duplicated ev id is credited once", async () => {
  const fresh = new Date(Date.now() - HOUR).toISOString();
  const { reconcile, posts } = loadReconciler({
    scheduled: [ev("t-dup", "Twin"), ev("t-dup", "Twin")],
    doneAt: { "t-dup": fresh },
    doneIds: ["t-dup"],
  });
  await reconcile();
  assert.equal(posts.length, 1);
});
