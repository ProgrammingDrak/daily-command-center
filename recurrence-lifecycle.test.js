// recurrence-lifecycle.test.js — the one-open-instance invariant
// (dcc-canonical-task-model, Phase D1).
//
// A recurring responsibility must PAUSE while an instance of it is scheduled,
// RESUME UNTOUCHED if that instance never gets done, and RESET FROM THE
// COMPLETION MOMENT when it does. These tests are written against the failure
// Drake actually hit ("schedule it for tomorrow and today's strip re-offers it
// on the very next render") plus the three mechanisms ANALYSIS.md Phase 7
// identified, so a regression reads as the original complaint rather than as an
// abstract assertion failure.

const test = require("node:test");
const assert = require("node:assert/strict");

const recurrence = require("./lib/recurrence");
const createResponsibilityStore = require("./responsibility-store");
const { responsibilityScore } = require("./responsibility-store");

const DAY = 86400000;

// ── The pause ──

test("an in-flight instance pauses the timer no matter how overdue the item is", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const stale = { cadence: "weekly", lastCompletedAt: new Date(at - 90 * DAY).toISOString() };
  // 90 days into a 7-day cadence: as loud as it gets.
  assert.equal(responsibilityScore(stale, at), 100);
  // Now an instance is scheduled. The timer stops dead.
  const scheduled = recurrence.applySchedule(stale, { blockId: "b1", localId: "resp-task-1", date: "2026-07-30" });
  assert.equal(responsibilityScore(scheduled, at), 0, "a scheduled instance must silence the definition");
});

test("THE ORIGINAL BUG: scheduling for TOMORROW silences today, not just the viewed day", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const props = { cadence: "weekly", lastCompletedAt: new Date(at - 30 * DAY).toISOString() };
  const tomorrow = recurrence.applySchedule(props, { blockId: "b1", localId: "l1", date: "2026-07-30" });
  // The old code's only "already scheduled" checks were scoped to the day being
  // viewed, so a task on tomorrow left today's strip re-offering it forever.
  assert.equal(responsibilityScore(tomorrow, at), 0);
  // And a week out is no different -- the pause is not date-relative.
  const nextWeek = recurrence.applySchedule(props, { blockId: "b1", localId: "l1", date: "2026-08-05" });
  assert.equal(responsibilityScore(nextWeek, at), 0);
});

test("pause and skip both suppress; resume and the next cycle release", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const overdue = { cadence: "weekly", lastCompletedAt: new Date(at - 30 * DAY).toISOString() };
  assert.equal(responsibilityScore(overdue, at), 100);

  const paused = recurrence.applyPause(overdue, null);
  assert.equal(paused.pausedUntil, "forever");
  assert.equal(responsibilityScore(paused, at), 0);
  assert.equal(responsibilityScore(recurrence.applyResume(paused), at), 100, "resume restores the accrued urgency");

  const untilDate = recurrence.applyPause(overdue, "2026-07-31");
  assert.equal(responsibilityScore(untilDate, at), 0);
  // The boundary itself: a dated pause releases ON its until-date, not the day
  // after. Without this the > / >= distinction is unpinned.
  assert.equal(responsibilityScore(untilDate, new Date(2026, 6, 31, 12, 0, 0)), 100, "a pause releases ON its until-date");
  assert.equal(responsibilityScore(untilDate, new Date(2026, 7, 1, 12, 0, 0)), 100, "a dated pause expires on its own");
  // A full ISO timestamp string-compares longer than any bare date, which would
  // silently buy an extra day; applyPause normalizes to the date part.
  const isoPause = recurrence.applyPause(overdue, "2026-07-30T10:00:00Z");
  assert.equal(isoPause.pausedUntil, "2026-07-30");
  assert.equal(responsibilityScore(isoPause, new Date(2026, 6, 30, 18, 0, 0)), 100, "an ISO pausedUntil must not buy an extra day");

  const skipped = recurrence.applySkip(overdue, at);
  assert.equal(responsibilityScore(skipped, at), 0);
  assert.ok(skipped.skipUntil > "2026-07-29", "a skip must move the item at least to tomorrow");
});

test("a dated pause and a skip are evaluated on the USER's day, not the host's", () => {
  // 2026-07-30T01:00Z is still Wednesday the 29th in Chicago, so a skip/pause
  // through the 30th is still active there. On a UTC host (which is what prod is)
  // the host-day comparison called it lapsed and handed back full urgency, so an
  // evening Skip did nothing and auto-schedule would re-materialize the task.
  const at = new Date("2026-07-30T01:00:00Z");
  const overdue = { cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z", skipUntil: "2026-07-30" };
  assert.equal(recurrence.isSkipped(overdue, at, "America/Chicago"), true);
  assert.equal(responsibilityScore(overdue, at, "America/Chicago"), 0, "the user's evening skip is honored");
  const paused = { cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z", pausedUntil: "2026-07-30" };
  assert.equal(recurrence.isPaused(paused, at, "America/Chicago"), true);
  assert.equal(responsibilityScore(paused, at, "America/Chicago"), 0);
});

// ── Skip is not Complete ──

test("Skip does NOT touch the cadence clock, so urgency keeps accruing underneath", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const lastDone = new Date(at - 30 * DAY).toISOString();
  const skipped = recurrence.applySkip({ cadence: "weekly", lastCompletedAt: lastDone }, at);
  // This is the whole point of Skip existing separately from Complete: Drake gets
  // the card off his screen without lying about having done the thing.
  assert.equal(skipped.lastCompletedAt, lastDone, "skip must not pretend the work happened");
  assert.equal(skipped.skipCount, 1);
  // Once the skip lapses the item is louder than it was, not reset.
  const after = new Date(skipped.skipUntil + "T12:00:00");
  assert.equal(responsibilityScore(skipped, after), 100);
});

test("Complete resets the clock from the completion moment and clears the pause", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const scheduled = recurrence.applySchedule(
    { cadence: "weekly", lastCompletedAt: new Date(at - 30 * DAY).toISOString() },
    { blockId: "b1", localId: "l1", date: "2026-07-29" }
  );
  const done = recurrence.applyCompletion(scheduled, { completedAt: at.toISOString(), taskId: "b1" });
  assert.equal(done.lastCompletedAt, at.toISOString());
  assert.equal(recurrence.hasOpenInstance(done), false, "completing must release the pause");
  assert.equal(responsibilityScore(done, at), 0, "just completed -> zero elapsed");
  // Exactly one cadence later it is due again, measured from the completion.
  assert.equal(responsibilityScore(done, new Date(at.getTime() + 7 * DAY)), 100);
});

test("un-checking restores the previous clock instead of leaving the reset in place", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const original = new Date(at - 30 * DAY).toISOString();
  const done = recurrence.applyCompletion(
    recurrence.applySchedule({ cadence: "weekly", lastCompletedAt: original }, { blockId: "b1", localId: "l1", date: "2026-07-29" }),
    { completedAt: at.toISOString(), taskId: "b1" }
  );
  const undone = recurrence.applyUncompletion(done, { blockId: "b1", localId: "l1", date: "2026-07-29" });
  // Before D1 an accidental check-off silently pushed the next occurrence a full
  // cycle out with no way back.
  assert.equal(undone.lastCompletedAt, original, "un-checking must put the clock back");
  assert.equal(undone.openInstanceBlockId, "b1", "and put the instance back in flight");

  // IDEMPOTENT: a retry or double-click must not treat the already-restored clock
  // as the completion being undone. Unguarded, the second call deleted
  // lastCompletedAt outright and slammed the item to 100 with the real timestamp
  // unrecoverable.
  const twice = recurrence.applyUncompletion(undone, { blockId: "b1", localId: "l1", date: "2026-07-29" });
  assert.equal(twice.lastCompletedAt, original, "a second un-check is a no-op on the clock");
  assert.equal(responsibilityScore(twice, at), responsibilityScore(undone, at));
});

test("a completion recorded with no taskId and no prior completion is STILL reversible", () => {
  // What the sidebar / triage Complete button produces: POST /complete sends only
  // completedAt, and an item with no instance in flight and no prior completion
  // leaves lastCompletedTaskId AND previousCompletedAt both null. Keying the undo
  // guard on those alone made this completion permanent.
  const done = recurrence.applyCompletion({ cadence: "weekly" }, { completedAt: "2026-07-29T12:00:00Z" });
  assert.equal(done.lastCompletedTaskId, null);
  assert.equal(done.previousCompletedAt, null);
  assert.equal(done.completionUndoable, true, "the explicit marker is what makes it reversible");
  const undone = recurrence.applyUncompletion(done, {});
  assert.equal(undone.lastCompletedAt, undefined, "the clock is genuinely cleared");
  assert.equal(undone.completionUndoable, undefined);
  // And still idempotent.
  assert.equal(recurrence.applyUncompletion(undone, {}).lastCompletedAt, undefined);
});

test("un-checking a FIRST-ever completion still clears the clock", () => {
  // previousCompletedAt is legitimately null here, so the idempotence guard has to
  // key on lastCompletedTaskId (which applyCompletion sets) rather than on it.
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const done = recurrence.applyCompletion(
    recurrence.applySchedule({ cadence: "weekly", createdAt: new Date(at - 30 * DAY).toISOString() }, { blockId: "b1", localId: "l1", date: "2026-07-29" }),
    { completedAt: at.toISOString(), taskId: "b1" }
  );
  const undone = recurrence.applyUncompletion(done, { blockId: "b1" });
  assert.equal(undone.lastCompletedAt, undefined, "there was no prior completion to restore");
});

// ── "Kicks back in as if it wasn't ever done" ──

test("a dropped instance resumes at FULL accrued urgency, as if never scheduled", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const props = { cadence: "weekly", lastCompletedAt: new Date(at - 21 * DAY).toISOString() };
  const before = responsibilityScore(props, at);
  const scheduled = recurrence.applySchedule(props, { blockId: "b1", localId: "l1", date: "2026-07-29" });
  assert.equal(responsibilityScore(scheduled, at), 0);
  // Deleted / never done -> clear the pause and NOTHING else. The clock was never
  // touched, so every accrued day is still there. This is the behavior Drake
  // asked for, and it falls out of the model rather than needing its own path.
  const dropped = recurrence.clearOpenInstance(scheduled);
  assert.equal(responsibilityScore(dropped, at), before);
  assert.equal(dropped.lastCompletedAt, props.lastCompletedAt);
  assert.equal(dropped.openInstanceBlockId, undefined);
});

// ── Instance-state resolution: the derived half ──

const ROOT_KEY = { instanceDate: "2026-07-29", todayStr: "2026-07-29", keys: ["l1", "b1"] };

test("resolveInstanceState: an open instance stays open", () => {
  const out = recurrence.resolveInstanceState({
    ...ROOT_KEY,
    instanceBlock: { id: "b1", properties: { local_id: "l1", responsibilityId: "r1" } },
    dayRootProps: { _done: { ids: [], at: {} } },
  });
  assert.equal(out.state, "open");
});

test("resolveInstanceState: row-level done (quick-task / Slack timer / post-C5) is detected", () => {
  const out = recurrence.resolveInstanceState({
    ...ROOT_KEY,
    instanceBlock: { id: "b1", properties: { local_id: "l1", status: "done", completedAt: "2026-07-29T15:00:00Z" } },
    dayRootProps: {},
  });
  assert.equal(out.state, "done");
  assert.equal(out.completedAt, "2026-07-29T15:00:00Z");
});

test("resolveInstanceState: day-overlay done catches the four UI paths that never told the server", () => {
  // toggleDone, _autoCompleteShellAncestors, commitDoneOnDate/markOnDate and the
  // _onParentCompleted cascade all persist into day_root._done rather than onto
  // the task row. _autoCompleteShellAncestors is the one that mattered most:
  // because the shell ROOT is the node carrying responsibilityId and it never
  // went through toggleDone, no shell responsibility ever reset its cadence, no
  // matter how thoroughly its children were finished.
  const out = recurrence.resolveInstanceState({
    ...ROOT_KEY,
    instanceBlock: { id: "b1", properties: { local_id: "l1", responsibilityId: "r1", type: "shell" } },
    dayRootProps: { _done: { ids: ["l1"], at: { l1: "2026-07-29T16:30:00Z" } } },
  });
  assert.equal(out.state, "done", "a shell completed through its children must reset the cadence");
  assert.equal(out.completedAt, "2026-07-29T16:30:00Z");
});

test("resolveInstanceState: an API-inserted instance is keyed by row id, not local_id", () => {
  const out = recurrence.resolveInstanceState({
    ...ROOT_KEY,
    instanceBlock: { id: "b1", properties: { responsibilityId: "r1" } },
    dayRootProps: { _done: { ids: ["b1"], at: { b1: "2026-07-29T11:00:00Z" } } },
  });
  assert.equal(out.state, "done");
});

test("resolveInstanceState: every flavor of deleted reads as gone", () => {
  const hard = recurrence.resolveInstanceState({ ...ROOT_KEY, instanceBlock: null, dayRootProps: {} });
  assert.equal(hard.state, "gone");
  const soft = recurrence.resolveInstanceState({
    ...ROOT_KEY,
    instanceBlock: { id: "b1", deleted_at: "2026-07-29T10:00:00Z", properties: { local_id: "l1" } },
    dayRootProps: {},
  });
  assert.equal(soft.state, "gone");
  const overlay = recurrence.resolveInstanceState({
    ...ROOT_KEY,
    instanceBlock: { id: "b1", properties: { local_id: "l1" } },
    dayRootProps: { _deleted: ["l1"] },
  });
  assert.equal(overlay.state, "gone", "the day-root _deleted overlay is the client's delete representation");
});

test("an instance that was DONE and then deleted still counts as done", () => {
  // "Check it off, then tidy it off the itinerary" is an ordinary sequence. With
  // the delete checks running first it resolved to "gone", threw the completion
  // away, and re-offered the responsibility at full urgency the same day it was
  // actually done. Done is the stronger fact and wins.
  const out = recurrence.resolveInstanceState({
    ...ROOT_KEY,
    instanceBlock: { id: "b1", deleted_at: "2026-07-29T16:00:00Z", properties: { local_id: "l1" } },
    dayRootProps: { _done: { ids: ["l1"], at: { l1: "2026-07-29T15:00:00Z" } }, _deleted: ["l1"] },
  });
  assert.equal(out.state, "done", "deleting a finished task must not un-do the cadence reset");
  assert.equal(out.completedAt, "2026-07-29T15:00:00Z");
});

test("anchorMode calendar does not re-offer an occurrence already completed in this period", () => {
  // Calendar mode ignores lastCompletedAt for the BASE, so it needs an explicit
  // satisfaction check or the score keeps climbing after the work is done and the
  // card returns the instant it is checked off -- the reappear bug, reintroduced
  // through the other anchor mode.
  const at = new Date(2026, 6, 29, 12, 0, 0);
  const props = { cadenceDays: 7, anchorMode: "calendar", createdAt: new Date(at - 20 * DAY).toISOString() };
  assert.ok(responsibilityScore(props, at) >= recurrence.DUE_THRESHOLD, "due before it is done");
  const justDone = { ...props, lastCompletedAt: at.toISOString() };
  assert.equal(responsibilityScore(justDone, at), 0, "completing it must silence it in calendar mode too");
  // Still quiet later the same period, loud again after the next boundary.
  assert.equal(responsibilityScore(justDone, new Date(at.getTime() + 1 * DAY)), 0);
  assert.ok(responsibilityScore(justDone, new Date(at.getTime() + 9 * DAY)) > 0, "the next period re-arms it");
});

test("calendar anchor prefers a preferred-completion day more recent than the walked boundary", () => {
  // periodStart's `preferred > walked ? preferred : walked` branch -- the whole
  // reason calendar mode and a preferred cadence can coexist.
  const at = new Date(2026, 6, 29, 12, 0, 0); // Wednesday
  const base = { cadence: "weekly", anchorMode: "calendar", createdAt: new Date(2026, 5, 1).toISOString() };
  const walked = responsibilityScore(base, at);
  const withPreferred = responsibilityScore({ ...base, preferredCompletionCadence: "weekly", preferredDayOfWeek: 2 }, at); // Tuesday
  assert.ok(withPreferred < walked,
    `a preferred day nearer than the walked boundary wins the anchor (got ${withPreferred} vs ${walked})`);
});

test("preferredOccurrenceStart clamps a day-31 monthly back into a short month", () => {
  const out = recurrence.preferredOccurrenceStart(
    { preferredCompletionCadence: "monthly", preferredDayOfMonth: 31 },
    new Date(2026, 2, 5, 12), null
  );
  assert.equal(recurrence.dateStr(out), "2026-02-28");
});

test("nextOccurrenceDate clamps monthly/yearly rollover instead of overflowing", () => {
  // new Date(2026, 1, 31) rolls to March 3, so an unclamped skip on a day-31
  // monthly would hide the item until March and swallow February's occurrence.
  const jan31 = new Date(2026, 0, 31, 12, 0, 0);
  const monthly = recurrence.nextOccurrenceDate({ preferredCompletionCadence: "monthly", preferredDayOfMonth: 31 }, jan31);
  assert.equal(monthly, "2026-02-28");
  const feb29 = new Date(2024, 1, 29, 12, 0, 0); // a real leap day
  const yearly = recurrence.nextOccurrenceDate({ preferredCompletionCadence: "yearly", preferredMonth: 2, preferredMonthDay: 29 }, feb29);
  assert.equal(yearly, "2025-02-28");
});

test("resolveInstanceState: an undone instance on a PAST day reads as dropped, not eternally open", () => {
  const out = recurrence.resolveInstanceState({
    instanceBlock: { id: "b1", properties: { local_id: "l1" } },
    dayRootProps: { _done: { ids: [] } },
    keys: ["l1", "b1"],
    instanceDate: "2026-07-20",
    todayStr: "2026-07-29",
  });
  assert.equal(out.state, "gone", "a pause must never be able to leak forever");
});

// ── anchorMode: the Todoist every! / every split ──

test("anchorMode completion (default) measures from the completion; calendar from the boundary", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0);
  // A 7-day item running since 30 days ago, so its calendar boundaries fall at
  // -30/-23/-16/-9/-2 and the CURRENT period began 2 days ago (30 = 4*7 + 2).
  // It was finished 3 days ago -- i.e. before that boundary, in the prior period.
  const createdAt = new Date(at - 30 * DAY).toISOString();
  const lastCompletedAt = new Date(at - 3 * DAY).toISOString();

  const completionAnchored = responsibilityScore({ cadence: "weekly", createdAt, lastCompletedAt }, at);
  assert.equal(completionAnchored, 43, "completion mode: 3/7 elapsed, measured from when you actually finished");

  const calendarAnchored = responsibilityScore({ cadence: "weekly", createdAt, lastCompletedAt, anchorMode: "calendar" }, at);
  assert.equal(calendarAnchored, 29, "calendar mode: 2/7 from the boundary -- when you finished does not move the schedule");

  // Finishing INSIDE the current period satisfies it in either mode; that is the
  // reappear-after-Done guard, asserted for calendar mode in its own test below.
  const finishedThisPeriod = new Date(at - 1 * DAY).toISOString();
  assert.equal(responsibilityScore({ cadence: "weekly", createdAt, lastCompletedAt: finishedThisPeriod, anchorMode: "calendar" }, at), 0);
});

// ── Timezone ──

test("the preferred-day gate uses the USER's calendar day, not the host's", () => {
  // 2026-07-30 01:00 UTC is still Wednesday 2026-07-29 in Chicago. A weekly
  // responsibility preferred on WEDNESDAY must be due for a Chicago user and not
  // for a UTC one. Before D1 the server always answered in the host's zone and
  // the client trusted it, so the gate fired on the wrong local day for a 5-6
  // hour window every single day.
  const at = new Date("2026-07-30T01:00:00Z");
  const WEDNESDAY = 3;
  const props = { preferredCompletionCadence: "weekly", preferredDayOfWeek: WEDNESDAY };
  assert.equal(recurrence.preferredCompletionDue(props, at, "America/Chicago"), true);
  assert.equal(recurrence.preferredCompletionDue(props, at, "UTC"), false);
  // A bogus zone must degrade to HOST-LOCAL specifically, not merely "not throw" --
  // a typeof check would have been satisfied by any answer at all.
  assert.equal(
    recurrence.preferredCompletionDue(props, at, "Not/AZone"),
    recurrence.preferredCompletionDue(props, at, null),
    "an unknown IANA name degrades to host-local, it does not silently change the answer"
  );
});

test("nextOccurrenceDate lands on the next preferred day, and never today", () => {
  const at = new Date(2026, 6, 29, 12, 0, 0); // Wednesday
  const weekly = recurrence.nextOccurrenceDate({ preferredCompletionCadence: "weekly", preferredDayOfWeek: 3 }, at);
  assert.equal(weekly, "2026-08-05", "next Wednesday");
  const plain = recurrence.nextOccurrenceDate({ cadenceDays: 7 }, at);
  assert.equal(plain, "2026-08-05");
  const daily = recurrence.nextOccurrenceDate({ cadenceDays: 1 }, at);
  assert.equal(daily, "2026-07-30", "a daily item skips to tomorrow, never to today");
});

// ── The reconciler, against a fake blockDB ──

// Mirrors the parts of db.js the store actually uses. getBlock is a strict
// PRIMARY-KEY lookup, exactly like the real one -- that fidelity matters, because
// the production id shape (a client local_id stamped where a row id was assumed)
// is precisely what an id-agnostic fake would have hidden.
function makeFake({ blocks = {}, responsibilities = [] } = {}) {
  const calls = { updateBlock: [], getBlock: [], ensureDayRoot: [], getBlocksByDateIncludingDeleted: [], findBlockByLocalId: [] };
  return {
    calls,
    async getResponsibilityBlocks() { return responsibilities; },
    async getBlock(id) { calls.getBlock.push(id); return blocks[id] || null; },
    async getBlocksByDateIncludingDeleted(date, workspaceId) {
      calls.getBlocksByDateIncludingDeleted.push({ date, workspaceId });
      return Object.values(blocks).filter(b => b.date === date);
    },
    // Present so a regression that swaps the read-only day-root lookup for
    // ensureDayRoot is a recorded call rather than a swallowed TypeError.
    async ensureDayRoot(date) { calls.ensureDayRoot.push(date); return `day-root-${date}`; },
    // Mirrors db.js findBlockByLocalId: date-independent, keeps soft-deleted rows.
    async findBlockByLocalId(localId) {
      calls.findBlockByLocalId.push(localId);
      return Object.values(blocks).find(b => String((b.properties || {}).local_id) === String(localId)) || null;
    },
    async updateBlock(id, fields) {
      calls.updateBlock.push({ id, fields });
      if (blocks[id]) blocks[id] = { ...blocks[id], properties: fields.properties };
      return { id, properties: fields.properties };
    },
    // Mutate a row out from under the store, the way a real user's next click does.
    setBlock(id, properties) { blocks[id] = { ...(blocks[id] || { id }), id, properties }; },
  };
}

function makeStore(fake, today = "2026-07-29") {
  return createResponsibilityStore({
    blockDB: fake,
    getScheduleBlocks: async () => [{ blockType: "work", start: "09:00", end: "17:00" }],
    getTodayStr: () => today,
    assertBlockOwnership: () => {},
  });
}

test("getResponsibilityBlocks settles a completed instance without anyone firing an event", async () => {
  // The store scores against real `new Date()`, so the fixture's completion is
  // anchored to now rather than to a fixed date -- otherwise the expected score
  // would drift as the calendar moves.
  const nowIso = new Date().toISOString();
  const TODAY = recurrence.dateStr(new Date());
  const definition = {
    id: "r1",
    properties: {
      kind: "responsibility_item", title: "Weekly review", cadence: "weekly",
      lastCompletedAt: "2026-07-01T00:00:00Z",
      openInstanceBlockId: "b1", openInstanceLocalId: "l1", openInstanceDate: TODAY,
    },
  };
  const fake = makeFake({
    responsibilities: [definition],
    blocks: {
      b1: { id: "b1", properties: { local_id: "l1", responsibilityId: "r1", type: "shell" } },
      // The shell was completed through its children, so the only record is the
      // day root's _done overlay. No client code told the server anything.
      [`day-root-ws-1-${TODAY}`]: { id: `day-root-ws-1-${TODAY}`, properties: { _done: { ids: ["l1"], at: { l1: nowIso } } } },
    },
  });
  const store = makeStore(fake, TODAY);
  const items = await store.getResponsibilityBlocks("ws-1");
  assert.equal(fake.calls.updateBlock.length, 1, "the definition is healed on read");
  const healed = items[0].properties;
  assert.equal(healed.lastCompletedAt, nowIso, "the cadence clock resets from the completion moment");
  assert.equal(healed.openInstanceBlockId, undefined);
  assert.ok(healed.importanceScore < recurrence.DUE_THRESHOLD, `and it stops being offered (got ${healed.importanceScore})`);
});

test("getResponsibilityBlocks releases a deleted instance at full urgency, clock untouched", async () => {
  const definition = {
    id: "r1",
    properties: {
      kind: "responsibility_item", cadence: "weekly",
      lastCompletedAt: "2026-06-01T00:00:00Z",
      openInstanceBlockId: "b1", openInstanceLocalId: "l1", openInstanceDate: "2026-07-29",
    },
  };
  const fake = makeFake({
    responsibilities: [definition],
    blocks: { b1: { id: "b1", deleted_at: "2026-07-29T10:00:00Z", properties: { local_id: "l1" } } },
  });
  const store = makeStore(fake);
  const items = await store.getResponsibilityBlocks("ws-1");
  const healed = items[0].properties;
  assert.equal(healed.lastCompletedAt, "2026-06-01T00:00:00Z", "the clock must NOT be reset by a delete");
  assert.equal(healed.openInstanceBlockId, undefined);
  assert.equal(healed.importanceScore, 100, "it comes back exactly as loud as it had become");
});

// THE PRODUCTION ID SHAPE. This is the one that was broken and that every other
// reconciler fixture hid by keying its fake blocks on the row id.
//
// insertTaskNow / materializeShellTemplate fire onScheduled with ONE client-minted
// id as both localId and blockId, and blockStore.createBlock posts no id, so the
// row's primary key is a server UUID and the client id survives only in
// properties.local_id. A bare getBlock(openInstanceBlockId) therefore missed,
// resolveInstanceState read "no row" as "gone", and the pause was erased by the
// very next read -- the one registerOpenInstance itself triggers. Verified against
// the live server before the fix: the pause did not survive a single round trip.
test("PRODUCTION SHAPE: an instance the client registered by local_id keeps the pause", async () => {
  const TODAY = recurrence.dateStr(new Date());
  const CLIENT_ID = "qa-1785355511933";  // what insertTaskNow mints
  const fake = makeFake({
    responsibilities: [{
      id: "r1",
      properties: {
        kind: "responsibility_item", cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z",
        // exactly what registerOpenInstance posts: info.blockId === info.localId
        openInstanceBlockId: CLIENT_ID, openInstanceLocalId: CLIENT_ID, openInstanceDate: TODAY,
      },
    }],
    blocks: {
      // The real row: server UUID primary key, client id only in local_id.
      "uuid-9": { id: "uuid-9", date: TODAY, properties: { local_id: CLIENT_ID, responsibilityId: "r1" } },
    },
  });
  const items = await makeStore(fake, TODAY).getResponsibilityBlocks("ws-1");
  assert.equal(fake.calls.updateBlock.length, 0, "nothing to settle -- the instance is alive");
  assert.equal(items[0].properties.openInstanceBlockId, CLIENT_ID, "the pause must survive a local_id stamp");
  assert.equal(items[0].properties.importanceScore, 0, "and the item stays unoffered");
});

test("PRODUCTION SHAPE: a local_id-registered instance completed via the day overlay still resets the cadence", async () => {
  const TODAY = recurrence.dateStr(new Date());
  const CLIENT_ID = "qa-1785355511999";
  const nowIso = new Date().toISOString();
  const fake = makeFake({
    responsibilities: [{
      id: "r1",
      properties: {
        kind: "responsibility_item", cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z",
        openInstanceBlockId: CLIENT_ID, openInstanceLocalId: CLIENT_ID, openInstanceDate: TODAY,
      },
    }],
    blocks: {
      "uuid-9": { id: "uuid-9", date: TODAY, properties: { local_id: CLIENT_ID, responsibilityId: "r1", type: "shell" } },
      [`day-root-ws-1-${TODAY}`]: { id: `day-root-ws-1-${TODAY}`, date: TODAY, properties: { _done: { ids: [CLIENT_ID], at: { [CLIENT_ID]: nowIso } } } },
    },
  });
  const items = await makeStore(fake, TODAY).getResponsibilityBlocks("ws-1");
  assert.equal(items[0].properties.lastCompletedAt, nowIso);
  assert.equal(items[0].properties.openInstanceBlockId, undefined);
});

test("PRODUCTION SHAPE: an instance dragged to ANOTHER day keeps the pause", async () => {
  // Nothing re-stamps openInstanceDate when a task is rescheduled, so the stamped
  // day goes stale. Without the date-independent local_id lookup the day scan
  // missed, the resolver said "gone", and the pause was dropped while the task was
  // sitting alive on a different day.
  const TODAY = recurrence.dateStr(new Date());
  const MOVED_TO = recurrence.dateStr(new Date(Date.now() + 3 * DAY));
  const CLIENT_ID = "qa-moved-1";
  const fake = makeFake({
    responsibilities: [{
      id: "r1",
      properties: {
        kind: "responsibility_item", cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z",
        openInstanceBlockId: CLIENT_ID, openInstanceLocalId: CLIENT_ID, openInstanceDate: TODAY,
      },
    }],
    blocks: { "uuid-moved": { id: "uuid-moved", date: MOVED_TO, properties: { local_id: CLIENT_ID, responsibilityId: "r1" } } },
  });
  const items = await makeStore(fake, TODAY).getResponsibilityBlocks("ws-1");
  assert.deepEqual(fake.calls.findBlockByLocalId, [CLIENT_ID], "the date-independent lookup is what saves this");
  assert.equal(items[0].properties.openInstanceBlockId, CLIENT_ID, "the pause survives the move");
  assert.equal(items[0].properties.importanceScore, 0);
});

test("PRODUCTION SHAPE: an instance stamped with NO date still keeps the pause", async () => {
  // registerOpenInstance falls back to blockStore.getCurrentDate(), which can be
  // null, and setOpenInstance nulls any non-date. With no date there is no day to
  // scan at all.
  const TODAY = recurrence.dateStr(new Date());
  const CLIENT_ID = "qa-nodate-1";
  const fake = makeFake({
    responsibilities: [{
      id: "r1",
      properties: {
        kind: "responsibility_item", cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z",
        openInstanceBlockId: CLIENT_ID, openInstanceLocalId: CLIENT_ID, openInstanceDate: null,
      },
    }],
    blocks: { "uuid-nd": { id: "uuid-nd", date: TODAY, properties: { local_id: CLIENT_ID, responsibilityId: "r1" } } },
  });
  const items = await makeStore(fake, TODAY).getResponsibilityBlocks("ws-1");
  assert.equal(items[0].properties.openInstanceBlockId, CLIENT_ID);
  assert.equal(fake.calls.getBlocksByDateIncludingDeleted.length, 0, "no date means no day scan to attempt");
});

test("readDayRoot only falls back to the legacy un-prefixed day root for ws-1", async () => {
  const fake = makeFake({ blocks: { "day-root-2026-07-29": { id: "day-root-2026-07-29", properties: { _done: { ids: ["l1"] } } } } });
  const store = makeStore(fake);
  assert.ok(await store.readDayRoot("2026-07-29", "ws-1"), "ws-1 still reads its legacy row");
  assert.equal(await store.readDayRoot("2026-07-29", "ws-2"), null, "ws-2 must not settle its cadence from ws-1's day overlay");
  assert.ok(await store.readDayRoot("2026-07-29", null), "a null workspace reads the un-prefixed id directly");
});

test("readDayRoot rejects a non-date, so a forged openInstanceDate cannot aim the lookup", async () => {
  const fake = makeFake({ blocks: { "day-root-ws-3-2026-07-29": { id: "day-root-ws-3-2026-07-29", properties: { _done: { ids: ["l1"] } } } } });
  const store = makeStore(fake);
  // "ws-3-2026-07-29" would interpolate into another workspace's day-root id.
  assert.equal(await store.readDayRoot("ws-3-2026-07-29", "ws"), null);
  assert.equal(await store.readDayRoot("../../etc", "ws-1"), null);
});

test("getResponsibilityBlocks leaves a genuinely open instance paused", async () => {
  const definition = {
    id: "r1",
    properties: {
      kind: "responsibility_item", cadence: "weekly",
      lastCompletedAt: "2026-06-01T00:00:00Z",
      openInstanceBlockId: "b1", openInstanceLocalId: "l1", openInstanceDate: "2026-07-30",
    },
  };
  const fake = makeFake({
    responsibilities: [definition],
    blocks: { b1: { id: "b1", properties: { local_id: "l1", responsibilityId: "r1" } } },
  });
  const store = makeStore(fake);
  const items = await store.getResponsibilityBlocks("ws-1");
  assert.equal(fake.calls.updateBlock.length, 0, "nothing to settle");
  assert.equal(items[0].properties.importanceScore, 0);
  assert.equal(items[0].properties.openInstanceBlockId, "b1");
});

test("the reconciler does not create a day_root as a side effect of a read", async () => {
  const TODAY = recurrence.dateStr(new Date());
  const fake = makeFake({
    responsibilities: [{ id: "r1", properties: { kind: "responsibility_item", cadence: "weekly", openInstanceBlockId: "b1", openInstanceLocalId: "l1", openInstanceDate: TODAY } }],
    blocks: { b1: { id: "b1", date: TODAY, properties: { local_id: "l1" } } },
  });
  // No day-root row exists. readDayRoot must return null rather than inserting one
  // -- a GET that writes rows is its own bug. Assert on the CALLS, not on the
  // return values: both "correct" and "threw and got swallowed" produce a null
  // root and zero writes, so value-only assertions could not tell them apart.
  const store = makeStore(fake, TODAY);
  await store.getResponsibilityBlocks("ws-1");
  assert.deepEqual(fake.calls.ensureDayRoot, [], "a GET must never insert a day_root");
  assert.ok(fake.calls.getBlock.includes(`day-root-ws-1-${TODAY}`), "and it must actually attempt the read");
  assert.equal(fake.calls.updateBlock.length, 0);
});

// REGRESSION. The day-root read is memoized so several definitions sharing a day
// cost one read. That memo must be per-PASS: the store is instantiated once for
// the process, so a store-lifetime cache pinned whatever properties it saw first
// and never noticed a later completion -- which silently broke exactly the
// overlay path this phase exists to fix. Caught by the live scenario run.
test("a completion written AFTER an earlier read is still seen (day-root memo is per-pass)", async () => {
  const TODAY = recurrence.dateStr(new Date());
  const rootId = `day-root-ws-1-${TODAY}`;
  const fake = makeFake({
    responsibilities: [{
      id: "r1",
      properties: {
        kind: "responsibility_item", cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z",
        openInstanceBlockId: "b1", openInstanceLocalId: "l1", openInstanceDate: TODAY,
      },
    }],
    blocks: {
      b1: { id: "b1", properties: { local_id: "l1", responsibilityId: "r1" } },
      [rootId]: { id: rootId, properties: { _done: { ids: [], at: {} } } },
    },
  });
  const store = makeStore(fake, TODAY);

  // Pass 1: nothing done yet, so the day root gets read and found empty.
  let items = await store.getResponsibilityBlocks("ws-1");
  assert.equal(items[0].properties.openInstanceBlockId, "b1", "still open after the first read");

  // The user now completes it through a UI path that only writes the overlay.
  const nowIso = new Date().toISOString();
  fake.setBlock(rootId, { _done: { ids: ["l1"], at: { l1: nowIso } } });

  // Pass 2 must see it. A store-lifetime cache would return the stale empty root
  // here and the responsibility would stay paused forever.
  items = await store.getResponsibilityBlocks("ws-1");
  assert.equal(items[0].properties.lastCompletedAt, nowIso, "the second read must observe the new completion");
  assert.equal(items[0].properties.openInstanceBlockId, undefined);
});

test("a definition that cannot be settled stays paused instead of failing the whole read", async () => {
  const fake = makeFake({
    responsibilities: [
      { id: "r1", properties: { kind: "responsibility_item", cadence: "weekly", openInstanceBlockId: "boom", openInstanceLocalId: "l1", openInstanceDate: "2026-07-29" } },
      { id: "r2", properties: { kind: "responsibility_item", cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z" } },
    ],
  });
  fake.getBlock = async (id) => { if (id === "boom") throw new Error("pg exploded"); return null; };
  const store = makeStore(fake);
  const items = await store.getResponsibilityBlocks("ws-1");
  assert.equal(items.length, 2);
  assert.equal(items[0].properties.openInstanceBlockId, "boom", "still paused, not silently released");
  assert.equal(items[1].properties.importanceScore, 100, "the healthy sibling is unaffected");
});

// ── The lifecycle writers (the seam between the pure transitions and the DB) ──

test("markResponsibilityComplete records previousCompletedAt, clears the pause, and persists NO derived score", async () => {
  const fake = makeFake({
    blocks: { r1: { id: "r1", properties: { kind: "responsibility_item", cadence: "weekly", lastCompletedAt: "2026-06-01T00:00:00Z", openInstanceBlockId: "b1" } } },
  });
  await makeStore(fake).markResponsibilityComplete("r1", "ws-1", { completedAt: "2026-07-29T12:00:00Z", taskId: "b1" });
  const written = fake.calls.updateBlock[0].fields.properties;
  assert.equal(written.lastCompletedAt, "2026-07-29T12:00:00Z");
  assert.equal(written.previousCompletedAt, "2026-06-01T00:00:00Z");
  assert.equal(written.openInstanceBlockId, undefined, "completing releases the pause");
  // importanceScore/suppressed/preferredDue are derived-for-display. Writing them
  // freezes a stale answer into the row (and its operations-log entry) that
  // misleads the next reader of a raw block -- here it would claim urgency 100 on
  // a responsibility completed a millisecond earlier.
  assert.equal("importanceScore" in written, false, "a derived score must not be persisted");
  assert.equal("suppressed" in written, false);
  assert.equal("preferredDue" in written, false);
});

test("the lifecycle writers return null for a missing or wrong-kind row, which is the routes' 404", async () => {
  const fake = makeFake({ blocks: { notResp: { id: "notResp", properties: { kind: "task_menu" } } } });
  const store = makeStore(fake);
  assert.equal(await store.markResponsibilityComplete("nope", "ws-1", {}), null);
  assert.equal(await store.skipResponsibilityCycle("notResp", "ws-1", {}), null);
  assert.equal(await store.pauseResponsibility("nope", "ws-1", {}), null);
  assert.equal(fake.calls.updateBlock.length, 0, "a rejected target is never written");
});

test("pauseResponsibility refuses a malformed `until` rather than pausing forever by accident", async () => {
  const mk = () => makeFake({ blocks: { r1: { id: "r1", properties: { kind: "responsibility_item", cadence: "weekly" } } } });
  // "tomorrow" sorts above every YYYY-MM-DD, which would have been a permanent
  // pause wearing a friendly label; a US-format date sorts below and would have
  // been a silent no-op.
  const bad = mk();
  await makeStore(bad).pauseResponsibility("r1", "ws-1", { until: "tomorrow" });
  assert.equal(bad.calls.updateBlock[0].fields.properties.pausedUntil, "forever");
  const good = mk();
  await makeStore(good).pauseResponsibility("r1", "ws-1", { until: "2026-08-15" });
  assert.equal(good.calls.updateBlock[0].fields.properties.pausedUntil, "2026-08-15");
});

test("setOpenInstance drops a forged non-date rather than storing it as openInstanceDate", async () => {
  const fake = makeFake({ blocks: { r1: { id: "r1", properties: { kind: "responsibility_item", cadence: "weekly" } } } });
  await makeStore(fake).setOpenInstance("r1", "ws-1", { blockId: "b1", localId: "l1", date: "ws-3-2026-07-29" });
  assert.equal(fake.calls.updateBlock[0].fields.properties.openInstanceDate, null);
});

// ── The due-line constant ──

test("DUE_THRESHOLD is the one server-side copy of the due line", () => {
  assert.equal(recurrence.DUE_THRESHOLD, 75);
  assert.equal(require("./responsibility-store").DUE_THRESHOLD, 75);
});
