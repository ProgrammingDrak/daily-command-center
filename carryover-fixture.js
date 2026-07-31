// Shared test fixture shim for the carryover lane (C2).
//
// The carryover tests describe a world as `{ "2026-07-28": [dayRoot, blk, blk] }` —
// the shape blockStore's range cache used to serve, back when collectUnfinished
// scanned archived days itself. C2 moved that scan behind GET /api/tasks/open, so the
// collector now reads a payload instead of a cache. This turns one into the other so
// every existing fixture keeps working and the tests keep testing the collector
// rather than a rewritten harness.
//
// It deliberately applies ONLY the date window. The rest of the predicate (row types,
// task-kind, fixed-type skip, start-or-nested, roots-only, and the descendant
// re-filter) is SQL now and is pinned in open-tasks-query.test.js against the query
// itself. Reimplementing it here would let a broken predicate pass on both sides,
// which is the failure mode this split exists to prevent.
"use strict";

// Mirrors db.getCarryoverPool's contract: { rows, overlays, scanned }.
// `overlays[date]` carries the day_root slice the collector needs — done ids and
// locked ids — because locks live on the ORIGIN day's day_root, never on the block.
function payloadFrom(daysByDate, { before, days } = {}) {
  const dates = Object.keys(daysByDate)
    .filter((d) => !before || d < before)
    .filter((d) => {
      if (days == null) return true;
      const floor = new Date(before + "T00:00:00Z");
      floor.setUTCDate(floor.getUTCDate() - days);
      return d >= floor.toISOString().slice(0, 10);
    })
    .sort()
    .reverse();

  const rows = [];
  const overlays = {};
  for (const date of dates) {
    const blocks = daysByDate[date] || [];
    const root = blocks.find((b) => b.type === "day_root");
    const rp = (root && root.properties) || {};
    const locked = rp._lockedTasks;
    overlays[date] = {
      done: Array.isArray(rp._done && rp._done.ids) ? rp._done.ids : [],
      locked: Array.isArray(locked) ? locked : (locked ? Object.keys(locked) : [])
    };
    for (const b of blocks) {
      if (b.type === "day_root") continue;
      rows.push(Object.assign({}, b, { date: b.date || date }));
    }
  }
  // `scanned` counts the dates that actually YIELDED rows, matching what
  // getCarryoverPool computes (its `dates` comes from the returned pool, so a day
  // whose only rows were filtered out contributes nothing). Counting date keys here
  // instead would pin client tests to a number production never produces.
  return { rows, overlays, scanned: new Set(rows.map((r) => r.date)).size };
}

// The DCC.api stub the collector calls. Parses the same query string the real
// endpoint parses, so a change to how the collector builds that URL shows up here.
function apiStub(daysByDate) {
  return async function api(url) {
    const qs = String(url).split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const rawDays = params.get("days") || "";
    const days = rawDays === "all" ? null : (parseInt(rawDays, 10) || 14);
    return payloadFrom(daysByDate, { before: params.get("before"), days });
  };
}

module.exports = { payloadFrom, apiStub };
