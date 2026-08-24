// The dialog half of "tracked time is transferrable and splittable".
//
// The store and route halves are pinned in time-reallocation.test.js and
// time-reallocate-route.test.js. What only the CLIENT can get wrong is the
// arithmetic it claims is identical to the server's, and the file says so in its
// own header: "The LAST piece always takes the remainder, on the server and here,
// so the arithmetic cannot drift between the two." Nothing held those two
// implementations together until this file.
//
// The dialog's logic is closure-private (an IIFE exposing only open/close/refreshDate),
// and every regression the five-lane review found in it was STRUCTURAL: a duplicated
// readiness rule that drifted, state read after an await, a hand-rolled predicate that
// disagreed with the server's, a second hardcoded ceiling, four helpers reimplemented.
// So this file pins the structure and the cross-layer parity, and checks the arithmetic
// against the server's own planner rather than a hand-written expectation. Behavioral
// coverage of the reallocation itself lives in the store and route tests, which can
// exercise it for real.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require.resolve("./public/js/time-reallocate.js"), "utf8");
const { MAX_ALLOCATION_PARTS, planAllocations } = require("./lib/task-timing");

test("the dialog's ceiling is the server's, not a second hardcoded number", () => {
  // MAX_PIECES was a literal 12 beside a server MAX_ALLOCATION_PARTS of 12, with
  // nothing asserting they agree. Bumping one silently desyncs the UI from the route.
  assert.equal(MAX_ALLOCATION_PARTS, 12);
  assert.match(source, /var MAX_PIECES = 12;/,
    "MAX_PIECES must track lib/task-timing MAX_ALLOCATION_PARTS");
});

test("the payload gives every piece but the last a length, and the last none", () => {
  // This is the client's half of the conservation rule. Verified against the server's
  // own planner rather than against a hand-written expectation, so the two cannot drift.
  const parts = [{ minutes: 20 }, { minutes: 25 }, {}];
  const plan = planAllocations(60 * 60, parts);
  assert.ok(plan.ok);
  assert.deepEqual(plan.parts.map((p) => p.durSec), [1200, 1500, 900]);
  assert.equal(plan.parts.reduce((sum, p) => sum + p.durSec, 0), 3600,
    "the shape the dialog sends conserves the segment exactly");
  // And the shape the dialog builds: minutes on all but the last.
  assert.match(source, /if \(index !== state\.pieces\.length - 1\) part\.minutes =/,
    "the last piece must be sent without a length");
});

test("an empty minutes box is not submittable", () => {
  // `Number("") || 0` only made the remainder LARGER, so the old gate stayed enabled and
  // the plan was rejected server-side with "Every piece needs a length in minutes".
  assert.match(source, /return last \|\| Number\(piece\.minutes\) >= 1;/,
    "readiness must require a positive length on every piece but the last");
  assert.ok(!/var ready = remainingMinutes\(\) >= 1 && state\.pieces\.every\(function \(piece\) \{ return !!piece\.taskId/.test(source),
    "the second, laxer copy of the readiness rule must be gone");
  assert.equal((source.match(/function isReady\(/g) || []).length, 1, "exactly one readiness rule");
});

test("the write goes through block-store, not a bare fetch", () => {
  // block-store owns the WAL, the optimistic cache, the save indicator and the
  // clientId the SSE echo is suppressed by, and day-context wraps it to drop the slot
  // cache. This dialog was the only block write in the app outside that layer.
  assert.match(source, /window\.blockStore\.reallocateTimeEntry\(entryId, parts, \{ actionId: actionId \}\)/);
  const store = fs.readFileSync(require.resolve("./public/js/block-store.js"), "utf8");
  assert.match(store, /async reallocateTimeEntry\(entryId, parts, options\)/);
  assert.match(store, /case "realloc":/, "and the WAL can replay it");
  const dayContext = fs.readFileSync(require.resolve("./public/js/day-context.js"), "utf8");
  assert.match(dayContext, /_wrapWrite\(bs, "reallocateTimeEntry"/, "and day-context invalidates its day");
});

test("save captures its locals before awaiting, so closing mid-flight cannot strand it", () => {
  // close() nulls `state` and stays reachable during the request (Escape, X, Cancel,
  // backdrop). Reading state after the await threw, then threw again in the catch, so a
  // write that SUCCEEDED got no refresh and no callback.
  const save = source.slice(source.indexOf("async function save()"), source.indexOf("async function refreshDate"));
  assert.match(save, /var entryId = state\.entry\.id;/);
  assert.match(save, /var callback = state\.onSaved;/);
  assert.ok(!/await refreshDate\(state\.entry\.date\)/.test(save), "must not read state after awaiting");
  assert.match(save, /if \(state\) \{ state\.saving = false;/, "and the catch must tolerate a closed dialog");
});

test("the picker only offers destinations the server accepts", () => {
  // The type-only check this replaces let through every NON_TASK_KINDS row and anything
  // failing foldsIntoItinerary, all of which come back 400 WORK_NOT_TRACKABLE.
  assert.match(source, /model\.foldsIntoItinerary\(row\) \|\| \(model\.isTaskRow\(row\) && props\.kind === "backlog"\)/,
    "the client predicate must mirror routes/blocks.js isWorkTaskRow");
  assert.ok(!/if \(row\.type === "day_root" \|\| row\.type === "time_entry"\) return;/.test(source),
    "the hand-rolled type-only filter must be gone");
});

test("shared helpers come from core.js instead of a fourth local copy", () => {
  assert.match(source, /var esc = window\.DCC\.esc;/);
  assert.match(source, /var api = window\.DCC\.api;/);
  assert.match(source, /window\.DCC\.dates\.addDays\(today, 1\)/);
  assert.ok(!/function esc\(value\) \{\n\s+return String\(value == null/.test(source),
    "the local escaper copy must be gone");
});

test("refreshDate reports a refusal instead of assuming the day reloaded", () => {
  // loadDay returns null WITHOUT loading while writes are pending, which left the fill
  // handing a stale durSec to the next dialog.
  assert.match(source, /var loaded = await bs\.loadDay\(dateStr\);/);
  assert.match(source, /return \{ stale: true \};/);
});
