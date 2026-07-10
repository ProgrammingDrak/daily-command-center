#!/usr/bin/env node
// backfill-meeting-blocks.mjs
//
// One-time, re-runnable migration. Materializes the meetings[] recorded in every
// historical day into durable meeting task blocks, so the read-time synthesis
// fallback in server.js can be deleted without blanking the past.
//
// It reuses meeting-materializer.materializeMeetings per date with
// hasMeetingsKey=false, which means it NEVER cancels and NEVER resurrects a
// user-deleted meeting (soft-deleted rows are looked up by source_id and skipped).
// The materializer is idempotent and calendar-wins, so re-running is safe.
//
// Two sources of day history:
//   • Filesystem (default): the committed day JSONs under data/state and
//     data/brain. Reflects local commits, not prod writes.
//   • Postgres dcc_state (--from-db): the durable prod day history. This is the
//     truer source for anything ingested on prod but never committed to the repo.
//     Railway's on-host JSON is ephemeral, so the DB is the only real prod record.
//
// Day payloads carry no owner, matching how ingest and reads default (ws-1, null
// user). Pass --workspace-id / --user-id to match a specific deployment. In
// --from-db mode the range is scoped to --workspace-id so the two modes diff
// apples-to-apples.
//
// Usage:
//   node scripts/backfill-meeting-blocks.mjs --dry-run                 # FS, counts only
//   node scripts/backfill-meeting-blocks.mjs                           # FS, apply
//   node scripts/backfill-meeting-blocks.mjs --from-db --dry-run       # prod DB, counts only
//   node scripts/backfill-meeting-blocks.mjs --from-db                 # prod DB, apply
//   node scripts/backfill-meeting-blocks.mjs --from-db --from 2026-01-01 --to 2026-07-10
//   node scripts/backfill-meeting-blocks.mjs --workspace-id ws-1 --user-id 1
//   node scripts/backfill-meeting-blocks.mjs --verbose                 # per-date breakdown
//
// Reads DATABASE_URL from the environment (.env via dotenv, like server.js).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Pure, testable collection + dedup ─────────────────────────────────────────
// A candidate is { date, meetings, ts, source }. Both the filesystem walk and
// the dcc_state read produce candidates in this shape; pickBestByDate reduces
// them the same way regardless of origin.

// pg returns a DATE column as a JS Date at local midnight; day JSONs carry a
// "YYYY-MM-DD" string. Normalize both to the calendar-date string.
function normalizeDate(d) {
  if (d == null) return null;
  if (typeof d === "string") {
    const s = d.slice(0, 10);
    return DATE_RE.test(s) ? s : null;
  }
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return null;
}

// Keep, per date, the newest candidate that actually carries meetings. The
// materializer is calendar-wins and idempotent, so one authoritative pass per
// date is enough. Ties (equal ts) resolve to the later candidate in iteration
// order, matching the original ">=" behavior.
function pickBestByDate(candidates) {
  const bestByDate = new Map(); // date -> { meetings, ts, source }
  for (const c of candidates) {
    if (!c || !c.date || !Array.isArray(c.meetings) || c.meetings.length === 0) continue;
    const prev = bestByDate.get(c.date);
    if (!prev || c.ts >= prev.ts) {
      bestByDate.set(c.date, { meetings: c.meetings, ts: c.ts, source: c.source });
    }
  }
  return bestByDate;
}

function walkJson(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; } // missing dir is fine
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walkJson(full)); continue; }
    if (!e.name.endsWith(".json") || e.name === "manifest.json") continue;
    out.push(full);
  }
  return out;
}

function fileTimestamp(data, file) {
  const raw = data?.last_updated_at || data?.savedAt;
  const t = raw ? Date.parse(raw) : NaN;
  if (!Number.isNaN(t)) return t;
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Filesystem source: walk every store, emit one candidate per readable dated
// file. Returns { candidates, filesScanned }.
function collectFromFiles(stores) {
  const candidates = [];
  let filesScanned = 0;
  for (const store of stores) {
    for (const file of walkJson(store.dir)) {
      let data;
      try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { console.warn(`skip unreadable ${file}: ${e.message}`); continue; }
      filesScanned++;
      let date = normalizeDate(typeof data?.date === "string" ? data.date : null);
      if (!date) {
        const base = path.basename(file, ".json");
        date = DATE_RE.test(base) ? base : null;
      }
      if (!date) continue;
      const meetings = Array.isArray(data?.meetings) ? data.meetings : [];
      candidates.push({ date, meetings, ts: fileTimestamp(data, file), source: store.name });
    }
  }
  return { candidates, filesScanned };
}

// dcc_state source: one candidate per row. Rows are the parsed output of
// db.getDccStateRange ({ date, state_json, updated_at, workspace_id, ... }).
function collectFromDbRows(rows) {
  const candidates = [];
  for (const row of rows || []) {
    const date = normalizeDate(row?.date);
    if (!date) continue;
    const meetings = Array.isArray(row?.state_json?.meetings) ? row.state_json.meetings : [];
    const ts = row?.updated_at ? Date.parse(row.updated_at) : NaN;
    candidates.push({
      date,
      meetings,
      ts: Number.isNaN(ts) ? 0 : ts,
      source: `db:${row?.workspace_id || "?"}`,
    });
  }
  return candidates;
}

// ── Filesystem stores ─────────────────────────────────────────────────────────
const STATE_DIR = path.join(ROOT, "data", "state");
const STORES = [
  { name: "days", dir: path.join(STATE_DIR, "days") },
  { name: "recent", dir: path.join(ROOT, "data", "brain", "recent") },
  { name: "state-archive", dir: path.join(STATE_DIR, "archive") },
  { name: "brain-archive", dir: path.join(ROOT, "data", "brain", "archive") },
];

// ── Materializer (real, or a dry wrapper that counts without writing) ─────────
function makeDryBlockDB(real) {
  let synth = 0;
  return {
    getBlocksByDateIncludingDeleted: (...a) => real.getBlocksByDateIncludingDeleted(...a),
    ensureDayRoot: async () => {},
    createBlock: async (b) => ({ id: `dry-${++synth}`, ...b, deleted_at: null }),
    updateBlock: async (id, patch) => ({ id, ...patch }),
    deleteBlock: async (id) => ({ id }),
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const hasFlag = (f) => argv.includes(f);
  const getOpt = (f, dflt) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
  const DRY = hasFlag("--dry-run");
  const VERBOSE = hasFlag("--verbose");
  const FROM_DB = hasFlag("--from-db");
  const WORKSPACE_ID = getOpt("--workspace-id", "ws-1");
  const USER_ID_RAW = getOpt("--user-id", null);
  const USER_ID = USER_ID_RAW == null ? null : Number(USER_ID_RAW);
  const FROM = getOpt("--from", "2000-01-01");
  const TO = getOpt("--to", "2100-01-01");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Provide it via .env (like the server) or the environment.");
    process.exit(1);
  }

  const blockDB = require("../db.js");
  const pool = require("../pg-pool.js");
  const { scoreTaskPoints } = require("../slot-scoring.js");
  const createMeetingMaterializer = require("../meeting-materializer.js");
  // Shared with server.js so the migration keys blocks exactly like the ingest path.
  const meetingIdentity = require("../meeting-identity.js");
  const APP_TIME_ZONE = process.env.DCC_TIME_ZONE || process.env.APP_TIME_ZONE || "America/New_York";

  // Collect candidates from the chosen source, then reduce to one authoritative
  // set of meetings per date.
  let candidates, scanLabel;
  try {
    if (FROM_DB) {
      const rows = await blockDB.getDccStateRange(FROM, TO, WORKSPACE_ID);
      candidates = collectFromDbRows(rows);
      scanLabel = `${rows.length} dcc_state row(s) in [${FROM}..${TO}] ws=${WORKSPACE_ID}`;
    } else {
      const r = collectFromFiles(STORES);
      candidates = r.candidates;
      scanLabel = `${r.filesScanned} day file(s)`;
    }
  } catch (e) {
    console.error(`failed to read day history (${FROM_DB ? "--from-db" : "filesystem"}): ${e.message}`);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
  }

  const bestByDate = pickBestByDate(candidates);
  const dates = [...bestByDate.keys()].sort();
  console.log(
    `${DRY ? "[DRY RUN] " : ""}source=${FROM_DB ? "dcc_state" : "filesystem"}; scanned ${scanLabel}; ` +
    `${dates.length} date(s) carry meetings; workspace=${WORKSPACE_ID} user=${USER_ID ?? "null"}`
  );

  const effectiveBlockDB = DRY ? makeDryBlockDB(blockDB) : blockDB;
  const { materializeMeetings } = createMeetingMaterializer({
    blockDB: effectiveBlockDB, scoreTaskPoints, meetingIdentity, APP_TIME_ZONE,
  });

  const totals = { created: 0, updated: 0, skipped: 0, dates: 0, meetings: 0, errors: 0 };
  try {
    for (const date of dates) {
      const { meetings, source } = bestByDate.get(date);
      totals.meetings += meetings.length;
      try {
        const res = await materializeMeetings({
          date, meetings, userId: USER_ID, workspaceId: WORKSPACE_ID, hasMeetingsKey: false,
        });
        totals.created += res.created;
        totals.updated += res.updated;
        totals.skipped += res.skipped;
        totals.dates++;
        if (VERBOSE) {
          console.log(
            `  ${date} [${source}] meetings=${meetings.length} ` +
            `created=${res.created} updated=${res.updated} skipped=${res.skipped}`
          );
        }
      } catch (e) {
        totals.errors++;
        console.error(`  ${date}: FAILED ${e.message}`);
      }
    }
  } finally {
    try { await pool.end(); } catch { /* ignore */ }
  }

  console.log(
    `${DRY ? "[DRY RUN] " : ""}done: ${totals.dates}/${dates.length} date(s), ` +
    `${totals.meetings} meeting record(s) -> created=${totals.created} updated=${totals.updated} ` +
    `skipped=${totals.skipped} errors=${totals.errors}` +
    (DRY ? "  (nothing written)" : "")
  );
  process.exit(totals.errors ? 1 : 0);
}

// Exported for unit tests; the DB/materializer wiring stays inside main() so
// importing this module never opens a pool or calls process.exit.
export { normalizeDate, pickBestByDate, collectFromFiles, collectFromDbRows, STORES };

// Run only when invoked directly, not when imported by a test.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
