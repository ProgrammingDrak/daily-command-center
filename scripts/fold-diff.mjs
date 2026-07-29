#!/usr/bin/env node
// fold-diff.mjs — does a data change alter WHAT RENDERS on the itinerary?
//
// The acceptance test for any migration or backfill that claims "zero behavior
// change". Row counts and totals cannot answer that question: this project's first
// migration attempt kept the ledger byte-identical, passed the smoke suite, and still
// moved 572 rows on and off the itinerary. Two effects even partly cancelled in the
// aggregate (1501 foldable before, 1419 after) which is exactly how it hid.
//
// The trap it exists to catch: writes to properties are NOT inert in this codebase.
// The client's fold predicate branches on the PRESENCE of properties.local_id and on
// specific properties.status values, so an "additive" backfill is a visibility change.
//
// Usage:
//   node scripts/fold-diff.mjs snapshot before      # against DATABASE_URL
//   npm run migrate
//   node scripts/fold-diff.mjs snapshot after
//   node scripts/fold-diff.mjs compare              # exits 1 if anything moved
//
// Point DATABASE_URL at a DISPOSABLE restore of prod, not prod. This measures a real
// apply, so it has to actually apply; `migrate --dry-run` rolls its own body back and
// therefore cannot show you what the migration would do.
//
// Snapshots land in .fold-snapshots/ (gitignored scratch, safe to delete).
//
// This mirrors public/js/persistence.js isFoldableTask. If that predicate changes --
// and Phase C0 changes it deliberately -- update FOLD_SQL in the same commit, or this
// script silently starts measuring the wrong thing. That coupling is the point: it
// forces the two to be reasoned about together.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP_DIR = join(ROOT, ".fold-snapshots");

// Mirrors what the itinerary actually RENDERS: isFoldableTask (persistence.js) minus
// the per-day _deleted overlay that the client applies after the fold. Kept as one SQL
// string so it is auditable side by side with the JS.
//
// The overlay subtraction is not optional. Without it this tool flags every row that a
// migration converts from "hidden by day_root._deleted" to "hidden by deleted_at" as a
// regression, when the user sees no difference either way. Measured: 86 false alarms.
const FOLD_SQL = `
  WITH del AS (
    SELECT r.workspace_id, r.date, x.lid
      FROM blocks r
      CROSS JOIN LATERAL jsonb_array_elements_text(r.properties->'_deleted') AS x(lid)
     WHERE r.type = 'day_root' AND jsonb_typeof(r.properties->'_deleted') = 'array'
  )
  SELECT b.id,
         COALESCE(b.properties->>'kind', '(nokind)')     AS kind,
         COALESCE(b.properties->>'status', '(none)')     AS status,
         COALESCE(left(b.properties->>'title', 60), '')  AS title,
         COALESCE(b.date::text, '(dateless)')            AS date,
         -- A dateless row the user deleted on at least one day. It still renders on
         -- OTHER days today (the overlay is per-day), so removing it IS a visibility
         -- change -- but an intended one: the user asked for it to go, repeatedly, and
         -- its reappearance is the resurrection bug this project exists to fix.
         -- Classified rather than hidden, so the judgment stays visible.
         (CASE WHEN b.date IS NULL AND EXISTS (
             SELECT 1 FROM del d
              WHERE d.workspace_id IS NOT DISTINCT FROM b.workspace_id
                AND d.lid IN (b.id, b.properties->>'local_id'))
           THEN 'user-deleted-dateless' ELSE '' END)                AS intended
    FROM blocks b
   WHERE b.type = 'block'
     AND b.deleted_at IS NULL
     -- Hidden client-side by its own day's delete overlay. Dated rows only: a dateless
     -- row folds onto every day, so being listed on one day still leaves it rendering
     -- elsewhere, and "renders somewhere" is the granularity this test cares about.
     AND NOT ( b.date IS NOT NULL AND EXISTS (
           SELECT 1 FROM del d
            WHERE d.workspace_id IS NOT DISTINCT FROM b.workspace_id
              AND d.date IS NOT DISTINCT FROM b.date
              AND d.lid IN (b.id, b.properties->>'local_id')) )
     -- persistence.js: responsibility scaffolding and move tombstones never fold
     AND COALESCE(b.properties->>'kind', '') NOT LIKE 'responsibility%'
     AND COALESCE(b.properties->>'kind', '') <> 'reschedule_tombstone'
     -- persistence.js:261 -- these three statuses drop the row out of the fold
     AND COALESCE(b.properties->>'status', '') NOT IN ('deleted', 'archived', 'done')
     -- persistence.js:262 -- a local_id IS the admission ticket, or kind/shell/meeting
     AND ( b.properties->>'local_id' IS NOT NULL
        OR b.properties->>'kind' = 'task'
        OR b.properties->>'kind' = 'shell'   OR b.properties->>'type' = 'shell'
        OR b.properties->>'kind' = 'meeting' OR b.properties->>'type' = 'meeting'
        OR b.properties->>'type' = 'oneone' )
   ORDER BY b.id`;

function psql(sql) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(2);
  }
  return execFileSync("psql", [url, "-t", "-A", "-F", "\t", "-c", sql], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
}

function snapshot(label) {
  mkdirSync(SNAP_DIR, { recursive: true });
  const out = psql(FOLD_SQL).trim();
  const rows = out ? out.split("\n") : [];
  writeFileSync(join(SNAP_DIR, `${label}.tsv`), rows.join("\n"));
  console.log(`${label}: ${rows.length} foldable rows -> .fold-snapshots/${label}.tsv`);
  return rows.length;
}

function load(label) {
  const p = join(SNAP_DIR, `${label}.tsv`);
  if (!existsSync(p)) {
    console.error(`ERROR: no '${label}' snapshot. Run: node scripts/fold-diff.mjs snapshot ${label}`);
    process.exit(2);
  }
  const txt = readFileSync(p, "utf8").trim();
  const rows = txt ? txt.split("\n") : [];
  return new Map(rows.map((r) => {
    const [id, ...rest] = r.split("\t");
    return [id, rest];
  }));
}

function describe(fields) {
  const [kind, status, title, date] = fields;
  return `${(title || "(untitled)").slice(0, 52).padEnd(52)}  ${kind}/${status}  ${date}`;
}

const INTENDED_IDX = 4; // the `intended` column in FOLD_SQL

function compare() {
  const before = load("before");
  const after = load("after");

  const allVanished = [...before.keys()].filter((id) => !after.has(id));
  const appeared = [...after.keys()].filter((id) => !before.has(id));

  // An intended removal is still a visibility change; it is just one somebody decided
  // on. Split it out rather than filtering it away, so the decision stays auditable.
  const intended = allVanished.filter((id) => (before.get(id)[INTENDED_IDX] || "") !== "");
  const vanished = allVanished.filter((id) => (before.get(id)[INTENDED_IDX] || "") === "");

  console.log(`\nrendering before: ${before.size}`);
  console.log(`rendering after:  ${after.size}`);
  console.log(`\nVANISHED, unexplained: ${vanished.length}`);
  console.log(`APPEARED: ${appeared.length}`);
  if (intended.length) console.log(`vanished but classified INTENDED: ${intended.length}`);

  if (intended.length) {
    console.log("\n── INTENDED removals (reviewed, not failures) ──");
    for (const id of intended) {
      console.log(`  ${describe(before.get(id))}   [${before.get(id)[INTENDED_IDX]}]`);
    }
  }

  // Aggregate counts hide this: report the two directions separately, always.
  for (const [heading, ids, src] of [
    ["VANISHED", vanished, before], ["APPEARED", appeared, after],
  ]) {
    if (!ids.length) continue;
    console.log(`\n── ${heading} ──`);
    const byGroup = new Map();
    for (const id of ids) {
      const f = src.get(id);
      const k = `${f[0]}/${f[1]}`;
      byGroup.set(k, (byGroup.get(k) || 0) + 1);
    }
    for (const [k, n] of [...byGroup].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${k}`);
    }
    console.log("  samples:");
    for (const id of ids.slice(0, 5)) console.log(`    ${describe(src.get(id))}`);
  }

  const moved = vanished.length + appeared.length;
  if (moved === 0) {
    console.log(intended.length
      ? `\nPASS: nothing moved unexplained (${intended.length} intended removal(s) listed above).`
      : "\nPASS: nothing moved on or off the itinerary.");
    return 0;
  }
  console.log(`\nFAIL: ${moved} rows changed visibility. A backfill claiming zero`);
  console.log("behavior change cannot do this. Narrow what it writes, or gate it");
  console.log("behind the code change that makes the new value render correctly.");
  return 1;
}

const [cmd, label] = process.argv.slice(2);
if (cmd === "snapshot") {
  if (!label) { console.error("usage: fold-diff.mjs snapshot <before|after>"); process.exit(2); }
  snapshot(label);
} else if (cmd === "compare") {
  process.exit(compare());
} else {
  console.error("usage: fold-diff.mjs snapshot <before|after> | compare");
  process.exit(2);
}
