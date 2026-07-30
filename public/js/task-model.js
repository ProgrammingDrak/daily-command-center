// ======== TASK MODEL ========
// ONE projection from a persisted `block` row to the in-memory `ev` shape every
// render surface consumes. Hoisted verbatim out of reloadPersistedEdits
// (persistence.js), which was the only place that knew how to do it — so every
// OTHER surface that needed a task from a block hand-rolled a narrower bag and
// silently dropped fields. The carryover lane's 15-field `rows.push({...})` and
// its 7-field `_unfToEv` were exactly that, which is why an unfinished row had
// no Slack pill, no tags, no prep chip, no lock, and a hardcoded PUBLIC privacy
// chip: the row builder asked for fields that were stripped two hops upstream.
//
//   fromBlock(block, opts) -> the ev. Pure: no globals mutated, nothing read off
//     the page. opts.deriveEnd derives a missing `end` from start+duration
//     instead of the legacy fmt(duration) (see the note on `end` below).
//
// Browser: loaded after task-serialize.js, before data.js/persistence.js/state.js;
// exposes window.DCC.TaskModel. Node: require()d by tests. UMD wrapper matches
// task-serialize.js / task-types.js / day-context.js.
//
// This file is the spine later phases build on (Track C: C4's isTaskRow, C5's
// status derivation, C6's selectDay/selectTree). Keep it pure and dependency-free.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    const DCC = (root.DCC = root.DCC || {});
    DCC.TaskModel = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // state.js owns the canonical pt/fmt/ms trio and is NOT a module, so prefer the
  // globals in the browser (zero drift by construction) and fall back to these
  // identical locals under node so the projection stays require()able + testable.
  // Same idiom as unfinished-tasks.js's fmtDur.
  function _pt(s) {
    if (typeof pt === "function") return pt(s);
    const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "00:00"));
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  }
  function _fmt(mins) {
    if (typeof fmt === "function") return fmt(mins);
    return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
  }
  function _ms(m) {
    if (typeof ms === "function") return ms(m);
    return m >= 60 ? Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m";
  }

  function fromBlock(block, opts) {
    opts = opts || {};
    block = block || {};
    const p = block.properties || {};
    // API task blocks have no local_id; key on the row id.
    const taskId = p.local_id || block.id;
    const d = p.duration || p.estimatedMinutes || 30;
    // A dateless row is unscheduled by definition: any stored start on it is
    // stale (e.g. stamped by an old reflow), so ignore it and keep the row
    // in the Unscheduled section until a drag gives it a real slot.
    const dateless = !block.date;
    const hasStoredTime = !dateless && p.start && p.start !== "00:00";
    const untimed = !p.start || dateless;    // no scheduled time -> Unscheduled section
    // `end`: the legacy fallback fmt(d) reads a DURATION as a clock time, so a
    // block with start "09:00" and no end got end "00:30" -> dur(ev) negative.
    // Harmless for today's rows (recalcTimes rewrites them immediately), fatal
    // for a carryover row that never gets recalced — hence deriveEnd.
    // Clamped to the last minute of the day. Unclamped, start "23:30" + 60min gave
    // end "25:30", and pt() wraps the hour (((h%24)+24)%24), so pt("25:30") is 90 and
    // dur(ev) came out -1320 -- deriveEnd reproducing the exact negative duration it
    // exists to prevent, just at the day boundary. That fed _taskDuration -> findSlot,
    // which emitted an end like "-22:00" and got a 400 from the server, so Today /
    // Tomorrow / Move failed on every surface and the row was stuck. 1439 not 24*60,
    // because pt("24:00") is 0 here.
    const end = p.end || ((opts.deriveEnd && p.start) ? _fmt(Math.min(24 * 60 - 1, _pt(p.start) + d)) : _fmt(d));
    const task = {
      id: taskId, title: p.title, type: p.type || "task",
      _blockId: block.id,
      _dateless: dateless,   // day-agnostic row: Unscheduled everywhere, excluded from day stats
      createdAt: block.created_at || p.created_at || p.createdAt || null,
      start: p.start || "00:00",
      end: end,
      meta: p.meta || ("Custom task · " + _ms(d)),
      detail: p.detail || "", source: p.source || "manual",
      source_id: p.source_id || "", notes: p.notes || "", untimed: untimed,
      notionUrl: p.notionUrl || "", calUrl: p.calUrl || "", priority: p.priority || "High",
      tags: Array.isArray(p.tags) ? p.tags : [],
      kind: p.kind || "",
      // Meeting affordances (join link / location / RSVP), and the block id
      // the meeting-automation panel keys off (itinerary-card.js).
      location: p.location || "",
      hangout_link: p.hangout_link || p.conferenceUrl || "",
      rsvp_status: p.rsvp_status || "",
      // Auto-prep chip: the materializer stamps prep_status on the meeting block
      // ("pending" at birth, "ready" once a brief lands). Surface it so the row
      // chip (itinerary-card.js) renders without a page-level meetings[] join.
      prepStatus: p.prep_status || null,
      // Recap chip: set to "ready" by applyArtifacts once a summary lands, so the
      // row shows a Recap chip (schedule-tab.js) that opens the modal's Recap tab.
      recapStatus: p.recap_status || null,
      dashboardRef: p.dashboard_ref || null,
      recordingReview: !!p.recording_review,
      meetingBlockId: (p.type === "meeting" || p.kind === "meeting" || p.type === "oneone") ? block.id : (p.meetingBlockId || ""),
      isPlaceholder: p.isPlaceholder || false,
      placeholderMenus: Array.isArray(p.placeholderMenus) ? p.placeholderMenus : [],
      taskGroupId: p.taskGroupId || null,
      responsibilityId: p.responsibilityId || null,
      responsibilityTitle: p.responsibilityTitle || "",
      capacityBucket: p.capacityBucket || "",
      responsibilityScore: p.responsibilityScore || null,
      alertKey: p.alertKey || null,
      alertType: p.alertType || null,
      publicVisibility: p.publicVisibility || "public",
      triageId: p.triageId || null,
      delegatedItemId: p.delegatedItemId || null,
      linkedBlockId: p.linkedBlockId || null,
      linkedTagId: p.linkedTagId || null,
      ampUrl: p.ampUrl || "",
      hubspotUrl: p.hubspotUrl || "",
      wrapId: p.wrapId || null,
      isWrap: !!p.isWrap,
      subtaskOf: p.subtaskOf || null,
      reschedulePlacement: p.reschedulePlacement || null,
      rescheduledFrom: p.rescheduledFrom || null,
      sourceTaskId: p.sourceTaskId || null
    };
    if (p.commuteMinutes || p.commute_minutes) task.commuteMinutes = p.commuteMinutes || p.commute_minutes;
    if (p.commuteToMinutes || p.commute_to_minutes) task.commuteToMinutes = p.commuteToMinutes || p.commute_to_minutes;
    if (p.commuteBackMinutes || p.commute_back_minutes || p.commuteReturnMinutes || p.commute_return_minutes) task.commuteBackMinutes = p.commuteBackMinutes || p.commute_back_minutes || p.commuteReturnMinutes || p.commute_return_minutes;
    // Pin the start time so recalcTimes() doesn't overwrite it (skip nested
    // items: ride-alongs/subtasks live under their parent, never cascaded).
    if (hasStoredTime && !task.subtaskOf) task._pinnedStart = p.start;
    return task;
  }

  return { fromBlock: fromBlock };
});
