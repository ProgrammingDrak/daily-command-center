-- 001_canonical_model.sql — canonicalize the task model. ZERO behavior change.
--
-- Seven idempotent, re-runnable steps that move facts currently living in the
-- per-day day_root overlay and in client-space local_ids into the blocks rows
-- themselves. NOTHING reads the canonical values yet: later phases flip the read
-- paths one at a time. That is what makes this revertible — `git revert` the code
-- and the backfilled values are inert.
--
-- Requires the helper functions from pg-schema.js POST_SCHEMA_STATEMENTS:
--   dcc_is_task_row(type, properties)        — the one task-row predicate
--   dcc_resolve_local_id(ws, date, ref)      — client-space ref -> ONE row id, or NULL
-- scripts/migrate.js applies those before running any migration.
--
-- Every step RAISE NOTICEs its counts; the runner captures them into
-- schema_migrations.notes so the audit endpoint and the QA summary can quote them.
--
-- SAFETY NOTE ON deleted_at: every tombstone this migration stamps uses now(),
-- never the original (older) delete time. server.js runs purgeSoftDeleted(30) at
-- boot and daily, which HARD-deletes rows whose deleted_at is older than 30 days.
-- Backdating would hand those rows to the next purge and make this migration
-- irreversible. Migration-stamped tombstones also carry a provenance marker in
-- properties._migratedDeleteSource so they stay distinguishable from user deletes.

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1 — local_id completion. REMOVED. Do not re-add it.
--
-- The plan called for stamping `local_id = id` on every task row lacking one, as a
-- "version-skew shield" so an old client bundle keeps resolving its lookups. Two
-- findings killed it, both verified against a restore of prod:
--
-- 1. It is UNNECESSARY. The client already falls back to the row id when local_id is
--    absent. public/js/persistence.js:274 is literally
--      const taskId = p.local_id || block.id;   // API task blocks have no local_id
--    and sync.js:360/369/380 do the same. The invariant holds without writing a byte.
--
-- 2. It is NOT INERT, which is the whole premise of this phase. persistence.js:262
--    admits a row into the itinerary fold when it HAS a local_id:
--      if(!p.local_id && p.kind!=="task" && !isShell && !isMeetingBlock) return false;
--    local_id does double duty here as an identifier AND as the client's "this is a
--    task, render it" flag. Stamping it promoted 245 non-task rows into the itinerary:
--    70 meeting-prep docs, 7 transcripts, 7 recap summaries, 52 unapproved
--    proposed_action_items, 15 schedule-template rows, and 4 DATELESS rows
--    ("TV Task", "Social", "Leisure", "Work Meetings") which fold onto EVERY day
--    viewed, not just one.
--
-- Nothing downstream needs it either: steps 2, 5 and 7 RESOLVE local_ids (via
-- dcc_resolve_local_id) rather than requiring rows to carry one, and A4 can backfill
-- once the readers are gone. db.js createBlock does not stamp it at create time
-- either, for the same reason.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2 — parent_id + rel resolution
--
-- Resolve properties.subtaskOf / properties.wrapId (client-space local_ids, and in
-- newer rows already row ids) into a real parent_id edge.
--
-- IMPORTANT, and NOT what the plan assumed: parent_id today already holds the
-- row's CONTAINER, which for most itinerary tasks is its day_root. So parent_id IS
-- NULL does NOT mean "root task", either before or after this migration. A root
-- task's parent_id is its day_root id. The canonical root test is
--   parent_id IS NULL OR parent.type = 'day_root'
-- (see routes/admin-model.js -> rootPredicate, which states it once for Track C).
-- Repointing a subtask away from its day_root is safe: nothing reads "children of
-- a day_root" — every itinerary read filters on the date column, not parent_id.
--
-- The tie-break is load-bearing. dcc_resolve_local_id returns NULL on a tie, so an
-- ambiguous ref leaves parent_id alone and the row stays a root: exactly today's
-- flat behavior, never worse. Guessing would silently re-parent a real task.
-- ─────────────────────────────────────────────────────────────────────────────

-- 2a — stamp rel for every row that carries a link, INDEPENDENT of whether the
-- edge resolves. The intent ("this was a subtask") is worth keeping even when the
-- target is gone, and it makes the step idempotent on its own guard.
DO $step2a$
DECLARE n integer;
BEGIN
  UPDATE blocks
     SET properties = properties || jsonb_build_object(
           'rel', CASE WHEN properties->>'subtaskOf' IS NOT NULL
                       THEN 'subtask' ELSE 'ride_along' END),
         updated_at = now()
   WHERE properties->>'rel' IS NULL
     AND (properties->>'subtaskOf' IS NOT NULL OR properties->>'wrapId' IS NOT NULL)
     AND dcc_is_task_row(type, properties);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'step2.rel_stamped=%', n;
END $step2a$;

-- 2b — resolve the edge itself.
DO $step2b$
DECLARE n_linked integer;
BEGIN
  CREATE TEMP TABLE _p2 ON COMMIT DROP AS
  SELECT b.id AS child_id,
         COALESCE(b.properties->>'subtaskOf', b.properties->>'wrapId') AS ref,
         dcc_resolve_local_id(
           b.workspace_id, b.date,
           COALESCE(b.properties->>'subtaskOf', b.properties->>'wrapId')
         ) AS parent_id,
         dcc_count_local_id_candidates(
           b.workspace_id, b.date,
           COALESCE(b.properties->>'subtaskOf', b.properties->>'wrapId')
         ) AS cands
    FROM blocks b
    LEFT JOIN blocks p ON p.id = b.parent_id
   WHERE (b.properties->>'subtaskOf' IS NOT NULL OR b.properties->>'wrapId' IS NOT NULL)
     AND dcc_is_task_row(b.type, b.properties)
     -- "has no task-tree edge yet": unparented, or still parented to its container.
     -- Re-runs find the edge already pointing at the parent task and skip.
     AND (b.parent_id IS NULL OR p.type = 'day_root');

  UPDATE blocks b
     SET parent_id = _p2.parent_id,
         updated_at = now()
    FROM _p2
   WHERE b.id = _p2.child_id
     AND _p2.parent_id IS NOT NULL
     AND _p2.parent_id <> b.id;                 -- never self-parent
  GET DIAGNOSTICS n_linked = ROW_COUNT;

  RAISE NOTICE 'step2.parent_linked=%', n_linked;
  -- Split matters: "no_row" is a dead reference (nothing to link to, harmless);
  -- "ambiguous" is a live Date.now() collision the resolver refused to guess at.
  -- Both leave parent_id alone, so the row stays a root — today's behavior exactly.
  RAISE NOTICE 'step2.parent_no_row=%', (SELECT count(*) FROM _p2 WHERE cands = 0);
  RAISE NOTICE 'step2.parent_ambiguous=%', (SELECT count(*) FROM _p2 WHERE cands > 1 AND parent_id IS NULL);
END $step2b$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3 — cycle scrub, then validate the constraint
--
-- reschedule-subtree.test.js carries an explicit cycle case, so these exist in
-- real data. Breaking a cycle NULLs parent_id on its members, degrading them to
-- roots — again, today's behavior, never worse.
-- ─────────────────────────────────────────────────────────────────────────────
DO $step3$
DECLARE
  n_self  integer;
  n_cyc   integer;
  ids     text;
BEGIN
  UPDATE blocks SET parent_id = NULL, updated_at = now() WHERE parent_id = id;
  GET DIAGNOSTICS n_self = ROW_COUNT;
  RAISE NOTICE 'step3.self_parents_cleared=%', n_self;

  CREATE TEMP TABLE _cyc ON COMMIT DROP AS
  WITH RECURSIVE walk(start_id, node, depth, path, looped) AS (
    SELECT b.id, b.parent_id, 1, ARRAY[b.id], false
      FROM blocks b WHERE b.parent_id IS NOT NULL
    UNION ALL
    SELECT w.start_id, p.parent_id, w.depth + 1, w.path || w.node,
           p.parent_id = ANY(w.path)
      FROM walk w
      JOIN blocks p ON p.id = w.node
     WHERE NOT w.looped AND w.node IS NOT NULL AND w.depth < 64
  )
  SELECT DISTINCT start_id FROM walk WHERE looped;

  SELECT count(*), string_agg(start_id, ',') INTO n_cyc, ids FROM _cyc;
  IF COALESCE(n_cyc, 0) > 0 THEN
    UPDATE blocks SET parent_id = NULL, updated_at = now()
     WHERE id IN (SELECT start_id FROM _cyc);
    RAISE NOTICE 'step3.cycle_ids=%', ids;
  END IF;
  RAISE NOTICE 'step3.cycles_scrubbed=%', COALESCE(n_cyc, 0);
END $step3$;

-- Safe to re-run: VALIDATE on an already-validated constraint is a no-op.
ALTER TABLE blocks VALIDATE CONSTRAINT blocks_no_self_parent;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4 — status normalization
--
-- Only the three transformations the analysis calls for. The other statuses in the
-- wild (scheduled/proposed/draft/ready/active/ingested/queued/blocked) all belong
-- to proposals, pending_tasks and meeting artifacts — NOT open itinerary tasks —
-- and are deliberately left alone.
-- ─────────────────────────────────────────────────────────────────────────────

-- 4a — MOVED OUT to migrations/002_completion_status.sql. Do not re-add it here.
--
-- Collapsing done/completed/completedAt into status='done' is NOT inert:
-- public/js/persistence.js:261 is
--   if(p.status==="deleted"||p.status==="archived"||p.status==="done") return false;
-- so a row stamped status='done' is dropped from the itinerary fold ENTIRELY and
-- renders neither as done nor as open. That is exactly the bug Drake reported from
-- Slack, and Phase C0 exists to fix that line. Writing the status before C0 ships
-- would reproduce it across the archive: measured at 240 rows vanishing on a prod
-- restore. 002 carries this work and is gated on C0 being merged.

-- 4b — pending_approval is an APPROVAL state, not a lifecycle state. Moving it out
-- leaves status needing a value: 'proposed' (the convention proposed_action_item
-- already uses) keeps these rows out of idx_blocks_open. Dropping status entirely
-- would make them COALESCE to 'open' and surface unapproved proposals in carryover.
DO $step4b$
DECLARE n integer;
BEGIN
  UPDATE blocks
     SET properties = properties || jsonb_build_object('approval', 'pending', 'status', 'proposed'),
         updated_at = now()
   WHERE properties->>'status' = 'pending_approval';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'step4.approval_pending=%', n;
END $step4b$;

-- 4c — legacy status IN ('deleted','archived') becomes a real tombstone. Verified to
-- have no live writer, so this is one-time cleanup, not an ongoing path.
-- The dcc_is_task_row guard is REQUIRED, not decoration. Without it this matches every
-- block type, and 'archived' is a live user-visible state for two of the kinds that
-- predicate excludes: task groups (routes/blocks.js writes `status: incoming.status`,
-- public/js/task-groups.js filters status!=='archived', i.e. archived groups still
-- exist) and responsibilities (public/js/responsibilities.js has an archived sidebar
-- view). Both read through db functions that filter `deleted_at IS NULL`, so
-- tombstoning them removes them from the API, and purgeSoftDeleted(30) hard-DELETEs
-- them 30 days later. Zero such rows on prod today, so this is a trap rather than a
-- live bug — but --force re-runs are documented as safe, so the guard has to be here.
DO $step4c$
DECLARE n integer;
BEGIN
  UPDATE blocks
     SET deleted_at = now(),
         properties = properties || jsonb_build_object('_migratedDeleteSource', 'legacy_status'),
         updated_at = now()
   WHERE deleted_at IS NULL
     AND properties->>'status' IN ('deleted', 'archived')
     AND dcc_is_task_row(type, properties);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'step4.legacy_status_tombstoned=%', n;
END $step4c$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 5 — overlay migration. The important one.
--
-- Every day_root, every date, across the WHOLE archive. Facts that today live only
-- in day_root.properties (and are therefore invisible to any server-side query)
-- move onto the rows they describe.
--
-- EVERY day_root KEY IS LEFT IN PLACE. Nothing is destroyed until A4, and that is
-- precisely what makes Tiers 1-5 revertible.
-- ─────────────────────────────────────────────────────────────────────────────

-- 5a — MOVED OUT to migrations/002_completion_status.sql. Do not re-add it here.
-- Same reason as 4a: writing status='done' drops the row out of the itinerary fold
-- until Phase C0 lands. This was the large population (268 rows on prod), because
-- itinerary completion normally persists ONLY to day_root._done and never onto the
-- task row, so those rows carry no status today.

-- 5b — _deleted[] -> deleted_at (now(); see the purge note at the top of this file)
--
-- The two failure modes are reported separately and both are STABLE across re-runs.
-- "no_row" means nothing anywhere carries that local_id — the task predates row
-- storage or was hard-purged, so the overlay entry describes something that cannot
-- be deleted. "ambiguous" means a live local_id collision the resolver refused to
-- guess at. Counting them together would hide the only one worth acting on.
-- DATE SCOPING IS REQUIRED HERE, and it is not the same rule as step 2's.
-- `_deleted` is a PER-DAY fact: the client only hides a row when the id appears in the
-- overlay of the day being VIEWED. But dcc_resolve_local_id's tier 1 (`x.id = p_ref`)
-- matches on row id with no date predicate, so a delete recorded on day X can resolve
-- to a row dated Y and tombstone it — hiding a row on day Y that the user never
-- deleted there. Caught by scripts/fold-diff.mjs: 1 of 87 rows on a prod restore.
-- Accept only a row on the overlay's own date, or a DATELESS row (which folds onto
-- every day, so a delete recorded on any day unambiguously means that row).
-- Rows this refuses are reported, not guessed at.
DO $step5b$
DECLARE n integer;
BEGIN
  CREATE TEMP TABLE _ov_del ON COMMIT DROP AS
  SELECT dcc_resolve_local_id(r.workspace_id, r.date, e.lid) AS block_id,
         dcc_count_local_id_candidates(r.workspace_id, r.date, e.lid) AS cands,
         r.date AS overlay_date,
         e.lid AS local_id
    FROM blocks r
    CROSS JOIN LATERAL jsonb_array_elements_text(r.properties->'_deleted') AS e(lid)
   WHERE r.type = 'day_root'
     AND jsonb_typeof(r.properties->'_deleted') = 'array';

  UPDATE blocks b
     SET deleted_at = now(),
         properties = b.properties || jsonb_build_object('_migratedDeleteSource', 'day_root._deleted'),
         updated_at = now()
    FROM _ov_del o
   WHERE b.id = o.block_id
     AND (b.date IS NOT DISTINCT FROM o.overlay_date OR b.date IS NULL)
     AND b.deleted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'step5.deleted_applied=%', n;
  RAISE NOTICE 'step5.deleted_no_row=%', (SELECT count(*) FROM _ov_del WHERE cands = 0);
  RAISE NOTICE 'step5.deleted_ambiguous=%', (SELECT count(*) FROM _ov_del WHERE cands > 1 AND block_id IS NULL);
  RAISE NOTICE 'step5.deleted_wrong_date_refused=%', (
    SELECT count(*) FROM _ov_del o JOIN blocks b ON b.id = o.block_id
     WHERE b.date IS NOT NULL AND b.date IS DISTINCT FROM o.overlay_date);
END $step5b$;

-- 5c — backlog_deleted tombstone rows -> soft-delete the backlog row they mark.
-- The tombstone is only retired when a target was actually found: an orphan
-- tombstone is the ONLY remaining record that the item was deleted, and dropping it
-- would let a localStorage-backed backlog item reappear.
DO $step5c$
DECLARE n_target integer; n_tomb integer;
BEGIN
  UPDATE blocks b
     SET deleted_at = now(),
         properties = b.properties || jsonb_build_object('_migratedDeleteSource', 'backlog_deleted'),
         updated_at = now()
    FROM blocks t
   WHERE t.properties->>'kind' = 'backlog_deleted'
     AND t.deleted_at IS NULL
     AND b.workspace_id IS NOT DISTINCT FROM t.workspace_id
     AND b.properties->>'kind' = 'backlog'
     AND b.properties->>'local_id' = t.properties->>'local_id'
     AND b.deleted_at IS NULL;
  GET DIAGNOSTICS n_target = ROW_COUNT;

  UPDATE blocks t
     SET deleted_at = now(), updated_at = now()
   WHERE t.properties->>'kind' = 'backlog_deleted'
     AND t.deleted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM blocks b
        WHERE b.workspace_id IS NOT DISTINCT FROM t.workspace_id
          AND b.properties->>'kind' = 'backlog'
          AND b.properties->>'local_id' = t.properties->>'local_id'
          AND b.deleted_at IS NOT NULL );
  GET DIAGNOSTICS n_tomb = ROW_COUNT;

  RAISE NOTICE 'step5.backlog_targets_deleted=%', n_target;
  RAISE NOTICE 'step5.backlog_tombstones_retired=%', n_tomb;
END $step5c$;

-- 5d — the three order overlays -> sort_order at (i+1)*1000, matching exactly what
-- saveTaskOrder already writes, so this is a no-op wherever the two are in sync.
--
-- All three are collapsed into ONE winner per row before anything is written. They
-- overlap — a row can sit in _taskOrder and _subtaskOrder, and two day_roots can
-- resolve the same undated row — so applying them as three sequential UPDATEs made
-- each run overwrite the last and the migration never reached a fixed point
-- (measured: 35 rows flip-flopping on every re-run). DISTINCT ON with an explicit
-- precedence makes the outcome deterministic and the second run a true no-op.
--
-- Precedence, strongest first: _subtaskOrder (order within one parent) beats
-- _unscheduledOrder (the untimed lane) beats _taskOrder (the whole-day list), then
-- the later day_root date wins, then the lower ordinal.
DO $step5d$
DECLARE n integer; raw1 integer; raw2 integer; raw3 integer;
BEGIN
  CREATE TEMP TABLE _ov_order_src ON COMMIT DROP AS
    SELECT dcc_resolve_local_id(r.workspace_id, r.date, e.lid) AS block_id,
           e.ord AS ord, 1 AS prec, r.date AS rdate
      FROM blocks r
      CROSS JOIN LATERAL jsonb_array_elements_text(r.properties->'_taskOrder')
           WITH ORDINALITY AS e(lid, ord)
     WHERE r.type = 'day_root' AND jsonb_typeof(r.properties->'_taskOrder') = 'array'
    UNION ALL
    SELECT dcc_resolve_local_id(r.workspace_id, r.date, e.lid),
           e.ord, 2, r.date
      FROM blocks r
      CROSS JOIN LATERAL jsonb_array_elements_text(r.properties->'_unscheduledOrder')
           WITH ORDINALITY AS e(lid, ord)
     WHERE r.type = 'day_root' AND jsonb_typeof(r.properties->'_unscheduledOrder') = 'array'
    UNION ALL
    SELECT dcc_resolve_local_id(r.workspace_id, r.date, e.lid),
           e.ord, 3, r.date
      FROM blocks r
      CROSS JOIN LATERAL jsonb_each(r.properties->'_subtaskOrder') AS kv(parent_lid, kids)
      CROSS JOIN LATERAL jsonb_array_elements_text(kv.kids) WITH ORDINALITY AS e(lid, ord)
     WHERE r.type = 'day_root'
       AND jsonb_typeof(r.properties->'_subtaskOrder') = 'object'
       AND jsonb_typeof(kv.kids) = 'array';

  SELECT count(*) FILTER (WHERE prec = 1 AND block_id IS NOT NULL),
         count(*) FILTER (WHERE prec = 2 AND block_id IS NOT NULL),
         count(*) FILTER (WHERE prec = 3 AND block_id IS NOT NULL)
    INTO raw1, raw2, raw3 FROM _ov_order_src;

  CREATE TEMP TABLE _ov_order ON COMMIT DROP AS
  SELECT DISTINCT ON (block_id) block_id, ord, rdate
    FROM _ov_order_src
   WHERE block_id IS NOT NULL
   ORDER BY block_id, prec DESC, rdate DESC NULLS LAST, ord ASC;

  -- Date-scoped for the same reason as 5b: an order list is a per-day fact, and the
  -- resolver's tier 1 is date-blind, so without this one day's ordering could renumber
  -- a row that lives on a different day.
  UPDATE blocks b SET sort_order = o.ord * 1000, updated_at = now()
    FROM _ov_order o
   WHERE b.id = o.block_id
     AND (b.date IS NOT DISTINCT FROM o.rdate OR b.date IS NULL)
     AND b.sort_order <> o.ord * 1000;
  GET DIAGNOSTICS n = ROW_COUNT;

  RAISE NOTICE 'step5.order_entries_task=%', raw1;
  RAISE NOTICE 'step5.order_entries_unscheduled=%', raw2;
  RAISE NOTICE 'step5.order_entries_subtask=%', raw3;
  RAISE NOTICE 'step5.order_applied=%', n;
END $step5d$;

-- 5g — _pinnedStarts { local_id: "HH:MM" } -> properties._pinnedStart
--
-- DISTINCT ON for the same reason step 5d needs it. Two day_roots can hold the same
-- resolvable key with DIFFERENT times: dcc_resolve_local_id's tier-1 branch
-- (`x.id = p_ref`) carries no date predicate, and for API-inserted rows the client's
-- task id IS the row id, so a task pinned on two dates leaves one id in two
-- _pinnedStarts maps. Without a single winner the `<> o.pinned` guard lets the UPDATE
-- alternate values forever and the migration never reaches a fixed point.
DO $step5g$
DECLARE n integer;
BEGIN
  CREATE TEMP TABLE _ov_pin ON COMMIT DROP AS
  SELECT DISTINCT ON (block_id) block_id, pinned, rdate
    FROM (
      SELECT dcc_resolve_local_id(r.workspace_id, r.date, kv.lid) AS block_id,
             kv.value AS pinned, r.date AS rdate
        FROM blocks r
        CROSS JOIN LATERAL jsonb_each_text(r.properties->'_pinnedStarts') AS kv(lid, value)
       WHERE r.type = 'day_root' AND jsonb_typeof(r.properties->'_pinnedStarts') = 'object'
    ) s
   WHERE block_id IS NOT NULL
   ORDER BY block_id, rdate DESC NULLS LAST;

  UPDATE blocks b
     SET properties = b.properties || jsonb_build_object('_pinnedStart', o.pinned),
         updated_at = now()
    FROM _ov_pin o
   WHERE b.id = o.block_id
     AND (b.date IS NOT DISTINCT FROM o.rdate OR b.date IS NULL)
     AND o.pinned IS NOT NULL
     AND COALESCE(b.properties->>'_pinnedStart', '') <> o.pinned;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'step5.pinned_starts_applied=%', n;
END $step5g$;

-- 5h — _lockedTasks [local_id] -> properties.locked
DO $step5h$
DECLARE n integer;
BEGIN
  CREATE TEMP TABLE _ov_lock ON COMMIT DROP AS
  SELECT DISTINCT dcc_resolve_local_id(r.workspace_id, r.date, e.lid) AS block_id,
         r.date AS rdate
    FROM blocks r
    CROSS JOIN LATERAL jsonb_array_elements_text(r.properties->'_lockedTasks') AS e(lid)
   WHERE r.type = 'day_root' AND jsonb_typeof(r.properties->'_lockedTasks') = 'array';

  UPDATE blocks b
     SET properties = b.properties || jsonb_build_object('locked', true),
         updated_at = now()
    FROM _ov_lock o
   WHERE b.id = o.block_id
     AND (b.date IS NOT DISTINCT FROM o.rdate OR b.date IS NULL)
     AND COALESCE((b.properties->>'locked')::boolean, false) IS DISTINCT FROM true;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'step5.locked_applied=%', n;
END $step5h$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 6 — idempotency dedupe
--
-- Soft-delete all but the OLDEST row in each duplicate (workspace_id,
-- idempotency_key) group. A3 adds the unique index a full tier later, once this has
-- run and been audited — deliberately not in the same PR as the dedupe.
-- ─────────────────────────────────────────────────────────────────────────────
DO $step6$
DECLARE n integer; g integer;
BEGIN
  SELECT count(*) INTO g FROM (
    SELECT 1 FROM blocks
     WHERE properties->>'idempotency_key' IS NOT NULL AND deleted_at IS NULL
     GROUP BY workspace_id, properties->>'idempotency_key'
    HAVING count(*) > 1) t;

  UPDATE blocks b
     SET deleted_at = now(),
         properties = b.properties || jsonb_build_object('_migratedDeleteSource', 'idempotency_dedupe'),
         updated_at = now()
   WHERE b.id IN (
     SELECT id FROM (
       SELECT id, row_number() OVER (
                PARTITION BY workspace_id, properties->>'idempotency_key'
                ORDER BY created_at ASC, id ASC) AS rn
         FROM blocks
        WHERE properties->>'idempotency_key' IS NOT NULL AND deleted_at IS NULL
     ) r WHERE r.rn > 1
   );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'step6.dupe_groups=%', COALESCE(g, 0);
  RAISE NOTICE 'step6.dupes_tombstoned=%', n;
END $step6$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 7 — points ledger canonical key, written as a SIDECAR. Not a rewrite.
--
-- slot_point_ledger has UNIQUE (workspace_id, source_type, source_key) and the credit
-- insert is ON CONFLICT DO NOTHING (slot-store.js earnTaskCredit). That conflict
-- clause is the ONLY idempotency guard on task credit. Client keys are
-- "<date>:<local_id>" (schedule.js, slots.js); server keys are already
-- "<date>:<blockId>" (routes/dcc.js, routes/slack-events.js).
--
-- The plan said to REWRITE source_key into row-id space. That is wrong while the
-- client still writes the legacy space, and it double-credits immediately rather than
-- at C5: public/js/slots.js reconcileCompletedTaskCredits re-posts the legacy
-- "<date>:<local_id>" key for every done task on init and on every `dcc:data-ready`.
-- Rewrite the stored key and that re-post finds no conflict, inserts a SECOND ledger
-- row and bumps point_balance. On page load. It is also the one destructive edit in
-- this migration: source_key is live data and a git revert cannot put it back.
--
-- So: leave source_key ALONE and record the row-id form alongside it in
-- metadata.canonical_source_key. Purely additive, revertible, and it gives C5 exactly
-- what it needs — C5 checks both spaces before crediting, which is the fix Drake
-- assigned to C5 on 2026-07-29. The audit reports coverage and the unresolved
-- remainder so C5 knows what it inherits.
-- ─────────────────────────────────────────────────────────────────────────────
DO $step7$
DECLARE n integer;
BEGIN
  CREATE TEMP TABLE _led ON COMMIT DROP AS
  SELECT l.id,
         l.workspace_id,
         l.source_type,
         split_part(l.source_key, ':', 1) AS prefix,
         substring(l.source_key from position(':' in l.source_key) + 1) AS id_half,
         -- dcc_try_date, not a shape regex: '0000-99-99' matches ^\d{4}-\d{2}-\d{2}$
         -- and then raises on the cast, which would abort this whole transaction and
         -- make the migration unappliable until someone hand-deleted the row.
         dcc_try_date(split_part(l.source_key, ':', 1)) AS key_date
    FROM slot_point_ledger l
   WHERE l.source_type = 'task_complete'
     AND position(':' in l.source_key) > 0
     -- skip keys already in row-id space; those are correct as they stand
     AND NOT EXISTS (
       SELECT 1 FROM blocks b
        WHERE b.id = substring(l.source_key from position(':' in l.source_key) + 1));

  ALTER TABLE _led ADD COLUMN new_id text;
  UPDATE _led SET new_id = dcc_resolve_local_id(workspace_id, key_date, id_half);

  UPDATE slot_point_ledger l
     SET metadata = COALESCE(l.metadata, '{}'::jsonb)
                    || jsonb_build_object('canonical_source_key', _led.prefix || ':' || _led.new_id)
    FROM _led
   WHERE l.id = _led.id
     AND _led.new_id IS NOT NULL
     AND COALESCE(l.metadata->>'canonical_source_key', '') <> _led.prefix || ':' || _led.new_id;
  GET DIAGNOSTICS n = ROW_COUNT;

  RAISE NOTICE 'step7.canonical_key_stamped=%', n;
  RAISE NOTICE 'step7.ledger_keys_unresolved=%', (SELECT count(*) FROM _led WHERE new_id IS NULL);
END $step7$;
