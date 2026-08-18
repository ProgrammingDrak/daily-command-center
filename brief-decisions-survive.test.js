"use strict";

// The Day-in-Review regression: brief `pages` were carried forward across every
// rebuild while `decisions` (the record of "I already approved/dismissed this card")
// were dropped, so every nightly publish re-offered work the user had already
// answered. Nothing asserted this before; the section shipped for months with
// `['current','history']` as the only keys that ever reached disk.

const test = require("node:test");
const assert = require("node:assert/strict");
const dccIntelligence = require("./dcc-intelligence");

const DECISIONS = { "dr-session-abc": { action: "approved", decided_at: "2026-08-17T12:00:00.000Z" } };

function stateWithDecisions() {
  return {
    date: "2026-08-17",
    glymphatic_brief: {
      current: { pages: [{ id: "day-review", items: [{ id: "dr-session-abc", title: "Log the session" }] }] },
      history: [],
      decisions: { ...DECISIONS },
      decision_log: [{ task_id: "dr-session-abc", action: "approved" }],
    },
  };
}

test("buildBrief carries decisions and decision_log forward", () => {
  const state = stateWithDecisions();
  const rebuilt = dccIntelligence.buildBrief({ state, openItems: [], meetings: [], health: [] });

  assert.deepStrictEqual(rebuilt.decisions, DECISIONS, "decisions must survive a rebuild");
  assert.equal(rebuilt.decision_log.length, 1, "decision_log must survive a rebuild");
  // The asymmetry that made this so confusing: the items were always carried forward.
  const page = rebuilt.current.pages.find((p) => p.id === "day-review");
  assert.ok(page && page.items.length === 1, "the items were never the thing being lost");
});

test("buildBrief returns an empty decisions map rather than undefined", () => {
  const rebuilt = dccIntelligence.buildBrief({
    state: { date: "2026-08-17", glymphatic_brief: { current: { pages: [] }, history: [] } },
    openItems: [], meetings: [], health: [],
  });
  assert.deepStrictEqual(rebuilt.decisions, {});
  assert.deepStrictEqual(rebuilt.decision_log, []);
});

test("mergeBriefForIngest keeps existing decisions when a publish omits them", () => {
  const merged = dccIntelligence.mergeBriefForIngest(
    { current: { pages: ["old"] }, decisions: { ...DECISIONS }, decision_log: [{ task_id: "dr-session-abc" }] },
    { current: { pages: ["fresh"] } }
  );
  assert.deepStrictEqual(merged.decisions, DECISIONS, "a publish must not erase the user's answers");
  assert.equal(merged.decision_log.length, 1);
  assert.deepStrictEqual(merged.current.pages, ["fresh"], "but the publish still owns authored content");
});

// Precedence must match db.js saveDccState's ON CONFLICT clause, which COALESCEs the
// STORED decisions over the incoming ones. If this helper let a publish win, it would
// document a contract Postgres silently reverses on every UPDATE.
test("a stored decision always beats an incoming one for the same id", () => {
  const merged = dccIntelligence.mergeBriefForIngest(
    { decisions: { a: { action: "approved" } } },
    { decisions: { a: { action: "dismissed" }, b: { action: "approved" } } }
  );
  assert.equal(merged.decisions.a.action, "approved", "a publish must not overwrite the user's answer");
  assert.equal(merged.decisions.b.action, "approved", "but it may introduce an id the store has never seen");
});

test("a round-tripped decision_log does not double, and stays capped", () => {
  // GET /api/state/day hands back the whole section, log included, so a publisher that
  // echoes what it read is the NORMAL shape here, not an edge case.
  const entry = { task_id: "dr-session-abc", action: "approved", time: null, at: "2026-08-17T12:00:00.000Z" };
  let brief = { decision_log: [entry] };
  for (let i = 0; i < 6; i++) brief = dccIntelligence.mergeBriefForIngest(brief, { ...brief });
  assert.deepStrictEqual(brief.decision_log, [entry], "a round-tripped log must not grow");

  const many = Array.from({ length: 260 }, (_, i) => ({
    task_id: `t${i}`, action: "approve", time: null, at: `2026-08-17T12:00:${String(i % 60).padStart(2, "0")}.000Z`,
  }));
  const capped = dccIntelligence.mergeBriefForIngest({ decision_log: many }, {});
  assert.equal(capped.decision_log.length, 200, "matches the .slice(-200) cap saveDccBriefDecision uses");
  assert.equal(capped.decision_log[199].task_id, "t259", "keeps the newest entries");
});

test("mergeBriefForIngest drops malformed log entries instead of storing them", () => {
  const merged = dccIntelligence.mergeBriefForIngest(
    { decision_log: [null, "nope", { task_id: "ok", action: "approve", at: "2026-08-17T12:00:00.000Z" }] },
    {}
  );
  assert.equal(merged.decision_log.length, 1);
});

test("mergeBriefForIngest tolerates missing and non-object input", () => {
  assert.deepStrictEqual(dccIntelligence.mergeBriefForIngest(null, null).decisions, {});
  assert.deepStrictEqual(dccIntelligence.mergeBriefForIngest(undefined, { decisions: null }).decisions, {});
});
