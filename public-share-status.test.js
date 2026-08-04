// Contract tests for what the PUBLIC todo share treats as done and as hidden
// (routes/social-todo.js buildPublicTodoShare), after C5b moved completion onto the row.
//
// Why this file exists: step 6 of C5b is not a tidy-up, it is load-bearing for step 2. The
// moment completion writes `properties.status` instead of `day_root._done`, an overlay-only
// `doneIds` publishes every task Drake finished today as `open` — or as `overdue`, once its
// end time passes — on a page he shares with other people. The deleted half is the same
// shape from the other direction: B1/C3 moved deletion to the `deleted_at` COLUMN, and
// `getBlocksByDate` filters those rows out entirely, so a deleted task's TIMELINE twin has
// had nothing hiding it since. That is the "the public share keeps showing tasks Drake
// deleted" bug the C5 plan named.
//
// Harness pattern: raw source sliced into a node:vm context (recalc-times.test.js,
// day-root-overlays.test.js). The slice is exactly the region C5b changed — the done/hidden
// set construction — because everything around it (calendar maps, task normalization, the
// triage merge) is untouched and would only dilute what a failure here means.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./routes/social-todo.js"), "utf8");

function mustMatch(re, what) {
  const m = SRC.match(re);
  if (!m) throw new Error("public-share-status.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

const IDENTITY_SRC = mustMatch(/function publicTaskIdentityIds\(input\) \{[\s\S]*?\n\}/, "publicTaskIdentityIds");
// The slice runs from the single DAY READ through the end of the `for (const block of blocks)`
// loop, i.e. it includes the try/catch and the live/tombstoned split — not just the set
// construction. Starting it below the read would mean the harness supplied `blocks` and
// `tombstoned` itself and had to fake the degradation warning, so the "fails closed, loudly"
// test would assert a string the harness wrote rather than one the code emits. That is the
// assert-on-a-mock-that-cannot-fail trap this project keeps paying for.
const SETS_SRC = mustMatch(
  /let allRows;[\s\S]*?\n {2}for \(const block of blocks\) \{[\s\S]*?\n {2}\}/,
  "the day read + done/hidden set construction in buildPublicTodoShare"
);

// ONE store behind every question, so a fixture cannot claim a row exists for the live
// read and not for the tombstone read (C5a's mock-contradiction lesson). `rows` is the
// whole day; the two reads partition it on `deleted_at` exactly as db.js does.
function build({ rootProps = {}, rows = [], tombstoneReadThrows = false } = {}) {
  const warnings = [];
  const reads = [];
  // The widened slice derives `root`/`rootProps` from the day's own day_root ROW, which is
  // what production does — so the overlays go on a real row rather than being handed in as a
  // variable the real code never reads.
  const allRows = rootProps && Object.keys(rootProps).length
    ? [{ id: "root-1", type: "day_root", properties: rootProps }].concat(rows)
    : rows.slice();
  const ctx = {
    // BOTH channels: the fail-closed path logs with console.error, and a fake missing the
    // method turns the real throw into "console.error is not a function" — a harness bug
    // masquerading as the assertion passing for the wrong reason.
    console: {
      warn: (...a) => warnings.push(a.map(String).join(" ")),
      error: (...a) => warnings.push(a.map(String).join(" ")),
    },
    date: "2026-08-04",
    share: { workspace_id: "ws-1" },
    // A pure filter in production (server.js), so a pass-through is faithful here.
    filterLegacyGcalBlocks: (b) => b,
    // ONE store behind both reads, partitioned on `deleted_at` exactly as db.js's two
    // queries differ — so a fixture cannot claim a row exists for the live read and not for
    // the tombstone read (C5a's mock-contradiction lesson).
    blockDB: {
      getBlocksByDateIncludingDeleted: async (d, ws) => {
        reads.push(["all", d, ws]);
        if (tombstoneReadThrows) throw new Error("db down");
        return allRows;
      },
    },
  };
  vm.createContext(ctx);
  // The IIFE's rejection is captured, so a fail-closed throw is observable rather than an
  // unhandled rejection that crashes the runner.
  vm.runInContext(
    IDENTITY_SRC + "\nglobalThis.__done = (async () => {\n" + SETS_SRC + "\nreturn { done: [...doneIds].sort(), hidden: [...hiddenIds].sort(), blocks: blocks.length };\n})().then(o=>{globalThis.__out=o;},e=>{globalThis.__err=e;});",
    ctx
  );
  // Copied into HOST arrays: the vm has its own realm, so an array built in there is not
  // reference-equal to Array.prototype out here and deepStrictEqual rejects it on the
  // prototype alone, with a "same structure but not reference-equal" message that says
  // nothing about the assertion you meant to make.
  return new Promise((r) => setTimeout(() => {
    if (ctx.__err) return r({ threw: String(ctx.__err && ctx.__err.message), warnings, reads });
    r({ done: [...ctx.__out.done], hidden: [...ctx.__out.hidden], blocks: ctx.__out.blocks, warnings, reads });
  }, 0));
}

const row = (id, props, extra) => ({ id, type: "block", properties: props || {}, ...(extra || {}) });

test("a row completed on the ROW is published as done (the C5b regression this closes)", async () => {
  const out = await build({ rows: [row("blk-1", { local_id: "t1", title: "Ship it", status: "done", completedAt: "2026-08-04T12:00:00Z" })] });
  assert.ok(out.done.includes("t1"), "the local_id the share keys on");
  assert.ok(out.done.includes("blk-1"), "and the row id, since API tasks are keyed that way");
});

test("every spelling of a row completion counts, matching the fold's predicate", async () => {
  for (const props of [{ status: "done" }, { done: true }, { completedAt: "2026-08-04T12:00:00Z" }]) {
    const out = await build({ rows: [row("blk-1", { local_id: "t1", title: "x", ...props })] });
    assert.ok(out.done.includes("t1"), "not treated as done: " + JSON.stringify(props));
  }
});

test("an open row is not published as done", async () => {
  const out = await build({ rows: [row("blk-1", { local_id: "t1", title: "x", status: "open" })] });
  assert.deepEqual(out.done, []);
  // `done` must be strictly true. A truthy leftover is not a completion, same rule as the
  // fold's row seed (server-done-rows.test.js).
  const out2 = await build({ rows: [row("blk-2", { local_id: "t2", title: "x", done: "false" })] });
  assert.deepEqual(out2.done, []);
});

test("a DELETED row's aliases are hidden, so its timeline twin stops rendering", async () => {
  // The row itself is already absent from `blocks` (getBlocksByDate filters deleted_at), so
  // this can only come from the tombstone read. The timeline item carrying the same id is
  // what the share would otherwise publish.
  const out = await build({
    rows: [row("blk-9", { local_id: "gone-1", title: "Deleted thing", source_id: "evt-9" }, { deleted_at: "2026-08-04T10:00:00Z" })],
  });
  assert.ok(out.hidden.includes("gone-1"));
  assert.ok(out.hidden.includes("blk-9"));
  assert.ok(out.hidden.includes("evt-9"), "the source_id alias too, which is how a calendar twin is keyed");
});

test("a live row is NOT hidden", async () => {
  const out = await build({ rows: [row("blk-1", { local_id: "t1", title: "x" })] });
  assert.deepEqual(out.hidden, []);
});

// Named for what it PROVES, not for what would be nice. In this branch a deleted task's
// timeline twin does still publish — the row is absent from `blocks` either way, so nothing
// can put its aliases in the hide set. The accepted degradation is: keep serving the list,
// keep the overlay hide set, and SAY SO. The warning is the whole safety story, so it is
// asserted rather than swallowed.
// REWRITTEN after review round 2. The first cut degraded to an overlay-only hide set, which is
// fail-OPEN: with no tombstones the `deleted_at` aliases never reach `hiddenIds`, so the
// timeline twin of a task the owner DELETED gets published again to whoever holds the link, and
// only pre-B1 `_deleted` entries still hide anything. The comment claimed the opposite of what
// the code did. Nor is the failure self-cancelling: the tombstone-inclusive scan is the LARGER
// of the two queries on a ~2000-block day, so a statement timeout hits it while the narrower
// live query would have succeeded — exactly the state that tripped the branch.
test("a failed tombstone read REFUSES to publish rather than hiding nothing", async () => {
  const out = await build({
    rootProps: { _deleted: ["overlay-gone"] },
    rows: [row("blk-9", { local_id: "gone-1", title: "x" }, { deleted_at: "2026-08-04T10:00:00Z" })],
    tombstoneReadThrows: true,
  });
  assert.equal(out.threw, "db down", "the caller answers a generic 500 and the viewer re-polls in 15s");
  assert.equal(out.warnings.length, 1, "and it is logged, not swallowed");
  assert.match(out.warnings[0], /tombstone read failed/);
  assert.deepEqual(out.reads.map((r) => r[0]), ["all"], "no second scan to paper over it");
});

// The perf half, asserted because it is easy to regress back into two scans: the
// tombstone-inclusive read is a strict SUPERSET of the live one, and this handler is polled
// every 15s per open viewer.
test("the happy path reads the day ONCE", async () => {
  const out = await build({ rows: [row("blk-1", { local_id: "t1", title: "x" })] });
  assert.deepEqual(out.reads.map((r) => r[0]), ["all"], "one scan, split locally");
  assert.deepEqual(out.reads[0].slice(1), ["2026-08-04", "ws-1"], "scoped to the date and the share's workspace");
});

test("the LEGACY overlays are still read, unioned with the row facts", async () => {
  // 23 of prod's 401 `_done` entries are the only representation of a real completion (12
  // whose local_id is shared by 2+ rows so migration 002 refused to guess, 11 that render
  // from an archive-day timeline with no row at all), and old day_roots still carry
  // `_pushed` for rows that were hidden rather than moved. Dropping either read republishes
  // finished or departed work as open.
  const out = await build({
    rootProps: { _done: { ids: ["legacy-done"], at: { "legacy-done-at": "x" } }, _deleted: ["legacy-del"], _pushed: { ids: ["legacy-push"] } },
    rows: [row("blk-1", { local_id: "t1", title: "x", status: "done" })],
  });
  assert.deepEqual(out.done, ["blk-1", "legacy-done", "legacy-done-at", "t1"]);
  assert.deepEqual(out.hidden, ["legacy-del", "legacy-push"]);
});

test("an overlay hit still fans out to the row's other aliases", async () => {
  // The pre-existing behavior, kept: the overlay names ONE spelling of an id and the share
  // renders items under several, so a hit on any alias has to mark them all.
  const out = await build({
    rootProps: { _done: { ids: ["t1"] } },
    rows: [row("blk-1", { local_id: "t1", title: "x", source_id: "evt-1" })],
  });
  assert.deepEqual(out.done, ["blk-1", "evt-1", "t1"]);
});
