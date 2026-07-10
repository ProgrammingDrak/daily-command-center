// Unit tests for the pure collection/dedup helpers in
// scripts/backfill-meeting-blocks.mjs. Exercises the newest-wins dedup, the
// meetings-carrying filter, DATE-column normalization, and the dcc_state row
// shape (--from-db) without opening a pool — the DB read path is tested by
// feeding rows shaped exactly like db.getDccStateRange output.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  normalizeDate,
  pickBestByDate,
  collectFromDbRows,
  collectFromFiles,
} from "./scripts/backfill-meeting-blocks.mjs";

const MODULE_URL = new URL("./scripts/backfill-meeting-blocks.mjs", import.meta.url).href;

const mtg = (id) => ({ event_id: id, title: id, start: "2026-06-17T16:00:00Z", end: "2026-06-17T17:00:00Z" });

test("normalizeDate: string, ISO datetime, Date object, and junk", () => {
  assert.equal(normalizeDate("2026-06-17"), "2026-06-17");
  assert.equal(normalizeDate("2026-06-17T00:00:00Z"), "2026-06-17");
  // pg hands back a DATE column as a local-midnight Date; local getters invert it.
  assert.equal(normalizeDate(new Date(2026, 5, 17)), "2026-06-17");
  assert.equal(normalizeDate(null), null);
  assert.equal(normalizeDate("nope"), null);
  assert.equal(normalizeDate(new Date("invalid")), null);
});

test("pickBestByDate: keeps the newest candidate per date", () => {
  const best = pickBestByDate([
    { date: "2026-06-17", meetings: [mtg("old")], ts: 100, source: "a" },
    { date: "2026-06-17", meetings: [mtg("new")], ts: 200, source: "b" },
  ]);
  assert.equal(best.size, 1);
  assert.equal(best.get("2026-06-17").source, "b");
  assert.equal(best.get("2026-06-17").meetings[0].event_id, "new");
});

test("pickBestByDate: equal ts resolves to later candidate (matches original >=)", () => {
  const best = pickBestByDate([
    { date: "2026-06-17", meetings: [mtg("first")], ts: 100, source: "a" },
    { date: "2026-06-17", meetings: [mtg("second")], ts: 100, source: "b" },
  ]);
  assert.equal(best.get("2026-06-17").source, "b");
});

test("pickBestByDate: skips empty/absent meetings, keeps distinct dates", () => {
  const best = pickBestByDate([
    { date: "2026-06-17", meetings: [], ts: 100, source: "a" },
    { date: "2026-06-18", meetings: [mtg("x")], ts: 100, source: "b" },
    { date: "2026-06-19", meetings: null, ts: 100, source: "c" },
    { date: null, meetings: [mtg("y")], ts: 100, source: "d" },
  ]);
  assert.deepEqual([...best.keys()].sort(), ["2026-06-18"]);
});

test("pickBestByDate: a later empty file does NOT clobber an earlier meetings-carrying one", () => {
  // Empty candidates are filtered before dedup, so a newer blank day can't erase
  // a real meetings[] for the same date.
  const best = pickBestByDate([
    { date: "2026-06-17", meetings: [mtg("real")], ts: 100, source: "a" },
    { date: "2026-06-17", meetings: [], ts: 999, source: "b" },
  ]);
  assert.equal(best.get("2026-06-17").meetings[0].event_id, "real");
});

test("collectFromDbRows: maps getDccStateRange rows to candidates", () => {
  const rows = [
    { date: new Date(2026, 5, 17), state_json: { meetings: [mtg("a")] }, updated_at: "2026-06-17T12:00:00Z", workspace_id: "ws-1" },
    { date: "2026-06-18", state_json: { meetings: [mtg("b")] }, updated_at: "2026-06-18T12:00:00Z", workspace_id: "ws-1" },
    { date: "2026-06-19", state_json: {}, updated_at: "2026-06-19T12:00:00Z", workspace_id: "ws-1" }, // no meetings key
    { date: null, state_json: { meetings: [mtg("c")] }, updated_at: "x", workspace_id: "ws-1" }, // bad date -> dropped
  ];
  const candidates = collectFromDbRows(rows);
  assert.equal(candidates.length, 3); // null-date row dropped
  const c0 = candidates.find((c) => c.date === "2026-06-17");
  assert.equal(c0.meetings[0].event_id, "a");
  assert.equal(c0.source, "db:ws-1");
  assert.equal(c0.ts, Date.parse("2026-06-17T12:00:00Z"));
  const c2 = candidates.find((c) => c.date === "2026-06-19");
  assert.deepEqual(c2.meetings, []); // missing meetings -> [], filtered later by pickBestByDate
});

test("collectFromDbRows -> pickBestByDate: empty input yields nothing", () => {
  assert.equal(pickBestByDate(collectFromDbRows([])).size, 0);
  assert.equal(pickBestByDate(collectFromDbRows(null)).size, 0);
});

test("collectFromDbRows: missing updated_at -> ts=0; missing workspace_id -> db:? source", () => {
  // Defensive branches: the schema makes updated_at/workspace_id non-null, but a
  // valid-date row lacking them must degrade rather than NaN-poison the dedup.
  const candidates = collectFromDbRows([
    { date: "2026-06-20", state_json: { meetings: [mtg("z")] } },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].ts, 0);
  assert.equal(candidates[0].source, "db:?");
});

test("collectFromFiles: dated files, basename fallback, skips undated/manifest/unreadable, newest wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-fs-"));
  try {
    // Two files for the same date -> newest by last_updated_at wins.
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ date: "2026-06-17", meetings: [mtg("old")], last_updated_at: "2026-06-17T10:00:00Z" }));
    fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ date: "2026-06-17", meetings: [mtg("new")], last_updated_at: "2026-06-17T12:00:00Z" }));
    // Date only in the basename (no `date` key).
    fs.writeFileSync(path.join(dir, "2026-06-18.json"), JSON.stringify({ meetings: [mtg("base")] }));
    // No date anywhere -> dropped.
    fs.writeFileSync(path.join(dir, "nodate.json"), JSON.stringify({ meetings: [mtg("x")] }));
    // manifest.json -> ignored by the walk by name.
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ date: "2026-06-19", meetings: [mtg("m")] }));
    // Unreadable -> warn + skip (not counted in filesScanned).
    fs.writeFileSync(path.join(dir, "bad.json"), "{ not json");

    const { candidates, filesScanned } = collectFromFiles([{ name: "t", dir }]);
    assert.equal(filesScanned, 4); // a, b, 2026-06-18, nodate (manifest by-name, bad.json unparseable)
    const best = pickBestByDate(candidates);
    assert.deepEqual([...best.keys()].sort(), ["2026-06-17", "2026-06-18"]);
    assert.equal(best.get("2026-06-17").meetings[0].event_id, "new");
    assert.equal(best.get("2026-06-18").meetings[0].event_id, "base");
    assert.equal(best.get("2026-06-17").source, "t");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importing the module runs no main(): clean exit, no output, even without DATABASE_URL", () => {
  // Guards the CLI entrypoint check: a regression that let main() run on import
  // would either exit 1 (missing DATABASE_URL) or open a pool — both fail here.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(MODULE_URL)})`],
    { env, encoding: "utf8", timeout: 20000 }
  );
  assert.equal(res.status, 0, `nonzero exit; stderr: ${res.stderr}`);
  assert.equal(res.stdout.trim(), "");
});
