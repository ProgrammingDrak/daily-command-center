-- 004_one_sort_space.sql — renumber `sort_order` into ONE 1000-spaced space per (date, workspace).
--
-- @gated: REWRITES sort_order on every live task row. Read the whole header, take a backup, then
-- @gated: `npm run migrate -- --only 004_one_sort_space.sql`. This is the one migration in the
-- @gated: project that overwrites existing ordering data rather than adding to it.
--
-- ╔═══════════════════════════════════════════════════════════════════════════════════╗
-- ║  WHY A REWRITE IS THE SAFE OPTION HERE, WHICH IS BACKWARDS FROM USUAL             ║
-- ║                                                                                    ║
-- ║  Measured on prod before this phase, over 1815 live task rows:                      ║
-- ║    231   positive multiple of 1000   <- a DRAG (schedule.js _writeRowOrder)          ║
-- ║    1005  in 1..1439, not 1000-aligned <- db.js createItineraryTask's derivedSort,    ║
-- ║                                          i.e. MINUTES OF DAY, not an order          ║
-- ║    289   exactly 0                    <- db.js/block-store.js createBlock's default  ║
-- ║    290   other                        <- mixed history                              ║
-- ║  and **63 of 113 days held a mix of these.**                                        ║
-- ║                                                                                    ║
-- ║  So the column is not currently an order at all: it is three unrelated numbering    ║
-- ║  schemes sharing one field. Preserving it preserves nonsense. C6b measured this and ║
-- ║  refused to flip the read on top of it, which is why C6c exists.                    ║
-- ║                                                                                    ║
-- ║  This migration and the five producer fixes that ship with it (db.js createBlock,   ║
-- ║  createItineraryTask, rescheduleBlocks, updateBlock; block-store.js createBlock) are ║
-- ║  what make `sort_order` mean one thing.                                              ║
-- ║                                                                                    ║
-- ║  ★ APPLY THIS *BEFORE* DEPLOYING THE CLIENT. The read flip is NOT tolerant of this   ║
-- ║  file not having run -- the overlay fallback only fires when a day has zero          ║
-- ║  orderable rows, so an un-migrated day would read the mixed column and the first     ║
-- ║  drag would prune the overlay that held the real order. The other direction is safe  ║
-- ║  and needs no code: the OLD client reads the overlay and merely dual-writes          ║
-- ║  `sort_order`, so renumbering underneath it is invisible.                            ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHERE THE ORDER COMES FROM, in priority order per day:
--
--   1. `day_root._taskOrder` position, when that day has one and the row is named in it.
--      This is THE USER'S REAL INTENT: it is the list a drag wrote and the list the client has
--      been reading as the authority all along. 41 day_roots carry it, 769 ids, in TWO id spaces
--      (247 row ids, 495 local_ids, 73 resolving to nothing) -- both spaces are resolved here.
--   2. the row's existing `sort_order`, for a row that day's overlay does not name.
--   3. `created_at`, then `id`, as the final tie-break so the result is deterministic and a
--      re-run cannot shuffle equal rows.
--
-- Subtask siblings are ordered by `_subtaskOrder` inside the same pass where it exists (3
-- day_roots, 7 entries per 001's notes), by falling back to the same rule -- a subtask that the
-- parent's list names inherits its position through rule 1 the same way a top-level row does.
--
-- Idempotent: a second run recomputes the identical numbering from the same inputs and the
-- `WHERE sort_order <> new` guard makes it write 0 rows.
-- Non-destructive to the OVERLAYS: `_taskOrder` / `_unscheduledOrder` / `_subtaskOrder` are left in
-- place. A4 removes them with the `_done` and pin/lock keys.
-- Touches no ledger table. Verify `slot_point_ledger` row count + sum(delta) byte-identical across
-- the apply -- that is a canary, not a hope.

-- No BEGIN/COMMIT: scripts/migrate.js wraps each migration in one transaction.

-- ── the day_root order overlays, both id spaces resolved to a row ────────────────────────
WITH overlay AS (
  SELECT dr.date,
         dr.workspace_id,
         e.ev_id,
         e.pos
  FROM blocks dr
  CROSS JOIN LATERAL (
    -- SRF expanded in FROM, never inside a CASE scalar subquery: that form raises
    -- "more than one row returned by a subquery used as an expression" for >= 2 entries and
    -- silently returns only the first for exactly 1. C6b shipped that bug into review.
    SELECT t.ev_id, t.ord AS pos
      FROM jsonb_array_elements_text(dr.properties -> '_taskOrder')
             WITH ORDINALITY AS t(ev_id, ord)
     WHERE jsonb_typeof(dr.properties -> '_taskOrder') = 'array'
  ) e
  WHERE dr.type = 'day_root'
    AND dr.deleted_at IS NULL
    AND dr.properties ? '_taskOrder'
),
-- One row per (block, position). A block can match an overlay entry by local_id OR by row id;
-- DISTINCT ON keeps the LOWEST position, so an id named twice takes its earliest slot.
resolved AS (
  SELECT DISTINCT ON (b.id) b.id AS block_id, o.pos
  FROM overlay o
  JOIN blocks b
    ON b.deleted_at IS NULL
   AND b.type IN ('block', 'added_task')
   AND b.date IS NOT DISTINCT FROM o.date
   AND b.workspace_id IS NOT DISTINCT FROM o.workspace_id
   AND (b.properties ->> 'local_id' = o.ev_id OR b.id::text = o.ev_id)
  WHERE dcc_is_task_row(b.type, b.properties)
  ORDER BY b.id, o.pos
),
-- Every live task row, numbered within its own (date, workspace) space.
-- Rule 1 (overlay position) sorts ahead of rule 2 (existing sort_order) via the NULL-last flag.
numbered AS (
  SELECT b.id AS block_id,
         (ROW_NUMBER() OVER (
            PARTITION BY b.date, b.workspace_id
            ORDER BY (r.pos IS NULL),          -- overlay-named rows first
                     r.pos,                     -- ...in their overlay order
                     b.sort_order,              -- then by whatever the column already said
                     b.created_at,               -- deterministic tie-breaks
                     b.id
          )) * 1000 AS new_sort
  FROM blocks b
  LEFT JOIN resolved r ON r.block_id = b.id
  WHERE b.deleted_at IS NULL
    AND b.type IN ('block', 'added_task')
    AND dcc_is_task_row(b.type, b.properties)
)
UPDATE blocks b
   SET sort_order = n.new_sort,
       updated_at = now()
  FROM numbered n
 WHERE b.id = n.block_id
   -- Idempotency AND a smaller write: skip a row that is already correct.
   AND b.sort_order IS DISTINCT FROM n.new_sort;
