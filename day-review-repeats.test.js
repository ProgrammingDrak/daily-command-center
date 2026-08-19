"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const repeats = require("./day-review-repeats");

function packet(items, decisions = {}) {
  return {
    date: "2026-08-19",
    glymphatic_brief: {
      decisions,
      current: { pages: [{ id: "day-review", review_date: "2026-08-18", items }] },
    },
  };
}

test("an exact title/tag repeat stays hidden after a prior dismissal changed its id", () => {
  const prior = packet(
    [{ id: "old-id", title: "reply with exactly READY", tags: ["claude"] }],
    { "old-id": { action: "dismiss" } }
  );
  const current = packet([
    { id: "new-id", title: "reply with exactly READY", tags: ["claude"] },
    { id: "real-work", title: "Ship the mobile fix", tags: ["dcc"] },
  ]);

  const out = repeats.applyDayReviewRepeatOverlay(current, [{ state_json: prior }]);
  const page = out.glymphatic_brief.current.pages[0];
  assert.deepEqual(page.items.map((item) => item.id), ["real-work"]);
  assert.deepEqual(page.repeat_suppressed_items, [{
    id: "new-id",
    signature: "reply with exactly ready::::claude",
    reason: "dismissed-repeat",
  }]);
});

test("same-title items with different tags remain distinct", () => {
  const prior = packet(
    [{ id: "old-id", title: "Review launch", tags: ["internal"] }],
    { "old-id": { action: "dismiss" } }
  );
  const current = packet([{ id: "customer-launch", title: "Review launch", tags: ["customer"] }]);
  const out = repeats.applyDayReviewRepeatOverlay(current, [prior]);
  assert.deepEqual(out.glymphatic_brief.current.pages[0].items.map((item) => item.id), ["customer-launch"]);
});

test("duplicates inside one packet collapse and keep unique follow-ups", () => {
  const current = packet([
    { id: "a", title: "Rebase the branch", tags: ["git"], followups: [{ id: "f1", title: "Run tests" }] },
    { id: "b", title: "Rebase the branch", tags: ["git"], followups: [
      { id: "f2", title: "Run tests" },
      { id: "f3", title: "Push the branch" },
    ] },
  ]);
  const out = repeats.applyDayReviewRepeatOverlay(current, []);
  const page = out.glymphatic_brief.current.pages[0];
  assert.deepEqual(page.items.map((item) => item.id), ["a"]);
  assert.deepEqual(page.items[0].followups.map((item) => item.id), ["f1", "f3"]);
  assert.equal(page.repeat_suppressed_items[0].reason, "duplicate");
});

test("approved history does not suppress a later occurrence", () => {
  const prior = packet([{ id: "old", title: "Daily standup", tags: ["work"] }], {
    old: { action: "approve" },
  });
  const current = packet([{ id: "new", title: "Daily standup", tags: ["work"] }]);
  const out = repeats.applyDayReviewRepeatOverlay(current, [prior]);
  assert.deepEqual(out.glymphatic_brief.current.pages[0].items.map((item) => item.id), ["new"]);
});

test("the item that owns a dismissal remains available for Undo while its sibling is hidden", () => {
  const current = packet([
    { id: "dismissed", title: "Repeated session", tags: ["claude"] },
    { id: "sibling", title: "Repeated session", tags: ["claude"] },
  ], { dismissed: { action: "dismiss" } });
  const out = repeats.applyDayReviewRepeatOverlay(current, []);
  const page = out.glymphatic_brief.current.pages[0];
  assert.deepEqual(page.items.map((item) => item.id), ["dismissed"]);
  assert.equal(page.repeat_suppressed_items[0].id, "sibling");
});

test("a dismissal outlives the republish that replaces its packet's items", () => {
  // The real row layout, not the convenient one. The client reviews yesterday's packet
  // from TODAY's borrowed row, so the decision lands there; the next night's publish
  // replaces that row's items. Verified in prod on 2026-08-17: 34 stored decisions
  // against 24 item ids in the same row. Joining ids back to items finds nothing, so
  // the signature has to travel ON the decision.
  const republished = {
    glymphatic_brief: {
      decisions: { "old-id": { action: "dismiss", signature: repeats.itemSignature({ title: "reply with exactly READY", tags: ["claude"] }) } },
      current: { pages: [{ id: "day-review", items: [{ id: "unrelated", title: "Something else entirely" }] }] },
    },
  };
  const current = packet([{ id: "new-id", title: "reply with exactly READY", tags: ["claude"] }]);
  const out = repeats.applyDayReviewRepeatOverlay(current, [republished]);
  assert.deepEqual(out.glymphatic_brief.current.pages[0].items.map((i) => i.id), []);
});

test("a dismissed FOLLOW-UP does not come back under a new id", () => {
  const prior = packet(
    [{ id: "p-old", title: "Session", followups: [{ id: "f-old", title: "Send the rollout note" }] }],
    { "f-old": { action: "dismiss" } }
  );
  const current = packet([{ id: "p-new", title: "Session", followups: [{ id: "f-new", title: "Send the rollout note" }] }]);
  const out = repeats.applyDayReviewRepeatOverlay(current, [prior]);
  const kept = out.glymphatic_brief.current.pages[0].items;
  assert.deepEqual(kept.map((i) => i.id), ["p-new"], "the parent is a distinct signature and survives");
  assert.deepEqual(kept[0].followups.map((f) => f.id), [], "the re-keyed follow-up is suppressed");
});

test("the follow-up that OWNS the current dismissal still renders, so Undo works", () => {
  const current = packet(
    [{ id: "p", title: "Session", followups: [{ id: "f", title: "Send the rollout note" }] }],
    { f: { action: "dismiss" } }
  );
  const out = repeats.applyDayReviewRepeatOverlay(current, []);
  assert.deepEqual(out.glymphatic_brief.current.pages[0].items[0].followups.map((f) => f.id), ["f"]);
});

test("the overlay does not mutate stored packet objects", () => {
  const current = packet([
    { id: "a", title: "Duplicate" },
    { id: "b", title: "Duplicate" },
  ]);
  const before = JSON.stringify(current);
  repeats.applyDayReviewRepeatOverlay(current, []);
  assert.equal(JSON.stringify(current), before);
});
