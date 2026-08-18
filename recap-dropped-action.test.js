// The Recap tab's rendering contract for a meeting action item whose task was dropped.
//
// A placed follow-up that Drake drops from Loose Ends leaves its proposal at
// status:"dismissed" / dismissedReason:"task-dropped" (routes/blocks.js
// transitionLinkedMeetingAction). This file pins what that has to LOOK like on the
// meeting card, because three of the four behaviours here are ones the obvious
// implementation gets wrong:
//
//   1. The row must render at all. render() has always filtered `dismissed` out before
//      recapActionsHtml sees it, so a dropped item would silently vanish instead of
//      reporting -- which reads as "the follow-up was never captured".
//   2. The dropped branch must beat the `placed` session Map. That map records
//      "scheduled during this page session" and isPlaced consults it FIRST, so
//      schedule-here -> drop-in-Loose-Ends -> reopen-without-reload would still say
//      "Scheduled ✓" off a stale in-memory entry.
//   3. It must never emit a Schedule button. Re-offering that control is precisely how
//      dropped work climbs back onto the day.
//
// Harness pattern: delete-subtree.test.js -- raw source sliced out of the browser file
// and run in a node:vm context, since meeting-automation.js has DOM side effects at load.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./public/js/meeting-automation.js"), "utf8");

function mustMatch(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error("recap-dropped-action.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

const RENDER_ACTIONS_SRC = mustMatch(SRC, /function recapActionsHtml\(actions,placed,id,dashboardRef\)\{[\s\S]*?\n {2}\}/, "recapActionsHtml");
// recapActionsHtml renders a citation deeplink per row, so the slice needs its helper.
const RECAP_TIME_SRC = mustMatch(SRC, /function recapTime\(seconds\)\{[\s\S]*?\n {2}\}/, "recapTime");
// Just the filter line out of render(). Slicing the whole function would drag in the
// block editors; the filter is the entire contract for what reaches the renderer.
const FILTER_SRC = mustMatch(SRC, /const actions=\(\(data&&data\.proposedActions\)\|\|\[\]\)\.filter\([^\n]*\);/, "render()'s proposedActions filter");

// The third changed filter, and the client half of this feature's intent: without its
// "dismissed" term the itinerary panel renders a dropped proposal as a PRE-CHECKED row
// under a live "Approve selected" button.
const PANEL_FILTER_SRC = mustMatch(SRC, /const proposed=\(data&&data\.proposedActions\|\|\[\]\)\.filter\([^\n]*\);/, "renderPanel's proposedActions filter");

function panelVisible(proposedActions) {
  const sandbox = { data: { proposedActions } };
  vm.createContext(sandbox);
  vm.runInContext(PANEL_FILTER_SRC + "\nglobalThis.__out=proposed;", sandbox);
  return sandbox.__out;
}

function ctx() {
  const sandbox = {
    esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    )),
    _prettyDateLabel: (d) => d,
  };
  vm.createContext(sandbox);
  vm.runInContext(RECAP_TIME_SRC, sandbox);
  vm.runInContext(RENDER_ACTIONS_SRC, sandbox);
  return sandbox;
}

function render(actions, placed) {
  const sandbox = ctx();
  sandbox.__actions = actions;
  sandbox.__placed = placed || new Map();
  // id + dashboardRef are the citation-link args; no dashboardRef means no link,
  // which keeps these assertions about the control column and nothing else.
  return vm.runInContext('recapActionsHtml(__actions,__placed,"mtg-1",null)', sandbox);
}

// Run render()'s filter over a proposal list without booting the modal.
function visible(proposedActions) {
  const sandbox = { data: { proposedActions } };
  vm.createContext(sandbox);
  vm.runInContext(FILTER_SRC + "\nglobalThis.__out=actions;", sandbox);
  return sandbox.__out;
}

const DROPPED = {
  id: "p1", text: "Chase the migration", priority: "Medium", origin: "automated",
  status: "dismissed", dismissedReason: "task-dropped", droppedFromDate: "2026-07-20",
};

test("a dropped proposal survives render()'s dismissed filter", () => {
  const rows = visible([DROPPED]);
  assert.equal(rows.length, 1, "a system-made dismissal has to reach the card");
});

test("a hand-dismissed proposal still disappears, exactly as before", () => {
  const rows = visible([{ id: "p2", text: "No longer needed", status: "dismissed" }]);
  assert.deepEqual(rows, [], "no dismissedReason means the old behaviour is untouched");
});

test("a dropped action renders an inert Dropped pill and NO Schedule button", () => {
  const html = render([DROPPED]);
  assert.match(html, /recap-sched-dropped">Dropped</);
  assert.equal(/recap-sched-btn/.test(html), false, "re-offering Schedule is how dropped work comes back");
  assert.equal(/Scheduled/.test(html), false);
  assert.match(html, /class="recap-action is-scheduled is-dropped"/);
});

test("dropped beats the in-session placed Map", () => {
  // Schedule it in the modal, drop it in Loose Ends, reopen without a reload: `placed`
  // still holds the optimistic entry. Server truth has to win.
  const html = render([DROPPED], new Map([["p1", { date: "2026-07-20", start: "09:00" }]]));
  assert.match(html, /Dropped</);
  assert.equal(/Scheduled/.test(html), false, "the stale session entry must not outrank the drop");
});

test("a dropped action keeps no placedDate to trip isPlaced", () => {
  // Belt and braces on the server's rename: even if a placedDate somehow survived, the
  // dropped branch is evaluated first and still wins.
  const html = render([{ ...DROPPED, placedDate: "2026-07-20" }]);
  assert.match(html, /Dropped</);
  assert.equal(/Scheduled/.test(html), false);
});

test("an ordinary placed action is unchanged", () => {
  const html = render([{ id: "p3", text: "Ship it", status: "placed", placedDate: "2026-07-20" }]);
  assert.match(html, /recap-sched-done">Scheduled 2026-07-20/);
  assert.equal(/recap-sched-dropped/.test(html), false);
});

test("an ordinary proposed action still gets its Schedule button", () => {
  const html = render([{ id: "p4", text: "Draft the brief", status: "proposed", priority: "High" }]);
  assert.match(html, /recap-sched-btn[^>]*data-action-id="p4">Schedule</);
  assert.equal(/recap-sched-dropped/.test(html), false);
});

test("a delegated action is still owner-noted, not droppable-looking", () => {
  const html = render([{ id: "p5", text: "Their job", status: "proposed", owner: "other" }]);
  assert.match(html, /recap-owner-note">Owner: other</);
  assert.equal(/recap-sched-dropped/.test(html), false);
});

test("a dropped proposal never reaches the Approve-selected list", () => {
  assert.deepEqual(panelVisible([DROPPED]), [], "a pre-checked row is how dropped work looks approvable");
});

test("an ordinary proposed action is still offered for approval", () => {
  assert.equal(panelVisible([{ id: "p9", status: "proposed" }]).length, 1);
});
