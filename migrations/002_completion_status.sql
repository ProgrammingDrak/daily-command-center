-- 002_completion_status.sql — move completion onto the task row.
--
-- ╔═══════════════════════════════════════════════════════════════════════════════╗
-- ║  DO NOT RUN THIS UNTIL PHASE C0 IS MERGED AND DEPLOYED.                        ║
-- ║                                                                                ║
-- ║  public/js/persistence.js:261 currently reads                                  ║
-- ║    if(p.status==="deleted"||p.status==="archived"||p.status==="done")           ║
-- ║      return false;                                                             ║
-- ║  so a row carrying status='done' is dropped from the itinerary fold ENTIRELY    ║
-- ║  and renders neither as done nor as open. That is the bug Drake reported from   ║
-- ║  Slack (a ✅'d task vanishing), and Phase C0 exists to fix that exact line.     ║
-- ║                                                                                ║
-- ║  Running this first reproduces the bug across the whole archive. Measured on a  ║
-- ║  restore of prod: 240 completed tasks disappear from the itinerary.             ║
-- ║                                                                                ║
-- ║  Gate: C0 merged, deployed, and `isFoldableTask` admitting status==='done'.     ║
-- ║  Verify with scripts/fold-diff.mjs, which reports 0 vanishing rows once C0 is   ║
-- ║  in. The @gated directive below makes this mechanical: `npm run migrate` will    ║
-- ║  NOT apply this file, only an explicit --only will.                            ║
-- ╚═══════════════════════════════════════════════════════════════════════════════╝
--
-- @gated: unsafe until Phase C0 ships. persistence.js:261 drops status='done' rows out of the itinerary fold entirely, so this hides 240 completed tasks. Run scripts/fold-diff.mjs first and require 0 vanishing.
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
