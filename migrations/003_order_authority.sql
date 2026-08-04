-- 003_order_authority.sql — move pins and locks off the day_root overlays onto the row.
--
-- @gated: writes properties on live task rows. Read the scope note below, then run with
-- @gated: `npm run migrate -- --only 003_order_authority.sql`. C6b's READS tolerate this not
-- @gated: having run, so a deploy that lands first loses nothing.
--
-- ╔═══════════════════════════════════════════════════════════════════════════════════╗
-- ║  WHAT THIS DOES *NOT* DO, AND WHY THAT IS THE WHOLE DESIGN                        ║
-- ║                                                                                    ║
-- ║  It does NOT touch `sort_order`.                                                   ║
-- ║                                                                                    ║
-- ║  The C6 plan and the C6b brief both read as though the three order LISTS            ║
-- ║  (`_taskOrder`, `_unscheduledOrder`, `_subtaskOrder`) still needed migrating onto   ║
-- ║  `sort_order`. Measured on a prod restore with 001 + 002 applied (2026-08-04):      ║
-- ║  migration 001 ALREADY DID IT. Its own schema_migrations.notes records              ║
-- ║  step5.order_applied 313, order_entries_task 530, order_entries_subtask 7,          ║
-- ║  order_entries_unscheduled 0, pinned_starts_applied 144, locked_applied 0. And      ║
-- ║  `sort_order IS NULL` on **0** of 1815 live task rows.                              ║
-- ║                                                                                    ║
-- ║  Since 001, `saveTaskOrder` has DUAL-WRITTEN: overlay plus `blockStore.reorder`.    ║
-- ║  So `sort_order` is not merely backfilled, it is current for every row a drag has   ║
-- ║  touched. Re-deriving it from the overlay here could only make it WORSE, because    ║
-- ║  neither side carries a timestamp -- an overlay entry older than a dual-written     ║
-- ║  `sort_order` would silently win and undo a real reorder. C6b's change for order    ║
-- ║  is therefore a READ FLIP with no data step, and this file says so out loud rather  ║
-- ║  than shipping a migration that looks thorough and quietly regresses drags.         ║
-- ║                                                                                    ║
-- ║  For the record, what the overlays still held that `sort_order` does not need:      ║
-- ║  `_taskOrder` 41 day_roots / 769 ids in TWO id spaces (247 row ids, 495 local_ids,  ║
-- ║  73 resolving to nothing); `_unscheduledOrder` 1 day_root / 7 ids (0 row ids, 3     ║
-- ║  live local_ids, 4 dead); `_subtaskOrder` 3 day_roots.                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHAT IT DOES DO: backfill the two axes that genuinely have no other source.
--
--   step1  properties._pinnedStart  <- day_root._pinnedStarts
--          64 day_roots / 178 entries; 170 resolve to a local_id, 5 to a row id, 5 to
--          nothing. 120 rows already carry the field (001 applied 144), because CREATION
--          writes it but the pin/unpin path was overlay-only. Existing row values WIN --
--          a row that already carries a pin was pinned more recently than the overlay
--          entry that names it, since creation and 001 both predate every later drag.
--
--   step2  properties.locked       <- day_root._lockedTasks
--          ZERO day_roots carry it and 001 applied 0 lock entries, so this step is a
--          proven no-op on this data. It ships anyway: the client now reads
--          `properties.locked`, and a step that runs and writes 0 rows is the only honest
--          way to say "there was nothing here" rather than assuming it.
--
-- Idempotent: both steps skip a row that already agrees, so runs 2 and 3 write 0 rows.
-- Non-destructive: the overlay keys are LEFT IN PLACE. A4 removes them, together with the
-- `_done` keys and `db.js`'s `_lockedTasks` read, which is still the server-side lock source.
--
-- The ledger must be byte-identical across this migration (row count + point total before
-- and after). It touches no ledger table, so that is a canary, not a hope.

-- No BEGIN/COMMIT: scripts/migrate.js wraps each migration in one transaction
-- (it either fully applies or leaves the DB untouched), and neither 001 nor 002 opens its
-- own. Opening one here warned twice on the first apply.

-- ── step 1: pins ──────────────────────────────────────────────────────────────────────
-- One row per (date, overlay key). `dr.date` scopes the resolution so an id that exists on
-- two days binds to the right one; the local_id join is tried first because 170 of 178
-- entries are local_ids and only 5 are row ids.
WITH pin_entries AS (
  SELECT dr.date,
         dr.workspace_id,
         e.key   AS ev_id,
         e.value AS pinned_start
  FROM blocks dr
  CROSS JOIN LATERAL jsonb_each_text(dr.properties -> '_pinnedStarts') AS e(key, value)
  WHERE dr.type = 'day_root'
    AND dr.deleted_at IS NULL
    AND dr.properties ? '_pinnedStarts'
),
resolved AS (
  SELECT DISTINCT ON (b.id) b.id AS row_id, pe.pinned_start
  FROM pin_entries pe
  JOIN blocks b
    ON b.deleted_at IS NULL
   AND b.type = 'block'
   AND b.date = pe.date
   AND b.workspace_id = pe.workspace_id
   AND (b.properties ->> 'local_id' = pe.ev_id OR b.id::text = pe.ev_id)
  WHERE dcc_is_task_row(b.type, b.properties)
    -- Existing row values win: creation and 001 both predate every later pin, so a row that
    -- already carries the field is the fresher fact.
    AND NOT (b.properties ? '_pinnedStart')
    AND pe.pinned_start IS NOT NULL
    AND pe.pinned_start <> ''
  ORDER BY b.id, pe.pinned_start
)
UPDATE blocks b
   SET properties = b.properties || jsonb_build_object('_pinnedStart', r.pinned_start),
       updated_at = now()
  FROM resolved r
 WHERE b.id = r.row_id;

-- ── step 2: locks ─────────────────────────────────────────────────────────────────────
-- `_lockedTasks` is an ARRAY on every row that has ever carried it, but db.js also accepts an
-- object map (open-tasks-query.test.js pins that), so both shapes are unnested here. Expected
-- to write 0 rows on prod; if it ever writes more, the completion summary must say so.
WITH lock_entries AS (
  SELECT dr.date, dr.workspace_id, x.ev_id
  FROM blocks dr
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN jsonb_typeof(dr.properties -> '_lockedTasks') = 'array'
               THEN (SELECT jsonb_array_elements_text(dr.properties -> '_lockedTasks'))
             WHEN jsonb_typeof(dr.properties -> '_lockedTasks') = 'object'
               THEN (SELECT jsonb_object_keys(dr.properties -> '_lockedTasks'))
             ELSE NULL
           END AS ev_id
  ) x
  WHERE dr.type = 'day_root'
    AND dr.deleted_at IS NULL
    AND dr.properties ? '_lockedTasks'
    AND x.ev_id IS NOT NULL
),
lock_resolved AS (
  SELECT DISTINCT b.id AS row_id
  FROM lock_entries le
  JOIN blocks b
    ON b.deleted_at IS NULL
   AND b.type = 'block'
   AND b.date = le.date
   AND b.workspace_id = le.workspace_id
   AND (b.properties ->> 'local_id' = le.ev_id OR b.id::text = le.ev_id)
  WHERE dcc_is_task_row(b.type, b.properties)
    AND COALESCE((b.properties ->> 'locked')::boolean, false) IS NOT TRUE
)
UPDATE blocks b
   SET properties = b.properties || jsonb_build_object('locked', true),
       updated_at = now()
  FROM lock_resolved r
 WHERE b.id = r.row_id;
