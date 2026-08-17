-- 005_meeting_citation_namespace.sql
-- Move transcript evidence off the task timing field names used by the itinerary.
--
-- @gated: Deploy citation-aware meeting automation before applying this migration.
-- @gated: Run `npm run migrate -- --only 005_meeting_citation_namespace.sql` after backup.
--
-- Legacy proposed_action_item rows stored transcript evidence as top-level
-- properties.start / properties.quote. `start` is a transcript offset on these rows,
-- not an HH:MM task time. Rewrite it under properties.citation so every field has one
-- meaning and old proposals cannot be mistaken for scheduled work.
--
-- No BEGIN/COMMIT: scripts/migrate.js wraps this file in one transaction.

DO $migration$
DECLARE
  migrated_proposals integer;
  migrated_tasks integer;
BEGIN
  UPDATE blocks
     SET properties = (properties - 'start' - 'quote') ||
       jsonb_build_object(
         'citation',
         jsonb_strip_nulls(jsonb_build_object(
           'startOffset', CASE
             WHEN jsonb_typeof(properties -> 'start') = 'number'
              AND (properties ->> 'start')::numeric >= 0
             THEN properties -> 'start'
             ELSE NULL
           END,
           'quote', NULLIF(btrim(properties ->> 'quote'), '')
         )) ||
         (CASE
            WHEN jsonb_typeof(properties -> 'citation') = 'object' THEN properties -> 'citation'
            ELSE '{}'::jsonb
          END)
       ),
       updated_at = now()
   WHERE properties ->> 'kind' = 'proposed_action_item'
     AND (properties ? 'start' OR properties ? 'quote');

  GET DIAGNOSTICS migrated_proposals = ROW_COUNT;
  RAISE NOTICE 'citation.proposals_migrated=%', migrated_proposals;

  -- Approved action rows carry the same evidence inside meetingSource. Their own
  -- top-level `start` is a real HH:MM itinerary time and must remain untouched.
  UPDATE blocks
     SET properties = jsonb_set(
       properties,
       '{meetingSource}',
       ((properties -> 'meetingSource') - 'start' - 'quote') ||
       jsonb_build_object(
         'citation',
         jsonb_strip_nulls(jsonb_build_object(
           'startOffset', CASE
             WHEN jsonb_typeof(properties -> 'meetingSource' -> 'start') = 'number'
              AND (properties -> 'meetingSource' ->> 'start')::numeric >= 0
             THEN properties -> 'meetingSource' -> 'start'
             ELSE NULL
           END,
           'quote', NULLIF(btrim(properties -> 'meetingSource' ->> 'quote'), '')
         )) ||
         (CASE
            WHEN jsonb_typeof(properties -> 'meetingSource' -> 'citation') = 'object'
              THEN properties -> 'meetingSource' -> 'citation'
            ELSE '{}'::jsonb
          END)
       )
     ),
     updated_at = now()
   WHERE jsonb_typeof(properties -> 'meetingSource') = 'object'
     AND ((properties -> 'meetingSource') ? 'start' OR (properties -> 'meetingSource') ? 'quote');

  GET DIAGNOSTICS migrated_tasks = ROW_COUNT;
  RAISE NOTICE 'citation.approved_tasks_migrated=%', migrated_tasks;
END
$migration$;
