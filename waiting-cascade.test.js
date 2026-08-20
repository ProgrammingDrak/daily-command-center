// Completing one row of a delegation closes the cluster. The failure this replaces:
// finishing delegated work left its check-in reminders live on the itinerary, so the
// nag outlived the thing it was nagging about. These pin WHICH rows a completion takes
// and, just as importantly, which it must not.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const cascade = require("./waiting-cascade");
const ROUTES_SRC = fs.readFileSync(require.resolve("./routes/blocks.js"), "utf8");

const item = (id, properties) => ({ id, properties: Object.assign({ kind: "delegated_item" }, properties) });
const task = (id, properties, extra) => Object.assign({ id, type: "block", properties: properties || {} }, extra || {});

const reminder = (id, itemId, extra) => task(id, {
  source: "waiting-checkin", local_id: "waiting-checkin-task:" + itemId, delegatedItemId: itemId, title: "Check in: thing",
}, extra);
const unblockRow = (id, itemId, extra) => task(id, {
  source: "waiting-unblock", local_id: "waiting-unblock-task:" + itemId, delegatedItemId: itemId, title: "thing",
}, extra);

test("role is read from the id and the source, never from delegatedItemId", () => {
  // THE inversion bug, in this module's terms: unblockWaitingItem stamps
  // delegatedItemId on the row carrying the REAL WORK too, so an id-first read calls
  // that row a reminder -- and a cascade that believes it would close the work while
  // leaving the nag, exactly backwards.
  assert.equal(cascade.roleOf(reminder("a", "w1")), "reminder");
  assert.equal(cascade.roleOf(unblockRow("b", "w1")), "task");
  assert.equal(cascade.roleOf(task("c", { delegatedItemId: "w1", title: "unrelated" })), "");
  assert.equal(cascade.roleOf(task("waiting-checkin-task:w1", {})), "reminder", "the id alone is enough");
  assert.equal(cascade.roleOf(task("d", { source: "waiting_checkin" })), "reminder", "underscore spelling");
});

test("a task finds its Waiting item through all three edges", () => {
  const items = [item("w1", {}), item("w2", { linkedBlockId: "task-7" })];
  assert.equal(cascade.itemIdForTask(reminder("a", "w1"), items), "w1", "the stamp");

  const legacy = task("waiting-checkin-task:w1", { source: "waiting-checkin" });
  assert.equal(cascade.itemIdForTask(legacy, items), "w1", "the local_id suffix, for rows made before the stamp");

  // The work task existed FIRST and the item was raised off it, so the task carries no
  // edge at all -- only the item points, and it points the other way.
  const preexisting = task("task-7", { title: "Review metrics" });
  assert.equal(cascade.itemIdForTask(preexisting, items), "w2");
  assert.equal(cascade.itemIdForTask(task("task-7", { local_id: "task-7" }), items), "w2", "matched on local_id too");

  assert.equal(cascade.itemIdForTask(task("nope", {}), items), "");
  assert.equal(cascade.itemIdForTask(null, items), "");
  assert.equal(cascade.itemIdForTask(reminder("a", "w1", { deleted_at: "2026-08-19T00:00:00Z" }), items), "",
    "a tombstone belongs to nothing");
});

test("completing the work takes the item and every open reminder", () => {
  const it = item("w1", {});
  const work = unblockRow("blk-work", "w1");
  const plan = cascade.cascadeTargets({
    trigger: work,
    item: it,
    tasks: [work, reminder("blk-r1", "w1"), reminder("blk-r2", "w1")],
  });
  assert.equal(plan.item, it);
  assert.deepEqual(plan.tasks.map(r => r.id), ["blk-r1", "blk-r2"]);
});

test("the trigger and anything already done are excluded, so a retry is a no-op", () => {
  // This is what makes the cascade safe to re-run after a partial failure: the second
  // pass sees the rows the first pass closed and has nothing left to do.
  const it = item("w1", { status: "done" });
  const plan = cascade.cascadeTargets({
    trigger: reminder("blk-r1", "w1"),
    item: it,
    tasks: [
      reminder("blk-r1", "w1"),
      reminder("blk-r2", "w1"),
      unblockRow("blk-work", "w1", { properties: { source: "waiting-unblock", local_id: "waiting-unblock-task:w1", status: "done" } }),
    ],
  });
  assert.equal(plan.item, null, "the item was already closed");
  assert.deepEqual(plan.tasks.map(r => r.id), ["blk-r2"]);

  const empty = cascade.cascadeTargets({ trigger: reminder("blk-r2", "w1"), item: null, tasks: [] });
  assert.deepEqual(empty, { item: null, tasks: [] });
});

test("all three spellings of done are honoured", () => {
  for (const props of [{ status: "done" }, { done: true }, { completedAt: "2026-08-19T00:00:00Z" }]) {
    const plan = cascade.cascadeTargets({
      trigger: { id: "other" }, item: null,
      tasks: [reminder("blk-r1", "w1", { properties: Object.assign({ source: "waiting-checkin" }, props) })],
    });
    assert.deepEqual(plan.tasks, [], JSON.stringify(props) + " must read as done");
  }
  // ...and the route module's own predicate agrees, because a fork there is invisible.
  assert.match(ROUTES_SRC, /props\.status === "done" \|\| props\.done === true \|\| !!props\.completedAt/,
    "routes/blocks.js's isCompleted and waiting-cascade's isDone must stay the same rule");
});

test("a stranger's row is never swept into the cluster", () => {
  // getWaitingClusterTasks is keyed on the item id, but the item's linked row is fetched
  // by a separate resolver and joined in memory. Nothing but this filter stops an
  // unrelated task that came back with it from being completed.
  const it = item("w1", { linkedBlockId: "task-7" });
  const plan = cascade.cascadeTargets({
    trigger: { id: "trigger" },
    item: it,
    tasks: [task("task-7", { title: "the linked work" }), task("task-99", { title: "someone else's task" })],
  });
  assert.deepEqual(plan.tasks.map(r => r.id), ["task-7"]);
});

test("a tombstoned row is left alone", () => {
  const plan = cascade.cascadeTargets({
    trigger: { id: "trigger" },
    item: item("w1", { deleted_at: undefined }),
    tasks: [reminder("blk-r1", "w1", { deleted_at: "2026-08-19T00:00:00Z" }), reminder("blk-r2", "w1")],
  });
  assert.deepEqual(plan.tasks.map(r => r.id), ["blk-r2"]);
});

test("the item's closing properties match what the Waiting complete route writes", () => {
  const props = cascade.completedItemProperties("2026-08-19T21:00:00.000Z");
  assert.equal(props.status, "done");
  assert.equal(props.completedAt, "2026-08-19T21:00:00.000Z");
  // Named apart from "waiting" so the drawer can tell a deliberate Complete from a close
  // that happened because the work finished.
  assert.equal(props.completedBy, "cascade");
  // The three fields that must be cleared, or a closed item keeps a scheduled reminder.
  assert.equal(props.snoozedUntil, null);
  assert.equal(props.checkInScheduledFor, null);
  assert.equal(props.checkInTaskId, null);
});

test("cascade mutation ids are deterministic and pass setTaskCompletion's validator", () => {
  const id = cascade.cascadeMutationId("w1", "blk-r1", 1755639600000);
  assert.equal(id, cascade.cascadeMutationId("w1", "blk-r1", 1755639600000), "same inputs, same id");
  assert.notEqual(id, cascade.cascadeMutationId("w1", "blk-r2", 1755639600000));
  assert.match(id, /^[A-Za-z0-9:_-]{1,128}$/, "db.js validateTaskCompletionInput rejects anything else");
  // Long uuid-shaped ids on both halves must still fit the 128-char ceiling.
  const long = cascade.cascadeMutationId("a".repeat(80), "b".repeat(80), 1755639600000);
  assert.ok(long.length <= 128, "id length " + long.length);
  assert.match(long, /^[A-Za-z0-9:_-]{1,128}$/);
});

// ── the wiring, grepped: three entry points must all cascade ──
test("every completion entry point runs the cascade, and only on complete", () => {
  assert.match(ROUTES_SRC, /const waitingCascade = require\("\.\.\/waiting-cascade"\);/);

  // 1. the canonical route, 2. the legacy PATCH completionIntent branch, 3. the Waiting
  // card's own Complete. A fourth caller of setTaskCompletion that forgets this is the
  // realistic regression, which is why the count is asserted rather than the presence.
  const calls = ROUTES_SRC.match(/await cascadeWaitingCompletion\(\{/g) || [];
  assert.equal(calls.length, 3, "expected the three completion entry points to cascade");

  assert.match(ROUTES_SRC, /body\.completed && !result\.duplicate && result\.task/,
    "the canonical route must skip the cascade on a reopen and on a deduped replay");
  assert.match(ROUTES_SRC, /req\.body\.completionIntent === "complete"\n\s+\? await cascadeWaitingCompletion/,
    "the legacy branch must skip the cascade on a reopen");

  // Swallowed on purpose: the caller's own completion already committed.
  assert.match(ROUTES_SRC, /catch \(error\) \{\n\s+console\.error\("\[waiting-cascade\] failed:"/);
});
