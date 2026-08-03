// lib/task-credit-keys.js — the equivalence closure over `slot_point_ledger`
// task_complete source keys. This is Phase C5's ledger gate.
//
// ── THE PROBLEM ───────────────────────────────────────────────────────────────
//
// `slot_point_ledger` is `UNIQUE (workspace_id, source_type, source_key)` and the
// credit insert is `ON CONFLICT DO NOTHING`. That clause is the ONLY idempotency
// guard on task credit, and it compares source keys as STRINGS. But one task has
// always had two spellings:
//
//   client  (public/js/slots.js earnTaskCredit)  ->  <date>:<local_id>
//   server  (routes/dcc.js, routes/slack-events.js) ->  <date>:<blockId>
//
// So a task credited by one surface and re-presented by the other finds no
// conflict, inserts a second row and bumps `point_balance` again. That is a live
// bug, not a hypothetical: complete a task in the UI (legacy key) and then ✅ it
// in Slack (row-id key) and it pays twice. Phase A1 measured the same hazard from
// the other end and correctly REFUSED to fix it by rewriting `source_key`, because
// `public/js/slots.js reconcileCompletedTaskCredits` re-posts the legacy key on
// every app init — rewrite the stored key and the re-post double-credits on page
// load. A1 left the row-id form in `metadata.canonical_source_key` as a sidecar
// instead, for this module to read.
//
// ── WHY THE AMBIGUITY THAT BLOCKED A1 DOES NOT BLOCK US ───────────────────────
//
// A1's resolver had to go **local_id -> row**, which is MULTI-VALUED: 13 legacy
// keys on prod have 2-3 live rows sharing one `local_id` (quick-add double-fires,
// created seconds apart), so it refused to guess and left `c5_ledgerNoRecreditRisk`
// false. That direction is genuinely unresolvable.
//
// The credit path never needs it. It only needs **row -> local_id**, and a row has
// exactly ONE `properties.local_id`, so that direction is single-valued and always
// resolves — even when three rows share the value. Measured on a fresh prod restore
// (2026-08-03), simulating every candidate row of all 384 stored keys presenting its
// row-id form (436 presentations):
//
//     naive `source_key` equality  ->  326 would DOUBLE-CREDIT
//     this closure                 ->  436/436 matched, 0 double-credits
//
// The ambiguity was a red herring. `credit-key-closure.test.js` pins that result
// with the real prod shapes as fixtures.
//
// ── THE CLOSURE ───────────────────────────────────────────────────────────────
//
// For an incoming `<date>:<idHalf>`, the equivalent keys are:
//   1. the key itself;
//   2. `<date>:<row.id>`       for every row the idHalf could name;
//   3. `<date>:<row.local_id>` for every row the idHalf could name;
//   4. any ledger row whose `metadata.canonical_source_key` is one of the above
//      (A1's sidecar — covers a row since tombstoned or re-minted, which (2)/(3)
//      would miss because the row is no longer resolvable).
//
// Step 3 is the load-bearing one. Steps 2 and 4 are cheap and cover the tail.
//
// ── OVER-MATCHING IS SAFE ONE WAY AND UNSAFE THE OTHER — HENCE `strict` ───────
//
// Step 2 walks local_id -> rows, which IS the multi-valued direction, so on a genuine
// collision the closure can over-match and answer "already credited" about a task that
// was not.
//
// On the EARN path that is the safe direction: the worst case is declining to pay
// twice, which is this ledger's house rule (A1's whole design treats double-crediting
// as the worse failure), and for 12 of the 13 prod collisions the colliding rows are
// duplicates of ONE task, so suppression is simply correct.
//
// ON THE REVOKE PATH THE SIGN FLIPS, and the first version of this module missed it.
// An over-match there does not withhold a payment, it DELETES a ledger row belonging to
// a different task and debits the balance by that task's points. The live example:
// `2026-07-31:st-1785503019024` is shared by two DISTINCT tasks, "Fold"
// (`d7bfd651…`) and "Put Away" (`fd0ffaf8…`) — both open, both 13:00, created 0.05s
// apart. Un-checking "Put Away" would resolve through the shared local_id and delete the
// credit "Fold" banked. Before this module that un-check simply found nothing (E1's
// documented bug), so the over-match would have been a NEW way to lose points.
//
// `strict: true` refuses any non-exact match when the closure saw more than one
// candidate row, so an ambiguous un-complete degrades to today's no-op instead of
// debiting the wrong task. revokeTaskCredit passes it; earnTaskCredit does not.
//
// Note this leaves the two colliding tasks crediting only ONCE between them, which is
// what happens today — they key to one string. This module inherits that rather than
// causing it. The fix is re-minting one row's `local_id`, live-data surgery this phase
// deliberately does not perform; it is reported to Track A instead.
//
// ── SCOPE: THE ID AXIS ONLY, AND THAT IS DELIBERATE ───────────────────────────
//
// The closure varies the ID half and holds the DATE half fixed. Review asked whether it
// should also close over each candidate row's own date, on the reasoning that the client
// can post `<chosen date>:<id>` (schedule.js commitDoneOnDate uses the date the user
// picked in the "did you do it today?" prompt) while the server posts `<row date>:<id>`,
// so the two spellings would miss each other and double-credit.
//
// MEASURED BEFORE DECIDING, and the answer is no. On a fresh prod restore, 15 rows
// already carry credits under two or more distinct date halves — and they are
// "Breakfast", "Coffee", "Morning Routine", "Stretch and Shower", "Tidy Task" on
// CONSECUTIVE days. Those are recurring tasks whose row was re-dated forward and then
// legitimately completed again. Closing over the date axis would have collapsed every
// one of them into a single credit, i.e. silently stopped paying for daily habits.
//
// So the date half is not incidental to the key, it is part of the identity: a
// source_key means "this task, completed on THIS day", and two days is two completions.
// The narrower claim is the honest one — **the 326 double-credits this closure prevents
// are all on the id axis.** A cross-date pair remains two credits by design.
//
// ── SCOPE: NON-DATE PREFIXES ──────────────────────────────────────────────────
//
// A key whose date half is not a parsable date (`shell:<blockId>`, the rollup
// container bonus, which is pinned to the row id ON PURPOSE so it dedupes across
// calendar dates) gets EXACT matching only. Closing over it would be wrong: the
// shell key deliberately has no date to close against.

// Same parse as routes/admin-model.js's LEDGER_ID_HALF, so the audit endpoint and
// the credit path can never disagree about where a key splits.
function splitSourceKey(sourceKey) {
  const key = String(sourceKey || "").trim();
  const at = key.indexOf(":");
  if (at <= 0) return null;
  return { datePart: key.slice(0, at), idHalf: key.slice(at + 1) };
}

// A date half we can close over. `dcc_try_date` is the DB-side twin; this is the
// JS gate that keeps `shell:<id>` out of the closure entirely.
function isClosableDatePart(datePart) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return false;
  const ms = Date.parse(datePart + "T00:00:00Z");
  if (!Number.isFinite(ms)) return false;
  // Round-trip: the regex admits '2026-02-31' and '0000-99-99', which Date.parse
  // either rolls over or rejects inconsistently across engines.
  return new Date(ms).toISOString().slice(0, 10) === datePart;
}

// ONE round trip. `cand` is the candidate-row set (the same predicate
// dcc_resolve_local_id uses, minus the tier ranking — we want ALL candidates, not
// a winner), `keys` is the closure, and the final select asks the ledger.
//
// Tenant-fenced with IS NOT DISTINCT FROM rather than `=` so a null workspace_id
// matches a null instead of evaluating to NULL and silently matching nothing —
// the seven-reader hazard Track C flagged to Track A in C3.
const CLOSURE_SQL = `
  WITH cand AS (
    SELECT b.id, b.properties->>'local_id' AS local_id
      FROM blocks b
     WHERE b.workspace_id IS NOT DISTINCT FROM $1
       AND b.type <> 'day_root'
       AND ( b.id = $3
          OR ( b.properties->>'local_id' = $3
               AND (b.date IS NOT DISTINCT FROM $4::date OR b.date IS NULL) ) )
  ), keys AS (
    SELECT $2::text AS k
    UNION SELECT $4::text || ':' || cand.id            FROM cand
    UNION SELECT $4::text || ':' || cand.local_id      FROM cand WHERE cand.local_id IS NOT NULL
  ), amb AS (
    -- HOW AMBIGUOUS IS THE THING WE MIGHT ACT ON — not how ambiguous the presented key
    -- was. The first cut counted the cand CTE, and that is the wrong axis: cand is built
    -- from the PRESENTED id half, so a row-id presentation matches exactly one row (id
    -- is the PK, and no block's local_id is a uuid) and always counted 1. Meanwhile the
    -- keys union still fans out through that row's local_id and reaches a colliding
    -- task's credit — which is the entire hazard. Verified on the prod restore:
    -- presenting Put Away's row id returned Fold's credit with the old counter reading 1,
    -- so strict waved through exactly the case it was written to refuse.
    --
    -- LIVE rows only. dcc_count_local_id_candidates tiers live rows above tombstones for
    -- the same reason: a soft-deleted twin must not make a live single-owner task
    -- permanently un-revocable.
    SELECT COALESCE(max(n), 1) AS n FROM (
      SELECT count(*) AS n
        FROM blocks b2 JOIN cand ON b2.properties->>'local_id' = cand.local_id
       WHERE b2.workspace_id IS NOT DISTINCT FROM $1
         AND b2.type <> 'day_root'
         AND b2.deleted_at IS NULL
         AND cand.local_id IS NOT NULL
         AND (b2.date IS NOT DISTINCT FROM $4::date OR b2.date IS NULL)
       GROUP BY cand.local_id
    ) g
  )
  SELECT l.source_key, l.delta, l.description,
         (SELECT n FROM amb) AS cand_count
    FROM slot_point_ledger l
   WHERE l.workspace_id IS NOT DISTINCT FROM $1
     AND l.source_type = 'task_complete'
     AND ( l.source_key IN (SELECT k FROM keys)
        OR l.metadata->>'canonical_source_key' IN (SELECT k FROM keys) )
   -- Deterministic winner when several equivalent rows already exist (possible
   -- for historical data written before this module existed): prefer the exact
   -- key, then the largest credit, so the upgrade path in earnTaskCredit cannot
   -- flap between rows across calls.
   ORDER BY (l.source_key = $2::text) DESC, l.delta DESC, l.source_key
   LIMIT 1`;

// Find an EXISTING ledger row equivalent to `sourceKey`.
//
// Returns `{ sourceKey, delta, description }` for the row that already holds this
// credit — whose `sourceKey` may DIFFER from the one passed in, and callers must
// use the returned one for any follow-up write — or null when the credit is
// genuinely new.
//
// Never throws for a caller's benefit: a closure failure must not take down a
// completion. It logs and returns null, which degrades to today's exact-match
// behavior rather than to a wrong answer... except that "today's behavior" is the
// double-credit this module exists to prevent, so the failure is logged loudly.
// Written ONCE and exported, for two reasons. It was duplicated verbatim in the two
// degraded branches below, and a later phase adding a column to one copy and not the
// other would only diverge on the path that is already failing. Exporting it also lets
// the test suite hold it to the same tenant-fencing guard as the closure — the earlier
// version was unreachable from the test, so a regression to bare `workspace_id = $1`
// there would have gone unseen.
const EXACT_SQL = `
  SELECT source_key, delta, description FROM slot_point_ledger
   WHERE workspace_id IS NOT DISTINCT FROM $1
     AND source_type = 'task_complete' AND source_key = $2
   LIMIT 1`;

const toCredit = (r) =>
  r ? { sourceKey: r.source_key, delta: Number(r.delta || 0), description: r.description } : null;

async function exactMatch(pool, workspaceId, key) {
  const { rows } = await pool.query(EXACT_SQL, [workspaceId, key]);
  return toCredit(rows[0]);
}

async function findEquivalentTaskCredit(pool, workspaceId, sourceKey, { strict = false } = {}) {
  const parts = splitSourceKey(sourceKey);
  const key = String(sourceKey || "").trim();
  if (!key) return null;

  // Not closable (no colon, or a non-date prefix like `shell:`): exact match only.
  if (!parts || !isClosableDatePart(parts.datePart)) return exactMatch(pool, workspaceId, key);

  try {
    const { rows } = await pool.query(CLOSURE_SQL, [workspaceId, key, parts.idHalf, parts.datePart]);
    if (!rows[0]) return null;
    // STRICT (revoke): a non-exact hit resolved through an AMBIGUOUS candidate set is
    // refused, because acting on it deletes a row that may belong to another task. An
    // exact hit is always honored — the key itself is not a guess.
    if (strict && rows[0].source_key !== key && Number(rows[0].cand_count) > 1) {
      console.warn(`[task-credit-keys] refusing an ambiguous match for ${key} (${rows[0].cand_count} candidate rows share that id); leaving the credit alone`);
      return exactMatch(pool, workspaceId, key);
    }
    return toCredit(rows[0]);
  } catch (e) {
    console.error(`[task-credit-keys] closure failed for ${key} (falling back to exact match):`, e.message);
    return exactMatch(pool, workspaceId, key);
  }
}

// ── THE AUDIT SIMULATION ──────────────────────────────────────────────────────
//
// routes/admin-model.js's `c5_ledgerNoRecreditRisk` gate reads this. It lives HERE,
// next to CLOSURE_SQL, on purpose: a gate that simulates the credit path from a
// separate copy of the logic is a gate that passes while the code is broken. This
// project has already been bitten by exactly that shape ("enforced at one call
// site, merely assumed at the other" — C4's review round 3), and by harnesses that
// were gentler than reality (C3's three stubs).
//
// The two queries are still not the same statement — one resolves ONE key, this one
// sweeps every key — so `credit-key-closure.test.js` runs both over the same rows
// and asserts they return the same verdict for every presentation. That test is
// what actually binds them; this comment only says where to look.
//
// WHAT IT SIMULATES: for every stored task_complete key, every row that key could
// name, presenting that row's ROW-ID form — the spelling routes/dcc.js and
// routes/slack-events.js use. Then it asks whether the closure finds the existing
// credit. Any presentation it cannot find is a double-credit waiting to happen.
//
// The gate deliberately does NOT read A1's `recredit_risk` (the `cands > 1`
// ambiguity count). That number cannot reach zero by any means C5 is allowed to
// use — the only routes to zero are rewriting `source_key` (double-credits on page
// load), tombstoning live rows of real data, or waiting for the collisions to age
// out — and it measures data ambiguity rather than re-credit reachability. It stays
// in the response as a reported number so nothing is hidden.
const CLOSURE_AUDIT_SQL = `
  WITH k AS MATERIALIZED (
    SELECT l.workspace_id, l.source_key,
           substring(l.source_key from position(':' in l.source_key) + 1) AS id_half,
           dcc_try_date(split_part(l.source_key, ':', 1)) AS key_date,
           split_part(l.source_key, ':', 1) AS date_half
      FROM slot_point_ledger l
     WHERE l.source_type = 'task_complete' AND position(':' in l.source_key) > 0
  ), cand AS (
    SELECT k.workspace_id, k.source_key, k.date_half,
           x.id AS row_id, x.properties->>'local_id' AS row_local_id
      FROM k
      JOIN blocks x
        ON x.workspace_id IS NOT DISTINCT FROM k.workspace_id
       AND x.type <> 'day_root'
       AND ( x.id = k.id_half
          OR ( x.properties->>'local_id' = k.id_half
               AND (x.date IS NOT DISTINCT FROM k.key_date OR x.date IS NULL) ) )
     -- shell:<id> and any other non-date prefix is exact-match-only by design, so
     -- it has no closure to simulate. Mirrors isClosableDatePart().
     WHERE k.key_date IS NOT NULL
  ), sim AS (
    SELECT c.date_half || ':' || c.row_id AS presented,
           EXISTS (
             SELECT 1 FROM slot_point_ledger l2
              WHERE l2.workspace_id IS NOT DISTINCT FROM c.workspace_id
                AND l2.source_type = 'task_complete'
                AND ( l2.source_key = c.date_half || ':' || c.row_id
                   OR l2.metadata->>'canonical_source_key' = c.date_half || ':' || c.row_id
                   OR (c.row_local_id IS NOT NULL
                       AND l2.source_key = c.date_half || ':' || c.row_local_id) )
           ) AS closure_finds_it,
           EXISTS (
             SELECT 1 FROM slot_point_ledger l2
              WHERE l2.workspace_id IS NOT DISTINCT FROM c.workspace_id
                AND l2.source_type = 'task_complete'
                AND l2.source_key = c.date_half || ':' || c.row_id
           ) AS exact_finds_it
      FROM cand c
  )
  SELECT count(*) AS closure_presentations,
         count(*) FILTER (WHERE NOT exact_finds_it)   AS exact_match_would_double_credit,
         count(*) FILTER (WHERE NOT closure_finds_it) AS closure_would_double_credit
    FROM sim`;

module.exports = { findEquivalentTaskCredit, splitSourceKey, isClosableDatePart, CLOSURE_SQL, CLOSURE_AUDIT_SQL, EXACT_SQL };
