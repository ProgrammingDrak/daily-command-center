// Unit tests for lib/task-timing.js — the ⏳→✅ duration ledger extracted from
// routes/slack-events.js (dcc-canonical-task-model E1).
//
// Two things are being pinned down here. First, the load-bearing guard: with no
// startedAt and no explicit fallback, finalizeTiming must record NOTHING — a UI
// check-off must never inherit the Slack-only 5-minute default and invent work
// that did not happen. Second, reconcileTiming: a task completed through the
// browser's day_root `_done` overlay still gets its Slack-started timer closed.
const { test } = require("node:test");
const assert = require("node:assert");
const createTaskTiming = require("./lib/task-timing");

const MIN = 60000;
const END = Date.parse("2026-07-28T18:00:00.000Z");

function makeHarness() {
  const blocks = [];
  const deleted = [];
  const counts = { query: 0, update: 0 };
  // What the DB actually holds, deep-copied. `blocks` entries are the SAME objects
  // the caller hands in, and the module assigns `block.properties` after each
  // write, so asserting only on those would pass even if updateBlock were never
  // called. Read `stored` when the question is "was this really persisted?".
  const stored = new Map();
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const blockDB = {
    // Returns the PERSISTED properties, deliberately decoupled from the array
    // object, so a test can make the DB row diverge from the caller's snapshot.
    getBlock: async (id) => {
      const b = blocks.find(x => x.id === id);
      if (!b) return null;
      return { ...b, properties: stored.has(id) ? copy(stored.get(id)) : b.properties };
    },
    updateBlock: async (id, { properties }) => {
      counts.update++;
      if (String(id).startsWith("boom")) throw new Error("write rejected " + id);
      const b = blocks.find(x => x.id === id);
      if (!b) throw new Error("not found " + id);
      stored.set(id, copy(properties));
      b.properties = properties;
      return { id };
    },
    createBlock: async ({ id, type, date, properties, parent_id }) => {
      const b = { id, type, date, properties, parent_id };
      blocks.push(b); stored.set(id, copy(properties));
      return b;                       // db.js returns the whole row; callers rely on it
    },
    ensureDayRoot: async (date) => `day-root-ws-1-${date}`,
  };
  const pool = {
    query: async (sql, params) => {
      counts.query++;
      if (/^\s*DELETE/i.test(sql)) {
        const i = blocks.findIndex(b => b.id === params[0] && b.type === "time_entry");
        if (i >= 0) { deleted.push(blocks.splice(i, 1)[0]); stored.delete(params[0]); }
        return { rows: [] };
      }
      const hit = blocks.find(b => b.id === params[0]);
      return { rows: hit ? [{ id: hit.id }] : [] };
    },
  };
  const timing = createTaskTiming({ pool, blockDB, timeZone: "America/New_York" });
  const addTask = (props, extra = {}) => {
    const b = { id: `blk-${blocks.length + 1}`, type: "block", date: "2026-07-28", properties: props, ...extra };
    blocks.push(b); stored.set(b.id, copy(props)); return b;
  };
  // Simulate ANOTHER writer committing to this row after the caller's SELECT.
  const mutateStored = (id, props) => stored.set(id, copy(props));
  const timerFor = (id) => blocks.find(b => b.type === "time_entry" && b.id === `${id}-slacktimer`);
  return { timing, blocks, deleted, counts, stored, addTask, mutateStored, timerFor };
}

const dayRoot = (props) => ({ id: "day-root-ws-1-2026-07-28", type: "day_root", date: "2026-07-28", properties: props });

test("finalizeTiming no-ops with no startedAt and no fallback — never invents minutes", async () => {
  const { timing, addTask, timerFor } = makeHarness();
  const task = addTask({ title: "Untimed", status: "done" });
  const res = await timing.finalizeTiming({ block: task, endMs: END });
  assert.equal(res.changed, false);
  assert.equal(task.properties.actualMinutes, undefined);
  assert.equal(task.properties.notes, undefined);
  assert.equal(timerFor(task.id), undefined, "no phantom time_entry");
});

test("finalizeTiming honors an explicit fallback (the Slack 🔖→✅ rule)", async () => {
  const { timing, addTask, timerFor } = makeHarness();
  const task = addTask({ title: "No hourglass" });
  const res = await timing.finalizeTiming({ block: task, endMs: END, fallbackMinutes: 5 });
  assert.equal(res.changed, true);
  assert.equal(res.timed, false);
  assert.equal(task.properties.actualMinutes, 5);
  assert.match(task.properties.notes, /no timer/);
  assert.equal(timerFor(task.id).properties.durSec, 300);
});

test("finalizeTiming computes real elapsed minutes from startedAt", async () => {
  const { timing, addTask, timerFor } = makeHarness();
  const task = addTask({ title: "Timed", startedAt: new Date(END - 40 * MIN).toISOString() });
  const res = await timing.finalizeTiming({ block: task, endMs: END });
  assert.equal(res.timed, true);
  assert.equal(res.actualMinutes, 40);
  assert.match(task.properties.notes, /Took ~40m/);
  assert.equal(timerFor(task.id).properties.durSec, 2400);
});

test("finalizeTiming keeps the user's own notes and appends the ⏱ line", async () => {
  const { timing, addTask } = makeHarness();
  const task = addTask({ title: "Timed", notes: "call Ben back", startedAt: new Date(END - 10 * MIN).toISOString() });
  await timing.finalizeTiming({ block: task, endMs: END });
  assert.match(task.properties.notes, /^call Ben back/);
  assert.match(task.properties.notes, /⏱ Took ~10m/);
});

test("finalizeTiming is idempotent — a second call re-times nothing", async () => {
  const { timing, addTask, blocks } = makeHarness();
  const task = addTask({ title: "Timed", startedAt: new Date(END - 40 * MIN).toISOString() });
  await timing.finalizeTiming({ block: task, endMs: END });
  const notesAfterFirst = task.properties.notes;
  const res = await timing.finalizeTiming({ block: task, endMs: END + 10 * MIN });
  assert.equal(res.changed, false);
  assert.equal(task.properties.actualMinutes, 40);
  assert.equal(task.properties.notes, notesAfterFirst, "the ⏱ note is not appended twice");
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 1);
});

test("finalizeTiming writes mergeProps even when there is nothing to time", async () => {
  const { timing, addTask } = makeHarness();
  const task = addTask({ title: "Untimed" });
  const res = await timing.finalizeTiming({ block: task, endMs: END, mergeProps: { status: "done", done: true } });
  assert.equal(res.changed, true);
  assert.equal(task.properties.status, "done");
  assert.equal(task.properties.actualMinutes, undefined, "still no invented minutes");
});

test("a ⏳ left running for days is capped, and the SEGMENT is capped with it", async () => {
  const { timing, addTask, timerFor } = makeHarness();
  const MAX = createTaskTiming.MAX_TIMED_MINUTES;
  const task = addTask({ title: "Forgotten", startedAt: new Date(END - 3 * 24 * 60 * MIN).toISOString() });
  const res = await timing.finalizeTiming({ block: task, endMs: END, maxMinutes: MAX });
  assert.equal(res.actualMinutes, MAX);
  assert.match(task.properties.notes, /timer left running/);
  // The clamp has to move the segment start too, or Day Review renders a 3-day bar
  // under a 16h number. Asserting the note alone would not catch that.
  assert.equal(res.startMs ?? END - MAX * 60000, END - MAX * 60000);
  const te = timerFor(task.id);
  assert.ok(te, "a segment is still created when clamped");
  assert.equal(te.properties.durSec, MAX * 60, "segment duration matches the capped minutes");
});

test("clearTiming un-times a task, strips only the ⏱ line, and drops the timer row", async () => {
  const { timing, addTask, blocks, deleted, stored } = makeHarness();
  const task = addTask({ title: "Timed", notes: "call Ben back", startedAt: new Date(END - 12 * MIN).toISOString() });
  await timing.finalizeTiming({ block: task, endMs: END, mergeProps: { status: "done", done: true, completedAt: new Date(END).toISOString() } });
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 1);

  await timing.clearTiming({
    block: task,
    mergeProps: { status: "open" },
    dropProps: ["done", "completedAt"],
  });
  assert.equal(task.properties.actualMinutes, undefined);
  assert.equal(task.properties.done, undefined);
  assert.equal(task.properties.completedAt, undefined);
  assert.equal(task.properties.status, "open");
  assert.equal(task.properties.notes, "call Ben back", "user text survives, ⏱ line does not");
  assert.ok(task.properties.startedAt, "startedAt survives so a re-✅ measures from the original ⏳");
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 0);
  assert.equal(deleted.length, 1, "the timer row is hard-deleted, not tombstoned");
  // Read the PERSISTED copy, not the caller's object, so this fails if the write
  // never happened.
  assert.equal(stored.get(task.id).actualMinutes, undefined);
  assert.equal(stored.get(task.id).notes, "call Ben back");
  assert.equal(stored.get(task.id).status, "open");
});

test("clearTiming then re-finalize records time again (the un-✅ → re-✅ round trip)", async () => {
  const { timing, addTask, timerFor } = makeHarness();
  const task = addTask({ title: "Timed", startedAt: new Date(END - 25 * MIN).toISOString() });
  await timing.finalizeTiming({ block: task, endMs: END });
  await timing.clearTiming({ block: task, dropProps: ["done", "completedAt"] });
  await timing.finalizeTiming({ block: task, endMs: END });
  assert.equal(task.properties.actualMinutes, 25);
  assert.equal(timerFor(task.id).properties.durSec, 1500);
});

test("reconcileTiming closes a timer on a row completed through the _done overlay", async () => {
  const { timing, blocks, addTask, timerFor } = makeHarness();
  const task = addTask({ local_id: "t-1", title: "Slack task", startedAt: new Date(END - 18 * MIN).toISOString() });
  blocks.push(dayRoot({ _done: { ids: ["t-1"], at: { "t-1": new Date(END).toISOString() } } }));

  const before = blocks.length;
  const n = await timing.reconcileTiming(blocks, { userId: 1, workspaceId: "ws-1" });
  assert.equal(n, 1);
  assert.equal(task.properties.actualMinutes, 18, "real elapsed, measured to the overlay's completion time");
  assert.equal(task.properties.actualMinutesFrom, "reconcile", "read-derived timing stays distinguishable from a real Slack measurement");
  assert.equal(timerFor(task.id).properties.durSec, 1080);
  assert.match(timerFor(task.id).properties.note, /closed on completion/);
  // The segment is minted mid-read, so it has to be folded into the array the
  // caller is about to return or Day Review shows the time one refresh late.
  assert.equal(blocks.length, before + 1);
  assert.ok(blocks.some(b => b.id === `${task.id}-slacktimer`), "timer row is in the response set");
});

test("reconcileTiming reverses its derived stamp when the task is un-checked", async () => {
  const { timing, blocks, deleted, addTask, timerFor } = makeHarness();
  const task = addTask({ local_id: "t-undo", title: "Reopen me", startedAt: new Date(END - 12 * MIN).toISOString() });
  const root = dayRoot({ _done: { ids: ["t-undo"], at: { "t-undo": new Date(END).toISOString() } } });
  blocks.push(root);

  assert.equal(await timing.reconcileTiming(blocks, {}), 1);
  assert.equal(task.properties.actualMinutes, 12);
  assert.ok(timerFor(task.id));

  // Still done on a later read: leave the derived answer alone. Without this the
  // reconciler would re-time itself every page load and double the ⏱ note.
  const notes = task.properties.notes;
  assert.equal(await timing.reconcileTiming(blocks, {}), 0);
  assert.equal(task.properties.notes, notes);
  assert.equal(blocks.filter(b => b.type === "time_entry").length, 1);

  root.properties._done = { ids: [], at: {} };
  assert.equal(await timing.reconcileTiming(blocks, {}), 1);
  assert.equal(task.properties.actualMinutes, undefined);
  assert.equal(task.properties.actualMinutesFrom, undefined);
  assert.equal(task.properties.notes, undefined);
  assert.equal(timerFor(task.id), undefined);
  assert.equal(deleted.length, 1, "the derived Day Review segment is removed too");
});

test("a real Slack measurement supersedes a derived timing guess", async () => {
  const { timing, blocks, addTask, timerFor } = makeHarness();
  const task = addTask({
    local_id: "t-retime",
    title: "Retimed",
    notes: "keep me",
    startedAt: new Date(END - 20 * MIN).toISOString(),
  });
  blocks.push(dayRoot({ _done: { ids: ["t-retime"], at: { "t-retime": new Date(END - 5 * MIN).toISOString() } } }));

  assert.equal(await timing.reconcileTiming(blocks, {}), 1);
  assert.equal(task.properties.actualMinutes, 15);
  assert.equal(task.properties.actualMinutesFrom, "reconcile");

  await timing.finalizeTiming({ block: task, endMs: END });
  assert.equal(task.properties.actualMinutes, 20);
  assert.equal(task.properties.actualMinutesFrom, undefined);
  assert.equal((task.properties.notes.match(/⏱/g) || []).length, 1, "the derived note is replaced, not doubled");
  assert.match(task.properties.notes, /^keep me/);
  assert.equal(timerFor(task.id).properties.durSec, 1200, "the derived segment is replaced with the measured window");
});

// Every other reconcile case goes through the _done overlay, so the row-level
// branch of isBlockDone / completionMsOf (the API-completion path the module was
// written for) would regress silently without this. No day_root in the array
// either, which pins the overlay === null path.
test("reconcileTiming closes a timer on a row completed on the ROW itself, no overlay", async () => {
  const { timing, blocks, addTask, timerFor } = makeHarness();
  const task = addTask({
    title: "API done", startedAt: new Date(END - 15 * MIN).toISOString(),
    status: "done", completedAt: new Date(END).toISOString(),
  });
  assert.equal(await timing.reconcileTiming(blocks, {}), 1);
  assert.equal(task.properties.actualMinutes, 15, "measured to props.completedAt, not to now");
  assert.equal(timerFor(task.id).properties.durSec, 900);
});

// reconcileTiming writes from a READ path and db.js updateBlock replaces the whole
// properties document, so persisting the snapshot it was handed would destroy
// anything committed between the caller's SELECT and this write — a Slack ✅
// landing mid-read, or the poller's title enrichment.
test("reconcileTiming re-reads before writing, so a concurrent completion is not clobbered", async () => {
  const { timing, blocks, addTask, mutateStored } = makeHarness();
  const task = addTask({ local_id: "t-race", title: "Racing", startedAt: new Date(END - 20 * MIN).toISOString() });
  blocks.push(dayRoot({ _done: { ids: ["t-race"], at: { "t-race": new Date(END).toISOString() } } }));

  // The caller's array now holds a STALE snapshot: the webhook committed the
  // completion (and the poller a real title) after the SELECT.
  mutateStored(task.id, {
    local_id: "t-race", title: "Reply to Ben about SOW", startedAt: task.properties.startedAt,
    status: "done", done: true, completedAt: new Date(END).toISOString(),
  });

  await timing.reconcileTiming(blocks, {});
  const p = task.properties;
  assert.equal(p.status, "done", "the concurrent completion survives");
  assert.equal(p.done, true);
  assert.ok(p.completedAt);
  assert.equal(p.title, "Reply to Ben about SOW", "and so does the poller's title");
  assert.equal(p.actualMinutes, 20, "while the timing still gets settled");
});

test("reconcileTiming skips a row that another writer already settled", async () => {
  const { timing, blocks, addTask, mutateStored, counts } = makeHarness();
  const task = addTask({ local_id: "t-done", startedAt: new Date(END - 20 * MIN).toISOString() });
  blocks.push(dayRoot({ _done: { ids: ["t-done"], at: { "t-done": new Date(END).toISOString() } } }));
  mutateStored(task.id, { local_id: "t-done", startedAt: task.properties.startedAt, actualMinutes: 20 });
  const updatesBefore = counts.update;
  assert.equal(await timing.reconcileTiming(blocks, {}), 0);
  assert.equal(counts.update, updatesBefore, "no write at all once it no longer qualifies");
});

// clearStart deletes startedAt whenever completedAt is absent, which is always
// true of an overlay-only completion. Gating the withdraw on startedAt would make
// a derived stamp permanently stuck.
test("a derived stamp is still withdrawable after startedAt is gone", async () => {
  const { timing, blocks, addTask, timerFor } = makeHarness();
  const task = addTask({ local_id: "t-nostart", title: "Oops", startedAt: new Date(END - 12 * MIN).toISOString() });
  const root = dayRoot({ _done: { ids: ["t-nostart"], at: { "t-nostart": new Date(END).toISOString() } } });
  blocks.push(root);
  assert.equal(await timing.reconcileTiming(blocks, {}), 1);
  assert.equal(task.properties.actualMinutes, 12);

  // un-⏳ in Slack clears startedAt, then the task is un-checked in the UI.
  delete task.properties.startedAt;
  root.properties._done = { ids: [], at: {} };

  assert.equal(await timing.reconcileTiming(blocks, {}), 1, "our own stamp is reconsidered without startedAt");
  assert.equal(task.properties.actualMinutes, undefined);
  assert.equal(task.properties.actualMinutesFrom, undefined);
  assert.equal(timerFor(task.id), undefined);
});

test("reconcileTiming caps rows per read and says what it deferred", async () => {
  const { timing, blocks, addTask } = makeHarness();
  for (let i = 0; i < 5; i++) {
    addTask({ local_id: `bulk-${i}`, startedAt: new Date(END - 10 * MIN).toISOString() });
  }
  const at = {};
  for (let i = 0; i < 5; i++) at[`bulk-${i}`] = new Date(END).toISOString();
  blocks.push(dayRoot({ _done: { ids: Object.keys(at), at } }));
  assert.equal(await timing.reconcileTiming(blocks, { maxRows: 2 }), 2, "only the cap is settled");
  // The rest settle on later reads rather than in one burst.
  assert.equal(await timing.reconcileTiming(blocks, { maxRows: 2 }), 2);
  assert.equal(await timing.reconcileTiming(blocks, { maxRows: 2 }), 1);
  assert.equal(await timing.reconcileTiming(blocks, { maxRows: 2 }), 0);
});

test("reconcileTiming matches a row by its DB id too, not just local_id", async () => {
  const { timing, blocks, addTask } = makeHarness();
  const task = addTask({ title: "API task", startedAt: new Date(END - 7 * MIN).toISOString() });
  blocks.push(dayRoot({ _done: { ids: [task.id], at: { [task.id]: new Date(END).toISOString() } } }));
  assert.equal(await timing.reconcileTiming(blocks, {}), 1);
  assert.equal(task.properties.actualMinutes, 7);
});

test("reconcileTiming leaves open, already-timed, and untimed-done rows alone", async () => {
  const { timing, blocks, addTask } = makeHarness();
  const open = addTask({ local_id: "open-1", startedAt: new Date(END - 5 * MIN).toISOString() });
  const timed = addTask({ local_id: "timed-1", startedAt: new Date(END - 5 * MIN).toISOString(), actualMinutes: 5, status: "done" });
  const neverStarted = addTask({ local_id: "cold-1", status: "done", completedAt: new Date(END).toISOString() });
  blocks.push(dayRoot({ _done: { ids: ["timed-1"], at: { "timed-1": new Date(END).toISOString() } } }));

  assert.equal(await timing.reconcileTiming(blocks, {}), 0);
  assert.equal(open.properties.actualMinutes, undefined);
  assert.equal(timed.properties.actualMinutes, 5);
  assert.equal(neverStarted.properties.actualMinutes, undefined, "done but never started ⇒ still no invented minutes");
});

test("reconcileTiming skips a done row with no derivable completion time", async () => {
  const { timing, blocks, addTask } = makeHarness();
  // done via `ids` only, no `at` timestamp: billing "now" for an old day would be a lie.
  const task = addTask({ local_id: "t-1", startedAt: new Date(END - 30 * MIN).toISOString() });
  blocks.push(dayRoot({ _done: { ids: ["t-1"] } }));
  assert.equal(await timing.reconcileTiming(blocks, {}), 0);
  assert.equal(task.properties.actualMinutes, undefined);
});

test("reconcileTiming ignores soft-deleted rows and non-task types", async () => {
  const { timing, blocks, addTask } = makeHarness();
  const tombstoned = addTask({ local_id: "gone-1", startedAt: new Date(END - 9 * MIN).toISOString() }, { deleted_at: "2026-07-28T12:00:00Z" });
  blocks.push(dayRoot({ _done: { ids: ["gone-1"], at: { "gone-1": new Date(END).toISOString() } } }));
  assert.equal(await timing.reconcileTiming(blocks, {}), 0);
  assert.equal(tombstoned.properties.actualMinutes, undefined);
});

// This runs on EVERY itinerary day read, so "cheap when there is nothing to do"
// is a requirement, not a nicety: the candidate filter is pure in-memory.
test("reconcileTiming does zero DB work when no timer is orphaned", async () => {
  const { timing, blocks, counts, addTask } = makeHarness();
  addTask({ local_id: "a", status: "done" });                                       // done, never started
  addTask({ local_id: "b", startedAt: new Date(END).toISOString(), actualMinutes: 3 }); // already timed
  blocks.push(dayRoot({ _done: { ids: ["a", "b"], at: { a: new Date(END).toISOString() } } }));
  assert.equal(await timing.reconcileTiming(blocks, {}), 0);
  assert.equal(counts.query, 0);
  assert.equal(counts.update, 0);
});

test("reconcileTiming survives one failing row and still settles the rest", async () => {
  const { timing, blocks, addTask } = makeHarness();
  const bad = addTask({ local_id: "bad-1", startedAt: new Date(END - 4 * MIN).toISOString() });
  bad.id = "boom-1";                                 // the harness rejects writes to boom*
  const good = addTask({ local_id: "good-1", startedAt: new Date(END - 6 * MIN).toISOString() });
  blocks.push(dayRoot({ _done: { ids: ["bad-1", "good-1"], at: { "bad-1": new Date(END).toISOString(), "good-1": new Date(END).toISOString() } } }));
  const n = await timing.reconcileTiming(blocks, {});
  assert.equal(n, 1);
  assert.equal(good.properties.actualMinutes, 6);
});

test("stripTookNote leaves prose untouched", () => {
  assert.equal(createTaskTiming.stripTookNote("hello\n\n⏱ Took ~4m (⏳ 2:00p → ✅ 2:04p)"), "hello");
  assert.equal(createTaskTiming.stripTookNote("⏱ ~5m (✅ 2:04p, no timer)"), "");
  assert.equal(createTaskTiming.stripTookNote("just prose"), "just prose");
  assert.equal(createTaskTiming.stripTookNote(""), "");
});
