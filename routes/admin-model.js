// Canonical task model audit (Phase A1). READ-ONLY, admin session required.
//   GET /api/admin/model-audit
//
// This endpoint is the deliverable of Phase A1, not a nicety. It is the GATE that
// two later phases are blocked on:
//
//   • C2 (roots-only, server-side) must not ship until parentEdges reads clean here.
//   • C5 (one status) must not ship until ledger.recreditRisk is ZERO. That number is
//     real points: slot_point_ledger dedupes on (workspace_id, source_type,
//     source_key) with ON CONFLICT DO NOTHING, legacy keys are "<date>:<local_id>",
//     and once completion moves to row-id space the conflict clause stops firing and
//     an already-credited task credits AGAIN.
//
// Run it against PROD. A synthetic database cannot show the Date.now() local_id
// collisions that drive every "ambiguous" count below.
//
// Every count distinguishes the two failure modes, because they mean opposite things:
//   noRow      — nothing anywhere carries that reference. The task is gone (hard-purged,
//                or it only ever existed in localStorage). Nothing to fix; harmless.
//   ambiguous  — 2+ live rows share that local_id. The resolver REFUSED to guess.
//                This is the number that needs a human decision before a read flip.
// Collapsing them into one "unresolved" total hides the only one worth acting on.
const pool = require("../pg-pool");

// One SQL expression for "the id half of a ledger source_key", reused by every ledger
// query below so they cannot drift apart. Keys are "<prefix>:<id>" where prefix is a
// date, "unknown", or "shell".
const LEDGER_ID_HALF = "substring(l.source_key from position(':' in l.source_key) + 1)";
// dcc_try_date, not a shape regex. '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' admits '0000-99-99'
// and '2026-02-31', and casting either raises "date/time field value out of range" --
// which would 500 this endpoint permanently, since source_key is stored and
// caller-supplied (POST /api/slot/earn-task runs no validate() middleware).
const LEDGER_KEY_DATE = "dcc_try_date(split_part(l.source_key, ':', 1))";

async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || {};
}

async function rows(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

function nums(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === null ? null : Number(v);
  return out;
}

async function audit() {
  // ── Step 1: local_id coverage ──
  const localIds = nums(await one(`
    SELECT count(*) FILTER (WHERE properties->>'local_id' IS NULL) AS missing,
           count(*) FILTER (WHERE properties->>'local_id' = id)    AS canonical,
           count(*) FILTER (WHERE properties->>'local_id' IS NOT NULL
                              AND properties->>'local_id' <> id)   AS legacy
      FROM blocks WHERE dcc_is_task_row(type, properties)`));

  // ── Step 2: parent edges ──
  // "root" is NOT `parent_id IS NULL` — see rootPredicate below.
  //
  // Every CTE that calls dcc_resolve_local_id / dcc_count_local_id_candidates is
  // MATERIALIZED on purpose. Both are inlinable SQL functions, so without the fence
  // the planner re-expands them inside each `count(*) FILTER (...)` and the query
  // stops returning (measured: >60s vs ~50ms). Resolve once per row, then aggregate.
  const parentEdges = nums(await one(`
    WITH linked AS MATERIALIZED (
      SELECT b.id, b.workspace_id, b.date,
             COALESCE(b.properties->>'subtaskOf', b.properties->>'wrapId') AS ref,
             b.parent_id, p.type AS parent_type
        FROM blocks b
        LEFT JOIN blocks p ON p.id = b.parent_id
       WHERE (b.properties->>'subtaskOf' IS NOT NULL OR b.properties->>'wrapId' IS NOT NULL)
         AND dcc_is_task_row(b.type, b.properties)
    ), res AS MATERIALIZED (
      SELECT linked.*,
             (parent_id IS NOT NULL AND parent_type <> 'day_root') AS has_edge,
             dcc_count_local_id_candidates(workspace_id, date, ref) AS cands,
             dcc_resolve_local_id(workspace_id, date, ref) AS resolved_to
        FROM linked
    )
    SELECT count(*) AS refs_total,
           count(*) FILTER (WHERE has_edge) AS resolved,
           count(*) FILTER (WHERE NOT has_edge AND cands = 0) AS no_row,
           count(*) FILTER (WHERE NOT has_edge AND cands > 1 AND resolved_to IS NULL) AS ambiguous
      FROM res`));

  // ── Step 3: cycles and self-parents (both must be zero after the scrub) ──
  const integrity = nums(await one(`
    WITH RECURSIVE walk(start_id, node, depth, path, looped) AS (
      SELECT b.id, b.parent_id, 1, ARRAY[b.id], false
        FROM blocks b WHERE b.parent_id IS NOT NULL
      UNION ALL
      SELECT w.start_id, p.parent_id, w.depth + 1, w.path || w.node, p.parent_id = ANY(w.path)
        FROM walk w JOIN blocks p ON p.id = w.node
       WHERE NOT w.looped AND w.node IS NOT NULL AND w.depth < 64
    )
    SELECT (SELECT count(*) FROM blocks WHERE parent_id = id) AS self_parents,
           (SELECT count(DISTINCT start_id) FROM walk WHERE looped) AS rows_in_cycles,
           (SELECT count(*) FROM blocks b
             WHERE b.parent_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id)) AS dangling_parents`));

  // ── Step 4: status distribution ──
  const { rows: statusRows } = await pool.query(`
    SELECT COALESCE(properties->>'status', '(none)') AS status, count(*)::int AS n
      FROM blocks WHERE dcc_is_task_row(type, properties)
     GROUP BY 1 ORDER BY 2 DESC`);
  const statusDistribution = Object.fromEntries(statusRows.map((r) => [r.status, r.n]));

  const completion = nums(await one(`
    SELECT count(*) FILTER (WHERE properties->>'status' = 'done') AS status_done,
           count(*) FILTER (WHERE properties->>'status' = 'done'
                              AND properties->>'completedAt' IS NULL) AS done_without_timestamp,
           count(*) FILTER (WHERE properties->>'status' <> 'done'
                              AND (properties->>'done' = 'true'
                                OR properties->>'completed' = 'true'
                                OR properties->>'completedAt' IS NOT NULL)) AS unnormalized_done,
           count(*) FILTER (WHERE properties->>'status' = 'pending_approval') AS pending_approval_left
      FROM blocks WHERE dcc_is_task_row(type, properties)`));

  // ── Step 5: overlay residue. Every day_root key is deliberately LEFT IN PLACE
  // until A4, so these are "does the overlay still say something the rows don't?" ──
  // `not_applied` is the one that matters day to day: the overlay still asserts
  // something the row does not, i.e. a fact the migration could not carry over.
  // `wrong_date` counts entries the migration DELIBERATELY refuses: the overlay is a
  // per-day fact, but the resolver's tier 1 matches on row id with no date predicate,
  // so an entry on day X can resolve to a row dated Y. Applying it would hide or
  // complete a row on a day the user never touched. Those are excluded from
  // not_applied, or a correct refusal would read as an incomplete migration.
  const DATE_SCOPED = "(b.date IS NOT DISTINCT FROM res.date OR b.date IS NULL)";
  const overlaySql = (jsonPath, appliedTest) => `
    WITH e AS MATERIALIZED (
      SELECT r.workspace_id, r.date, x.lid
        FROM blocks r
        CROSS JOIN LATERAL jsonb_array_elements_text(r.properties${jsonPath}) AS x(lid)
       WHERE r.type = 'day_root' AND jsonb_typeof(r.properties${jsonPath}) = 'array'
    ), res AS MATERIALIZED (
      SELECT e.*,
             dcc_resolve_local_id(e.workspace_id, e.date, e.lid) AS bid,
             dcc_count_local_id_candidates(e.workspace_id, e.date, e.lid) AS cands
        FROM e
    )
    SELECT count(*) AS entries,
           count(*) FILTER (WHERE cands = 0) AS no_row,
           count(*) FILTER (WHERE cands > 1 AND bid IS NULL) AS ambiguous,
           count(*) FILTER (WHERE bid IS NOT NULL AND NOT ${DATE_SCOPED}) AS wrong_date,
           count(*) FILTER (WHERE bid IS NOT NULL AND ${DATE_SCOPED}
                              AND NOT (${appliedTest})) AS not_applied
      FROM res LEFT JOIN blocks b ON b.id = res.bid`;

  // COALESCE, not a bare comparison. With `b.properties->>'status' = 'done'` a row
  // carrying NO status key yields NULL, `NOT NULL` is NULL, and a FILTER excludes
  // anything that is not TRUE -- so the rows this check exists to catch (overlay says
  // done, row says nothing) counted as zero. 1844 of ~3100 task rows on prod carry no
  // status at all, i.e. the blindness covered the dominant row shape. The migration
  // always used the COALESCE form; this aligns the audit with it.
  const overlayDone = nums(await one(
    overlaySql("->'_done'->'ids'", "COALESCE(b.properties->>'status', '') = 'done'")));
  const overlayDeleted = nums(await one(
    overlaySql("->'_deleted'", "b.deleted_at IS NOT NULL")));

  // ── Step 6: idempotency dupes. Counted BOTH ways on purpose. `anyState` is what
  // decided the index's PREDICATE — 32 duplicate groups across tombstones is why the
  // tombstone-spanning version A3 was specified with could never be created — and
  // `live` is what the index A3 actually shipped enforces, so it is the one that must
  // stay at 0 from here on. A non-zero `live` after A3 would mean the unique index is
  // missing, not that data drifted; it cannot go above 0 while the index exists. ──
  const idempotency = nums(await one(`
    SELECT (SELECT count(*) FROM (
              SELECT 1 FROM blocks WHERE properties->>'idempotency_key' IS NOT NULL
               GROUP BY workspace_id, properties->>'idempotency_key' HAVING count(*) > 1) t)
             AS dupe_groups_any_state,
           (SELECT count(*) FROM (
              SELECT 1 FROM blocks WHERE properties->>'idempotency_key' IS NOT NULL AND deleted_at IS NULL
               GROUP BY workspace_id, properties->>'idempotency_key' HAVING count(*) > 1) t)
             AS dupe_groups_live`));

  // ── Step 6b: are A3's indexes actually THERE? ──
  // applyPostSchema swallows a failed statement by design (boot must survive one), so
  // "the code contains a CREATE INDEX" and "the index exists on this database" are
  // different facts, and A1 learned the hard way that only the second one counts.
  // Read pg_indexes, not the deploy log.
  // Reads pg_index, not pg_indexes, to get `indnullsnotdistinct` — because PRESENT IS
  // NOT ENOUGH for the unique one. `CREATE UNIQUE INDEX IF NOT EXISTS` will NOT rebuild
  // an index that already exists under that name, so any database that booted an
  // earlier build of this branch keeps the old NULLS-DISTINCT definition forever, with
  // the NULL-workspace hole open and the gate cheerfully reading true. Asserting the
  // semantics rather than the name is the difference between a gate and a formality.
  const a3Indexes = await rows(`
    SELECT c.relname AS indexname, i.indnullsnotdistinct
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
     WHERE t.relname = 'blocks'
       AND c.relname IN ('idx_blocks_idem_unique','idx_blocks_idem_key','idx_blocks_workspace_date_all')`);
  const byIndexName = new Map(a3Indexes.map(r => [r.indexname, r]));
  const idemUnique = byIndexName.get("idx_blocks_idem_unique");
  const a3IndexesPresent = {
    idx_blocks_idem_unique: !!idemUnique && idemUnique.indnullsnotdistinct === true,
    idx_blocks_idem_key: byIndexName.has("idx_blocks_idem_key"),
    idx_blocks_workspace_date_all: byIndexName.has("idx_blocks_workspace_date_all"),
  };

  // ── Step 7: THE LEDGER GATE ──
  // One materialized pass classifies every task_complete key; the roll-up and the
  // per-key readout below both read from it rather than recomputing the resolution.
  const LEDGER_CLASSIFIED = `
    WITH k AS MATERIALIZED (
      SELECT l.id, l.workspace_id, l.source_key, l.delta, l.description,
             l.metadata->>'canonical_source_key' AS canonical_key,
             ${LEDGER_ID_HALF} AS id_half,
             ${LEDGER_KEY_DATE} AS key_date
        FROM slot_point_ledger l
       WHERE l.source_type = 'task_complete' AND position(':' in l.source_key) > 0
    ), c AS MATERIALIZED (
      SELECT k.*,
             EXISTS (SELECT 1 FROM blocks b WHERE b.id = k.id_half) AS in_row_id_space,
             dcc_count_local_id_candidates(k.workspace_id, k.key_date, k.id_half) AS cands,
             EXISTS (SELECT 1 FROM blocks b
                      WHERE b.workspace_id IS NOT DISTINCT FROM k.workspace_id
                        AND b.properties->>'local_id' = k.id_half
                        AND b.deleted_at IS NULL) AS task_is_live
        FROM k
    )`;

  const ledger = nums(await one(`${LEDGER_CLASSIFIED}
    SELECT count(*) AS keys_total,
           count(*) FILTER (WHERE in_row_id_space) AS keys_row_id_space,
           count(*) FILTER (WHERE NOT in_row_id_space) AS keys_legacy_remaining,
           -- A1 writes the row-id form to metadata.canonical_source_key rather than
           -- rewriting source_key, so C5 can consult both spaces. This is the coverage.
           count(*) FILTER (WHERE NOT in_row_id_space AND canonical_key IS NOT NULL)
             AS legacy_with_canonical_sidecar,
           count(*) FILTER (WHERE NOT in_row_id_space AND cands = 0) AS legacy_orphan_no_row,
           -- THE GATE: a legacy key the resolver refused to rewrite because 2+ rows
           -- share that local_id. C5 would mint a different key for the same task and
           -- credit it AGAIN. Must be 0 before C5 ships.
           count(*) FILTER (WHERE NOT in_row_id_space AND cands > 1) AS recredit_risk,
           COALESCE(sum(delta) FILTER (WHERE NOT in_row_id_space AND cands > 1), 0) AS recredit_risk_points,
           -- The subset that can ACTUALLY re-credit: a key pointing only at tombstoned
           -- rows cannot, because there is no live task left to complete.
           count(*) FILTER (WHERE NOT in_row_id_space AND cands > 1 AND task_is_live) AS recredit_risk_live_task,
           COALESCE(sum(delta) FILTER (WHERE NOT in_row_id_space AND cands > 1 AND task_is_live), 0)
             AS recredit_risk_live_points
      FROM c`));

  // The offending keys themselves, so the decision can be made on titles rather than
  // on a count. Bounded — this is a gate readout, not a data export.
  const { rows: riskKeys } = await pool.query(`${LEDGER_CLASSIFIED}
    SELECT source_key, delta, description, cands AS candidates, task_is_live
      FROM c WHERE NOT in_row_id_space AND cands > 1
     ORDER BY delta DESC LIMIT 50`);

  const { rows: migrations } = await pool.query(
    "SELECT filename, applied_at, duration_ms, notes FROM schema_migrations ORDER BY filename");

  return {
    generatedAt: new Date().toISOString(),

    // Gate booleans first — the whole point of the endpoint is a yes/no answer.
    //
    // Only conditions that CAN reach true are gates. Two counts below look like
    // failures and are not: an ambiguous parent edge and an orphaned ledger key are
    // permanent properties of legacy data, unreachable by any migration. Gating on
    // them would mean gating forever, so they are reported as decisions instead.
    gates: {
      // 001's own work: did every fact IT carries over land? Deliberately excludes
      // completion, which 001 no longer touches -- see migration002_completionPending.
      migration001Complete:
        completion.pending_approval_left === 0
        && overlayDeleted.not_applied === 0,

      integrityClean:
        integrity.self_parents === 0
        && integrity.rows_in_cycles === 0
        && integrity.dangling_parents === 0,

      // TRUE means completion still lives only in the day_root overlay, i.e. 002 has
      // not run. That remains the CORRECT state even now that C0 (#257) has shipped:
      // C0 cleared the RENDERING gate, but 002 has a second, still-open POINTS gate.
      // slots.js reconcileCompletedTaskCredits credits every done task in the fold on
      // each dcc:data-ready, and 12 of the rows 002 marks done have no matching ledger
      // key, so they would be credited retroactively. See the header of
      // migrations/002_completion_status.sql for the measurement and the three ways to
      // clear it. Do not read this gate as "C0 shipped, go".
      migration002_completionPending:
        overlayDone.not_applied > 0 || completion.unnormalized_done > 0,

      // THE C5 GATE. Deliberately narrower than the plan's "zero unresolved ledger
      // keys": 45 of the 57 unresolved keys point at no row at all, so they can never
      // resolve AND can never re-credit (there is no task left to complete). The
      // condition that actually protects points is "no key whose task is still live
      // sits in the wrong id space".
      c5_ledgerNoRecreditRisk: ledger.recredit_risk_live_task === 0,

      // A3 HAS SHIPPED, so the question changed: not "could the index be created"
      // but "is it on THIS database". applyPostSchema logs a failure and carries on,
      // and the deploy stays green either way, so this gate is the only honest
      // answer — read from pg_indexes. Enforcement (the unique index) and the live
      // dupe count have to agree; a live dupe with the index present is impossible,
      // so the pair catches both "index missing" and "index somehow bypassed".
      a3_idempotencyEnforced:
        a3IndexesPresent.idx_blocks_idem_unique && idempotency.dupe_groups_live === 0,
    },

    // Not blockers — judgement calls that belong to a human before a read flip.
    decisions: {
      parentEdgesAmbiguous: parentEdges.ambiguous,
      parentEdgesNoRow: parentEdges.no_row,
      parentEdgesNote:
        "These rows keep parent_id NULL and render as roots, which is EXACTLY today's " +
        "flat behavior, so they do not block C2. They are only worth acting on if " +
        "Drake wants the nesting recovered by hand.",
      overlayEntriesRefusedWrongDate: overlayDone.wrong_date + overlayDeleted.wrong_date,
      overlayWrongDateNote:
        "Overlay entries whose id resolves to a row on a DIFFERENT date. The overlay is " +
        "a per-day fact and the resolver's tier 1 is date-blind, so applying these would " +
        "hide or complete a row on a day the user never touched. Refused on purpose, " +
        "not a failure. Caught by scripts/fold-diff.mjs.",
      ledgerRecreditRiskLiveTasks: ledger.recredit_risk_live_task,
      ledgerRecreditRiskLivePoints: ledger.recredit_risk_live_points,
      ledgerNote:
        "A1 does NOT rewrite source_key; it writes the row-id form alongside it in " +
        "metadata.canonical_source_key (see legacy_with_canonical_sidecar). Rewriting " +
        "would double-credit immediately, not at C5: slots.js " +
        "reconcileCompletedTaskCredits re-posts the legacy <date>:<local_id> key on " +
        "every app init, so a rewritten row loses its ON CONFLICT anchor and credits " +
        "again on page load. C5 must check BOTH spaces before crediting (Drake " +
        "assigned that fix to C5, 2026-07-29). These recredit-risk keys are the " +
        "remainder with no sidecar, because 2+ rows share that local_id and the " +
        "resolver refused to guess; ledgerRiskKeys carries their titles and deltas.",
      a3IndexesPresent,
      a3IndexPredicate:
        "SHIPPED (A3). The index as originally specified " +
        "(`WHERE properties->>'idempotency_key' IS NOT NULL`) could never be created — " +
        "32 duplicate groups exist among tombstoned rows — so it carries " +
        "`AND deleted_at IS NULL` and constrains LIVE rows only. The consequence to " +
        "keep in mind: a tombstone does NOT reserve its key, so 'never resurrect a " +
        "deleted row' remains lib/materialize-guard.js's job at the route layer. The " +
        "index is the concurrency backstop, the guard is the no-resurrect rule; " +
        "neither one subsumes the other.",
    },

    // `missing` is EXPECTED to be large and is not a defect. A1 deliberately does not
    // backfill local_id (see 001 "Step 1 (removed)"): the client already falls back to
    // the row id when it is absent (persistence.js:274), while its PRESENCE is the
    // fold's admission flag, so stamping it promoted 245 non-task rows into the
    // itinerary. Nothing downstream needs it.
    localIds,
    parentEdges,
    integrity,
    statusDistribution,
    completion,
    overlay: { done: overlayDone, deleted: overlayDeleted },
    idempotency,
    ledger,
    ledgerRiskKeys: riskKeys.map((r) => ({
      sourceKey: r.source_key,
      delta: Number(r.delta),
      description: r.description,
      candidates: Number(r.candidates),
      taskIsLive: r.task_is_live,
    })),
    migrations,

    notes: {
      // Stated here because the A1 plan assumed otherwise and Track C reads this
      // endpoint before writing its roots-only query. parent_id has always held the
      // row's CONTAINER: for most itinerary tasks that is its day_root. A1 only
      // repoints rows that carry a subtaskOf/wrapId link. A root task's parent_id is
      // therefore its day_root id, NOT null.
      rootPredicate:
        "A root task is `parent_id IS NULL OR parent.type = 'day_root'`, NOT `parent_id IS NULL`. " +
        "Verified on prod: 1345 of 1531 parent edges pointed at a day_root before A1.",
      overlayKeysRetained:
        "Every day_root overlay key is intentionally still in place. A4 removes them; " +
        "that is what makes Tiers 1-5 revertible.",
      migrationTombstoneDates:
        "Tombstones stamped by the migration use now(), never the original delete time, " +
        "because purgeSoftDeleted(30) hard-deletes anything older than 30 days and " +
        "backdating would make this migration irreversible. They carry " +
        "properties._migratedDeleteSource for provenance.",
      // The single most important thing a later phase can learn from A1.
      propertyWritesAreNotInert:
        "Writes to properties are NOT inert in this codebase. The client's fold " +
        "predicate branches on the PRESENCE of properties.local_id (persistence.js:262) " +
        "and on specific properties.status values (persistence.js:261), so an " +
        "'additive' backfill is a visibility change. A1's first draft kept the ledger " +
        "byte-identical and passed the smoke suite while moving 572 rows on and off the " +
        "itinerary, and the two directions partly cancelled in aggregate counts " +
        "(1501 foldable before, 1419 after) which is how it hid. Use " +
        "scripts/fold-diff.mjs as the acceptance test for any data change claiming " +
        "zero behavior change.",
    },
  };
}

module.exports = function mount(app, ctx) {
  const { requireAdmin, route } = ctx;
  app.get("/api/admin/model-audit", requireAdmin, route(() => audit()));
};

module.exports.audit = audit;
