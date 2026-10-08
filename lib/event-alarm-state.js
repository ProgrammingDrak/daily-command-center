// Authenticated read-only provenance: an unknown/missing event is not a cancellation.
module.exports = async function eventAlarmState(db, assertOwnership, id, workspaceId) {
  const block = await db.getBlockIncludingDeleted(id);
  if (!block) return null;
  try { assertOwnership(block, workspaceId); } catch { return null; }
  return block;
};
