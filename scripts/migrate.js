#!/usr/bin/env node
/**
 * migrate.js — one-shot data migration runner.
 *
 * Deliberately SEPARATE from pg-schema.js, which runs on every boot via
 * `npm start`. Idempotent DDL belongs in the boot path; a heavy one-shot UPDATE
 * across the whole archive does not.
 *
 * Usage:
 *   npm run migrate                    # apply every pending, NON-GATED migration
 *   npm run migrate -- --dry-run       # run inside a transaction, then ROLLBACK
 *   npm run migrate -- --only 001_canonical_model.sql
 *   npm run migrate -- --force         # re-run even if already recorded
 *   npm run migrate -- --list          # show applied/pending/gated, touch nothing
 *
 * Each migration runs inside ONE transaction: it either fully applies or leaves the
 * database untouched. Migrations are written to be re-runnable anyway (every step
 * guards its own writes), so --force is safe; the schema_migrations ledger exists to
 * keep a normal `npm run migrate` from doing pointless work, not as the safety net.
 *
 * GATED MIGRATIONS. A file containing a `-- @gated: <reason>` line is NEVER applied by
 * a bare `npm run migrate`; it runs only when named explicitly with --only. Some data
 * changes are correct but must not land until a matching code change ships (see
 * 002_completion_status.sql, which is unsafe until Phase C0 makes status='done'
 * render). A comment alone would not have stopped the runner, so the gate is
 * mechanical.
 *
 * Migrations RAISE NOTICE their counts. Those notices are captured verbatim into
 * schema_migrations.notes so the audit endpoint and the ship summary can quote the
 * numbers from the run that actually happened rather than re-deriving them.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// MUST precede pg-pool: pg-pool builds its Pool at require time from
// process.env.DATABASE_URL, and pg-pool does not load dotenv itself. Without this the
// pool is constructed with connectionString undefined and falls back to libpq
// defaults, so `npm run migrate` dies with 3D000 (or worse, silently targets a
// different database) on any machine that keeps DATABASE_URL in .env rather than
// exported. Every other DB entry point in this repo does the same: server.js,
// pg-schema.js, scripts/check-db.js.
require("dotenv/config");
const pool = require("../pg-pool");
const { applyPostSchema } = require("../pg-schema");

const GATED_RE = /^\s*--\s*@gated:\s*(.+)$/im;

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, only: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--only") {
      opts.only = argv[++i];
      // Without this, a missing value leaves only=undefined, the `!only` filter in
      // discover() passes everything, and `--only` silently becomes "apply them all"
      // on a runner whose job is one-shot archive-wide writes. A swallowed value also
      // eats the next flag, so `--only --dry-run` would run for real.
      if (!opts.only || opts.only.startsWith("--")) {
        throw new Error("--only requires a migration filename");
      }
    }
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function discover(only) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !only || f === only)
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
      const gated = GATED_RE.exec(sql);
      return {
        filename,
        sql,
        gate: gated ? gated[1].trim() : null,
        checksum: crypto.createHash("sha256").update(sql).digest("hex").slice(0, 16),
      };
    });
}

async function applied() {
  const { rows } = await pool.query("SELECT filename, checksum, applied_at FROM schema_migrations");
  return new Map(rows.map((r) => [r.filename, r]));
}

// Notices arrive as "step1.local_id_stamped=42". Anything that doesn't match that
// shape is kept as a plain message so nothing a migration says is silently dropped.
function collectNotices(client, sink) {
  const onNotice = (n) => {
    const msg = String(n.message || "").trim();
    const m = /^([\w.]+)=(-?\d+)$/.exec(msg);
    if (m) sink.counts[m[1]] = Number(m[2]);
    else sink.messages.push(msg);
    console.log(`    · ${msg}`);
  };
  client.on("notice", onNotice);
  return () => client.removeListener("notice", onNotice);
}

async function runOne(migration, opts) {
  const client = await pool.connect();
  const sink = { counts: {}, messages: [] };
  const detach = collectNotices(client, sink);
  const started = Date.now();
  try {
    await client.query("BEGIN");
    await client.query(migration.sql);
    const durationMs = Date.now() - started;

    if (opts.dryRun) {
      await client.query("ROLLBACK");
      console.log(`  ↩ dry-run: rolled back after ${durationMs}ms`);
      return { ...sink, durationMs, applied: false };
    }

    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, applied_at, duration_ms, notes)
       VALUES ($1, $2, NOW(), $3, $4)
       ON CONFLICT (filename) DO UPDATE
         SET checksum = EXCLUDED.checksum,
             applied_at = EXCLUDED.applied_at,
             duration_ms = EXCLUDED.duration_ms,
             notes = EXCLUDED.notes`,
      [migration.filename, migration.checksum, durationMs, JSON.stringify(sink)]
    );
    await client.query("COMMIT");
    console.log(`  ✓ applied in ${durationMs}ms`);
    return { ...sink, durationMs, applied: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    detach();
    client.release();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, "").replace(/^ ?\* ?/gm, ""));
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  // The migrations call dcc_is_task_row / dcc_resolve_local_id and rely on
  // idx_blocks_local_id for speed, so guarantee the post-schema layer is present
  // before running anything. Idempotent and non-fatal per statement.
  await applyPostSchema();

  const migrations = discover(opts.only);
  if (migrations.length === 0) {
    console.log(opts.only ? `No migration named ${opts.only}` : "No migrations found.");
    return;
  }
  const already = await applied();

  if (opts.list) {
    for (const m of migrations) {
      const rec = already.get(m.filename);
      const drift = rec && rec.checksum !== m.checksum ? "  ⚠ CHANGED SINCE APPLIED" : "";
      const state = rec ? `applied  ${m.filename}  ${rec.applied_at.toISOString()}${drift}`
                        : `${m.gate ? "GATED   " : "pending "} ${m.filename}`;
      console.log(state);
      if (m.gate && !rec) console.log(`         gate: ${m.gate}`);
    }
    return;
  }

  let ran = 0;
  for (const m of migrations) {
    const rec = already.get(m.filename);
    // A gate is skipped unless the operator named this file explicitly. Checked before
    // the applied/force branches so --force alone can never sweep a gated migration in.
    if (m.gate && !opts.only) {
      console.log(`⛔ ${m.filename} is GATED and was NOT run.`);
      console.log(`   gate: ${m.gate}`);
      console.log(`   to run it anyway: npm run migrate -- --only ${m.filename}`);
      continue;
    }
    if (rec && !opts.force) {
      if (rec.checksum !== m.checksum) {
        console.log(`⚠ ${m.filename} was applied at an older checksum (${rec.checksum} → ${m.checksum}).`);
        console.log("  Re-run with --force to apply the current file.");
      } else {
        console.log(`↷ ${m.filename} already applied`);
      }
      continue;
    }
    console.log(`${opts.dryRun ? "▷ dry-run" : "▶ applying"} ${m.filename}`);
    await runOne(m, opts);
    ran++;
  }
  console.log(ran === 0 ? "Nothing to do." : `Done (${ran} migration${ran === 1 ? "" : "s"}).`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("[migrate] FAILED:", err.message);
    if (err.where) console.error("[migrate] where:", err.where);
    process.exitCode = 1;
    await pool.end().catch(() => {});
  });
