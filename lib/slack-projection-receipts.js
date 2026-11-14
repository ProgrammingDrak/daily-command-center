"use strict";

// Keep PostgreSQL timestamps and versions in PostgreSQL. A JavaScript Date
// truncates microseconds, and an updated_at watermark can skip a late commit.
const eligible = alias => `(${alias}.properties->>'source' IN
  ('slack-bookmark', 'slack-delegate', 'slack-delegate-completion')
  OR ${alias}.properties->>'kind' = 'delegated_item')`;

// Group common explicit targets once. Legacy changes conservatively invalidate
// receipts where permissive URL parsing or linked resolution could change the
// answer. The projector still determines actual target membership.
const candidatesSql = `
WITH waiting AS MATERIALIZED (
  SELECT w.id, w.deleted_at, w.xmin::text AS version,
         w.properties->>'slack_channel' AS channel, w.properties->>'slack_ts' AS ts,
         w.properties->>'linkedBlockId' AS ref,
         COALESCE(w.properties->>'slack_channel' ~ '^[CDG][A-Z0-9]+$'
           AND w.properties->>'slack_ts' ~ '^[0-9]+[.][0-9]+$', false) AS explicit,
         (w.properties->'contact'->'sourceRef' IS NOT NULL
           OR w.properties ?| ARRAY['source_id','sourceRef','source_url','slack_url','permalink']) AS has_permalink,
         linked.versions AS linked_versions
  FROM blocks w
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_array(t.id, t.xmin::text) ORDER BY t.id) AS versions
    FROM blocks t
    WHERE t.workspace_id = w.workspace_id AND t.deleted_at IS NULL
      AND (t.id = w.properties->>'linkedBlockId' OR t.properties->>'local_id' = w.properties->>'linkedBlockId')
  ) linked ON w.properties->>'linkedBlockId' IS NOT NULL
  WHERE w.workspace_id = $1 AND w.properties->>'kind' = 'delegated_item'
), explicit_targets AS (
  SELECT channel, ts,
    md5(jsonb_agg(jsonb_build_array(id, version) ORDER BY id)::text) AS version
  FROM waiting
  WHERE deleted_at IS NULL AND explicit
  GROUP BY channel, ts
), legacy_targets AS (
  SELECT
    md5(jsonb_agg(jsonb_build_array(id, version, linked_versions) ORDER BY id)
      FILTER (WHERE NOT explicit AND (has_permalink OR ref IS NOT NULL))::text) AS possible,
    md5(jsonb_agg(jsonb_build_array(id, version, linked_versions) ORDER BY id)::text) AS all_waiting
  FROM waiting
  WHERE deleted_at IS NULL
), revisions AS (
  SELECT b.id, b.updated_at,
    md5(jsonb_build_array(b.xmin::text, b.updated_at, own.linked_versions,
      exact.version, legacy.possible,
      CASE WHEN exact_coordinates.valid IS NOT TRUE THEN legacy.all_waiting END,
      markers.versions)::text) AS revision
  FROM blocks b
  LEFT JOIN waiting own ON own.id = b.id
  LEFT JOIN explicit_targets exact
    ON exact.channel = b.properties->>'slack_channel' AND exact.ts = b.properties->>'slack_ts'
  CROSS JOIN legacy_targets legacy
  CROSS JOIN LATERAL (
    SELECT b.properties->>'slack_channel' ~ '^[CDG][A-Z0-9]+$'
      AND b.properties->>'slack_ts' ~ '^[0-9]+[.][0-9]+$' AS valid
  ) exact_coordinates
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_array(d.id, d.xmin::text) ORDER BY d.id) AS versions
    FROM jsonb_array_elements_text(CASE
      WHEN jsonb_typeof(b.properties->'dependencyWaitingItemIds') = 'array'
        THEN b.properties->'dependencyWaitingItemIds'
      WHEN b.properties->>'dependencyWaitingItemId' IS NOT NULL
        THEN jsonb_build_array(b.properties->>'dependencyWaitingItemId')
      ELSE '[]'::jsonb END) AS marker(id)
    JOIN blocks d ON d.id = marker.id AND d.workspace_id = b.workspace_id
  ) markers
  WHERE b.workspace_id = $1 AND ${eligible("b")}
)
SELECT b.id, b.revision, b.updated_at::text
FROM revisions b
LEFT JOIN slack_projection_receipts r
  ON r.workspace_id = $1 AND r.actor_key = $2 AND r.block_id = b.id
WHERE r.revision IS DISTINCT FROM b.revision
   OR (r.outcome IN ('retry', 'unreachable') AND r.next_attempt_at <= clock_timestamp())
ORDER BY b.updated_at ASC, b.id ASC
LIMIT $3`;

async function recordReceipt(pool, workspace, actor, id, revision, outcome, nextAttempt = null) {
  await pool.query(`
    INSERT INTO slack_projection_receipts AS receipt
      (workspace_id, actor_key, block_id, revision, outcome, next_attempt_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (workspace_id, actor_key, block_id) DO UPDATE
    SET revision = excluded.revision, outcome = excluded.outcome,
        next_attempt_at = CASE WHEN excluded.outcome = 'cooldown'
          THEN greatest(receipt.next_attempt_at, excluded.next_attempt_at)
          ELSE excluded.next_attempt_at END
  `, [workspace, actor, id, revision, outcome, nextAttempt]);
}

module.exports = { candidatesSql, recordReceipt };
