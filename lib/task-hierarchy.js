// Database hierarchy validation uses the same edge precedence as TaskModel.
// Row and local IDs are aliases; an ambiguous local ID is never guessed.
function fail(message, status = 409) {
  const error = new Error(message);
  error.statusCode = status;
  error.publicCode = "TASK_HIERARCHY_INVALID";
  throw error;
}
function edgeOf(row) {
  const p = row.properties || {};
  return p.wrapId || p.subtaskOf || null;
}
function resolveRef(rows, ref, date, allowMissing) {
  if (!ref) return null;
  const direct = rows.find((r) => r.id === ref);
  if (direct) return direct;
  const matches = rows.filter((r) => (r.properties || {}).local_id === ref && (r.date || null) === (date || null));
  if (!matches.length && allowMissing) return null;
  if (matches.length !== 1) fail(matches.length ? "Parent task reference is ambiguous" : "Parent task is unavailable");
  return matches[0];
}
function planParentChange(existing, properties, explicitParentId, rows, date) {
  const p = { ...properties };
  if (p.wrapId && p.subtaskOf) fail("A task must have one parent relationship");
  const ref = edgeOf({ properties: p });
  if (ref && [existing.id, p.local_id, existing.properties?.local_id].filter(Boolean).includes(ref))
    fail("A task cannot be its own parent");
  let parent = ref
    ? resolveRef(rows, ref, date)
    : explicitParentId
      ? rows.find((r) => r.id === explicitParentId)
      : null;
  // Day roots are placement containers, not hierarchy relationships.
  if (parent?.type === "day_root") {
    if (ref) fail("A task parent must be a task, not a day container");
    delete p.rel;
    return { parentId: parent.id, properties: p };
  }
  if (explicitParentId && !parent) fail("Parent task is unavailable");
  if (ref && explicitParentId && parent.id !== explicitParentId) fail("Parent task references disagree");
  if (parent) {
    if (parent.id === existing.id) fail("A task cannot be its own parent");
    if ((parent.date || null) !== (date || null)) fail("Parent and child must belong to the same task pool or day");
    const index = new Map(rows.map((r) => [r.id, r])),
      seen = new Set();
    let current = parent;
    while (current) {
      if (current.id === existing.id || (p.local_id && current.properties?.local_id === p.local_id))
        fail("That parent would create a task cycle");
      if (seen.has(current.id)) fail("The parent task already belongs to a cycle");
      seen.add(current.id);
      const currentRef = edgeOf(current);
      current = currentRef ? resolveRef(rows, currentRef, current.date, true) : index.get(current.parent_id);
      if (current?.type === "day_root") break;
    }
    if (!ref) p.subtaskOf = parent.properties?.local_id || parent.id;
    p.rel = p.wrapId ? "ride_along" : "subtask";
  } else {
    p.subtaskOf = null;
    p.wrapId = null;
    delete p.rel;
  }
  return { parentId: parent?.id || null, properties: p };
}
module.exports = { edgeOf, planParentChange };
