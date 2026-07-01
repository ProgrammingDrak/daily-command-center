// Pure helpers for the true-move rescheduler (POST /api/blocks/:id/reschedule).
//
// Subtasks and ride-alongs link to their parent by LOCAL id — properties.subtaskOf
// / properties.wrapId equal the parent's properties.local_id — NOT the DB parent_id
// column. So the subtree that must move with a parent is discovered by walking those
// local-id links, seeded from the parent's local_id.

// Given the origin day's task blocks and the parent block being moved, return the
// de-duped list of block ids whose `date` should change: the parent plus its whole
// nested subtree. `dayBlocks` should already be filtered to non-deleted task blocks
// (type "block" with a properties.local_id) on the origin date.
function collectSubtreeBlockIds(dayBlocks, parent) {
  const parentLocalId = (parent && parent.properties && parent.properties.local_id) || null;
  const inTree = new Set(parentLocalId ? [parentLocalId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of dayBlocks) {
      const p = b.properties || {};
      const link = p.subtaskOf || p.wrapId;
      if (link && inTree.has(link) && !inTree.has(p.local_id)) { inTree.add(p.local_id); changed = true; }
    }
  }
  const ids = [];
  const seen = new Set();
  const add = (b) => { if (b && !seen.has(b.id)) { seen.add(b.id); ids.push(b.id); } };
  add(parent); // the parent always moves, even if it somehow lacks a local_id
  for (const b of dayBlocks) if (inTree.has((b.properties || {}).local_id)) add(b);
  return ids;
}

module.exports = { collectSubtreeBlockIds };
