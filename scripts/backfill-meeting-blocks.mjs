#!/usr/bin/env node
// backfill-meeting-blocks.mjs
//
// One-time, re-runnable migration. Materializes the meetings[] recorded in every
// historical day file into durable meeting task blocks, so the read-time synthesis
// fallback in server.js can be deleted without blanking the past.
//
// It reuses meeting-materializer.materializeMeetings per date with
// hasMeetingsKey=false, which means it NEVER cancels and NEVER resurrects a
// user-deleted meeting (soft-deleted rows are looked up by source_id and skipped).
// The materializer is idempotent and calendar-wins, so re-running is safe.
//
// Day files carry no owner, matching how ingest and reads default (ws-1, null
// user). Pass --workspace-id / --user-id to match a specific deployment.
//
// Usage:
//   node scripts/backfill-meeting-blocks.mjs --dry-run       # counts only, writes nothing
//   node scripts/backfill-meeting-blocks.mjs                 # apply
//   node scripts/backfill-meeting-blocks.mjs --workspace-id ws-1 --user-id 1
//   node scripts/backfill-meeting-blocks.mjs --verbose       # per-date breakdown
//
// Reads DATABASE_URL from the environment (.env via dotenv, like server.js).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const blockDB = require("../db.js");
const pool = require("../pg-pool.js");
const { scoreTaskPoints } = require("../slot-scoring.js");
const createMeetingMaterializer = require("../meeting-materializer.js");

// Same identity precedence as server.js meetingIdentity.
const meetingIdentity = (m) =>
  String(m?.event_id || m?.source_id || m?.gcal_event_id || m?.id || "").trim();

const APP_TIME_ZONE = process.env.DCC_TIME_ZONE || process.env.APP_TIME_ZONE || "America/New_York";

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const getOpt = (f, dflt) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const DRY = hasFlag("--dry-run");
const VERBOSE = hasFlag("--verbose");
const WORKSPACE_ID = getOpt("--workspace-id", "ws-1");
const USER_ID_RAW = getOpt("--user-id", null);
const USER_ID = USER_ID_RAW == null ? null : Number(USER_ID_RAW);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Provide it via .env (like the server) or the environment.");
  process.exit(1);
}

// ── Day-file stores ──────────────────────────────────────────────────────────
// A date can appear in more than one store. We keep the most-recently-saved file
// per date and materialize its meetings[] once (the materializer is calendar-wins
// and idempotent, so one authoritative pass per date is enough).
const STATE_DIR = path.join(ROOT, "data", "state");
const STORES = [
  { name: "days", dir: path.join(STATE_DIR, "days") },
  { name: "recent", dir: path.join(ROOT, "data", "brain", "recent") },
  { name: "state-archive", dir: path.join(STATE_DIR, "archive") },
  { name: "brain-archive", dir: path.join(ROOT, "data", "brain", "archive") },
];

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function fileTimestamp(data, file) {
  const raw = data?.last_updated_at || data?.savedAt;
  const t = raw ? Date.parse(raw) : NaN;
  if (!Number.isNaN(t)) return t;
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Group by date -> keep the newest file that actually carries meetings.
const bestByDate = new Map(); // date -> { file, store, ts, meetings }
let filesScanned = 0;
for (const store of STORES) {
  for (const file of walkJson(store.dir)) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { console.warn(`skip unreadable ${file}: ${e.message}`); continue; }
    filesScanned++;
    let date = typeof data?.date === "string" ? data.date : null;
    if (!date || !DATE_RE.test(date)) {
      const base = path.basename(file, ".json");
      date = DATE_RE.test(base) ? base : null;
    }
    if (!date) continue;
    const meetings = Array.isArray(data?.meetings) ? data.meetings : [];
    if (meetings.length === 0) continue; // nothing to materialize from this file
    const ts = fileTimestamp(data, file);
    const prev = bestByDate.get(date);
    if (!prev || ts >= prev.ts) bestByDate.set(date, { file, store: store.name, ts, meetings });
  }
}

const dates = [...bestByDate.keys()].sort();
console.log(
  `${DRY ? "[DRY RUN] " : ""}scanned ${filesScanned} day file(s); ` +
  `${dates.length} date(s) carry meetings; workspace=${WORKSPACE_ID} user=${USER_ID ?? "null"}`
);

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

const effectiveBlockDB = DRY ? makeDryBlockDB(blockDB) : blockDB;
const { materializeMeetings } = createMeetingMaterializer({
  blockDB: effectiveBlockDB, scoreTaskPoints, meetingIdentity, APP_TIME_ZONE,
});

// ── Run ───────────────────────────────────────────────────────────────────────
const totals = { created: 0, updated: 0, skipped: 0, dates: 0, meetings: 0, errors: 0 };
try {
  for (const date of dates) {
    const { meetings, store } = bestByDate.get(date);
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
          `  ${date} [${store}] meetings=${meetings.length} ` +
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
