// ======== WAITING CLUSTER COMPLETION ========
// One delegated thing is up to three rows, and closing one used to leave the others
// standing:
//
//   the ITEM      the Waiting drawer card (kind: delegated_item). The record of the
//                 delegation itself -- who owes what, the Slack permalink, the cadence.
//   the TASK      the row carrying the REAL WORK. Either a pre-existing task the item
//                 was raised off (item.linkedBlockId) or the "waiting-unblock-task:*"
//                 row unblockWaitingItem creates when the blocker clears.
//   the REMINDERS the "waiting-checkin-task:*" rows that nag about it. These OUTLIVE
//                 the item by design -- completing or deleting the item only ever
//                 touched the item -- which is how Drake ended up with live check-ins
//                 chasing work that was already finished.
//
// Completing any one of the three now closes the cluster. This module is the pure half:
// it decides WHICH rows a completion must also close, from plain rows, so the rule is
// testable without a database and cannot fork between the three entry points that call
// it (the task-completion route, the legacy PATCH completionIntent branch, and the
// Waiting item's own complete route).
//
// Deliberately NOT here: the writes. Each cascaded TASK goes back through
// blockDB.setTaskCompletion so it earns its points, closes its work session and syncs
// to Slack exactly as a hand-ticked row would -- a raw property write would skip all
// three. See cascadeWaitingCompletion in routes/blocks.js.
//
// Node: require()d by routes/blocks.js and its tests. No browser consumer -- the client
// completes through the routes and re-renders off the broadcast.

const CHECKIN_SOURCE = "waiting-checkin";
const UNBLOCK_SOURCE = "waiting-unblock";
const CHECKIN_LOCAL_ID = /^waiting-checkin-task:(.+)$/;
const UNBLOCK_LOCAL_ID = /^waiting-unblock-task:(.+)$/;

function props(row) {
  return (row && row.properties) || {};
}

// The same three spellings routes/blocks.js's isCompleted accepts. Duplicated rather
// than imported because that one is a closure inside the route module; they are pinned
// together by a test.
function isDone(row) {
  const p = props(row);
  return p.status === "done" || p.done === true || !!p.completedAt;
}

function isLive(row) {
  return !!row && !row.deleted_at;
}

// ROLE FIRST, id second -- the rule delegated.js's checkInItemId documents and this
// module has to obey too. `delegatedItemId` alone is NOT the tell: unblockWaitingItem
// stamps it on the row carrying the real work as well, so reading it first would call
// that row a reminder. The id prefix and the source tag are what mean "reminder".
function roleOf(row) {
  const p = props(row);
  const source = String(p.source || "").replace(/_/g, "-");
  const localId = String(p.local_id || row && row.id || "");
  if (CHECKIN_LOCAL_ID.test(localId) || source === CHECKIN_SOURCE) return "reminder";
  if (UNBLOCK_LOCAL_ID.test(localId) || source === UNBLOCK_SOURCE) return "task";
  return "";
}

function suffixItemId(localId, pattern) {
  const match = pattern.exec(String(localId || ""));
  return match ? match[1].trim() : "";
}

// Which Waiting item does this TASK belong to? Three edges, because three creation
// paths wrote three different ones and all three are still in the data:
//   1. the stamped delegatedItemId (every row scheduleDelegatedItem or
//      unblockWaitingItem has made since those stamps existed);
//   2. the local_id suffix, the older spelling and the only edge on the first rows;
//   3. an item pointing back at this row through linkedBlockId -- the case where the
//      work task existed FIRST and the Waiting item was raised off it, so the task
//      carries no edge of its own at all.
function itemIdForTask(task, items) {
  if (!isLive(task)) return "";
  const p = props(task);
  const role = roleOf(task);
  if (role) {
    const stamped = String(p.delegatedItemId || "").trim();
    if (stamped) return stamped;
    const pattern = role === "reminder" ? CHECKIN_LOCAL_ID : UNBLOCK_LOCAL_ID;
    const fromLocalId = suffixItemId(p.local_id || task.id, pattern);
    if (fromLocalId) return fromLocalId;
  }
  const refs = new Set([task.id, p.local_id].filter(Boolean).map(String));
  const owner = (items || []).find(item => {
    if (!isLive(item) || props(item).kind !== "delegated_item") return false;
    const linked = String(props(item).linkedBlockId || "").trim();
    return !!linked && refs.has(linked);
  });
  return owner ? String(owner.id) : "";
}

// The rows a completion of `trigger` must ALSO close.
//
// `trigger` is whatever the caller already completed (a task row, or the item itself
// when the Waiting card's Complete button fired). It is excluded from the result by id,
// so a caller can pass the full cluster without re-closing what it just wrote.
//
// Rows already done are excluded too, which is what makes the whole cascade re-runnable:
// a retry after a partial failure closes only what is still open.
function cascadeTargets({ trigger, item, tasks }) {
  const triggerId = String((trigger && trigger.id) || "");
  const openTasks = (tasks || []).filter(row =>
    isLive(row) && String(row.id) !== triggerId && !isDone(row) && !!roleOfOrLinked(row, item));
  const openItem = (isLive(item) && String(item.id) !== triggerId && !isDone(item)) ? item : null;
  return { item: openItem, tasks: openTasks };
}

// A row belongs to the cluster if it plays a cluster ROLE (reminder / unblock task) or
// it is the item's linked work row. Without the second half, a task the item was raised
// off -- which carries no role marker at all -- would be silently dropped from the
// cascade even though the Waiting card's own Complete button already closes it.
function roleOfLinkedTask(row, item) {
  const linked = String(props(item).linkedBlockId || "").trim();
  if (!linked) return "";
  const refs = new Set([row.id, props(row).local_id].filter(Boolean).map(String));
  return refs.has(linked) ? "task" : "";
}

function roleOfOrLinked(row, item) {
  return roleOf(row) || (item ? roleOfLinkedTask(row, item) : "");
}

// The properties that close a Waiting item, matching the shape POST
// /api/waiting-items/:id/complete writes. `completedBy` names the cascade so the drawer
// can tell "Drake pressed Complete here" apart from "this closed because the work did".
function completedItemProperties(completedAt) {
  return {
    status: "done",
    completedAt,
    completedBy: "cascade",
    snoozedUntil: null,
    checkInScheduledFor: null,
    checkInTaskId: null,
  };
}

// Deterministic, so a retry of a half-finished cascade is a no-op rather than a second
// completion. setTaskCompletion dedupes on this id. Constrained to the charset its
// validator accepts ([A-Za-z0-9:_-]), which block ids and epoch millis already satisfy.
function cascadeMutationId(itemId, taskId, atMs) {
  return `waiting-cascade:${String(itemId).slice(0, 40)}:${String(taskId).slice(0, 40)}:${atMs}`;
}

module.exports = {
  CHECKIN_SOURCE,
  UNBLOCK_SOURCE,
  cascadeMutationId,
  cascadeTargets,
  completedItemProperties,
  isDone,
  itemIdForTask,
  roleOf,
};
