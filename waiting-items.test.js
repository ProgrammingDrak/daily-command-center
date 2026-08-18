const test = require("node:test");
const assert = require("node:assert/strict");
const Waiting = require("./waiting-items");

const item = (overrides = {}) => ({
  id: "w-1",
  type: "block",
  created_at: "2026-08-01T13:00:00.000Z",
  properties: {
    kind: "delegated_item",
    myTask: "Ship launch deck",
    title: "Legal approval",
    delegatee: { name: "Morgan", kind: "person" },
    waitingReason: "both",
    checkInDate: "2026-08-11",
    checkInDays: 7,
    status: "open",
    ...overrides,
  },
});

test("legacy delegated rows normalize into Waiting without a migration", () => {
  const props = Waiting.normalizeProperties({
    myTask: "Legacy task",
    delegatee: { name: "Taylor" },
    checkInCadence: "weekly",
  });
  assert.equal(props.kind, "delegated_item");
  assert.equal(props.waitingReason, "delegated");
  assert.equal(props.checkInDays, 7);
  assert.deepEqual(props.contact, {
    channel: "other",
    address: "",
    sourceRef: "",
    threadTs: "",
    messageTs: "",
  });
});

test("Waiting enters attention at 70 percent and respects snooze", () => {
  const early = Waiting.attentionFor(item(), "2026-08-08", { timeZone: "America/New_York" });
  assert.equal(early.phase, "early");
  assert.equal(early.attentionScore, 70);
  assert.equal(early.draftEligible, false);
  assert.equal(Waiting.attentionFor(item({ snoozedUntil: "2026-08-10" }), "2026-08-08"), null);
  assert.equal(Waiting.attentionFor(item({ snoozedUntil: "2026-08-08" }), "2026-08-08").phase, "early");
});

test("due Waiting item gets a stable copy-ready triage overlay", () => {
  const waiting = item({ contact: {
    channel: "slack",
    address: "C1",
    sourceRef: "https://example.slack.com/archives/C1/p1",
    threadTs: "222.50",
    messageTs: "222.55",
  } });
  const out = Waiting.mergeTriage({ open_items: [{ id: "gmail:existing" }] }, [waiting], "2026-08-11", {
    nowIso: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(out.open_items.length, 2);
  const draft = out.open_items[1];
  assert.equal(draft.id, "waiting-checkin:w-1:2026-08-11");
  assert.equal(draft.waiting_item_id, "w-1");
  assert.equal(draft.draft_type, "internal");
  assert.deepEqual(draft.contact, waiting.properties.contact);
  assert.match(draft.draft_preview, /Hi Morgan/);
  assert.match(draft.draft_preview, /Legal approval/);
});

test("native Sweep draft wins over the internal fallback and stale cycles drop", () => {
  const native = {
    id: "waiting-checkin:w-1:2026-08-11",
    waiting_item_id: "w-1",
    waiting_cycle_key: "waiting:w-1:2026-08-11",
    draft_type: "slack",
    draft_link: "https://slack.test/draft",
  };
  const stale = { ...native, id: "waiting-checkin:w-1:2026-08-04", waiting_cycle_key: "waiting:w-1:2026-08-04" };
  const out = Waiting.mergeTriage({ open_items: [stale, native] }, [item()], "2026-08-11");
  assert.deepEqual(out.open_items, [native]);
});

test("completing a triage cycle advances cadence exactly once", () => {
  const current = item();
  const result = Waiting.completeCycleProperties(
    current,
    "waiting:w-1:2026-08-11",
    "2026-08-11T15:00:00.000Z",
    "America/New_York"
  );
  assert.equal(result.status, "completed");
  assert.equal(result.properties.checkInDate, "2026-08-18");
  assert.equal(result.properties.lastCompletedCycleKey, "waiting:w-1:2026-08-11");
  const repeated = Waiting.completeCycleProperties(
    { ...current, properties: result.properties },
    "waiting:w-1:2026-08-11",
    "2026-08-11T15:01:00.000Z",
    "America/New_York"
  );
  assert.equal(repeated.status, "skipped_stale");
});

test("unblocked and completed rows never enter attention or triage", () => {
  for (const status of ["unblocked", "done"]) {
    const row = item({ status, completedAt: "2026-08-10T10:00:00.000Z" });
    assert.equal(Waiting.attentionFor(row, "2026-08-12"), null);
    assert.deepEqual(Waiting.mergeTriage({ open_items: [] }, [row], "2026-08-12").open_items, []);
  }
});

test("task dependencies stay out of follow-up cadence and triage", () => {
  const dependency = item({
    blockerType: "task",
    blockerBlockId: "buy-fixture",
    linkedBlockId: "install-fixture",
    checkInDate: "2026-08-11",
  });
  assert.equal(Waiting.isTaskDependency(dependency), true);
  assert.equal(Waiting.attentionFor(dependency, "2026-08-12"), null);
  assert.deepEqual(Waiting.mergeTriage({ open_items: [] }, [dependency], "2026-08-12").open_items, []);
});

// ── a scheduled check-in must not also nag ────────────────────────────────────
//
// Reproduced live before this gate existed: scheduling a check-in from the Waiting drawer
// left THREE prompts for one dependency at the same time. The itinerary task the user just
// placed, a read-time triage card (mergeTriage), and a Sweep Suite reply draft
// (/api/waiting-items/attention feeds draft-replies).
//
// The condition deliberately mirrors the client's own filter in public/js/delegated.js
// (`p.checkInTaskId && p.checkInScheduledFor >= todayStr()`) so the sidebar and the server
// cannot disagree about what counts as already handled.

const scheduledRow = (extra) => ({
  id: "waiting-sched",
  type: "block",
  date: null,
  created_at: "2026-08-01T12:00:00.000Z",
  properties: {
    kind: "delegated_item",
    myTask: "Chase the vendor",
    title: "Vendor invoice",
    delegatee: { name: "Vendor", kind: "person" },
    checkInDate: "2026-08-10",
    checkInDays: 7,
    status: "open",
    ...extra,
  },
});
const attentionOn = (extra, date) =>
  Waiting.attentionFor(scheduledRow(extra), date, { timeZone: "America/New_York" });

test("an unscheduled overdue check-in still asks for attention", () => {
  assert.ok(attentionOn({}, "2026-08-18"), "the baseline must keep working");
});

test("a check-in scheduled for TODAY does not also raise a card", () => {
  assert.equal(attentionOn({ checkInTaskId: "t-1", checkInScheduledFor: "2026-08-18" }, "2026-08-18"), null);
});

test("a check-in scheduled for a future day stays quiet", () => {
  assert.equal(attentionOn({ checkInTaskId: "t-1", checkInScheduledFor: "2026-08-19" }, "2026-08-18"), null);
});

test("the gate LAPSES once the scheduled day passes with the cycle still open", () => {
  // This is what keeps the gate from becoming a dangling pointer. Nothing clears
  // checkInTaskId when the linked task is DELETED (only completeCycleProperties clears it,
  // on success), so an open-ended gate would silence the item permanently.
  assert.ok(
    attentionOn({ checkInTaskId: "t-1", checkInScheduledFor: "2026-08-17" }, "2026-08-18"),
    "an unkept plan must resurface"
  );
});

test("a task id with no scheduled date does not silence anything", () => {
  assert.ok(attentionOn({ checkInTaskId: "t-1" }, "2026-08-18"));
});

test("a scheduled date with no task id does not silence anything", () => {
  assert.ok(attentionOn({ checkInScheduledFor: "2026-08-18" }, "2026-08-18"));
});

test("a malformed scheduled date is ignored rather than trusted", () => {
  assert.ok(attentionOn({ checkInTaskId: "t-1", checkInScheduledFor: "not-a-date" }, "2026-08-18"));
});

test("completing the cycle clears the gate fields, so the next cycle is unaffected", () => {
  // completeCycleProperties nulls checkInTaskId/checkInScheduledFor, which is what makes
  // the gate self-limiting rather than sticky across cycles.
  const row = scheduledRow({ checkInTaskId: "t-1", checkInScheduledFor: "2026-08-10" });
  const done = Waiting.completeCycleProperties(row, "waiting:waiting-sched:2026-08-10", "2026-08-10T12:00:00.000Z", "America/New_York");
  assert.equal(done.status, "completed");
  assert.equal(done.properties.checkInTaskId, null);
  assert.equal(done.properties.checkInScheduledFor, null);
});
