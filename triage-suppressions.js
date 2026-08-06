// ======== TRIAGE SUPPRESSIONS ========
//
// The durable, date-independent record of "I already handled this triage item".
//
// Two defects made triage look untouched on any surface that did not happen to be
// the tab you cleared it in:
//
//   1. "Gone" was stored on the day_root BLOCK for the date you were looking at
//      (`_dismissed` / `_triageDeleted` / `_triageScheduled`). Clearing 19 items on
//      2026-08-04 wrote 19 ids onto day-root-ws-1-2026-08-04 and nothing onto the
//      2026-08-05 root, so the next morning every one of them was back. A phone
//      opening a fresh day saw the raw list, which is what surfaced this.
//
//   2. Deleting an item POSTed the whole client `__state` to /api/ingest/day-state
//      with the item stripped from `triage.open_items` and appended to
//      `triage.deleted_items`. But `deleted_items` was written by the frontend and
//      read by NOTHING: `mergeOpenItems` only ever dropped items marked
//      status:"resolved" (which no reader sets) or aged out. `triage` is a
//      full-replace section in that ingest route, so the next Sweep Suite publish
//      overwrote the section wholesale and every deletion evaporated. On prod that
//      showed as 2026-08-04 holding `_triageDeleted: 19` on its day_root while the
//      same day's state carried `deleted_items: 0` and a full 21-item open list,
//      last written by "scheduled-task".
//
// So suppression cannot live in the day state at all: the sweep owns that section
// and replaces it. It lives in its own dateless rows instead
// (type="block", properties.kind="triage_suppression"), which are workspace-scoped,
// survive every publish, and belong to no single date. The read path
// (buildDayResponse) and the write path (the ingest merge) both apply them, so a
// re-emitted item is stripped whether it arrives from the sweep or from a stale
// mirror.
//
// Pure module, no DB or express imports, so the tests can require() it under plain
// node the way dcc-intelligence.js's do.

const SUPPRESSION_KIND = "triage_suppression";

// The identity of a triage item, and it MUST stay byte-identical to the key
// mergeOpenItems builds — a suppression that keys differently than the merge does
// is a suppression that never matches. dcc-intelligence.js imports this rather
// than keeping its own copy, which is the only reason the two can't drift.
//
// Note what live items actually carry: prod open_items have `id` and `type` and NO
// `source`/`source_id` at all (e.g. {id: "gmail:19f3d0b61ba384a8", type: "email"}),
// so the real-world key is "email|gmail:19f3d0b61ba384a8". The source/source_id
// arms are for reader output that has been through normalizeTriageItem.
function triageItemKey(item) {
  if (!item) return "";
  const source = item.source || item.type || "unknown";
  const id = item.source_id || item.id || item.title || "";
  return `${source}|${id}`;
}

// A suppression matches an item on EITHER the composite key or the bare id.
// Belt and braces on purpose: the composite key is what the merge dedupes on, but
// it is built from fields the sweep controls, and a reader that starts emitting
// `source` where it used to emit only `type` would silently change every key and
// resurrect the entire backlog. The bare id is the client's handle and is stable
// across that change.
function suppressionIndex(suppressions) {
  const keys = new Set();
  const ids = new Set();
  for (const s of suppressions || []) {
    if (!s) continue;
    if (s.key) keys.add(s.key);
    if (s.triage_id) ids.add(s.triage_id);
  }
  return { keys, ids };
}

function isSuppressed(item, index) {
  if (!item || !index) return false;
  if (index.ids.size && item.id && index.ids.has(item.id)) return true;
  return index.keys.size > 0 && index.keys.has(triageItemKey(item));
}

// Strip suppressed items out of a triage section and hand back what was stripped.
//
// `suppressed_items` rides along because the client still has to render the
// "Completed" list and offer Undo, and it can no longer derive that from
// open_items — the whole point is that a handled item is gone from open_items on
// every device. Returns a NEW object; the caller's triage is not mutated.
function applyTriageSuppressions(triage, suppressions) {
  const base = triage && typeof triage === "object" ? triage : {};
  const list = Array.isArray(suppressions) ? suppressions : [];
  if (!list.length) return { ...base, suppressed_items: [] };
  const index = suppressionIndex(list);
  const openItems = Array.isArray(base.open_items) ? base.open_items : [];
  return {
    ...base,
    open_items: openItems.filter((item) => !isSuppressed(item, index)),
    suppressed_items: list,
  };
}

// Shape a suppression row for storage. `title` is deliberately NOT stored under a
// `title` property: these are dateless type="block" rows, and TaskModel's
// selectUnscheduled treats a dateless titled block as BACKLOG WORK. Storing the
// title as `title` would file every handled triage item into Drake's backlog. It
// goes in `itemTitle`, which no selector reads.
function buildSuppressionProperties({ triageId, key, itemTitle, reason, note, at }) {
  return {
    kind: SUPPRESSION_KIND,
    triage_id: triageId || "",
    key: key || "",
    itemTitle: itemTitle || "",
    reason: reason === "deleted" ? "deleted" : "done",
    note: note || "",
    at: at || new Date().toISOString(),
  };
}

// Read side: turn stored blocks back into the flat records the state section and
// the client both speak.
function suppressionFromBlock(block) {
  if (!block) return null;
  const p = block.properties || {};
  if (p.kind !== SUPPRESSION_KIND) return null;
  return {
    block_id: block.id,
    triage_id: p.triage_id || "",
    key: p.key || "",
    title: p.itemTitle || "",
    reason: p.reason || "done",
    note: p.note || "",
    at: p.at || block.created_at || "",
  };
}

function suppressionsFromBlocks(blocks) {
  return (blocks || []).map(suppressionFromBlock).filter(Boolean);
}

module.exports = {
  SUPPRESSION_KIND,
  triageItemKey,
  suppressionIndex,
  isSuppressed,
  applyTriageSuppressions,
  buildSuppressionProperties,
  suppressionFromBlock,
  suppressionsFromBlocks,
};
