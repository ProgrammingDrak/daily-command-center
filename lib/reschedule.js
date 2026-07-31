// Pure helpers for the true-move rescheduler (POST /api/blocks/:id/reschedule).
//
// A task's nesting is recorded in TWO edge spaces, and a mover that reads only one of
// them strands rows:
//
//   1. LOCAL-ID links — properties.subtaskOf / properties.wrapId hold the parent's
//      properties.local_id. This is what the client writes, and it is the complete
//      edge set today.
//   2. The parent_id COLUMN — resolved from those links by migration 001 and, since A1,
//      dual-written on every create (db.js createBlock -> resolveParentRef).
//
// Neither is a superset of the other, measured on the dcc_canon_c prod restore with 001
// applied:
//   - parent_id alone MISSES 40 rows across 26 parents. dcc_resolve_local_id returns NULL
//     on a tie and there are 28 live local_id collision groups (60 rows), so a duplicated
//     parent local_id leaves its children's edges unresolved — and the twins of the moved
//     row itself are only findable by local_id.
//   - local_id alone MISSES rows whose subtaskOf/wrapId holds a ROW ID rather than a
//     local_id (7 live; the walk matches link -> local_id only, so it cannot see them),
//     and rows with no local_id at all.
//
// So this walks BOTH and unions the result. Proven on the same restore: identical
// membership to the local-id-only walk on all 2092 candidate parents (onlyOld=0,
// onlyNew=0) — a structural superset with no behavior drift — while parent_id-only
// would have stranded those 40 rows.

// Given the origin day's task blocks and the parent block being moved, return the
// de-duped list of block ids whose `date` should change: the parent plus its whole
// nested subtree, parent FIRST (routes/blocks.js treats index 0 as the parent).
//
// `dayBlocks` should already be filtered to the origin date's task rows (see
// routes/blocks.js — `local_id || kind === "task"`, matching the itinerary fold). That
// filter is what keeps meeting artifacts (meeting_prep / meeting_summary /
// meeting_transcript / proposed_action_item — real parent_id children of a meeting, but
// not tasks) from being dragged along by the parent_id edge.
function collectSubtreeBlockIds(dayBlocks, parent) {
  const parentLocalId = (parent && parent.properties && parent.properties.local_id) || null;
  // Two frontiers, because the two edge spaces are keyed differently: links point at
  // local_ids, the column points at row ids.
  const inTree = new Set(parentLocalId ? [parentLocalId] : []);
  const rowIds = new Set(parent && parent.id ? [parent.id] : []);
  // A day_root is a container, not a task. Its children by parent_id are "every task on
  // that date", so propagating out of one would re-date the whole day. Seeding the row
  // frontier only for a non-day_root keeps that impossible here as well as at the route.
  const walkRowIds = parent && parent.type === "day_root" ? new Set() : rowIds;
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of dayBlocks) {
      if (b.type === "day_root") continue;
      const p = b.properties || {};
      const link = p.subtaskOf || p.wrapId;
      const joined =
        (link && inTree.has(link)) ||                       // nested by local-id link
        (b.parent_id && walkRowIds.has(b.parent_id)) ||     // nested by parent_id column
        (p.local_id && inTree.has(p.local_id));             // a twin sharing a tree local_id
      if (!joined) continue;
      if (p.local_id && !inTree.has(p.local_id)) { inTree.add(p.local_id); changed = true; }
      if (!rowIds.has(b.id)) { rowIds.add(b.id); changed = true; }
    }
  }
  const ids = [];
  const seen = new Set();
  const add = (b) => { if (b && !seen.has(b.id)) { seen.add(b.id); ids.push(b.id); } };
  add(parent); // the parent always moves, even if it somehow lacks a local_id
  for (const b of dayBlocks) if (inTree.has((b.properties || {}).local_id) || rowIds.has(b.id)) add(b);
  return ids;
}

module.exports = { collectSubtreeBlockIds };
