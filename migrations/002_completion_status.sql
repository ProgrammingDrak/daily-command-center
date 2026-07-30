-- 002_completion_status.sql — move completion onto the task row.
--
-- ╔═══════════════════════════════════════════════════════════════════════════════╗
-- ║  TWO GATES. C0 CLEARS THE FIRST. THE SECOND IS STILL OPEN.                      ║
-- ║                                                                                ║
-- ║  GATE 1 — rendering. CLEARED by Phase C0 (#257, squash 14b9ba2, deployed        ║
-- ║  2026-07-30). Before C0, persistence.js read                                   ║
-- ║    if(p.status==="deleted"||p.status==="archived"||p.status==="done")           ║
-- ║      return false;                                                             ║
-- ║  so status='done' dropped a row out of the itinerary fold entirely and it       ║
-- ║  rendered neither as done nor as open. Running this before C0 reproduced that   ║
-- ║  bug 240 times. C0 removed 'done' from the list and added a dateless-done       ║
-- ║  guard, so the render side is now safe.                                        ║
-- ║                                                                                ║
-- ║  GATE 2 — POINTS. STILL OPEN. This is the one that matters now.                 ║
-- ║  slots.js reconcileCompletedTaskCredits runs on every `dcc:data-ready` and      ║
-- ║  calls earnTaskCredit for EVERY done task in the fold, keyed                    ║
-- ║  `<viewed date>:<local_id || block.id>`. C0 verified that is a no-op for        ║
-- ║  SERVER-completed rows, because those were already credited under that same     ║
-- ║  key. The rows THIS migration marks done are a different population: they were ║
-- ║  completed through day_root._done, and some were never credited at all.        ║
-- ║                                                                                ║
-- ║  Measured on a restore of prod (001 + 002 applied, 2026-07-30): of 255 rows     ║
-- ║  this migration newly marks done and dates, 243 already have that exact ledger  ║
-- ║  key (no-op) and **12 DO NOT — the reconciler would credit them on the next     ║
-- ║  page load**. Four are meetings carrying 8/30/30/30 stamped points; the rest    ║
-- ║  are 0-stamped but earnTaskCredit RECOMPUTES via scoreTaskPoints, so the real   ║
-- ║  award is not knowable from the stamp. Retroactive points for work finished in  ║
-- ║  May, June and July.                                                           ║
-- ║                                                                                ║
-- ║  To clear gate 2, ONE of:                                                      ║
-- ║   (a) C5 makes the credit path consult both key spaces before crediting — A1    ║
-- ║       left the row-id form in metadata.canonical_source_key for exactly this;   ║
-- ║   (b) pre-stamp the 12 missing ledger keys with delta 0 so ON CONFLICT fires;   ║
-- ║   (c) Drake decides ~100+ retroactive points are acceptable and says so.        ║
-- ║                                                                                ║
-- ║  Re-measure before running; the number moves as tasks are completed. The query  ║
-- ║  is in handoffs/phase-A1-complete.md.                                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════════╝
--
-- @gated: GATE 1 (rendering) cleared by C0 #257. GATE 2 (points) STILL OPEN: slots.js reconcileCompletedTaskCredits credits every done task in the fold on each dcc:data-ready, and 12 of the rows this marks done have no matching ledger key, so they would be credited retroactively (4 meetings alone = 98 stamped pts, and scoring is recomputed). Clear it via C5's both-key-space check, or a delta-0 pre-stamp, or an explicit decision from Drake. Re-measure first.
--
-- Split out of 001 because 001's contract is zero behavior change and this step
-- cannot honor it on its own. Everything here was written and verified as part of
-- Phase A1; only the timing moved.
--
-- Both steps are idempotent and re-runnable, same discipline as 001.

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1 — row-level completion signals collapse to status='done'
--
-- done/completed/completedAt already live ON the row for the paths that write them
-- (routes/dcc.js quick-task, routes/slack-events.js). This only normalizes the
-- spelling. completedAt falls back to the row's updated_at, an honest approximation,
-- rather than now(), which would claim every historical completion happened during
-- the migration.
-- ─────────────────────────────────────────────────────────────────────────────
DO $step1$
DECLARE n integer;
BEGIN
  UPDATE blocks
     SET properties = properties
           || jsonb_build_object('status', 'done')
           || jsonb_build_object('completedAt', COALESCE(
                properties->>'completedAt',
                properties->>'doneAt',
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
         updated_at = now()
   WHERE COALESCE(properties->>'status', '') <> 'done'
     AND dcc_is_task_row(type, properties)
     AND ( properties->>'done' = 'true'
        OR properties->>'completed' = 'true'
        OR properties->>'completedAt' IS NOT NULL );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'c002.step1.status_done=%', n;
END $step1$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2 — day_root._done.ids / ._done.at -> row status='done' + completedAt
--
-- This is the large population (268 rows on prod), because itinerary completion is
-- persisted ONLY to day_root.properties._done and never onto the task row: four
-- separate UI paths write the overlay (schedule.js toggleDone, sync.js saveDoneState,
-- and two more), and none of them touch the row.
--
-- Every day_root key is LEFT IN PLACE. Nothing is destroyed until A4, and that is
-- what keeps this revertible.
-- ─────────────────────────────────────────────────────────────────────────────
DO $step2$
DECLARE n integer;
BEGIN
  CREATE TEMP TABLE _ov_done ON COMMIT DROP AS
  SELECT dcc_resolve_local_id(r.workspace_id, r.date, e.lid) AS block_id,
         dcc_count_local_id_candidates(r.workspace_id, r.date, e.lid) AS cands,
         r.date AS overlay_date,
         r.properties->'_done'->'at'->>e.lid AS done_at,
         e.lid AS local_id
    FROM blocks r
    CROSS JOIN LATERAL jsonb_array_elements_text(r.properties->'_done'->'ids') AS e(lid)
   WHERE r.type = 'day_root'
     AND jsonb_typeof(r.properties->'_done'->'ids') = 'array';

  -- Date-scoped, same rule as 001's step 5b: _done is a PER-DAY fact and the resolver's
  -- tier 1 matches on row id with no date predicate, so without this a completion
  -- recorded on day X could mark a row that lives on day Y as done.
  UPDATE blocks b
     SET properties = b.properties
           || jsonb_build_object('status', 'done')
           || jsonb_build_object('completedAt', COALESCE(
                b.properties->>'completedAt', o.done_at,
                to_char(b.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
         updated_at = now()
    FROM _ov_done o
   WHERE b.id = o.block_id
     AND (b.date IS NOT DISTINCT FROM o.overlay_date OR b.date IS NULL)
     AND COALESCE(b.properties->>'status', '') <> 'done';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'c002.step2.done_applied=%', n;
  -- Split because the two mean opposite things: no candidate row at all is a dead
  -- overlay entry (harmless), while 2+ candidates is a live local_id collision the
  -- resolver refused to guess at.
  RAISE NOTICE 'c002.step2.done_no_row=%', (SELECT count(*) FROM _ov_done WHERE cands = 0);
  RAISE NOTICE 'c002.step2.done_ambiguous=%',
    (SELECT count(*) FROM _ov_done WHERE cands > 1 AND block_id IS NULL);
END $step2$;
