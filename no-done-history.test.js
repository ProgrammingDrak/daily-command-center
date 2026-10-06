"use strict";

// Pills are queues of OPEN work. Drake, 2026-10-05: "None of these pills (waiting,
// loose ends, unscheduled, whenever) should have historical done sections. That is
// tracked ON THE DAY THAT IT WAS COMPLETED." And the Waiting badge is a notification:
// it counts only items overdue for a check-in. Triage joined the capsule the same day,
// under the same rule.
//
// What these pin:
//   1. Waiting has no Done filter, and All lists open items only
//   2. the Waiting badge and the Overdue tab share ONE rule, and the badge hides at zero
//   3. a done untimed task leaves the drawer's Triage or Unscheduled half and lands
//      on its day, in the time block (and order) of its completion time

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const DELEGATED = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");
const TAB = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const TimeBlocks = require("./public/js/time-blocks.js");

function slice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found; the source moved, fix the pattern");
  return m[0];
}
const plain = (ctx, expr) => JSON.parse(vm.runInContext("JSON.stringify(" + expr + ")", ctx));

// ── Waiting ──

const WAITING = [
  slice(DELEGATED, / {2}function isDoneDelegated\(item\) \{[\s\S]*?\n {2}\}/, "isDoneDelegated"),
  slice(DELEGATED, / {2}function isOpenDelegated\(item\) \{[\s\S]*?\n {2}\}/, "isOpenDelegated"),
  slice(DELEGATED, / {2}function wantsCheckIn\(item\) \{[\s\S]*?\n {2}\}/, "wantsCheckIn"),
  slice(DELEGATED, / {2}function isOverdue\(item\) \{[\s\S]*?\n {2}\}/, "isOverdue"),
  slice(DELEGATED, / {2}function filterItems\(items, filter\) \{[\s\S]*?\n {2}\}/, "filterItems"),
  slice(DELEGATED, / {2}function updateBadge\(overdueCount\) \{[\s\S]*?\n {2}\}/, "updateBadge"),
].join("\n");

const item = (id, props) => ({ id, properties: Object.assign({ title: id }, props) });
const ITEMS = [
  item("overdue", { remaining: -3 }),
  item("upcoming", { remaining: 4 }),
  item("done", { remaining: -9, status: "done", completedAt: "2026-10-01T10:00:00Z" }),
  item("snoozed", { remaining: -2, snoozed: true }),
  item("dependency", { remaining: -2, dependency: true }),
  item("followed-up", { remaining: -5, checkInRepeat: false }),
  item("check-in-booked", { remaining: -1, checkInTaskId: "t", checkInScheduledFor: "2026-10-06" }),
  // The date guards at their edges (today is 2026-10-05): a check-in booked for today
  // is handled; one booked for a past day and still open is not, and neither is a
  // one-off follow-up whose own date has passed.
  item("check-in-today", { remaining: -1, checkInTaskId: "t2", checkInScheduledFor: "2026-10-05" }),
  item("check-in-stale", { remaining: -1, checkInTaskId: "t3", checkInScheduledFor: "2026-10-04" }),
  item("dated-follow-up", { remaining: -1, checkInRepeat: false, checkInDate: "2026-10-04" }),
];

function waiting() {
  const els = {};
  const el = () => ({ textContent: "", style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  ["delegated-blocked-count", "waiting-pill-nav-count", "waiting-pill-nav"].forEach(id => { els[id] = el(); });
  const ctx = {
    document: { getElementById: id => els[id] || null },
    itemUrgency: i => ({ timing: { remaining: i.properties.remaining } }),
    isSnoozed: i => !!i.properties.snoozed,
    isTaskDependency: i => !!i.properties.dependency,
    todayStr: () => "2026-10-05",
  };
  vm.createContext(ctx);
  vm.runInContext(WAITING, ctx);
  ctx.ITEMS = ITEMS;
  return { ctx, els };
}

test("Waiting has no Done filter, and All lists open items only", () => {
  const { ctx } = waiting();
  assert.deepEqual(plain(ctx, 'filterItems(ITEMS, "all").map(i => i.id)'),
    ["overdue", "upcoming", "snoozed", "dependency", "followed-up", "check-in-booked",
      "check-in-today", "check-in-stale", "dated-follow-up"]);
  assert.deepEqual(plain(ctx, 'filterItems(ITEMS, "done").map(i => i.id)'),
    plain(ctx, 'filterItems(ITEMS, "all").map(i => i.id)'), "a stale 'done' filter falls back to open work");
  const filters = slice(DELEGATED, / {2}function renderFilters\(\) \{[\s\S]*?\n {2}\}/, "renderFilters");
  assert.doesNotMatch(filters, /"done"/, "the Done tab is gone");
});

test("the badge and the Overdue tab count only items overdue for a check-in", () => {
  const { ctx, els } = waiting();
  assert.deepEqual(plain(ctx, 'filterItems(ITEMS, "overdue").map(i => i.id)'), ["overdue", "check-in-stale", "dated-follow-up"]);
  assert.deepEqual(plain(ctx, 'filterItems(ITEMS, "upcoming").map(i => i.id)'),
    ["upcoming", "snoozed", "dependency", "followed-up", "check-in-booked", "check-in-today"]);
  const counted = vm.runInContext('ITEMS.filter(isOverdue).length', ctx);
  assert.equal(counted, 3);
  ctx.updateBadge(counted);
  assert.equal(els["waiting-pill-nav-count"].textContent, "3");
  assert.equal(els["waiting-pill-nav-count"].style.display, "");
  assert.match(els["waiting-pill-nav"].attrs["aria-label"], /3 overdue for a check-in/);
  // The sidebar feeds the badge from this same rule.
  assert.match(DELEGATED, /updateBadge\(all\.filter\(isOverdue\)\.length\)/);
});

test("the Waiting badge disappears when nothing is overdue", () => {
  const { ctx, els } = waiting();
  ctx.updateBadge(0);
  assert.equal(els["waiting-pill-nav-count"].style.display, "none");
  assert.equal(els["delegated-blocked-count"].style.display, "none");
  assert.match(els["waiting-pill-nav"].attrs["aria-label"], /none overdue/);
});

// ── Unscheduled: done work goes to its day ──

const FILE = [
  slice(TAB, /function _completionMinute\(ev\)\{[\s\S]*?\n\}/, "_completionMinute"),
  slice(TAB, /function _fileDoneUntimedOnTheDay\(groups,sourceGroup,timeBlocks\)\{[\s\S]*?\n\}/, "_fileDoneUntimedOnTheDay"),
].join("\n");

function filing(doneAt) {
  const pt = s => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
  const fmt = n => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
  const ctx = {
    DCC: { TimeBlocks }, doneAt, pt, fmt,
    isDone: ev => !!ev.done,
    _rowIsTimed: ev => !ev.untimed,
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(FILE, ctx);
  return ctx;
}

function localIso(h, m) { const d = new Date(2026, 9, 5, h, m); return d.toISOString(); }

test("a done untimed task leaves Unscheduled and lands in the block, and order, of its completion", () => {
  const blocks = [{ id: "am", name: "Morning", start: "08:00", end: "12:00" }, { id: "pm", name: "Afternoon", start: "12:00", end: "17:00" }];
  const groups = TimeBlocks.groupItineraryTree([
    { ev: { id: "t9", start: "09:00", end: "09:30" }, depth: 0 },
    { ev: { id: "t11", start: "11:00", end: "11:30" }, depth: 0 },
    { ev: { id: "open", untimed: true }, depth: 0 },
    { ev: { id: "mail", untimed: true, done: true }, depth: 0 },
    { ev: { id: "mail-step", untimed: true, done: true }, depth: 1 },
    { ev: { id: "lost", untimed: true, done: true }, depth: 0 },
  ], blocks);
  const unscheduled = groups.find(g => g.block.id === TimeBlocks.UNPLANNED_BLOCK.id);
  const ctx = filing({ mail: localIso(10, 15) });
  ctx._fileDoneUntimedOnTheDay(groups, unscheduled, blocks);
  const ids = g => Array.from(g.nodes, n => n.ev.id);
  assert.deepEqual(ids(unscheduled), ["open"], "only open work stays in the pill");
  const am = groups.find(g => g.block.id === "am");
  assert.deepEqual(ids(am), ["t9", "mail", "mail-step", "t11"], "filed at 10:15, between 9:00 and 11:00, subtree attached");
  const outside = groups.find(g => g.block === TimeBlocks.OUTSIDE_BLOCK);
  assert.ok(outside, "an unknown completion time still lands on the day");
  assert.deepEqual(ids(outside), ["lost"]);
  assert.ok(groups.indexOf(outside) < groups.indexOf(unscheduled), "Outside sits before the pill's group");
});

test("a done Triage task lands on its day too, and Outside still sits after the timed blocks", () => {
  const blocks = [{ id: "am", name: "Morning", start: "08:00", end: "12:00" }];
  const groups = TimeBlocks.groupItineraryTree([
    { ev: { id: "t9", start: "09:00", end: "09:30" }, depth: 0 },
    { ev: { id: "gmail", untimed: true, triageBlock: true, triageId: "gmail:1" }, depth: 0 },
    { ev: { id: "slack", untimed: true, triageBlock: true, triageId: "slack:1", done: true }, depth: 0 },
    { ev: { id: "repeat", untimed: true, triageBlock: true, triageId: "review:1", done: true }, depth: 0 },
    { ev: { id: "chore", untimed: true }, depth: 0 },
  ], blocks);
  const triage = groups.find(g => g.block.id === TimeBlocks.TRIAGE_BLOCK.id);
  const unscheduled = groups.find(g => g.block.id === TimeBlocks.UNPLANNED_BLOCK.id);
  const ctx = filing({ slack: localIso(9, 40) });
  ctx._fileDoneUntimedOnTheDay(groups, triage, blocks);
  const ids = g => Array.from(g.nodes, n => n.ev.id);
  assert.deepEqual(ids(triage), ["gmail"], "only open work stays behind the Triage door");
  assert.deepEqual(ids(groups.find(g => g.block.id === "am")), ["t9", "slack"]);
  const outside = groups.find(g => g.block === TimeBlocks.OUTSIDE_BLOCK);
  assert.deepEqual(ids(outside), ["repeat"]);
  // Triage is the FIRST group, so placing Outside relative to the source group would
  // put it above every time block.
  const order = groups.map(g => g.block.id);
  assert.ok(order.indexOf(null) > order.indexOf("am") && order.indexOf(null) < order.indexOf("unplanned"),
    "Outside goes after the timed blocks and before Unplanned: " + JSON.stringify(order));
  assert.deepEqual(ids(unscheduled), ["chore"]);
});

test("the list model files done work out of BOTH drawer halves", () => {
  const model = slice(TAB, /function _itineraryListModel\(\)\{[\s\S]*?\n\}/, "_itineraryListModel");
  assert.match(model, /_fileDoneUntimedOnTheDay\(groups,triageGroup,timeBlocks\);/);
  assert.match(model, /_fileDoneUntimedOnTheDay\(groups,unscheduledGroup,timeBlocks\);/);
  assert.match(model, /return \{[^}]*unscheduledGroup,triageGroup\}/);
});

test("rows filed into one gap keep completion order, whichever half they came from", () => {
  const blocks = [{ id: "am", name: "Morning", start: "08:00", end: "12:00" }];
  const groups = TimeBlocks.groupItineraryTree([
    { ev: { id: "t9", start: "09:00", end: "09:30" }, depth: 0 },
    { ev: { id: "t11", start: "11:00", end: "11:30" }, depth: 0 },
    { ev: { id: "late", untimed: true, triageBlock: true, done: true }, depth: 0 },
    { ev: { id: "early", untimed: true, done: true }, depth: 0 },
  ], blocks);
  const ctx = filing({ late: localIso(10, 30), early: localIso(10, 5) });
  // Triage files first, then Unscheduled, the way _itineraryListModel runs them.
  ctx._fileDoneUntimedOnTheDay(groups, groups.find(g => g.block.id === TimeBlocks.TRIAGE_BLOCK.id), blocks);
  ctx._fileDoneUntimedOnTheDay(groups, groups.find(g => g.block.id === TimeBlocks.UNPLANNED_BLOCK.id), blocks);
  assert.deepEqual(Array.from(groups.find(g => g.block.id === "am").nodes, n => n.ev.id), ["t9", "early", "late", "t11"]);
});

test("a task finished on ANOTHER day files under Outside as a plain Done, not at that clock time", () => {
  // Loose Ends checks off a past-day task on its own day, stamped with today's clock.
  const blocks = [{ id: "am", name: "Morning", start: "08:00", end: "12:00" }];
  const groups = TimeBlocks.groupItineraryTree([
    { ev: { id: "t9", start: "09:00", end: "09:30" }, depth: 0 },
    { ev: { id: "carried", untimed: true, done: true }, depth: 0 },
    { ev: { id: "same-day", untimed: true, done: true }, depth: 0 },
  ], blocks);
  const ctx = filing({ carried: new Date(2026, 9, 6, 10, 15).toISOString(), "same-day": localIso(10, 15) });
  ctx.__state = { date: "2026-10-05" };
  assert.equal(vm.runInContext('_completionMinute({ id: "carried" })', ctx), null);
  assert.equal(vm.runInContext('_completionMinute({ id: "same-day" })', ctx), 10 * 60 + 15);
  ctx._fileDoneUntimedOnTheDay(groups, groups.find(g => g.block.id === TimeBlocks.UNPLANNED_BLOCK.id), blocks);
  assert.deepEqual(Array.from(groups.find(g => g.block.id === "am").nodes, n => n.ev.id), ["t9", "same-day"]);
  assert.deepEqual(Array.from(groups.find(g => g.block === TimeBlocks.OUTSIDE_BLOCK).nodes, n => n.ev.id), ["carried"]);
});

test("Loose Ends and the Waiting badge share one check-in gate", () => {
  const attention = slice(DELEGATED, / {2}function attentionItems\(items\) \{[\s\S]*?\n {2}\}/, "attentionItems");
  assert.match(attention, /if \(!wantsCheckIn\(item\)\) return false;/);
  assert.match(WAITING, /return wantsCheckIn\(item\) && itemUrgency\(item\)\.timing\.remaining < 0;/);
});
