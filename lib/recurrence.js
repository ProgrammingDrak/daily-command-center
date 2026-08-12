// lib/recurrence.js — the recurrence lifecycle, pure.
//
// THE INVARIANT (dcc-canonical-task-model D1): a recurring responsibility has
// AT MOST ONE OPEN INSTANCE, and the definition knows about it. That single
// sentence is the whole phase. Everything below is its consequences.
//
// Before D1 the definition knew nothing: scheduling wrote nothing back, so a
// responsibility scheduled for TOMORROW was re-offered on today's strip on the
// very next render, forever. The fields that would have recorded it did not
// exist anywhere in the tree.
//
// The three lifecycle transitions, and why the middle one needs no code:
//
//   1. SCHEDULE   -> stamp openInstanceBlockId. The timer pauses: score is 0
//                    and the item is not offered, on ANY day, regardless of
//                    elapsed time.
//   2. DROPPED     -> clear openInstanceBlockId, touch NOTHING else. Because
//                    the clock is still anchored on the unchanged
//                    lastCompletedAt, every accumulated day of urgency is
//                    still there and the item re-offers exactly as if it had
//                    never been scheduled. This is Drake's "kicks back in as
//                    if it wasn't ever done" and it is free -- a consequence
//                    of the model, not a code path.
//   3. COMPLETE    -> clear openInstanceBlockId, set lastCompletedAt = now.
//                    Timer restarts from the completion moment.
//
// DERIVED, NOT EVENT-DRIVEN. The pause is only safe if it reliably clears --
// a pause that leaks becomes a permanent stall, which is worse than the bug it
// replaces. Four separate UI paths mark a task done and only one of them ever
// told the server (see ANALYSIS.md Phase 7), so an event hook would leak. So
// resolveInstanceState() reads the instance's ACTUAL persisted state instead
// of trusting anyone to fire an event: there is no completion path to miss
// because no path is being listened for. db.js's updateBlock hook is the
// eager half (instant reset when a row-level done lands, which is what the
// quick-task and Slack-timer paths already write, and what everything writes
// once C5 makes status='done' universal); this resolver is the correct half.
//
// This module is pure: no DB, no HTTP, no Date.now() except through an
// injectable `at`. The store owns the reads; this owns the decisions.

// The due line. A responsibility at or above this surfaces in the triage strip
// and the "due" sidebar filter. Was hardcoded in four places (three in
// public/js/responsibilities.js, one in routes/blocks.js's auto-schedule).
// The browser's copy of this number is window.urgency.DUE_THRESHOLD
// (public/js/urgency.js) -- one constant per runtime, and they must agree.
const DUE_THRESHOLD = 75;

// The score a preferred-completion day floors an item to ("Don't forget! This
// is when you like to do this").
const PREFERRED_FLOOR = 85;

const MS_PER_DAY = 86400000;

// ── Small date helpers ──

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function localDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function dateStr(date) {
  return date.getFullYear() + "-" +
    String(date.getMonth() + 1).padStart(2, "0") + "-" +
    String(date.getDate()).padStart(2, "0");
}

// Calendar parts of `at` AS SEEN IN `tz`, or in the host's local zone when tz
// is absent/bogus. This closes the timezone split documented in ANALYSIS.md
// Phase 7: importanceScore (including the preferred-day floor) is computed
// server-side in the Node process's zone while the browser computed the same
// thing in the user's zone, and the client preferred the server's answer. On a
// UTC host with a US-Central user they disagreed for a 5-6 hour window every
// day, so the preferred-day gate fired on the wrong local day. Node ships full
// ICU, so Intl gets us the user's real calendar day with no dependency.
// Formatter construction is the expensive part of Intl and the (at, tz) answer is
// stable within a request, so cache per zone. Only successful constructions are
// cached, which keeps the invalid-zone fallback below unchanged.
const _fmtCache = new Map();
function _zoneFormatter(tz) {
  let f = _fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    });
    _fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function hostParts(at) {
  return { year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate(), weekday: at.getDay() };
}

function zonedParts(at, tz) {
  if (!tz) return hostParts(at);
  let parts;
  try {
    parts = _zoneFormatter(tz).formatToParts(at);
  } catch {
    // An unknown/hostile IANA name must not take the request down.
    return hostParts(at);
  }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const weekday = WEEKDAY_INDEX[get("weekday")];
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: weekday === undefined ? at.getDay() : weekday,
  };
}

// "Today" as the USER sees it. Every date-string gate below compares against this
// rather than the host process's calendar day: prod runs UTC while the app's
// canonical zone is America/New_York, so a pause or skip set on a US evening would
// otherwise read as already lapsed for several hours.
function todayStrIn(at, tz) {
  const p = zonedParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// A stored until/skip value may be a bare YYYY-MM-DD or (from a sloppy caller) a
// full ISO timestamp. Compare on the date part only, so an ISO value does not
// sort long and silently buy an extra day.
function dayPart(v) {
  return String(v).slice(0, 10);
}

// ── Pause / skip / archive gates ──

// Is an instance of this definition currently in flight? While one is, the
// definition is "waiting" (Things 3's first-class state) and is not offered.
function hasOpenInstance(props) {
  return !!(props && (props.openInstanceBlockId || props.openInstanceLocalId));
}

// Explicit indefinite pause. `pausedUntil` may be a date (resume then) or the
// sentinel "forever" (resume only by an explicit Resume). A dated pause releases
// ON its until-date.
function isPaused(props, at = new Date(), tz = null) {
  if (!props) return false;
  const until = props.pausedUntil;
  if (!until) return false;
  if (until === "forever") return true;
  return dayPart(until) > todayStrIn(at, tz);
}

// "Skip this cycle" -- TickTick's skip-as-distinct-from-complete. Server-side
// and cross-device, replacing the pa-resp-snoozed-<viewDate> localStorage map
// which was per-browser, one day only, never synced and never GC'd.
function isSkipped(props, at = new Date(), tz = null) {
  if (!props || !props.skipUntil) return false;
  return dayPart(props.skipUntil) > todayStrIn(at, tz);
}

// Not offered for ANY reason: archived/done, paused, skipped, or an instance is
// already in flight. The one predicate both the score and the UI ask -- the
// client reads it off the normalized row rather than re-deriving it, so the two
// runtimes cannot disagree.
function isSuppressed(props, at = new Date(), tz = null) {
  if (!props) return true;
  const status = props.status || "active";
  if (status === "archived" || status === "done") return true;
  return hasOpenInstance(props) || isPaused(props, at, tz) || isSkipped(props, at, tz);
}

// ── Cadence anchoring ──

// Start of the period the definition is currently inside. This is the
// anchorMode split -- Todoist's `every!` vs `every`, made explicit per item
// because today the elapsed math is completion-anchored while the preferred-day
// floor is calendar-anchored and the two fight each other.
//
//   "completion" (default): the period starts when you last completed. Finish
//                           early and the next one shifts later with you.
//   "calendar":             the period starts on the current calendar
//                           boundary. Finish early and the next one still
//                           lands on schedule.
function periodStart(props, cadence, at, tz) {
  const completion = toDate(props.lastCompletedAt);
  const origin = toDate(props.createdAt || props.created_at || props.added_at);
  if (String(props.anchorMode || "completion") !== "calendar") {
    // Completion mode: the window starts when you last finished (falling back to
    // the series origin for an item never completed).
    return completion || origin || at;
  }
  // Calendar mode deliberately IGNORES lastCompletedAt for the base and walks
  // whole cadence periods from the series origin, so finishing early does not
  // push the next occurrence out -- it still lands on schedule.
  const anchor = origin || completion || at;
  if (!cadence) return anchor;
  const elapsedPeriods = Math.floor(Math.max(0, (at - anchor) / MS_PER_DAY) / cadence);
  const walked = new Date(anchor.getTime() + elapsedPeriods * cadence * MS_PER_DAY);
  // With a preferred-completion cadence configured, that day IS the calendar
  // boundary the user cares about; prefer it when it is the more recent one.
  const preferred = preferredOccurrenceStart(props, at, tz);
  return preferred && preferred > walked ? preferred : walked;
}

// Midnight of the most recent preferred-completion day at or before `at`, or
// null when the item has no preferred cadence. Used both to anchor calendar
// mode and to decide whether a completion already satisfied this occurrence.
function preferredOccurrenceStart(props, at, tz) {
  if (!props) return null;
  const cadence = String(props.preferredCompletionCadence || props.preferredCadence || "none").toLowerCase();
  if (!cadence || cadence === "none") return null;
  const p = zonedParts(at, tz);
  const todayLocal = new Date(p.year, p.month - 1, p.day);
  if (cadence === "weekly") {
    const day = Math.max(0, Math.min(6, Number(props.preferredDayOfWeek || 0)));
    const back = (p.weekday - day + 7) % 7;
    return new Date(todayLocal.getTime() - back * MS_PER_DAY);
  }
  if (cadence === "monthly") {
    const target = Math.max(1, Math.min(31, Number(props.preferredDayOfMonth || 1)));
    const thisMonth = Math.min(target, daysInMonth(p.year, p.month - 1));
    if (p.day >= thisMonth) return new Date(p.year, p.month - 1, thisMonth);
    const prev = new Date(p.year, p.month - 2, 1);
    return new Date(prev.getFullYear(), prev.getMonth(), Math.min(target, daysInMonth(prev.getFullYear(), prev.getMonth())));
  }
  if (cadence === "yearly") {
    const month = Math.max(1, Math.min(12, Number(props.preferredMonth || 1)));
    const target = Math.max(1, Math.min(31, Number(props.preferredMonthDay || 1)));
    const thisYear = new Date(p.year, month - 1, Math.min(target, daysInMonth(p.year, month - 1)));
    if (todayLocal >= thisYear) return thisYear;
    return new Date(p.year - 1, month - 1, Math.min(target, daysInMonth(p.year - 1, month - 1)));
  }
  if (cadence === "custom") {
    const anchorRaw = props.preferredCustomAnchor || props.preferredDate || "";
    const every = Math.max(1, Number(props.preferredCustomDays || props.preferredEveryDays || 1));
    const anchor = anchorRaw ? new Date(`${anchorRaw}T00:00:00`) : null;
    if (!anchor || Number.isNaN(anchor.getTime())) return null;
    const diff = Math.floor((todayLocal - localDateOnly(anchor)) / MS_PER_DAY);
    if (diff < 0) return null;
    return new Date(todayLocal.getTime() - (diff % every) * MS_PER_DAY);
  }
  return null;
}

// Is `at` a preferred-completion day, evaluated in the user's zone?
function preferredCompletionDue(props, at = new Date(), tz = null) {
  if (!props) return false;
  const cadence = String(props.preferredCompletionCadence || props.preferredCadence || "none").toLowerCase();
  if (!cadence || cadence === "none") return false;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;
  const start = preferredOccurrenceStart(props, at, tz);
  if (!start) return false;
  const p = zonedParts(at, tz);
  return start.getFullYear() === p.year && start.getMonth() + 1 === p.month && start.getDate() === p.day;
}

// THE REAPPEAR-AFTER-DONE FIX. The preferred-day floor used to ignore
// lastCompletedAt entirely: click Done on the triage card, the POST fires, the
// reload comes back, the score is STILL 85, it clears the due line, and because
// no task was created nothing suppressed it -- so the identical card reappeared
// a few hundred milliseconds later, and kept reappearing all day.
// responsibility-store.test.js pinned that as intended behavior.
//
// The floor now only applies if the current occurrence has not already been
// satisfied. "Current occurrence" is the preferred-day boundary when there is
// one (so a Thursday-preferred weekly completed Thursday morning stays quiet
// through Thursday night), else the current cadence period.
function preferredFloorApplies(props, at = new Date(), tz = null) {
  if (!preferredCompletionDue(props, at, tz)) return false;
  const done = toDate(props.lastCompletedAt);
  if (!done) return true;
  const occurrence = preferredOccurrenceStart(props, at, tz);
  if (occurrence) return done < occurrence;
  const cadence = Math.max(0, Number(props.cadenceDays || 0));
  if (!cadence) return true;
  return (at - done) / MS_PER_DAY >= cadence;
}

// ── Instance-state resolution (the derived half) ──

// What actually happened to the in-flight instance? Reads persisted state, so
// it is blind to which UI path did the deed -- which is the point.
//
//   instanceBlock  the instance's `blocks` row, or null if it is gone
//   dayRootProps   properties of the day_root for the instance's date. Client
//                  completions land in _done.{ids,at} there (see
//                  public/js/sync.js and public/js/persistence.js) and client
//                  deletes land in _deleted -- NOT on the task row. That is why
//                  reading the row alone would miss the four UI paths.
//   keys           candidate ids for this instance: the row id and its
//                  local_id (UI tasks key _done by local_id, API-inserted
//                  tasks by row id).
//   todayStr       the caller's today, so a past-dated instance that never got
//                  done is recognized as dropped rather than eternally open.
//
// Returns { state: "open" | "done" | "gone", completedAt }.
function resolveInstanceState({ instanceBlock, dayRootProps, keys, instanceDate, todayStr }) {
  const ids = (keys || []).filter(Boolean).map(String);
  const root = dayRootProps || {};
  const props = (instanceBlock && instanceBlock.properties) || {};

  // DONE IS CHECKED FIRST, BEFORE DELETED, and the order is load-bearing.
  // "I finished it" is a fact about work performed; deleting the row afterwards
  // is housekeeping and must not un-say it. Checking deleted first meant the
  // ordinary sequence "check it off, then tidy it off the itinerary" resolved to
  // "gone", threw the completion away, and re-offered the responsibility at full
  // urgency the same day it was actually done.

  // Row-level done. C5b made this the path EVERY completion takes: toggleDone,
  // _autoCompleteShellAncestors, commitDoneOnDate/markOnDate and the
  // _onParentCompleted cascade all write the row now, alongside quick-task and the
  // Slack timer.
  if (props.status === "done" || props.completedAt) {
    return { state: "done", completedAt: props.completedAt || props.updated_at || (instanceBlock && instanceBlock.updated_at) || null };
  }

  // Day-overlay done. KEPT IN C5b, deliberately, against the plan.
  //
  // D1 predicted this branch becomes dead code "once C5 makes status='done'
  // universal", and the C5b brief lists deleting it as step 7. Measured on prod
  // 2026-08-04 before deciding, and it is NOT dead: migration 002 could not resolve 12
  // `_done` entries whose local_id is shared by 2+ rows, so those rows still read
  // `status:'open'` while the overlay says done — and **two of the twelve are
  // responsibility instances**, both on 2026-06-09
  // (`resp-task-213da909-576-resched-20260609` and
  // `resp-task-4acdd120-3b1-resched-20260609`, "Alert: New deal entered the AMP with
  // zero expected matches"). Dropping this read re-opens their completed instances,
  // which re-arms the one-open-instance pause on a responsibility that was finished
  // two months ago.
  //
  // It goes with the overlay itself in A4, alongside persistence.js's matching legacy
  // read. Nothing WRITES `_done` any more, which is the part C5b actually owed.
  const doneIds = (root._done && Array.isArray(root._done.ids)) ? root._done.ids.map(String) : [];
  const hit = ids.find((id) => doneIds.includes(id));
  if (hit) {
    const at = (root._done && root._done.at) ? root._done.at[hit] : null;
    return { state: "done", completedAt: at || null };
  }

  // Deleted without ever being done, by either representation.
  if (!instanceBlock || instanceBlock.deleted_at) return { state: "gone", completedAt: null };
  const deletedOverlay = Array.isArray(root._deleted) ? root._deleted.map(String) : [];
  if (ids.some((id) => deletedOverlay.includes(id))) return { state: "gone", completedAt: null };

  // Still sitting there, undone, on a day that has already passed: the user
  // never did it. Drop the pause so the accumulated urgency comes back.
  if (instanceDate && todayStr && String(instanceDate) < String(todayStr)) {
    return { state: "gone", completedAt: null };
  }

  return { state: "open", completedAt: null };
}

// ── Property transitions (pure: props in, props out) ──

// SCHEDULE. Whatever day the instance lands on -- this is what makes
// schedule-for-tomorrow silence today's strip, which the old day-scoped checks
// could never do.
function applySchedule(props, { blockId, localId, date }) {
  const next = { ...(props || {}) };
  next.openInstanceBlockId = blockId || null;
  next.openInstanceLocalId = localId || null;
  next.openInstanceDate = date || null;
  next.openInstanceAt = new Date().toISOString();
  // Scheduling it IS the answer to "not now", so a stale skip must not outlive
  // the decision to actually do it.
  delete next.skipUntil;
  return next;
}

// COMPLETE. previousCompletedAt is what makes un-checking reversible; today
// un-checking leaves the cadence reset in place forever.
function applyCompletion(props, { completedAt, taskId } = {}) {
  const prev = props || {};
  const at = completedAt || new Date().toISOString();
  const next = { ...prev };
  next.previousCompletedAt = prev.lastCompletedAt || null;
  next.lastCompletedAt = at;
  next.lastCompletedTaskId = taskId || prev.openInstanceBlockId || prev.lastCompletedTaskId || null;
  // An EXPLICIT "there is a completion here to reverse" marker. Keying the undo
  // guard on lastCompletedTaskId/previousCompletedAt alone was not enough: the
  // sidebar and triage Complete buttons post only completedAt, and completing an
  // item that had no instance in flight and no prior completion leaves both of
  // those null -- so a later un-check found nothing to undo and silently failed to
  // restore the clock, which is the same unreversible-checkoff class of bug the
  // guard exists to prevent.
  next.completionUndoable = true;
  next.updatedAt = at;
  return clearOpenInstance(next);
}

// UN-CHECK. Restore the cadence clock to what it was before the completion we
// are undoing, and put the instance back in flight.
//
// IDEMPOTENT ON PURPOSE. Only the FIRST un-check has a completion to reverse.
// Without the guard a retry or double-click treated the already-restored clock as
// the completion being undone, deleted lastCompletedAt outright, and slammed a
// genuinely-recent responsibility to full urgency with the real timestamp
// unrecoverable. `lastCompletedTaskId` is set by applyCompletion, so it is the
// marker for "there is a completion here to undo" even when previousCompletedAt
// is legitimately null (a first-ever completion).
function applyUncompletion(props, { blockId, localId, date } = {}) {
  const prev = props || {};
  const next = { ...prev };
  const hasCompletionToUndo = !!(prev.completionUndoable || prev.lastCompletedTaskId || prev.previousCompletedAt);
  if (hasCompletionToUndo) {
    next.lastCompletedAt = prev.previousCompletedAt || null;
    next.previousCompletedAt = null;
    next.lastCompletedTaskId = null;
    delete next.completionUndoable;
    if (!next.lastCompletedAt) delete next.lastCompletedAt;
  }
  next.updatedAt = new Date().toISOString();
  return applySchedule(next, {
    blockId: blockId || prev.lastCompletedTaskId || null,
    localId: localId || null,
    date: date || prev.openInstanceDate || null,
  });
}

// DROPPED. Clear the pause and touch nothing else. lastCompletedAt is
// deliberately left alone -- that is the whole "resumes untouched" behavior.
function clearOpenInstance(props) {
  const next = { ...(props || {}) };
  delete next.openInstanceBlockId;
  delete next.openInstanceLocalId;
  delete next.openInstanceDate;
  delete next.openInstanceAt;
  return next;
}

// SKIP THIS CYCLE. Hide until the next occurrence, without lying about having
// done it. Deliberately distinct from Complete: it does not touch
// lastCompletedAt, so urgency keeps accruing underneath and the item comes
// back louder rather than resetting.
function applySkip(props, at = new Date(), tz = null) {
  const prev = props || {};
  const next = { ...prev };
  next.skipUntil = nextOccurrenceDate(prev, at, tz);
  next.skippedAt = new Date().toISOString();
  next.skipCount = Number(prev.skipCount || 0) + 1;
  return next;
}

// The day this item should next be considered: the next preferred day if it has
// one, else one cadence period out. Always at least tomorrow, so a skip is
// never a no-op.
function nextOccurrenceDate(props, at = new Date(), tz = null) {
  const prev = props || {};
  const p = zonedParts(at, tz);
  const todayLocal = new Date(p.year, p.month - 1, p.day);
  const tomorrow = new Date(todayLocal.getTime() + MS_PER_DAY);
  const occurrence = preferredOccurrenceStart(prev, at, tz);
  let candidate = tomorrow;
  if (occurrence) {
    const cadence = String(prev.preferredCompletionCadence || prev.preferredCadence || "none").toLowerCase();
    if (cadence === "weekly") candidate = new Date(occurrence.getTime() + 7 * MS_PER_DAY);
    // Monthly/yearly must CLAMP like preferredOccurrenceStart does, not overflow.
    // new Date(2026, 1, 31) rolls forward to March 3, so a day-31 monthly skipped
    // on Jan 31 would hide until Mar 3 and swallow February's occurrence whole.
    else if (cadence === "monthly") {
      const y = occurrence.getFullYear(), m = occurrence.getMonth() + 1;
      candidate = new Date(y, m, Math.min(occurrence.getDate(), daysInMonth(y, m)));
    } else if (cadence === "yearly") {
      const y = occurrence.getFullYear() + 1, m = occurrence.getMonth();
      candidate = new Date(y, m, Math.min(occurrence.getDate(), daysInMonth(y, m)));
    } else candidate = new Date(occurrence.getTime() + Math.max(1, Number(prev.preferredCustomDays || prev.preferredEveryDays || 1)) * MS_PER_DAY);
  } else {
    const cadence = Math.max(1, Number(prev.cadenceDays || prev.cadence_days || 7));
    candidate = new Date(todayLocal.getTime() + cadence * MS_PER_DAY);
  }
  return dateStr(candidate > tomorrow ? candidate : tomorrow);
}

// PAUSE / RESUME. `until` may be a YYYY-MM-DD date or omitted for indefinite.
// Normalized to a bare date so the string comparison in isPaused stays honest
// whatever shape the caller sent.
function applyPause(props, until) {
  const next = { ...(props || {}) };
  next.pausedUntil = until ? dayPart(until) : "forever";
  next.pausedAt = new Date().toISOString();
  return next;
}

function applyResume(props) {
  const next = { ...(props || {}) };
  delete next.pausedUntil;
  delete next.pausedAt;
  delete next.skipUntil;
  if ((next.status || "active") !== "active") next.status = "active";
  return next;
}

module.exports = {
  DUE_THRESHOLD,
  PREFERRED_FLOOR,
  MS_PER_DAY,
  // gates
  hasOpenInstance,
  isPaused,
  isSkipped,
  isSuppressed,
  // cadence
  periodStart,
  preferredOccurrenceStart,
  preferredCompletionDue,
  preferredFloorApplies,
  // resolution
  resolveInstanceState,
  // transitions
  applySchedule,
  applyCompletion,
  applyUncompletion,
  clearOpenInstance,
  applySkip,
  nextOccurrenceDate,
  applyPause,
  applyResume,
  // helpers (exported for tests + reuse; these are the ONE server-side copies)
  zonedParts,
  todayStrIn,
  dayPart,
  dateStr,
  localDateOnly,
  daysInMonth,
};
