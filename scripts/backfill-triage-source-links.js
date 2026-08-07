#!/usr/bin/env node
// Restore source deeplinks on the eight triage tasks scheduled on 2026-08-07.
//
// The source items still live in dcc_state.triage.open_items with source_ref
// URLs, but the old triage task serializer omitted source_id. This script is
// deliberately allowlisted to the affected block ids and defaults to a dry run.
// Pass --apply for the transactional update.

require("dotenv").config();

const { taskSourceUrl, taskSourceLabel } = require("../public/js/task-serialize");

const DEFAULT_DATE = "2026-08-07";
const AFFECTED_BLOCK_IDS = Object.freeze([
  "8a3bc0f5-65ab-4c58-8195-261f5e025f4f",
  "6db6209f-1d6e-426f-a9e3-8b91bb6acf60",
  "a7a169d8-2f33-490d-924f-62d56a03c751",
  "eaecaad7-f907-4306-b596-395b0fafd9fe",
  "f9cfd492-52f0-46e5-852f-48ecdcb6d012",
  "9234b22e-1ea2-4e2b-86ec-5bec40445eb1",
  "995a1988-d3dc-4150-b80e-1da589c31596",
  "ea713fe8-8245-42e3-b041-5d48fc79aede",
]);

function triageItems(state) {
  const items = state && state.triage && state.triage.open_items;
  return Array.isArray(items) ? items : [];
}

function buildBackfillPlan(rows, expectedIds = AFFECTED_BLOCK_IDS) {
  const expected = new Set(expectedIds);
  const seen = new Set();
  const candidates = [];
  const alreadyCorrect = [];
  const skipped = [];
  const issues = [];

  for (const row of rows || []) {
    if (!expected.has(row.id)) {
      issues.push({ id: row.id, reason: "not_allowlisted" });
      continue;
    }
    seen.add(row.id);
    if (row.deleted_at) {
      skipped.push({ id: row.id, reason: "deleted" });
      continue;
    }
    const props = row.properties || {};
    if (props.source !== "triage") {
      issues.push({ id: row.id, reason: "not_triage" });
      continue;
    }
    const triageId = String(props.triageId || "").trim();
    const item = triageItems(row.state_json).find((entry) => entry && String(entry.id || "") === triageId);
    if (!triageId || !item) {
      issues.push({ id: row.id, triageId, reason: "source_item_missing" });
      continue;
    }
    const url = taskSourceUrl(item);
    if (!url) {
      issues.push({ id: row.id, triageId, reason: "valid_source_url_missing" });
      continue;
    }
    const existing = String(props.source_id || "").trim();
    if (existing) {
      if (existing === url) alreadyCorrect.push({ id: row.id, triageId, url, label: taskSourceLabel(url) });
      else issues.push({ id: row.id, triageId, reason: "source_id_conflict", existing, expected: url });
      continue;
    }
    candidates.push({ id: row.id, triageId, url, label: taskSourceLabel(url) });
  }

  for (const id of expected) {
    if (!seen.has(id)) issues.push({ id, reason: "allowlisted_block_missing" });
  }
  return { candidates, alreadyCorrect, skipped, issues, expected: expected.size };
}

function printPlan(plan, prefix) {
  console.log(`${prefix}expected=${plan.expected} update=${plan.candidates.length} already_correct=${plan.alreadyCorrect.length} skipped=${plan.skipped.length} issues=${plan.issues.length}`);
  for (const row of plan.candidates) console.log(`  UPDATE ${row.id} ${row.label} ${row.url}`);
  for (const row of plan.alreadyCorrect) console.log(`  KEEP   ${row.id} ${row.label} ${row.url}`);
  for (const row of plan.skipped) console.log(`  SKIP   ${row.id} ${row.reason}`);
  for (const row of plan.issues) console.log(`  ISSUE  ${row.id} ${row.reason}`);
}

async function loadRows(queryable, date) {
  const result = await queryable.query(`
    SELECT b.id, b.properties, b.workspace_id, b.date::text AS date, b.deleted_at, s.state_json
      FROM blocks b
      LEFT JOIN dcc_state s
        ON s.date = b.date AND s.workspace_id = b.workspace_id
     WHERE b.id = ANY($1::text[])
       AND b.date = $2::date
     ORDER BY b.properties->>'start', b.id
  `, [AFFECTED_BLOCK_IDS, date]);
  return result.rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dateArg = argv.indexOf("--date");
  const date = dateArg >= 0 ? argv[dateArg + 1] : DEFAULT_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("--date must be YYYY-MM-DD");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  const pool = require("../pg-pool");
  try {
    const before = buildBackfillPlan(await loadRows(pool, date));
    printPlan(before, apply ? "[APPLY PREFLIGHT] " : "[DRY RUN] ");
    if (before.issues.length) throw new Error("preflight found issues; no rows were changed");
    if (!apply) {
      console.log("[DRY RUN] nothing written; rerun with --apply after reviewing the eight-row plan");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of before.candidates) {
        const result = await client.query(`
          UPDATE blocks
             SET properties = jsonb_set(properties, '{source_id}', to_jsonb($1::text), true),
                 updated_at = NOW()
           WHERE id = $2
             AND deleted_at IS NULL
             AND COALESCE(properties->>'source_id', '') = ''
        `, [row.url, row.id]);
        if (result.rowCount !== 1) throw new Error(`concurrent change prevented update of ${row.id}`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const after = buildBackfillPlan(await loadRows(pool, date));
    printPlan(after, "[VERIFY] ");
    if (after.candidates.length || after.issues.length ||
        after.alreadyCorrect.length + after.skipped.length !== AFFECTED_BLOCK_IDS.length) {
      throw new Error("post-write verification failed");
    }
    console.log(`[APPLIED] restored ${before.candidates.length} source link(s); all ${after.alreadyCorrect.length} live allowlisted rows are correct; ${after.skipped.length} deleted row(s) preserved`);
  } finally {
    await pool.end();
  }
}

module.exports = { AFFECTED_BLOCK_IDS, DEFAULT_DATE, buildBackfillPlan };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[backfill-triage-source-links] ${error.message}`);
    process.exitCode = 1;
  });
}
