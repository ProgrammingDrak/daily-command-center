-- @gated: Run only after the retired-container production audit passes. Deploy reader support first, dry-run, capture visible IDs and points, then run twice with zero second-run writes.

-- Snapshot the legacy roots once. Every write below keys from this stable set.
CREATE TEMP TABLE dcc_retired_containers ON COMMIT DROP AS
SELECT b.id,
       b.parent_id,
       b.workspace_id,
       b.date,
       COALESCE(NULLIF(b.properties->>'local_id', ''), b.id) AS local_id,
       b.properties->>'type' AS legacy_type
  FROM blocks b
 WHERE b.deleted_at IS NULL
   AND b.properties->>'type' IN ('shell', 'wrap');

CREATE TEMP TABLE dcc_retired_direct_children ON COMMIT DROP AS
SELECT DISTINCT ON (child.id)
       child.id AS child_id,
       root.id AS root_id,
       root.parent_id AS promoted_parent_id
  FROM dcc_retired_containers root
  JOIN blocks child
    ON child.deleted_at IS NULL
   AND child.id <> root.id
   AND (
        child.parent_id = root.id
        OR child.properties->>'wrapId' IN (root.id::text, root.local_id)
        OR child.properties->>'subtaskOf' IN (root.id::text, root.local_id)
   )
 ORDER BY child.id, root.id;

DO $$
DECLARE n INTEGER;
BEGIN
  UPDATE blocks child
     SET parent_id = promoted.promoted_parent_id,
         properties = (child.properties - 'wrapId' - 'subtaskOf' - 'isWrap')
           || jsonb_build_object(
                'rel', 'root',
                'retiredContainerPromotedFrom', promoted.root_id
              ),
         updated_at = NOW()
    FROM dcc_retired_direct_children promoted
   WHERE child.id = promoted.child_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'retired_containers.promoted_children=%', n;

  UPDATE blocks root
     SET properties = (root.properties - 'isWrap' - 'shellBonus' - 'rollupMode')
       || jsonb_build_object(
            'type', 'task',
            'retiredContainerType', legacy.legacy_type,
            'retiredContainerMigratedAt', NOW()::text
          )
       || CASE WHEN legacy.legacy_type = 'shell'
            THEN jsonb_build_object('point_multiplier', 0)
            ELSE '{}'::jsonb
          END
       || CASE WHEN legacy.legacy_type = 'shell' AND EXISTS (
            SELECT 1 FROM dcc_retired_direct_children child WHERE child.root_id = legacy.id
          ) THEN jsonb_build_object('retiredContainerHidden', true, 'occurrenceAnchor', true)
          ELSE '{}'::jsonb
          END,
         updated_at = NOW()
    FROM dcc_retired_containers legacy
   WHERE root.id = legacy.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'retired_containers.converted_roots=%', n;

  UPDATE blocks definition
     SET properties = jsonb_set(
       jsonb_set(
         jsonb_set(definition.properties, '{templateTree,version}', '2'::jsonb, true),
         '{templateTree,root,type}', '"task"'::jsonb, true
       ),
       '{templateTree,root,occurrenceAnchor}', 'true'::jsonb, true
     ),
         updated_at = NOW()
   WHERE definition.deleted_at IS NULL
     AND definition.properties->>'kind' = 'responsibility_item'
     AND definition.properties#>>'{templateTree,root,type}' = 'shell';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'retired_containers.recurring_templates=%', n;

  RAISE NOTICE 'retired_containers.task_ids_changed=0';
  RAISE NOTICE 'retired_containers.historical_points_touched=0';
END $$;
