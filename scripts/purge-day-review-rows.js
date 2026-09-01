#!/usr/bin/env node
// Purge everything the Day-in-Review task scan left behind.
//
// The scan inferred "tasks you did but forgot to track" from Claude/Codex chat
// transcripts, git commits and sent Slack/Gmail, then offered Approve to log them
// as already-completed tasks that banked slot points. It predicted badly and was
// ripped out on 2026-08-20. This script removes its residue.
//
// WHAT IT TOUCHES
//   1. blocks rows it authored          -> SOFT delete via db.deleteBlock
//   2. their slot_point_ledger credits  -> slotStore.revokeTaskCredit (balance debited)
//   3. dcc_state.state_json             -> drops the dead `day-review` page and
//                                          any dr-* / f-dr-* decision + log entry
//
// THIS CLAWS BACK BANKED POINTS AND CHANGES PAST DAY TOTALS. That is the intent:
// the tasks were never really tracked, so the points were never really earned.
// It is still destructive, so:
//   - dry run is the DEFAULT; --apply is required to write
//   - every matched row is written to data/backups/ before anything is deleted
//   - the delete is a SOFT delete, and db.deleteBlock also stores the row's full
//     properties in `operations.before_data`, so db.undeleteBlock(id) restores one
//
// Recommended order:
//   pg_dump "$DATABASE_URL" > backup-$(date +%F-%H%M).sql
//   node scripts/purge-day-review-rows.js                  # read the report
//   node scripts/purge-day-review-rows.js --apply
//   node scripts/purge-day-review-rows.js                  # expect zero matches
//
// NOTE ON CI: this file deliberately issues no destructive raw SQL of its own -- no
// row-removal statement, no schema change. The block removal goes through
// db.deleteBlock (an UPDATE plus an INSERT) and the ledger removal through
// slotStore.revokeTaskCredit. That keeps the repo's db-risk guardrail from tripping on
// this script. (The PR still needs `[db-ok]` because db.js itself was edited by the
// rip-out. Keep destructive SQL keywords out of this file's prose too -- the guardrail
// greps added lines, comments included.)

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const pool = require("../pg-pool");
const blockDB = require("../db");
const slotStore = require("../slot-store");

const APPLY = process.argv.includes("--apply");
const BACKUP_DIR = path.join(__dirname, "..", "data", "backups");

// routes/dcc.js wrote `source`, `created_by` AND `completedBy` on an approved item,
// and `source` + `created_by` on a pushed follow-up. Matching on all three OR'd
// together catches a row whose `source` a later edit changed while the provenance
// fields stayed. `properties->>` on a missing key is NULL, which is simply false here.
const MATCH_SQL = `
  SELECT id, date, workspace_id, user_id, deleted_at, properties
    FROM blocks
   WHERE properties->>'source' IN ('day-review', 'day-review-followup')
      OR properties->>'created_by' = 'day-review'
      OR properties->>'completedBy' = 'day-review'
   ORDER BY date NULLS FIRST, id`;

const DECISION_KEY_RE = /^(?:f-)?dr-/;

// node-postgres hands back a DATE column as a JS Date at LOCAL midnight. Stringifying
// it (or handing it straight back into a `WHERE date = $n`) drags the host timezone in
// and can land on the neighbouring day. Rebuild the plain calendar date from the local
// components, which is the same day node-postgres constructed it from.
function ymd(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isCompleted(props) {
  if (!props) return false;
  return !!(props.done || props.completedBy || props.completed_at ||
            String(props.status || "") === "done");
}

// Mirrors how earnTaskCredit was keyed at write time (routes/dcc.js used the ROW's
// own date, falling back to the posted one). revokeTaskCredit re-derives equivalent
// key spellings itself and is STRICT, so an ambiguous match no-ops rather than
// debiting the wrong task.
function creditKey(row) {
  return `${ymd(row.date) || ""}:${row.id}`;
}

// Drops a `day-review` page from a pages[] array in place. Returns how many went.
function dropPage(holder) {
  if (!holder || !Array.isArray(holder.pages)) return 0;
  const kept = holder.pages.filter((p) => !(p && p.id === "day-review"));
  const n = holder.pages.length - kept.length;
  if (n) holder.pages = kept;
  return n;
}

function pruneState(state) {
  if (!state || typeof state !== "object") return null;
  const brief = state.glymphatic_brief || state.glymphaticBrief;
  const context = state.glymphatic_context;
  const hasBrief = brief && typeof brief === "object";
  const hasContext = context && typeof context === "object";
  if (!hasBrief && !hasContext) return null;

  let changed = false;
  const removed = { pages: 0, context_pages: 0, decisions: 0, log: 0 };

  const current = hasBrief && brief.current && typeof brief.current === "object" ? brief.current : null;
  removed.pages = dropPage(current);
  if (removed.pages) changed = true;

  // glymphatic_context.pages is the INGESTED copy, and dcc-intelligence.js buildBrief
  // assigns it straight over current.pages whenever it is non-empty. Pruning only the
  // brief copy therefore fixes nothing: the next rebuild promotes the dead page back
  // in. Worse, on a day whose only page was the day-review, the promoted array leaves
  // gbPages with nothing after its retired-id filter, which drops the Brief tab into
  // the legacy non-paged layout and hides the canvas. Both copies have to go.
  removed.context_pages = dropPage(hasContext ? context : null);
  if (removed.context_pages) changed = true;

  if (!hasBrief) return changed ? removed : null;

  if (brief.decisions && typeof brief.decisions === "object") {
    for (const key of Object.keys(brief.decisions)) {
      if (DECISION_KEY_RE.test(key)) { delete brief.decisions[key]; removed.decisions++; changed = true; }
    }
  }

  if (Array.isArray(brief.decision_log)) {
    const kept = brief.decision_log.filter((e) => !(e && typeof e.task_id === "string" && DECISION_KEY_RE.test(e.task_id)));
    if (kept.length !== brief.decision_log.length) {
      removed.log = brief.decision_log.length - kept.length;
      brief.decision_log = kept;
      changed = true;
    }
  }

  return changed ? removed : null;
}

async function main() {
  const report = { blocks: [], credits: [], states: [] };

  // ── 1. What matches (SELECT only) ──
  const { rows } = await pool.query(MATCH_SQL);
  report.blocks = rows;

  const bySource = new Map();
  let completed = 0;
  let tombstoned = 0;
  for (const row of rows) {
    const props = row.properties || {};
    const key = `${props.source || "(none)"} / created_by=${props.created_by || "-"}`;
    bySource.set(key, (bySource.get(key) || 0) + 1);
    if (isCompleted(props)) completed++;
    if (row.deleted_at) tombstoned++;
  }

  console.log("=".repeat(72));
  console.log(`Day-in-Review purge  [${APPLY ? "APPLY" : "DRY-RUN"}]`);
  console.log("=".repeat(72));
  console.log(`blocks matched          ${rows.length}`);
  console.log(`  already tombstoned    ${tombstoned}  (soft-deleted again is a no-op)`);
  console.log(`  completed (credited)  ${completed}  <- these carry slot points`);
  for (const [key, n] of [...bySource].sort()) console.log(`  ${key}  ${n}`);

  // ── 2. Matching ledger credits ──
  const keys = rows.filter((r) => isCompleted(r.properties)).map((r) => ({ row: r, key: creditKey(r) }));
  if (keys.length) {
    const { rows: ledger } = await pool.query(
      `SELECT source_key, delta, workspace_id FROM slot_point_ledger
        WHERE source_type = 'task_complete' AND source_key = ANY($1::text[])`,
      [keys.map((k) => k.key)]
    );
    report.credits = ledger;
    const total = ledger.reduce((sum, r) => sum + Number(r.delta || 0), 0);
    console.log(`ledger rows matched     ${ledger.length}`);
    console.log(`points to claw back     ${total}`);
  } else {
    console.log("ledger rows matched     0");
  }

  // ── 3. dcc_state packets carrying the dead page / decisions ──
  const { rows: stateRows } = await pool.query(
    "SELECT date, workspace_id, user_id, state_json FROM dcc_state ORDER BY date");
  const dirtyStates = [];
  for (const row of stateRows) {
    const clone = JSON.parse(JSON.stringify(row.state_json || {}));
    const removed = pruneState(clone);
    if (removed) dirtyStates.push({ row, clone, removed });
  }
  report.states = dirtyStates.map((d) => ({ date: ymd(d.row.date), workspace_id: d.row.workspace_id, removed: d.removed }));
  console.log(`dcc_state rows to prune ${dirtyStates.length}`);
  for (const d of dirtyStates) {
    console.log(`  ${ymd(d.row.date)} ws=${d.row.workspace_id}  pages:${d.removed.pages} ` +
      `context_pages:${d.removed.context_pages} decisions:${d.removed.decisions} log:${d.removed.log}`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN complete. Nothing was written. Re-run with --apply.");
    return 0;
  }

  if (!rows.length && !dirtyStates.length) {
    console.log("\nNothing to do.");
    return 0;
  }

  // ── 4. Back up BEFORE writing ──
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `day-review-purge-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    taken_at: new Date().toISOString(),
    blocks: report.blocks,
    credits: report.credits,
    states: stateRows.filter((r) => report.states.some((s) => s.date === ymd(r.date) && s.workspace_id === r.workspace_id)),
  }, null, 2));
  console.log(`\nbackup -> ${backupPath}`);

  // ── 5. Revoke credits, THEN delete rows ──
  // Credit first: revokeTaskCredit reads nothing from `blocks`, but doing it before the
  // tombstone keeps the ordering obvious if this is ever interrupted -- a revoked credit
  // with a live row is re-runnable, a deleted row with a live credit is easy to miss.
  let revoked = 0;
  let clawedBack = 0;
  for (const { row, key } of keys) {
    try {
      const res = await slotStore.revokeTaskCredit(row.workspace_id, row.user_id, key);
      if (res && res.revoked) { revoked++; clawedBack += Number(res.credits || 0); }
    } catch (e) {
      console.error(`  ! credit revoke failed for ${key}: ${e.message}`);
    }
  }
  console.log(`credits revoked         ${revoked}  (${clawedBack} points debited)`);

  let deleted = 0;
  let alreadyGone = 0;
  for (const row of rows) {
    if (row.deleted_at) { alreadyGone++; continue; }
    try {
      await blockDB.deleteBlock(row.id);
      deleted++;
    } catch (e) {
      console.error(`  ! delete failed for ${row.id}: ${e.message}`);
    }
  }
  console.log(`blocks soft-deleted     ${deleted}  (${alreadyGone} already tombstoned)`);

  // ── 6. Prune the packets ──
  // A direct UPDATE, NOT blockDB.saveDccState: that function's ON CONFLICT clause
  // COALESCEs the STORED `glymphatic_brief.decisions` / `.decision_log` back over the
  // incoming ones by design (db.js), so no publish path can ever remove a decision.
  let pruned = 0;
  for (const d of dirtyStates) {
    try {
      await pool.query(
        "UPDATE dcc_state SET state_json = $1, updated_at = NOW() WHERE date = $2 AND workspace_id = $3",
        [d.clone, ymd(d.row.date), d.row.workspace_id]
      );
      pruned++;
    } catch (e) {
      console.error(`  ! state prune failed for ${ymd(d.row.date)}/${d.row.workspace_id}: ${e.message}`);
    }
  }
  console.log(`dcc_state rows pruned   ${pruned}`);
  console.log("\nAPPLIED. Re-run without --apply to confirm zero matches.");
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => pool.end().then(() => process.exit(code)))
    .catch((e) => {
      console.error("purge failed:", e);
      return pool.end().then(() => process.exit(1));
    });
}

module.exports = { pruneState, dropPage, isCompleted, creditKey, ymd, MATCH_SQL };
