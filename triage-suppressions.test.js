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
  suppressionsFromBlocks,
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

test("the raw list is never destroyed, so Undo has something to restore", () => {
  // Caught on a live local run, not in review: an earlier cut filtered at the INGEST door
  // as well, which stripped the item from stored state. Deleting the suppression then
  // restored nothing — the item was gone until the next sweep happened to re-emit it.
  // mergeOpenItems must stay suppression-blind for Undo to be lossless.
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
