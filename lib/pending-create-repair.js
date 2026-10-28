// Narrow recovery for a retained manual subtask create, never a row overwrite.
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const day = value => value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : null;
const stamp = value => value instanceof Date ? value.toISOString() : String(value);
function payload(input) {
  const p = input?.properties;
  if (require("../waiting-items").isTaskDependency(p)) fail("Create task dependencies through the Waiting API", 409);
  if (!input || typeof input.id !== 'string' || !input.id || input.type !== 'block'
    || !p || typeof p !== 'object' || Array.isArray(p) || p.type !== 'task'
    || p.source !== 'manual' || typeof p.title !== 'string' || !p.title.trim()
    || typeof p.subtaskOf !== 'string' || !p.subtaskOf || p.wrapId
    || p.startedAt || p.workStartedAt || p.status === 'doing'
    || Number(p.duration) !== 0 || p.start !== p.end) fail('Only a pending manual subtask creation can be repaired', 400);
  if (input.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fail('Invalid pending task date', 400);
  if (input.parent_id != null && typeof input.parent_id !== 'string') fail('Invalid pending parent', 400);
  return { id: input.id, type: input.type, date: input.date ?? null, parent_id: input.parent_id ?? null,
    properties: JSON.parse(JSON.stringify(p)), ...(input.sort_order == null ? {} : { sort_order: input.sort_order }) };
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
module.exports = function createPendingRepair({ pool, blockDB }) {
  return async function repair({ original, expected, apply, userId, workspaceId }) {
    const item = payload(original);
    if (!userId || !workspaceId) fail('An authenticated task owner is required', 403);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same lock order as normal hierarchical creates; serialize parent placement
      // and identity checks with other hierarchy writers, including another tab.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dcc-task-hierarchy'), hashtext($1))", [String(workspaceId)]);
      const parent = await blockDB.findUniqueLiveBlockByReference(item.properties.subtaskOf, workspaceId, client, true);
      if (!parent || parent.workspace_id !== workspaceId || !blockDB.isTaskRow(parent) || !parent.properties?.title) fail('Parent task is unavailable', 404);
      if (parent.id === item.id || (item.parent_id && item.parent_id !== parent.id)) fail('Pending parent references disagree');
      const placement = { parentId: parent.id, date: day(parent.date), parentRevision: stamp(parent.updated_at), payloadDigest: digest(item) };
      const repaired = { ...item, parent_id: parent.id, date: placement.date };
      // The payload's content is untouched. A collision must be the same creation,
      // not a deleted/edited row or another account's row. Never revive/overwrite.
      const verify = row => {
        if (!row || row.workspace_id !== workspaceId) fail('Task is unavailable', 404);
        if (row.deleted_at || row.type !== item.type || day(row.date) !== placement.date || row.parent_id !== parent.id
          || Object.keys(item.properties).some(key => !isDeepStrictEqual(row.properties?.[key], item.properties[key]))) {
          fail('The original task already exists with different content or placement. Keep the pending copy for review.');
        }
      };
      const existing = await blockDB.getBlock(item.id, client);
      if (existing) verify(existing);
      if (!apply) {
        await client.query('COMMIT');
        return { expected: placement, parentTitle: parent.properties.title, title: item.properties.title, originalDate: item.date, alreadySaved: !!existing };
      }
      if (!isDeepStrictEqual(expected, placement)) fail('Parent or pending content changed. Review the repair again.');
      const row = existing || await blockDB.createBlock({ ...repaired, user_id: userId, workspace_id: workspaceId }, client);
      verify(row);
      await client.query('COMMIT');
      return { block: row, created: !existing && !row._resolvedExisting };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
};
