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
// Reuse an index when inspecting many groups. Both edge spaces and local-ID
// twins remain authoritative; output order remains parent first, then pool order.
function createSubtreeCollector(dayBlocks) {
  const locals = new Map(), links = new Map(), parents = new Map();
  const add = (map, key, row) => { if (key) { if (!map.has(key)) map.set(key, []); map.get(key).push(row); } };
  for (const row of dayBlocks) {
    if (row.type === "day_root") continue;
    const p = row.properties || {};
    add(locals, p.local_id, row); add(links, p.wrapId || p.subtaskOf, row);
    if (!p.wrapId && !p.subtaskOf) add(parents, row.parent_id, row);
  }
  return parent => {
    const ids = new Set(parent && parent.id ? [parent.id] : []), localSeen = new Set(), rowSeen = new Set(), queue = [];
    const seed = row => {
      const local = (row.properties || {}).local_id;
      if (local && !localSeen.has(local)) { localSeen.add(local); queue.push(["local", local]); }
      if (row.type !== "day_root" && !rowSeen.has(row.id)) { rowSeen.add(row.id); queue.push(["row", row.id]); }
    };
    if (parent) seed(parent);
    for (let i = 0; i < queue.length; i++) {
      const [kind, key] = queue[i];
      const joined = kind === "local" ? [...(locals.get(key) || []), ...(links.get(key) || [])] : [...(parents.get(key) || []), ...(links.get(key) || [])];
      for (const row of joined) { ids.add(row.id); seed(row); }
    }
    return [...(parent && parent.id ? [parent.id] : []), ...dayBlocks.filter(row => row.id !== (parent && parent.id) && ids.has(row.id)).map(row => row.id)];
  };
}
function collectSubtreeBlockIds(dayBlocks, parent) { return createSubtreeCollector(dayBlocks)(parent); }
function findSubtreeRoots(rows) {
  const ids = new Set(rows.map(row => row.id)), locals = new Map();
  rows.forEach(row => { const local = (row.properties || {}).local_id; if (local) locals.set(local, (locals.get(local) || 0) + 1); });
  return rows.filter(row => {
    const p = row.properties || {};
    return !(p.wrapId || p.subtaskOf ? ids.has(p.wrapId || p.subtaskOf) || locals.has(p.wrapId || p.subtaskOf) : ids.has(row.parent_id)) && !(p.local_id && locals.get(p.local_id) > 1);
  });
}

// Build one same-day unplanned placement, preserving task identities and history.
function unplannedProperties(block, parentId, durations) {
  const p={...(block.properties||{})};
  const calendarOwned=["calendar","gcal"].includes(String(p.source||"").toLowerCase())||p.calendar_id||p.gcal_calendar_id;
  if(p.locked||p._locked||calendarOwned){const error=new Error("Locked or calendar-controlled tasks cannot move to Unplanned");error.statusCode=409;throw error;}
  if(block.id===parentId&&(p.completed||p.done||p.completedAt||["done","completed"].includes(p.status))){const error=new Error("Completed tasks cannot be dragged to Unplanned");error.statusCode=409;throw error;}
  const minutes=value=>{const m=/^(\d{2}):(\d{2})$/.exec(String(value||""));return m?Number(m[1])*60+Number(m[2]):null;};
  const start=minutes(p.start),end=minutes(p.end),span=start!==null&&end!==null?end-start:null;
  const requested=durations&&durations[block.id];
  const value=requested!==undefined?requested:(span>0?span:(p.duration??p.durMin??30));
  if(!Number.isFinite(value)||value<0||value>1440){const error=new Error("Invalid task duration for Unplanned");error.statusCode=400;throw error;}
  p.duration=value;p.durMin=value;
  for(const key of ["start","end","_pinnedStart","_userSetStart","userSetStart","all_day","all_day_start","all_day_end","triageBlock"])delete p[key];
  // Explicit nulls distinguish cleared placement from legacy rows missing time fields.
  p.start=null;p.end=null;
  if(p.kind==="backlog")delete p.kind;
  if(block.id===parentId){delete p.subtaskOf;delete p.wrapId;delete p.rel;}
  return p;
}
module.exports = { collectSubtreeBlockIds, createSubtreeCollector, findSubtreeRoots, unplannedProperties };
