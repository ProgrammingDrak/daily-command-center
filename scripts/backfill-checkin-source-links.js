#!/usr/bin/env node
// Stamp the missing origin permalink onto Waiting check-in reminders.
//
// Every reminder spawned before scheduleDelegatedItem started forwarding the
// item's deeplink persisted `source_id: ""`, so its row renders no Slack chip.
// The client heals most of them live (checkInSourceUrl legs 2 and 3), but a
// resolved link is not a STORED one: the row still has to re-derive it on every
// paint, and an item that is later purged outright takes leg 2 with it. This
// writes the answer down once.
//
// Resolution mirrors the client exactly, best evidence first:
//   1. the reminder's Waiting item, live and in the same workspace;
//   2. the reminder's own `detail` prose, which is where an ORPHAN's permalink
//      survives after its item is gone.
// Rows that resolve to nothing are reported and left alone -- a manually typed
// check-in has no origin to point at and is not a defect.
//
// Not allowlisted to specific ids (unlike backfill-triage-source-links): the
// affected set is "every reminder made before that line existed", which grows
// with each day of history rather than being eight known rows. The guards that
// replace the allowlist are the empty-source_id precondition on both the SELECT
// and the UPDATE, the dry run default, and the post-write verification pass.

require("dotenv").config();

const { taskSourceUrl, taskSourceLabel, recoverSourceUrl } = require("../public/js/task-serialize");

const CHECKIN_SOURCE = "waiting-checkin";
const CHECKIN_LOCAL_ID = /^waiting-checkin-task:(.+)$/;

// The Waiting item a reminder points at. `delegatedItemId` is the stamped edge;
// the local_id suffix is the older spelling, and still the only one on the very
// first reminders. Same two-step the client's checkInItemId does.
function waitingItemIdFor(props) {
  const stamped = String((props && props.delegatedItemId) || "").trim();
  if (stamped) return stamped;
  const match = CHECKIN_LOCAL_ID.exec(String((props && props.local_id) || ""));
  return match ? match[1].trim() : "";
}

// The item's deeplink, in the one precedence delegated.js's waitingSourceRef uses.
// Kept as a plain re-implementation rather than a require of the browser file: that
// module is an IIFE around `window`, and the two are pinned together by a test.
function itemSourceRef(props) {
  const p = props || {};
  const stored = String((p.contact && p.contact.sourceRef) || p.source_id || "").trim();
  if (stored) return stored;
  return recoverSourceUrl(p.notes) || recoverSourceUrl(p.captureNotes);
}

function buildBackfillPlan(rows, items) {
  const byId = new Map();
  for (const item of items || []) {
    if (!item || item.deleted_at) continue;
    byId.set(String(item.workspace_id || "") + "|" + String(item.id), item.properties || {});
  }

  const candidates = [];
  const unresolved = [];
  const issues = [];

  for (const row of rows || []) {
    const props = row.properties || {};
    if (row.deleted_at) { issues.push({ id: row.id, reason: "deleted" }); continue; }
    if (props.source !== CHECKIN_SOURCE) { issues.push({ id: row.id, reason: "not_a_check_in" }); continue; }
    if (String(props.source_id || "").trim()) { issues.push({ id: row.id, reason: "already_linked" }); continue; }

    const itemId = waitingItemIdFor(props);
    const itemProps = itemId ? byId.get(String(row.workspace_id || "") + "|" + itemId) : null;
    const viaItem = itemProps ? taskSourceUrl(itemSourceRef(itemProps)) : "";
    const url = viaItem || recoverSourceUrl(props.detail);

    if (!url) {
      unresolved.push({ id: row.id, date: row.date, itemId: itemId || null, title: props.title || "" });
      continue;
    }
    candidates.push({
      id: row.id,
      date: row.date,
      title: props.title || "",
      url,
      label: taskSourceLabel(url),
      via: viaItem ? "waiting_item" : "detail_prose",
    });
  }
  return { candidates, unresolved, issues };
}

function printPlan(plan, prefix) {
  console.log(`${prefix}update=${plan.candidates.length} unresolved=${plan.unresolved.length} issues=${plan.issues.length}`);
  for (const row of plan.candidates) console.log(`  UPDATE ${row.id} ${row.date} [${row.via}] ${row.label} ${row.url}`);
  for (const row of plan.unresolved) console.log(`  LEAVE  ${row.id} ${row.date} no recoverable origin -- "${row.title}"`);
  for (const row of plan.issues) console.log(`  ISSUE  ${row.id} ${row.reason}`);
}

// Only rows that are actually missing a link are selected, so a re-run after a
// successful apply is a no-op rather than an overwrite.
async function loadRows(queryable) {
  const result = await queryable.query(`
    SELECT id, workspace_id, date::text AS date, properties, deleted_at
      FROM blocks
     WHERE deleted_at IS NULL
       AND properties->>'source' = $1
       AND COALESCE(properties->>'source_id', '') = ''
     ORDER BY date NULLS LAST, properties->>'start', id
  `, [CHECKIN_SOURCE]);
  return result.rows;
}

async function loadItems(queryable) {
  const result = await queryable.query(`
    SELECT id, workspace_id, properties, deleted_at
      FROM blocks
     WHERE deleted_at IS NULL
       AND properties->>'kind' = 'delegated_item'
  `);
  return result.rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  const pool = require("../pg-pool");
  try {
    const before = buildBackfillPlan(await loadRows(pool), await loadItems(pool));
    printPlan(before, apply ? "[APPLY PREFLIGHT] " : "[DRY RUN] ");
    // `issues` cannot fire from the SELECT above (it already filters on all three
    // conditions), so one appearing means the query and this planner have drifted.
    if (before.issues.length) throw new Error("preflight found issues; no rows were changed");
    if (!apply) {
      console.log("[DRY RUN] nothing written; rerun with --apply after reviewing the plan");
      return;
    }
    if (!before.candidates.length) {
      console.log("[APPLIED] nothing to do; every check-in already carries a link or has no recoverable origin");
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

    // Re-running the SELECT is the verification: a written row no longer matches
    // its empty-source_id filter, so anything still listed as a candidate failed.
    const after = buildBackfillPlan(await loadRows(pool), await loadItems(pool));
    printPlan(after, "[VERIFY] ");
    if (after.candidates.length || after.issues.length) throw new Error("post-write verification failed");
    console.log(`[APPLIED] stamped ${before.candidates.length} check-in source link(s); ${after.unresolved.length} row(s) have no recoverable origin and were left alone`);
  } finally {
    await pool.end();
  }
}

module.exports = { CHECKIN_SOURCE, waitingItemIdFor, itemSourceRef, buildBackfillPlan };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[backfill-checkin-source-links] ${error.message}`);
    process.exitCode = 1;
  });
}
