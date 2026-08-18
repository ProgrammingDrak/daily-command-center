// Delegated / waiting look: ONE hue (--waiting) on the Waiting item, the original task
// it blocks, and the check-in reminders it spawns -- with a LABEL on each so a deleted
// check-in is never mistaken for a deleted task. That mistake is the bug this covers:
// deleting a check-in card looked exactly like deleting the work, so the delegated task
// silently stayed open.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TRIAGE_SRC = fs.readFileSync(require.resolve("./public/js/triage.js"), "utf8");
const WAITING_SRC = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");
const LIST_SRC = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const CARD_SRC = fs.readFileSync(require.resolve("./public/js/itinerary-card.js"), "utf8");
const STATE_SRC = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const CSS_SRC = fs.readFileSync(require.resolve("./public/css/dashboard.css"), "utf8");

function mustSlice(src, re, name) {
  const match = src.match(re);
  assert.ok(match, name + " not found");
  return match[0];
}
const esc = value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// ── triage.js: the reminder cards (itinerary Triage strip + Triage tab) ──
function triagePill() {
  const code = ["isWaitingCheckIn", "waitingCheckInPillHtml", "waitingCheckInDeleteTitle"]
    .map(name => mustSlice(TRIAGE_SRC, new RegExp("^function " + name + "\\([\\s\\S]*?\\n\\}", "m"), name))
    .join("\n");
  return vm.runInNewContext(code + "\n;({isWaitingCheckIn, waitingCheckInPillHtml, waitingCheckInDeleteTitle})", {
    DCC: { esc },
  });
}

test("a Waiting-sourced triage item is labelled a check-in, and says what deleting it does", () => {
  const { isWaitingCheckIn, waitingCheckInPillHtml, waitingCheckInDeleteTitle } = triagePill();
  const item = { id: "waiting-checkin:w1:2026-08-18", source: "waiting_checkin", waiting_item_id: "w1", contact: { name: "Mike P." } };
  assert.equal(isWaitingCheckIn(item), true);
  const html = waitingCheckInPillHtml(item);
  assert.match(html, /class="waiting-pill checkin"/);
  assert.match(html, /Check-in/);
  assert.match(html, /data-waiting-open="w1"/);
  // The tooltip is the fix: the reminder is not the task.
  assert.match(html, /The delegated task stays open in Waiting/);
  assert.match(waitingCheckInDeleteTitle(item), /check-in reminder \(the delegated task stays open in Waiting\)/);

  // A swept item that has nothing to do with Waiting keeps its own look and copy.
  const other = { id: "gmail:1", source: "gmail", type: "email_needs_response" };
  assert.equal(isWaitingCheckIn(other), false);
  assert.equal(waitingCheckInPillHtml(other), "");
  assert.equal(waitingCheckInDeleteTitle(other), "Delete triage item");
});

test("an unresolvable check-in still reads as one, without a dead link", () => {
  const { waitingCheckInPillHtml } = triagePill();
  const html = waitingCheckInPillHtml({ id: "x", source: "waiting-checkin" });
  assert.match(html, /^<span class="waiting-pill checkin"/);
  assert.doesNotMatch(html, /data-waiting-open/);
});

test("check-in ids and names are escaped into the pill", () => {
  const { waitingCheckInPillHtml } = triagePill();
  const html = waitingCheckInPillHtml({ waiting_item_id: 'w1" onclick="bad()', contact: { name: 'Mike" x' } });
  assert.match(html, /data-waiting-open="w1&quot; onclick=&quot;bad\(\)"/);
  assert.doesNotMatch(html, /onclick="bad\(\)"/);
});

test("both triage card builders paint the waiting hue and carry the pill", () => {
  // Itinerary Triage strip (the card that used to look like any other medium-priority item)
  const strip = mustSlice(TRIAGE_SRC, /^function buildScheduleTriageCard\(item\)\{[\s\S]*?\n\}/m, "buildScheduleTriageCard");
  assert.match(strip, /isWaitingCheckIn\(item\)\?"var\(--waiting/);
  assert.match(strip, /waiting-checkin-card/);
  assert.match(strip, /waitingCheckInPillHtml\(item\)/);
  assert.match(strip, /waitingCheckInDeleteTitle\(item\)/);
  // Triage tab
  const tab = mustSlice(TRIAGE_SRC, /^function buildTriageCard\(item\) \{[\s\S]*?\n\}/m, "buildTriageCard");
  assert.match(tab, /isWaitingCheckIn\(item\) \? "var\(--waiting/);
  assert.match(tab, /waiting-checkin-card/);
  assert.match(tab, /waitingCheckInPillHtml\(item\)/);
  // Deleting the reminder says so, so the 8s Undo toast can't be read as "task deleted".
  assert.match(TRIAGE_SRC, /isWaitingCheckIn\(item\) \? "Check-in deleted\. The delegated task is still open in Waiting" : "Triage item deleted"/);
});

// ── delegated.js: the itinerary row chip (both roles) ──
// The sandbox mirrors the REAL predicates rather than a convenient approximation of
// them: `isOpenDelegated` never looks at a top-level `done` flag and a task dependency
// needs blockerType, so stubs that ignore either detail make the exclusion tests below
// pass against fixtures the production code would happily paint a pill on.
const realIsDone = item => {
  const p = (item && item.properties) || {};
  return !!(p.completedAt || p.status === "done" || p.status === "unblocked");
};
const realIsTaskDependency = item => {
  const p = (item && item.properties) || {};
  return p.blockerType === "task" && !!p.blockerBlockId && !!p.linkedBlockId;
};
// `scans` counts block-cache sweeps so the per-render memo has a test, not just a comment.
function chipRenderer(items, opts) {
  opts = opts || {};
  const scans = { count: 0 };
  const code = ["getAllDelegatedItems", "getDelegatedItemById", "evIdentityIds", "checkInItemId", "isCheckInTask", "checkInItem",
                "checkInIsLive", "waitingLinkIndex", "waitingItemsForTask", "waitingPill", "waitingChipHtml"]
    .map(name => mustSlice(WAITING_SRC, new RegExp("^ {2}function " + name + "\\([\\s\\S]*?^ {2}\\}", "m"), name))
    .join("\n");
  const memo = mustSlice(WAITING_SRC, /^ {2}let _linkIndex = null;\n {2}let _linkIndexGen = -1;/m, "memo state");
  const sandbox = {
    esc,
    truncate: (s, n) => String(s || "").slice(0, n),
    Promise,
    Map,
    isOpenDelegated: item => !realIsDone(item),
    isTaskDependency: realIsTaskDependency,
    sortByUrgency: () => 0,
    window: {
      blockStore: {
        getByType: () => { scans.count++; return items.slice(); },
        get: id => (opts.storeGet === false ? null : items.find(i => i.id === id) || null),
        getMutationGeneration: () => (typeof opts.generation === "function" ? opts.generation() : (opts.generation || 0)),
      },
    },
  };
  const api = vm.runInNewContext(memo + "\n" + code + "\n;({waitingChipHtml, isCheckInTask, checkInIsLive, checkInItemId, waitingItemsForTask})", sandbox);
  return Object.assign(api, { scans });
}
const item = (id, props) => ({ id, properties: Object.assign({ kind: "delegated_item" }, props) });
const WAITING_ITEM = item("w1", { linkedBlockId: "task-1", delegatee: { name: "Mike P." }, myTask: "Review metrics" });

test("a check-in row is labelled a check-in and links back to its Waiting item", () => {
  const { waitingChipHtml, isCheckInTask } = chipRenderer([WAITING_ITEM]);
  const ev = { id: "waiting-checkin-task:w1", title: "Check in: Review metrics", source: "waiting-checkin", delegatedItemId: "w1" };
  assert.equal(isCheckInTask(ev), true);
  const html = waitingChipHtml(ev);
  assert.match(html, /class="waiting-pill checkin"/);
  assert.match(html, /Check-in · Mike P\./);
  assert.match(html, /data-waiting-open="w1"/);
  assert.match(html, /The delegated task stays open in Waiting/);
});

test("a check-in row is recognised from its id or source when delegatedItemId is missing", () => {
  const { isCheckInTask } = chipRenderer([]);
  assert.equal(isCheckInTask({ id: "waiting-checkin-task:w9" }), true);
  assert.equal(isCheckInTask({ id: "abc", source: "waiting_checkin" }), true);
  assert.equal(isCheckInTask({ id: "abc", source: "notion" }), false);
});

test("the ORIGINAL task wears the same hue, labelled 'Waiting on' -- that's the one to delete", () => {
  const { waitingChipHtml } = chipRenderer([WAITING_ITEM]);
  const html = waitingChipHtml({ id: "task-1", title: "Review metrics" });
  assert.match(html, /class="waiting-pill source"/);
  assert.match(html, /Waiting on Mike P\./);
  assert.match(html, /data-waiting-open="w1"/);
  assert.match(html, /delete the task there/);
});

test("the chip stays off unrelated tasks, closed items, and task dependencies", () => {
  // All three ways a Waiting item closes, on the shapes the real predicates read.
  const closed = [
    item("w2", { linkedBlockId: "task-2", delegatee: { name: "Ann" }, status: "done" }),
    item("w4", { linkedBlockId: "task-4", delegatee: { name: "Ann" }, status: "unblocked" }),
    item("w5", { linkedBlockId: "task-5", delegatee: { name: "Ann" }, completedAt: "2026-08-18T00:00:00Z" }),
  ];
  const dependency = item("w3", { linkedBlockId: "task-3", blockerBlockId: "task-9", blockerType: "task" });
  const { waitingChipHtml } = chipRenderer([WAITING_ITEM, ...closed, dependency]);
  assert.equal(waitingChipHtml({ id: "task-unrelated" }), "");
  for (const id of ["task-2", "task-4", "task-5"]) assert.equal(waitingChipHtml({ id }), "", id + " is closed");
  assert.equal(waitingChipHtml({ id: "task-3" }), "");   // carries the blocked/unlocks pill instead
  // ...and the live one still paints, so the exclusions above are not just a dead helper.
  assert.match(waitingChipHtml({ id: "task-1" }), /Waiting on Mike P\./);
});

// THE inversion bug: unblockWaitingItem stamps delegatedItemId on the row that carries
// the REAL WORK, so a delegatedItemId-first predicate labelled that row a reminder and
// told Drake the delegated task was still open while he deleted the task itself.
test("the waiting-UNBLOCK row is the work, not a reminder", () => {
  const { isCheckInTask, waitingChipHtml, checkInItemId } = chipRenderer([WAITING_ITEM]);
  const unblockRow = { id: "waiting-unblock-task:w1", source: "waiting-unblock", delegatedItemId: "w1", title: "Review metrics" };
  assert.equal(checkInItemId(unblockRow), null);
  assert.equal(isCheckInTask(unblockRow), false);
  assert.doesNotMatch(waitingChipHtml(unblockRow), /Check-in/);
});

// A reminder outlives its item: complete and delete leave the scheduled row alone.
test("a check-in whose Waiting item is closed or gone reads as stale, with no link", () => {
  const closed = item("w1", { linkedBlockId: "task-1", delegatee: { name: "Mike P." }, status: "done" });
  const ev = { id: "waiting-checkin-task:w1", source: "waiting-checkin", delegatedItemId: "w1" };
  const shut = chipRenderer([closed]);
  assert.equal(shut.checkInIsLive(ev), false);
  const html = shut.waitingChipHtml(ev);
  assert.match(html, /^<span class="waiting-pill checkin"/);
  assert.match(html, /already closed or gone, so the reminder is stale/);
  assert.doesNotMatch(html, /data-waiting-open/);
  assert.doesNotMatch(html, /stays open in Waiting/);
  // Deleted outright: nothing resolves, same stale copy rather than a false promise.
  const gone = chipRenderer([], { storeGet: false });
  assert.equal(gone.checkInIsLive(ev), false);
  assert.match(gone.waitingChipHtml(ev), /stale/);
  // Still live -> the promise is allowed.
  const live = chipRenderer([WAITING_ITEM]);
  assert.equal(live.checkInIsLive(ev), true);
  assert.match(live.waitingChipHtml(ev), /The delegated task stays open in Waiting/);
});

test("the whole block cache is swept once per render burst, not once per row", () => {
  const { waitingChipHtml, scans } = chipRenderer([WAITING_ITEM]);
  for (let i = 0; i < 25; i++) waitingChipHtml({ id: "task-" + i });
  assert.equal(scans.count, 1, "25 rows must not mean 25 cache sweeps");
});

test("a store write invalidates the per-burst index", () => {
  let gen = 0;
  const { waitingChipHtml, scans } = chipRenderer([WAITING_ITEM], { generation: () => gen });
  waitingChipHtml({ id: "task-1" });
  waitingChipHtml({ id: "task-1" });
  assert.equal(scans.count, 1, "same generation reuses the index");
  gen = 1;                                    // something wrote to the store
  waitingChipHtml({ id: "task-1" });
  assert.equal(scans.count, 2, "a mutation must drop the index rather than serve stale rows");
});

test("the pill's other three labels", () => {
  // Two people on one task collapse into a count, and the link goes to the first item.
  const two = chipRenderer([
    item("wA", { linkedBlockId: "t9", delegatee: { name: "Ann" } }),
    item("wB", { linkedBlockId: "t9", delegatee: { name: "Bo" } }),
  ]);
  const many = two.waitingChipHtml({ id: "t9" });
  assert.match(many, /Waiting on 2 people/);
  assert.match(many, /waiting on Ann, Bo\. Click/);
  assert.match(many, /data-waiting-open="wA"/);
  // A nameless delegatee still reads as delegated, and the tip drops the "waiting on" clause.
  const nameless = chipRenderer([item("wA", { linkedBlockId: "t9" })]);
  const bare = nameless.waitingChipHtml({ id: "t9" });
  assert.match(bare, /&#9203; Delegated</);
  assert.doesNotMatch(bare, /waiting on/);
  // The trailing period on a name is trimmed rather than doubled up.
  const dotted = chipRenderer([item("wA", { linkedBlockId: "t9", delegatee: { name: "Mike P." } }) ]);
  assert.match(dotted.waitingChipHtml({ id: "t9" }), /waiting on Mike P\. Click/);
});

test("the row matches on every id shape a block can carry", () => {
  const { waitingChipHtml } = chipRenderer([WAITING_ITEM]);
  assert.match(waitingChipHtml({ id: "local-9", _blockId: "task-1" }), /waiting-pill source/);
  assert.match(waitingChipHtml({ id: "local-9", local_id: "task-1" }), /waiting-pill source/);
});

// ── the surfaces that consume it ──
test("List rows and cards take the waiting hue and the pill from one helper", () => {
  for (const [name, src] of [["schedule-tab", LIST_SRC], ["itinerary-card", CARD_SRC]]) {
    assert.match(src, /window\.waitingRowChipHtml/, name + " builds the chip through the shared helper");
    assert.match(src, /waitChip\?'var\(--waiting/, name + " paints the bar with the waiting hue");
    assert.match(src, /waiting-row/, name + " marks the row");
  }
  // The pill is a button inside the row: the row's open-space click must not swallow it.
  assert.match(LIST_SRC, /closest\("\.waiting-pill"\)/);
});

test("deleting a check-in row says the delegated task is still open", () => {
  const del = mustSlice(STATE_SRC, /^async function deleteTaskWithUndo\(id\)\{[\s\S]*?\n\}/m, "deleteTaskWithUndo");
  assert.match(del, /window\.isWaitingCheckInTask\(ev\)/);
  // Orientation, not mere presence: an inverted ternary would put "Task deleted" back on
  // a check-in row, which is the exact regression this change exists to remove.
  assert.match(del, /isCheckIn\s*\?\s*\(liveCheckIn\s*\?\s*"Check-in deleted\. The delegated task is still open in Waiting"\s*:\s*"Check-in deleted\. Its Waiting item was already closed"\)\s*:\s*"Task deleted"/);
  assert.match(del, /window\.waitingCheckInIsLive\(ev\)/);
  assert.match(del, /label:"Undo"/);
});

test("one token defines the family, and the pill is styled once", () => {
  assert.match(CSS_SRC, /--waiting:#a31c43;/);
  assert.match(CSS_SRC, /--waiting-bg:rgba\(163,28,67,0\.42\)/);
  assert.match(CSS_SRC, /^\.waiting-pill\{/m);
  assert.match(CSS_SRC, /\.waiting-pill\.checkin\{border-style:dashed\}/);
  // "Open task" is part of the family, not a generic blue link.
  assert.match(CSS_SRC, /\.tri-open-waiting,\.schedule-triage-open-waiting\{border:0;background:transparent;color:var\(--waiting-ink\)/);
  // Text takes the readable member of the family; bars and borders take the deep one.
  assert.match(CSS_SRC, /--waiting-ink:#f0a3b6;/);
  assert.match(CSS_SRC, /^\.waiting-pill\{[^}]*color:var\(--waiting-ink\)/m);
});
