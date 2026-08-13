// Contract tests for the durable triage suppression layer.
//
// The bug these pin down, in the shape it actually appeared on prod (2026-08-05):
// `triage.open_items` held 23 items reaching back to 2026-07-07, the 2026-08-04
// day_root held `_triageDeleted: 19`, the 2026-08-05 day_root held neither that key
// nor `_dismissed`, and 2026-08-04's own state carried `deleted_items: 0` with a full
// open list stamped `last_updated_by: "scheduled-task"`. Two independent defects, so
// two independent properties below: a suppression must not expire with the day, and a
// suppression must survive the sweep re-emitting the item.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  triageItemKey,
  suppressionIndex,
  isSuppressed,
  applyTriageSuppressions,
  buildSuppressionProperties,
  suppressionFromBlock,
  suppressionsFromBlocks,
  suppressionDayKey,
  matchingSuppression,
  snapshotTriageItem,
  mergeTriageForIngest,
} = require("./triage-suppressions");
const { mergeOpenItems, triageItemKey: intelKey } = require("./dcc-intelligence");

// The read-time overlay, as buildDayResponse applies it. Suppression deliberately does
// NOT run at merge/persist time — see the note in routes/dcc.js — so "does a handled
// item come back" is a question about this composition, not about mergeOpenItems.
const serveTriage = (triage, suppressions) => applyTriageSuppressions(triage, suppressions);

// The real shape prod serves: `id` and `type`, and NO source/source_id. A key function
// written against normalizer output alone would key these as "unknown|..." and match
// nothing.
const LIVE_ITEM = { id: "gmail:19f3d0b61ba384a8", type: "email", title: "Re: discrepancies" };
const NORMALIZED_ITEM = { id: "x1", source: "gmail", source_id: "19f3d0b61ba384a8", type: "email", title: "Re: discrepancies" };

test("the key is byte-identical to the one mergeOpenItems dedupes on", () => {
  // Not a tautology now that dcc-intelligence imports it: this asserts the export stays
  // wired, because a local copy that drifts is a suppression that silently never matches.
  assert.equal(intelKey, triageItemKey);
  assert.equal(triageItemKey(LIVE_ITEM), "email|gmail:19f3d0b61ba384a8");
  assert.equal(triageItemKey(NORMALIZED_ITEM), "gmail|19f3d0b61ba384a8");
  assert.equal(triageItemKey(null), "");
});

test("a suppression matches on the composite key OR the bare id", () => {
  // Two arms on purpose. The composite key is built from fields the SWEEP controls, so a
  // reader that starts emitting `source` where it emitted only `type` would change every
  // key at once and resurrect the whole backlog. The bare id is the client's handle and
  // survives that.
  const byKey = suppressionIndex([{ key: "email|gmail:19f3d0b61ba384a8" }]);
  const byId = suppressionIndex([{ triage_id: "gmail:19f3d0b61ba384a8" }]);
  assert.equal(isSuppressed(LIVE_ITEM, byKey), true);
  assert.equal(isSuppressed(LIVE_ITEM, byId), true);
  assert.equal(isSuppressed({ id: "other", type: "email" }, byKey), false);
  assert.equal(isSuppressed({ id: "other", type: "email" }, byId), false);
});

test("a legacy Gmail thread suppression is a cutoff, not a permanent conversation tombstone", () => {
  const suppression = { triage_id: "gmail:thread-1", reason: "done", at: "2026-08-05T15:00:00Z" };
  const index = suppressionIndex([suppression]);
  const oldTurn = {
    id: "gmail:thread-1:message-a",
    type: "email",
    conversation_id: "thread-1",
    received_at: "2026-08-05T14:00:00Z",
  };
  const newTurn = { ...oldTurn, id: "gmail:thread-1:message-b", received_at: "2026-08-05T16:00:00Z" };
  assert.equal(matchingSuppression(oldTurn, index), suppression, "the already-handled turn stays dead");
  assert.equal(isSuppressed(newTurn, index), false, "a later inbound turn is allowed through");
});

test("an unparseable Gmail received date never gets hidden by a legacy cutoff", () => {
  const index = suppressionIndex([{ triage_id: "gmail:thread-1", at: "2026-08-05T15:00:00Z" }]);
  assert.equal(isSuppressed({ id: "gmail:thread-1:new", conversation_id: "thread-1" }, index), false);
});

test("suppression snapshots are allowlisted and bounded", () => {
  const snap = snapshotTriageItem({
    id: "gmail:t:m",
    title: "T".repeat(500),
    summary: "S".repeat(4000),
    receivedAt: "2026-08-05T14:00:00Z",
    conversationId: "t",
    arbitrary: { payload: "must not persist" },
  });
  assert.equal(snap.title.length, 220);
  assert.equal(snap.summary.length, 1000);
  assert.equal(snap.received_at, "2026-08-05T14:00:00Z");
  assert.equal(snap.conversation_id, "t");
  assert.equal("arbitrary" in snap, false);
});

test("a re-emitted item stays suppressed — the defect that made deletions evaporate", () => {
  // The sweep re-publishes the same open item every cycle, and mergeOpenItems keeps it:
  // its only exits are status:"resolved" (nothing sets it) and age-out. This item is
  // drafted and inside the 30-day grace, exactly like the 23 on prod, so age-out cannot
  // be what removes it. The overlay is what has to, and it must hold on the REAL sweep
  // shape: already-persisted AND re-emitted in the same merge.
  const now = Date.parse("2026-08-05T12:00:00Z");
  const drafted = {
    id: "gmail:19f3d0b61ba384a8",
    type: "email",
    title: "Re: discrepancies",
    first_seen_at: "2026-07-20T07:56:06Z",
    draft_url: "https://mail.google.com/mail/u/0/#drafts/19f3d0b61ba384a8",
  };
  const merged = mergeOpenItems([drafted], [drafted], now);
  assert.equal(merged.length, 1, "guard: the merge itself still keeps it — that is its job");

  const served = serveTriage({ open_items: merged }, [{ triage_id: "gmail:19f3d0b61ba384a8" }]);
  assert.deepEqual(served.open_items, [], "a handled item must not come back on the next sweep");
  assert.deepEqual(
    serveTriage({ open_items: merged }, [{ key: "email|gmail:19f3d0b61ba384a8" }]).open_items,
    [],
    "and the composite key matches the same item"
  );
});

test("suppressing then unsuppressing round-trips, because the overlay never mutates its input", () => {
  // Undo is only lossless if suppression is a projection rather than an edit. This pins
  // the pure half of that: the same stored list serves filtered or unfiltered depending
  // solely on the suppressions passed in, with no re-sweep and no repair step.
  //
  // The half that actually regressed is NOT here, because it cannot be: the destructive
  // cut was at POST /api/ingest/day-state, a route that never calls into this module.
  // An earlier version of this test asserted mergeOpenItems ignores suppressions and
  // could therefore never fail. triage-suppression-routes.test.js guards the real door,
  // behaviourally and by source, and both halves are mutation-proved.
  const now = Date.parse("2026-08-05T12:00:00Z");
  const item = { id: "gmail:abc", type: "email", first_seen_at: "2026-08-04T00:00:00Z" };
  const stored = mergeOpenItems([item], [item], now);
  assert.deepEqual(stored.map((i) => i.id), ["gmail:abc"], "storage keeps it while suppressed");
  assert.deepEqual(serveTriage({ open_items: stored }, [{ triage_id: "gmail:abc" }]).open_items, []);
  assert.deepEqual(
    serveTriage({ open_items: stored }, []).open_items.map((i) => i.id),
    ["gmail:abc"],
    "and removing the suppression serves it again, with no re-sweep needed"
  );
  assert.deepEqual(stored.map((i) => i.id), ["gmail:abc"], "neither call mutated the stored list");
});

test("suppressed_items is scoped to the day, while open_items is filtered against all of them", () => {
  // The asymmetry, as a property. Narrowing the open_items input resurrects the bug;
  // widening the suppressed_items output makes Completed accumulate everything ever
  // handled, on every date, one DOM row and one click listener each.
  const suppressions = [
    { triage_id: "gmail:old", reason: "done", at: "2026-06-01T09:00:00.000Z" },
    { triage_id: "gmail:today", reason: "done", at: "2026-08-05T14:00:00.000Z" },
  ];
  const out = applyTriageSuppressions(
    { open_items: [{ id: "gmail:old" }, { id: "gmail:today" }, { id: "slack:live" }] },
    suppressions,
    { date: "2026-08-05" }
  );
  assert.deepEqual(out.open_items.map((i) => i.id), ["slack:live"], "BOTH stay suppressed, regardless of age");
  assert.deepEqual(out.suppressed_items.map((s) => s.triage_id), ["gmail:today"], "only today's owes a Completed row");
});

test("an EVENING completion belongs to the local day it happened on, not the UTC one", () => {
  // The regression a UTC `.slice(0, 10)` gives you, and the reason the earlier version
  // of this test could not catch it: 14:00Z is 10:00 ET, same calendar day in both
  // clocks, so it passed either way. 01:30Z is 21:30 the PREVIOUS evening in ET -- the
  // window where a third of every day's completions land. Getting this wrong drops the
  // item off both days' Completed lists and takes its Undo with it.
  const evening = [{ triage_id: "gmail:pm", reason: "done", at: "2026-08-06T01:30:00.000Z" }];
  const tz = { timeZone: "America/New_York" };
  assert.deepEqual(
    applyTriageSuppressions({ open_items: [] }, evening, { date: "2026-08-05", ...tz }).suppressed_items.map((s) => s.triage_id),
    ["gmail:pm"],
    "handled at 21:30 ET on the 5th, so it is the 5th's Completed row"
  );
  assert.deepEqual(
    applyTriageSuppressions({ open_items: [] }, evening, { date: "2026-08-06", ...tz }).suppressed_items,
    [],
    "and not the 6th's, even though the UTC stamp says 08-06"
  );
  // The item stays suppressed on every date regardless, which is the half that must
  // never depend on this arithmetic.
  assert.deepEqual(
    applyTriageSuppressions({ open_items: [{ id: "gmail:pm" }] }, evening, { date: "2026-08-06", ...tz }).open_items,
    []
  );
});

test("suppressionDayKey normalizes what it is handed, including a pg Date", () => {
  // suppressionFromBlock falls back to the row's created_at, and node-postgres returns
  // timestamptz as a Date, whose String() is "Wed Aug 06 ..." and matches no date.
  assert.equal(suppressionDayKey(new Date("2026-08-06T01:30:00.000Z"), { timeZone: "America/New_York" }), "2026-08-05");
  assert.equal(suppressionDayKey("2026-08-06T01:30:00.000Z", { timeZone: "UTC" }), "2026-08-06");
  assert.equal(suppressionDayKey("2026-08-06T01:30:00.000Z"), "2026-08-06", "no zone: UTC, the old behaviour");
  assert.equal(suppressionDayKey(""), "");
  assert.equal(suppressionDayKey("not a date"), "not a date".slice(0, 10), "unparseable degrades, does not throw");
});

test("a trivial dismissal is recorded as trivial, so a second device agrees it was not work", () => {
  // Without the flag on the row, the phone (which has no local overlay) counts a
  // "not worth it" dismissal as completed work in the Done tab and the day's totals.
  assert.equal(buildSuppressionProperties({ triageId: "a", trivial: true }).trivial, true);
  assert.equal(buildSuppressionProperties({ triageId: "a" }).trivial, false);
  const row = suppressionFromBlock({ id: "s1", properties: { kind: "triage_suppression", triage_id: "a", trivial: true } });
  assert.equal(row.trivial, true);
});

test("with no date to scope by, the full list is served rather than an empty one", () => {
  // A missing Completed list is a lost Undo, which is worse than a long one.
  const suppressions = [{ triage_id: "a", reason: "done", at: "2026-06-01T09:00:00.000Z" }];
  assert.equal(applyTriageSuppressions({ open_items: [] }, suppressions).suppressed_items.length, 1);
  assert.equal(applyTriageSuppressions({ open_items: [] }, suppressions, {}).suppressed_items.length, 1);
});

test("stored strings are coerced and clamped, because these rows ride along on day reads", () => {
  const props = buildSuppressionProperties({
    triageId: "gmail:abc",
    itemTitle: "T".repeat(500),
    note: "N".repeat(4000),
  });
  assert.equal(props.itemTitle.length, 220);
  assert.equal(props.note.length, 1000);
  assert.equal(typeof buildSuppressionProperties({ itemTitle: { evil: 1 } }).itemTitle, "string");
});

test("applyTriageSuppressions strips open items and hands back what it stripped", () => {
  const triage = {
    open_items: [
      { id: "gmail:abc", type: "email" },
      { id: "slack:dm:D1:1", type: "slack" },
    ],
    resolved_items: [{ id: "old" }],
  };
  const out = applyTriageSuppressions(triage, [{ triage_id: "gmail:abc", reason: "done" }]);
  assert.deepEqual(out.open_items.map((i) => i.id), ["slack:dm:D1:1"]);
  assert.equal(out.suppressed_items.length, 1);
  assert.deepEqual(out.resolved_items, [{ id: "old" }], "untouched sections ride through");
  assert.deepEqual(triage.open_items.length, 2, "input is not mutated");
});

test("applyTriageSuppressions with none is a pass-through that still declares the field", () => {
  // The client reads `suppressed_items` unconditionally; leaving it undefined would make
  // "no suppressions" and "old server" indistinguishable at the boundary.
  const out = applyTriageSuppressions({ open_items: [{ id: "a" }] }, []);
  assert.deepEqual(out.open_items, [{ id: "a" }]);
  assert.deepEqual(out.suppressed_items, []);
  assert.deepEqual(applyTriageSuppressions(null, []).suppressed_items, []);
});

test("ingest preserves explicitly reopened snapshots but not stale source rows", () => {
  const merged = mergeTriageForIngest({
    open_items: [
      { id: "gmail:t:restored", title: "Restored", _dcc_reopened: true },
      { id: "gmail:t:stale", title: "Stale" },
    ],
    resolved_items: [],
  }, {
    open_items: [{ id: "gmail:t:new", title: "New" }],
    resolved_items: [{ id: "gmail:t:restored" }, { id: "gmail:t:old" }],
  });
  assert.deepEqual(merged.open_items.map((item) => item.id), ["gmail:t:restored", "gmail:t:new"]);
  assert.deepEqual(merged.resolved_items.map((item) => item.id), ["gmail:t:old"]);
});

test("the stored row never carries a `title`, because a dateless titled block is BACKLOG", () => {
  // TaskModel.selectUnscheduled admits any dateless type="block" row that has a title.
  // Storing the item's title under `title` would file every handled triage item into
  // Drake's backlog as a task. It goes in `itemTitle`, which no selector reads.
  const props = buildSuppressionProperties({
    triageId: "gmail:abc",
    key: "email|gmail:abc",
    itemTitle: "Re: discrepancies",
    reason: "done",
  });
  assert.equal(props.title, undefined);
  assert.equal(props.itemTitle, "Re: discrepancies");
  assert.equal(props.kind, "triage_suppression");
  assert.ok(props.at, "stamped, so Completed can be ordered and audited");
});

test("reason is a closed set — anything unrecognized is the conservative 'done'", () => {
  // "deleted" hides the item outright; "done" still owes the user a Completed row with an
  // Undo. A typo must not silently disappear something.
  assert.equal(buildSuppressionProperties({ reason: "deleted" }).reason, "deleted");
  assert.equal(buildSuppressionProperties({ reason: "done" }).reason, "done");
  assert.equal(buildSuppressionProperties({ reason: "banana" }).reason, "done");
  assert.equal(buildSuppressionProperties({}).reason, "done");
});

test("scheduled is a durable hidden state without pretending the source was handled", () => {
  const props = buildSuppressionProperties({
    triageId: "slack:dm:D1:1",
    reason: "scheduled",
    taskId: "triage-task-1",
    scheduledFor: "2026-08-14",
  });
  assert.equal(props.reason, "scheduled");
  assert.equal(props.task_id, "triage-task-1");
  assert.equal(props.scheduled_for, "2026-08-14");
  const suppression = suppressionFromBlock({ id: "s1", properties: props });
  assert.equal(suppression.reason, "scheduled");
  assert.equal(suppression.task_id, "triage-task-1");
  assert.deepEqual(
    applyTriageSuppressions({ open_items: [{ id: "slack:dm:D1:1" }] }, [suppression]).open_items,
    [],
    "scheduled work stays out of future elevation surfaces"
  );
});

test("blocks that are not suppressions are ignored on the way back in", () => {
  const rows = suppressionsFromBlocks([
    { id: "s1", properties: { kind: "triage_suppression", triage_id: "a", reason: "done", itemTitle: "A" } },
    { id: "b1", properties: { kind: "backlog", title: "a real task" } },
    { id: "n1", properties: {} },
    null,
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { block_id: rows[0].block_id, triage_id: rows[0].triage_id, title: rows[0].title },
    { block_id: "s1", triage_id: "a", title: "A" }
  );
});

test("a suppression is dateless by construction, so it cannot expire with the day", () => {
  // The first defect, stated as a property. The day_root overlay this replaces was keyed
  // `pa-triage-deleted-<date>` / `_triageDeleted` on that date's root, which is why 19
  // items cleared on 2026-08-04 were all back on 2026-08-05.
  const props = buildSuppressionProperties({ triageId: "gmail:abc", key: "email|gmail:abc" });
  assert.equal("date" in props, false);
  const index = suppressionIndex([{ triage_id: "gmail:abc" }]);
  for (const date of ["2026-08-04", "2026-08-05", "2027-01-01"]) {
    assert.equal(
      applyTriageSuppressions({ date, open_items: [{ id: "gmail:abc", type: "email" }] }, [{ triage_id: "gmail:abc" }]).open_items.length,
      0,
      "still suppressed on " + date
    );
  }
  assert.equal(isSuppressed({ id: "gmail:abc" }, index), true);
});
