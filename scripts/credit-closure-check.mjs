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
  let disagreements = 0;
  let jsFound = 0;
  for (const row of presented) {
    const hit = await findEquivalentTaskCredit(pool, row.workspace_id, row.presented_key);
    if (hit) jsFound++;
    else {
      disagreements++;
      if (disagreements <= 10) {
        console.log(`  ✖ JS found nothing for ${row.presented_key} (stored as ${row.stored_key})`);
      }
    }
  }
  console.log(`  presentations checked            ${presented.length}`);
  console.log(`  JS closure found a credit for    ${jsFound}`);
  if (presented.length === 0) fail("0 presentations to cross-check — the agreement half proves nothing.");
  else if (disagreements > 0) fail(`${disagreements} presentation(s) where the JS closure and the audit SQL disagree. They must not drift.`);
  else console.log(`  ✔ the two agree on every presentation`);

  // ── the numbers the audit gate itself will read ──
  console.log(`\n── gate ──`);
  const gate = presentations > 0 && closureMisses === 0;
  console.log(`  c5_ledgerNoRecreditRisk would read ${gate}`);
} finally {
  await pool.end();
}
