#!/usr/bin/env node
// scripts/credit-closure-check.mjs — the acceptance test for Phase C5's ledger gate.
//
// Same role scripts/fold-diff.mjs plays for a data change: the part of the claim that
// hermetic tests cannot prove. lib/task-credit-keys.js exists because of Date.now()
// local_id collisions, and synthetic rows cannot reproduce those, so its completeness
// has to be measured against real data.
//
// It proves TWO things:
//
//   1. COMPLETENESS — for every stored task_complete key, presenting any candidate
//      row's row-id spelling still finds the existing credit. Reported beside the
//      same count with the closure removed, which is the size of the bug being fixed.
//      A run that reports 0 presentations proves nothing and exits non-zero.
//
//   2. AGREEMENT — the set-based simulation the audit endpoint gates on
//      (CLOSURE_AUDIT_SQL) and the per-key closure the credit path actually calls
//      (findEquivalentTaskCredit) return the same verdict for every presentation.
//      Two copies of one rule is this project's most expensive recurring shape
//      ("enforced at one call site, merely assumed at the other"), so the binding is
//      measured rather than asserted in a comment.
//
// Usage:
//   DATABASE_URL=postgres://…/dcc_canon_c5 node scripts/credit-closure-check.mjs
//
// Read-only. Runs no writes and needs no migration state, though it is worth checking
// `schema_migrations` first — C3 lost a whole measurement to an unmigrated restore.

import pg from "pg";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { findEquivalentTaskCredit, CLOSURE_AUDIT_SQL } = require("../lib/task-credit-keys.js");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required. Point it at a RESTORE, never at prod.");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, ssl: /supabase|railway|render/.test(url) ? { rejectUnauthorized: false } : false });

function fail(msg) { console.error(`\n✖ ${msg}`); process.exitCode = 1; }

try {
  const { rows: [mig] } = await pool.query(
    "SELECT count(*)::int AS n, string_agg(filename, ', ' ORDER BY filename) AS files FROM schema_migrations");
  console.log(`migrations applied: ${mig.n} (${mig.files || "none"})`);
  if (mig.n === 0) fail("This restore has NO migrations applied. Measurements against it are void (C3's lesson).");

  // ── 1. completeness ──
  const { rows: [agg] } = await pool.query(CLOSURE_AUDIT_SQL);
  const presentations = Number(agg.closure_presentations);
  const exactMisses = Number(agg.exact_match_would_double_credit);
  const closureMisses = Number(agg.closure_would_double_credit);

  console.log(`\n── completeness ──`);
  console.log(`  presentations simulated          ${presentations}`);
  console.log(`  exact match would double-credit  ${exactMisses}`);
  console.log(`  closure would double-credit      ${closureMisses}`);

  if (presentations === 0) fail("0 presentations simulated — this run proves nothing. Check that `blocks` and `slot_point_ledger` are both populated.");
  else if (closureMisses > 0) fail(`${closureMisses} presentation(s) would still double-credit.`);
  else console.log(`  ✔ closure is complete over this data (and saves ${exactMisses} double-credits)`);

  // ── 2. agreement between the audit SQL and the JS the credit path runs ──
  // Rebuild the presentation list, then ask findEquivalentTaskCredit about each one.
  const { rows: presented } = await pool.query(`
    WITH k AS MATERIALIZED (
      SELECT l.workspace_id, l.source_key,
             substring(l.source_key from position(':' in l.source_key) + 1) AS id_half,
             dcc_try_date(split_part(l.source_key, ':', 1)) AS key_date,
             split_part(l.source_key, ':', 1) AS date_half
        FROM slot_point_ledger l
       WHERE l.source_type = 'task_complete' AND position(':' in l.source_key) > 0
    )
    SELECT DISTINCT k.workspace_id, k.source_key AS stored_key,
           k.date_half || ':' || x.id AS presented_key
      FROM k
      JOIN blocks x
        ON x.workspace_id IS NOT DISTINCT FROM k.workspace_id
       AND x.type <> 'day_root'
       AND ( x.id = k.id_half
          OR ( x.properties->>'local_id' = k.id_half
               AND (x.date IS NOT DISTINCT FROM k.key_date OR x.date IS NULL) ) )
     WHERE k.key_date IS NOT NULL`);

  console.log(`\n── agreement (JS closure vs the audit's simulation) ──`);
  // MEMBERSHIP, not existence. The first version of this loop only counted whether the
  // JS found SOMETHING, so a closure that returned a row for every key — the exact
  // failure mode the module admits to, and the one that makes revoke delete another
  // task's credit — would have scored a perfect 436/436. That is the same shape as the
  // differential harness in C2 that compared counts instead of membership and reported
  // "identical" for three real bugs.
  const equivalents = new Map();
  for (const r of presented) {
    if (!equivalents.has(r.presented_key)) equivalents.set(r.presented_key, new Set());
    equivalents.get(r.presented_key).add(r.stored_key);
  }
  let disagreements = 0;
  let overMatches = 0;
  let jsFound = 0;
  for (const row of presented) {
    const hit = await findEquivalentTaskCredit(pool, row.workspace_id, row.presented_key);
    if (!hit) {
      disagreements++;
      if (disagreements <= 10) console.log(`  ✖ JS found nothing for ${row.presented_key} (stored as ${row.stored_key})`);
      continue;
    }
    jsFound++;
    if (!equivalents.get(row.presented_key).has(hit.sourceKey)) {
      overMatches++;
      if (overMatches <= 10) console.log(`  ✖ JS returned ${hit.sourceKey} for ${row.presented_key}, which is not equivalent to it`);
    }
  }
  console.log(`  presentations checked            ${presented.length}`);
  console.log(`  JS closure found a credit for    ${jsFound}`);
  console.log(`  matched a NON-equivalent credit  ${overMatches}`);
  if (presented.length === 0) fail("0 presentations to cross-check — the agreement half proves nothing.");
  else if (disagreements > 0) fail(`${disagreements} presentation(s) where the JS closure and the audit SQL disagree. They must not drift.`);
  else if (overMatches > 0) fail(`${overMatches} presentation(s) where the JS closure matched a NON-equivalent credit.`);
  else console.log(`  ✔ the two agree on every presentation, and every match is equivalent`);

  // ── negative control ──
  // Every check above starts from a key that IS credited, so all of them would pass
  // against a closure that says "already credited" to everything. This asks the
  // opposite question: task rows carrying no credit at all must resolve to null.
  console.log(`\n── negative control (uncredited rows must NOT resolve) ──`);
  const { rows: uncredited } = await pool.query(`
    SELECT b.workspace_id, to_char(b.date,'YYYY-MM-DD') || ':' || b.id AS presented_key,
           (b.properties->>'local_id') IS NOT NULL AS has_local_id
      FROM blocks b
     WHERE b.type <> 'day_root' AND b.date IS NOT NULL AND b.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM slot_point_ledger l
          WHERE l.workspace_id IS NOT DISTINCT FROM b.workspace_id
            AND l.source_type = 'task_complete'
            AND ( l.source_key = to_char(b.date,'YYYY-MM-DD') || ':' || b.id
               OR l.source_key = to_char(b.date,'YYYY-MM-DD') || ':' || (b.properties->>'local_id')
               -- BOTH sidecar spellings. Checking only the row-id form selected rows the
               -- closure legitimately finds via a local_id-form sidecar, so the control
               -- would have failed spuriously.
               OR l.metadata->>'canonical_source_key' = to_char(b.date,'YYYY-MM-DD') || ':' || b.id
               OR l.metadata->>'canonical_source_key' = to_char(b.date,'YYYY-MM-DD') || ':' || (b.properties->>'local_id') ))
     -- ORDERED so a pass or a failure is reproducible. LIMIT with no ORDER BY samples a
     -- different 300 rows every run, which makes a green run un-rerunnable evidence.
     ORDER BY b.id
     LIMIT 300`);
  let falsePositives = 0;
  for (const r of uncredited) {
    const hit = await findEquivalentTaskCredit(pool, r.workspace_id, r.presented_key);
    if (hit) {
      falsePositives++;
      if (falsePositives <= 10) console.log(`  ✖ ${r.presented_key} has no credit, but the closure returned ${hit.sourceKey}`);
    }
  }
  const withLocalId = uncredited.filter(r => r.has_local_id).length;
  console.log(`  uncredited rows probed           ${uncredited.length}`);
  console.log(`  ...of which carry a local_id     ${withLocalId}   (0 would mean step 2 of the closure was never exercised)`);
  console.log(`  falsely reported as credited     ${falsePositives}`);
  if (uncredited.length === 0) fail("no uncredited rows to use as a negative control — this half proves nothing.");
  else if (falsePositives > 0) fail(`${falsePositives} uncredited task(s) the closure claims are already credited — those completions would never be paid.`);
  else console.log(`  ✔ the closure declines every uncredited row`);

  // ── strict mode, against the real collisions ──
  // The gate's simulation models the EARN direction only, so without this nothing
  // exercises the revoke guard against prod shapes. For every key whose closure hit is
  // NON-exact, strict must either refuse it or resolve it unambiguously; a strict answer
  // that still points at a different key than the caller asked for, on an ambiguous
  // candidate set, is a wrong debit waiting to happen.
  console.log(`\n── strict mode (the revoke guard) ──`);
  let strictWouldDebitForeign = 0;
  let strictRefusals = 0;
  for (const row of presented) {
    const loose = await findEquivalentTaskCredit(pool, row.workspace_id, row.presented_key);
    if (!loose || loose.sourceKey === row.presented_key) continue;   // exact hits are never guesses
    const hit = await findEquivalentTaskCredit(pool, row.workspace_id, row.presented_key, { strict: true });
    if (!hit || hit.sourceKey === row.presented_key) { strictRefusals++; continue; }
    // Not an alarm: an honored non-exact hit means the presented row's local_id has
    // exactly ONE live owner, so the resolved key names that same task. The common case
    // is a live row plus a tombstoned twin of itself, which is why the ambiguity count
    // filters on deleted_at IS NULL.
    strictWouldDebitForeign++;
  }
  console.log(`  non-exact hits refused (ambiguous) ${strictRefusals}`);
  console.log(`  non-exact hits honored (unambiguous) ${strictWouldDebitForeign}`);
  console.log(`  the honored ones are single-owner resolutions: the presented row's own local_id,`);
  console.log(`  shared with no other live row, so revoking through them targets that same task.`);
  if (strictRefusals === 0) fail("strict refused NOTHING. Either this restore has no local_id collisions (check ledgerRiskKeys) or the guard is not firing — it read cand_count off the wrong axis once already.");

  // ── the numbers the audit gate itself will read ──
  console.log(`\n── gate ──`);
  const gate = presentations > 0 && closureMisses === 0;
  console.log(`  c5_ledgerNoRecreditRisk would read ${gate}`);
} finally {
  await pool.end();
}
