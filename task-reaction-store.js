// One reaction ledger for owner, delegated and public-share surfaces.
// Authenticated reactions follow canonical task identity across share links.
async function set(
  client,
  { workspaceId, taskId, taskDate, title, actorUserId, actorKey, emoji, active, shareId = null }
) {
  const key = actorUserId ? "user:" + actorUserId : actorKey;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `reaction:${workspaceId}:${taskId}:${key}:${emoji}`
  ]);
  const params = [workspaceId, taskId, key, emoji];
  const existing = (
    await client.query(
      "SELECT id FROM todo_task_reactions WHERE workspace_id=$1 AND task_block_id=$2 AND actor_key=$3 AND emoji=$4",
      params
    )
  ).rows;
  const desired = active === undefined ? !existing.length : active;
  if (!desired)
    await client.query(
      "DELETE FROM todo_task_reactions WHERE workspace_id=$1 AND task_block_id=$2 AND actor_key=$3 AND emoji=$4",
      params
    );
  else if (!existing.length)
    await client.query(
      `INSERT INTO todo_task_reactions(workspace_id,share_id,task_id,task_date,task_block_id,task_title,identity_ids,emoji,actor_key,actor_user_id)
 VALUES($1,$2,$3,$4,$3,$5,$6,$7,$8,$9)`,
      [workspaceId, shareId, taskId, taskDate, title, JSON.stringify([taskId]), emoji, key, actorUserId || null]
    );
  return { emoji, active: desired };
}
async function list(client, workspaceId, taskId, actorKey) {
  return (
    await client.query(
      `SELECT emoji,COUNT(DISTINCT actor_key)::int AS count,BOOL_OR(actor_key=$3) AS mine
 FROM todo_task_reactions WHERE workspace_id=$1 AND task_block_id=$2 GROUP BY emoji`,
      [workspaceId, taskId, actorKey]
    )
  ).rows;
}
module.exports = { set, list };
