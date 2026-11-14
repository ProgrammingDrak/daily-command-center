// A validator for the private browser projection, independent of the command revision.
const { createHmac, randomBytes } = require("node:crypto");
const { fail } = require("./conversation-model");
const localSecret = randomBytes(32);
// The delta-sync cursor is pruned, omits queue-only tables and can hide a
// late commit with a lower sequence. Read MVCC identities of the actual input
// rows instead. Include IDs so deletes/moves also change the result.
const READ_VERSION_SQL = `
  WITH rotation AS MATERIALIZED (
    SELECT state, xmin::text AS version FROM work_rotations
    WHERE user_id=$1 AND workspace_id=$2
  ), queue_ids AS MATERIALIZED (
    SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(state->'order')='array'
      AND state->'version'='2'::jsonb THEN state->'order' ELSE '[]'::jsonb END) AS id FROM rotation
    UNION
    SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(state->'background')='object'
      AND state->'version' IS DISTINCT FROM '2'::jsonb THEN state->'background' ELSE '{}'::jsonb END) FROM rotation
    UNION
    SELECT task_id FROM conversation_background WHERE user_id=$1 AND workspace_id=$2
      AND NOT EXISTS (SELECT 1 FROM rotation WHERE state->'version'='2'::jsonb)
    UNION
    SELECT id FROM blocks
      WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL
        AND properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties)
  ), current_tasks AS MATERIALIZED (
    SELECT b.id, b.date, b.properties->>'local_id' AS local_id, b.xmin::text AS version
    FROM queue_ids JOIN blocks b USING(id)
    WHERE b.user_id=$1 AND b.workspace_id=$2 AND b.deleted_at IS NULL
  ), other_breaks AS MATERIALIZED (
    SELECT b.id, b.workspace_id, b.date, b.xmin::text AS version, w.xmin::text AS rotation_version
    FROM work_rotations w
    CROSS JOIN LATERAL jsonb_each(COALESCE(w.state->'items','{}'::jsonb)) item
    JOIN blocks b ON b.id=item.key AND b.user_id=w.user_id AND b.workspace_id=w.workspace_id
    WHERE w.user_id=$1 AND w.workspace_id<>$2 AND b.deleted_at IS NULL
      AND item.value->>'status'='foreground' AND item.value ? 'breakStartedAt'
  ), versions(kind, id, version) AS (
    SELECT 'rotation', '', version FROM rotation
    UNION ALL SELECT 'revision', '', revision::text FROM conversation_state WHERE user_id=$1
    UNION ALL SELECT 'legacy', task_id, xmin::text FROM conversation_background
      WHERE user_id=$1 AND workspace_id=$2
        AND NOT EXISTS (SELECT 1 FROM rotation WHERE state->'version'='2'::jsonb)
    UNION ALL SELECT 'task', id, version FROM current_tasks
    UNION ALL SELECT 'active', id, xmin::text FROM blocks
      WHERE user_id=$1 AND workspace_id IS DISTINCT FROM $2 AND deleted_at IS NULL
        AND properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties)
    UNION ALL SELECT 'break', id, version || ':' || rotation_version FROM other_breaks
    UNION ALL SELECT 'day', d.id, d.xmin::text FROM blocks d
      WHERE d.user_id=$1 AND d.type='day_root' AND d.deleted_at IS NULL
        AND ((d.workspace_id=$2 AND d.date IN (SELECT date FROM current_tasks))
          OR EXISTS (SELECT 1 FROM other_breaks b WHERE b.workspace_id=d.workspace_id AND b.date=d.date))
    UNION ALL SELECT 'session', b.id, b.xmin::text FROM blocks b
      WHERE b.user_id=$1 AND b.workspace_id=$2 AND b.type='time_entry' AND b.deleted_at IS NULL
        AND b.properties->>'blockId' IN (SELECT id FROM current_tasks UNION SELECT local_id FROM current_tasks)
    UNION ALL SELECT 'report', d.work_key, d.xmin::text FROM delegated_work d
      WHERE d.user_id=$1 AND d.workspace_id=$2 AND d.task_id IN (SELECT id FROM current_tasks)
  )
  SELECT (
    SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(kind,id,version) ORDER BY kind,id)::text, '[]'))
    FROM versions
  ) AS fingerprint FROM workspace_members
  WHERE user_id=$1 AND workspace_id=$2 AND role='owner'
`;

async function fingerprint(q, { userId, workspaceId }) {
  const { rows } = await q.query(READ_VERSION_SQL, [userId, workspaceId]);
  if (!rows.length) throw fail("Workspace owner access required", 403);
  return rows[0].fingerprint;
}

function validator(owner, version, expiresAt, secret = localSecret) {
  const scope = JSON.stringify(["dcc-working-queue-v1", owner.userId, owner.workspaceId, version, expiresAt]);
  return expiresAt + "." + createHmac("sha256", secret).update(scope).digest("base64url");
}

function matches(owner, version, submitted, now, secret) {
  if (typeof submitted !== "string" || !/^\d{1,16}\.[\w-]{43}$/.test(submitted)) return false;
  const expiresAt = Number(submitted.split(".")[0]);
  return (!expiresAt || expiresAt > now) && validator(owner, version, expiresAt, secret) === submitted;
}

// The browser derives these transitions locally for display. Refresh the raw
// projection too, since consumers of refresh() also use server status and order.
function expires(state) {
  const now = Date.parse(state.queue.serverNow);
  let next = Infinity;
  for (const item of state.queue.items) {
    const deadlines = [item.dueAt, item.snoozedUntil];
    for (const { execution } of item.delegated) deadlines.push(execution?.observedAt, execution?.validUntil);
    for (const deadline of deadlines) {
      const at = Date.parse(deadline);
      if (at > now) next = Math.min(next, at);
    }
  }
  return Number.isFinite(next) ? next : 0;
}

module.exports = { fingerprint, validator, matches, expires };
