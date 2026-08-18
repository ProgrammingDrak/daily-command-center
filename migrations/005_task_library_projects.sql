-- Task Library and Projects
-- Additive JSONB-backed organizational model plus durable many-to-many task edges.

BEGIN;

CREATE OR REPLACE FUNCTION dcc_is_task_row(p_type text, p_props jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p_type IS DISTINCT FROM 'day_root'
     AND p_type IS DISTINCT FROM 'time_entry'
     AND COALESCE(p_props->>'kind', '') NOT IN
         ('delegated_item', 'task_group', 'project', 'task_facet', 'task_view',
          'reschedule_tombstone', 'triage_suppression', 'slack_reaction_tombstone')
     AND (COALESCE(p_props->>'kind', '') NOT LIKE 'responsibility%'
          OR COALESCE(p_props->>'kind', '') = 'responsibility_task')
$fn$;

DROP INDEX IF EXISTS idx_blocks_task_dependency_dependent_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_task_dependency_edge
  ON blocks (workspace_id, (properties->>'blockerBlockId'), (properties->>'linkedBlockId'))
  WHERE deleted_at IS NULL
    AND type = 'block'
    AND properties->>'kind' = 'delegated_item'
    AND properties->>'blockerType' = 'task';

CREATE INDEX IF NOT EXISTS idx_blocks_project
  ON blocks (workspace_id, (properties->>'projectId'), created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_blocks_facet_values
  ON blocks USING GIN ((properties->'facetValues'))
  WHERE deleted_at IS NULL AND type = 'block';

COMMIT;
