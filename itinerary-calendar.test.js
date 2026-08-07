const test = require("node:test");
const assert = require("node:assert/strict");
const calendar = require("./public/js/itinerary-calendar.js");

const ev = (id, startMinute, endMinute) => ({ id, startMinute, endMinute });

test("overlap packing gives a disjoint group its full width back", () => {
  const rows = calendar.packOverlaps([ev("a", 540, 600), ev("b", 570, 630), ev("c", 660, 690)]);
  assert.equal(rows.find(x => x.id === "a").laneCount, 2);
  assert.equal(rows.find(x => x.id === "b").laneCount, 2);
  assert.equal(rows.find(x => x.id === "c").laneCount, 1);
  assert.equal(rows.find(x => x.id === "c").widthPct, 100);
});

test("identical overlaps receive stable lanes independent of input order", () => {
  const one = calendar.packOverlaps([ev("b", 540, 600), ev("a", 540, 600)]);
  const two = calendar.packOverlaps([ev("a", 540, 600), ev("b", 540, 600)]);
  assert.deepEqual(one.map(x => [x.id, x.lane]), two.map(x => [x.id, x.lane]));
  assert.deepEqual(one.map(x => [x.id, x.lane]), [["a", 0], ["b", 1]]);
});

test("chained overlaps stay in one group with deterministic lane reuse", () => {
  const rows = calendar.packOverlaps([ev("a", 540, 600), ev("b", 570, 630), ev("c", 615, 660)]);
  assert.deepEqual(rows.map(x => [x.id, x.lane, x.laneCount]), [
    ["a", 0, 2], ["b", 1, 2], ["c", 0, 2],
  ]);
});

test("week calculations stay Sunday-first across month and year boundaries", () => {
  assert.equal(calendar.weekStart("2027-01-01"), "2026-12-27");
  assert.equal(calendar.addDays("2026-12-27", 6), "2027-01-02");
});

test("date stepping remains stable across Eastern DST transitions", () => {
  assert.equal(calendar.addDays("2026-03-07", 1), "2026-03-08");
  assert.equal(calendar.addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(calendar.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(calendar.addDays("2026-11-01", 1), "2026-11-02");
});

test("all-day exclusive end dates cover every day except the end", () => {
  const row = {_block:{date:"2026-08-07"},allDay:true,allDayStart:"2026-08-07",allDayEnd:"2026-08-10"};
  assert.equal(calendar.spansDate(row,"2026-08-07"),true);
  assert.equal(calendar.spansDate(row,"2026-08-09"),true);
  assert.equal(calendar.spansDate(row,"2026-08-10"),false);
});

test("15-minute snapping clamps to the supported day", () => {
  assert.equal(calendar.snap(8),15);
  assert.equal(calendar.snap(1439),1425);
  assert.equal(calendar.clock(1425),"23:45");
});

test("the week grid projects roots only", () => {
  const rows = calendar.rootItems([
    {id:"root",subtaskOf:null,wrapId:null},
    {id:"step",subtaskOf:"root",wrapId:null},
    {id:"rider",subtaskOf:null,wrapId:"root"},
  ]);
  assert.deepEqual(rows.map(row=>row.id),["root"]);
});

test("source styling and links reject executable metadata", () => {
  assert.equal(calendar.safeColor("#12aBcF", "#000000"), "#12aBcF");
  assert.equal(calendar.safeColor("red;position:fixed", "#000000"), "#000000");
  assert.equal(calendar.safeExternalUrl("https://calendar.google.com/event?x=1", "https://dcc.example/"), "https://calendar.google.com/event?x=1");
  assert.equal(calendar.safeExternalUrl("", "https://dcc.example/"), "");
  assert.equal(calendar.safeExternalUrl("javascript:alert(1)", "https://dcc.example/"), "");
  assert.equal(calendar.safeExternalUrl("data:text/html,pwned", "https://dcc.example/"), "");
});
