"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { compactState } = require("./state-projection");
const { safeCursor, parseHistoryCursor, isGlobalBlock } = require("./sync-store");

test("compact state excludes historical ledgers and keeps active fields", () => {
  const compact = compactState({
    date: "2026-08-31",
    meta: { skill_runs: Array(100).fill({ large: true }) },
    mutations: Array(100).fill({ large: true }),
    triage: { open_items: [{ id: "open" }], resolved_items: [{ id: "old" }], cycle_count: 4 },
    completions: { tasks: [
      { task_id: "review", needs_review: true },
      { task_id: "done", needs_review: false },
      { task_id: "reviewed", needs_review: true, reviewed: true },
    ] },
    schedule: { timeline: [{ id: "legacy" }], working_hours: { start: "07:00" } },
  });
  assert.deepEqual(compact.triage.open_items, [{ id: "open" }]);
  assert.equal(compact.triage.resolved_items, undefined);
  assert.equal(compact.meta, undefined);
  assert.equal(compact.mutations, undefined);
  assert.deepEqual(compact.completions.tasks.map((row) => row.task_id), ["review"]);
  assert.equal(compact.schedule.timeline, undefined);
  assert.deepEqual(compact.schedule.working_hours, { start: "07:00" });
});

test("archive projection keeps the legacy timeline only when requested", () => {
  const compact = compactState({
    date: "2026-05-01",
    schedule: { timeline: [{ id: "legacy" }] },
    meetings: [{ id: "meeting" }],
  }, { archive: true });
  assert.deepEqual(compact.schedule.timeline, [{ id: "legacy" }]);
  assert.deepEqual(compact.meetings, [{ id: "meeting" }]);
});

test("sync cursors reject unsafe values", () => {
  assert.equal(safeCursor("42"), 42);
  assert.throws(() => safeCursor("-1"), /non-negative/);
  assert.throws(() => safeCursor("1.5"), /non-negative/);
  assert.deepEqual(parseHistoryCursor("1788177600000|42"), {
    beforeAt: "2026-08-31T12:00:00.000Z",
    beforeId: "42",
  });
  assert.throws(() => parseHistoryCursor("not-a-cursor"), /invalid history cursor/);
});

test("global classification matches BlockStore partitions", () => {
  assert.equal(isGlobalBlock({ type: "block", date: null, properties: {} }), true);
  assert.equal(isGlobalBlock({ type: "tag", date: null, properties: {} }), true);
  assert.equal(isGlobalBlock({ type: "block", date: "2026-08-31", properties: { tags: ["pinned"] } }), true);
  assert.equal(isGlobalBlock({ type: "block", date: "2026-08-31", properties: {} }), false);
});

test("hot paths use compact projections and server cursor routes", () => {
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const db = fs.readFileSync(path.join(__dirname, "db.js"), "utf8");
  const syncRoute = fs.readFileSync(path.join(__dirname, "routes", "sync.js"), "utf8");
  assert.match(server, /getDccStateCompact\(dateStr, ws\)/);
  assert.match(db, /async function getDccStateCompact/);
  assert.doesNotMatch(db.match(/async function getDccStateRange[\s\S]*?\n\}/)[0], /SELECT \*/);
  assert.match(syncRoute, /\/api\/sync\/bootstrap/);
  assert.match(syncRoute, /\/api\/sync\/pull/);
  assert.match(syncRoute, /\/api\/triage\/history/);
});
