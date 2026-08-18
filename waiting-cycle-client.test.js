"use strict";

// The stale-cycle contract, which is subtle enough that it produced a real regression
// during review and deserves a guard.
//
// `POST /api/waiting-items/:id/check-ins/complete` answers HTTP 200 with
// `status: "skipped_stale"` whenever the client's cycleKey is not the server's current
// one, so `resp.ok` is TRUE for a call that did nothing. The obvious fix -- retry under
// the `expectedCycleKey` the route hands back -- is a trap, because `skipped_stale` is
// ALSO the repeat-submit signal: after a successful completion the due date has moved, so
// resubmitting the old key is stale rather than duplicate. Retrying then completes a cycle
// the user never saw and leaves `lastCompletedCycleKey` equal to the NEXT due key, which
// (verified against a live server) leaves the item due forever with every later completion
// returning `skipped_duplicate`. Permanently frozen cadence, silently.
//
// So: only retry when the server's cycle is NOT later than ours.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");
const TRIAGE_SRC = fs.readFileSync(require.resolve("./public/js/triage.js"), "utf8");

function mustSlice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found — the source moved or was renamed, fix the pattern");
  return m[0];
}

const DUE_OF = mustSlice(SRC, / {2}function cycleDueOf\(key\) \{[\s\S]*?\n {2}\}/, "cycleDueOf");
const COMPLETE = mustSlice(SRC, / {2}async function completeCheckInCycle\(id, key, completedAt\) \{[\s\S]*?\n {2}\}/, "completeCheckInCycle");

// Build a sandbox with a scripted sequence of route responses.
function harness(responses) {
  const calls = [];
  const ctx = {
    postWaitingAction: async (id, action, body) => {
      calls.push({ id, action, cycleKey: body.cycleKey });
      return responses[calls.length - 1];
    },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(`${DUE_OF}\n${COMPLETE}\nthis.__run = completeCheckInCycle;`, ctx);
  return { run: ctx.__run, calls };
}

const W = "w-1";
const KEY_OLD = `waiting:${W}:2026-08-11`;
const KEY_NEXT = `waiting:${W}:2026-08-25`;
const AT = "2026-08-18T16:00:00.000Z";

test("a clean completion issues exactly one request", async () => {
  const h = harness([{ ok: true, status: "completed" }]);
  const r = await h.run(W, KEY_OLD, AT);
  assert.equal(r.status, "completed");
  assert.equal(h.calls.length, 1);
});

test("a LATER server cycle is accepted without advancing anything", async () => {
  // This is the regression. The cadence already moved past our cycle (another device, or
  // a double click), so there is nothing left for us to close. Completing the server's
  // current cycle here would consume a cycle the user never saw and freeze the cadence.
  const h = harness([{ ok: true, status: "skipped_stale", expectedCycleKey: KEY_NEXT }]);
  const r = await h.run(W, KEY_OLD, AT);
  assert.equal(r.status, "skipped_stale", "reports the no-op rather than faking success");
  assert.equal(h.calls.length, 1, "MUST NOT retry into a future cycle");
});

test("an EARLIER-or-equal server cycle is retried once", async () => {
  // The legitimate stale case: our snapshot was ahead of the server (a reschedule pulled
  // the check-in earlier), so the server's current cycle is the one genuinely due.
  const earlier = `waiting:${W}:2026-08-04`;
  const h = harness([
    { ok: true, status: "skipped_stale", expectedCycleKey: earlier },
    { ok: true, status: "completed" },
  ]);
  const r = await h.run(W, KEY_OLD, AT);
  assert.equal(r.status, "completed");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].cycleKey, earlier, "retries under the key the route supplied");
});

test("a stale result with no expectedCycleKey is accepted, not retried", async () => {
  // waiting-items.js returns expectedCycleKey: null when the item has no due date at all.
  // Throwing here would make the card impossible to dismiss.
  const h = harness([{ ok: true, status: "skipped_stale", expectedCycleKey: null }]);
  const r = await h.run(W, KEY_OLD, AT);
  assert.equal(r.status, "skipped_stale");
  assert.equal(h.calls.length, 1);
});

test("skipped_duplicate is returned as-is and never retried", async () => {
  const h = harness([{ ok: true, status: "skipped_duplicate" }]);
  const r = await h.run(W, KEY_OLD, AT);
  assert.equal(r.status, "skipped_duplicate");
  assert.equal(h.calls.length, 1);
});

test("the retry is bounded: a second stale response never triggers a third request", async () => {
  const earlier = `waiting:${W}:2026-08-04`;
  const h = harness([
    { ok: true, status: "skipped_stale", expectedCycleKey: earlier },
    { ok: true, status: "skipped_stale", expectedCycleKey: earlier },
  ]);
  await h.run(W, KEY_OLD, AT);
  assert.equal(h.calls.length, 2, "no retry storm");
});

// ── one owner, not two copies ────────────────────────────────────────────────

test("triage.js goes through the window.DCC.Waiting facade instead of its own fetch", () => {
  const fn = mustSlice(
    TRIAGE_SRC,
    /^async function completeWaitingCycle\(waitingItemId, cycleKey, completedAt\) \{[\s\S]*?\n\}/m,
    "completeWaitingCycle"
  );
  assert.ok(fn.includes("completeCheckInCycle"), "must delegate to the shared primitive");
  assert.ok(!fn.includes("fetch("), "a second fetch copy is how this logic drifts");
  assert.ok(!fn.includes("expectedCycleKey"), "stale handling belongs in exactly one place");
});

test("dismissTriage advances the cadence BEFORE it writes the suppression", () => {
  const fn = mustSlice(
    TRIAGE_SRC,
    /^async function dismissTriage\(triageId, note, trivial\) \{[\s\S]*?\n\}/m,
    "dismissTriage"
  );
  const advance = fn.indexOf("completeWaitingCycle");
  const suppress = fn.indexOf("persistTriageSuppression");
  assert.ok(advance > -1 && suppress > -1, "both steps still present");
  assert.ok(advance < suppress, "suppressing first would leave the card hidden but still overdue");
});
