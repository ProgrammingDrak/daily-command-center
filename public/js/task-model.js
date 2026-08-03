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
//   isTaskRow(block) -> is this row a task at all? (C4) The client twin of
//     db.js's `dcc_is_task_row`, same exclusion list, verified against it.
//   foldsIntoItinerary(block) -> isTaskRow AND addressable as an ev. (C4) The rule
//     the itinerary fold and the time-sync share; they had drifted.
//   backlogKey(block) -> the ev id the Backlog projection stores a row under. (C4)
//     One definition, because three disagreed by a "blk-" prefix.
//   selectUnscheduled(blocks, opts) -> the rows that ARE the Unscheduled section
//     and the Backlog, which C4 made the same list.
//
// Browser: loaded after task-serialize.js, before data.js/persistence.js/state.js;
// exposes window.DCC.TaskModel. Node: require()d by tests. UMD wrapper matches
// task-serialize.js / task-types.js / day-context.js.
//
// This file is the spine later phases build on (Track C: C4's isTaskRow, C5's
// status derivation, C6's selectDay/selectTree). Keep it pure and dependency-free.
//
// C4 deliberately did NOT put its two write primitives here, even though the phase
// plan said to: "pure and dependency-free" above is a real invariant (these tests
// require() this file under node, with no window), and a primitive that calls
// blockStore.updateBlock is neither. They live in state.js instead, beside the three
// other verbs that change a task's date -- scheduleTaskOnDate (creates),
// unscheduleTaskFromDate (deletes) and rescheduleTaskToDate (moves) -- so the next
// person to add a fourth sees all of them at once. See `scheduleRowOnDay` there.
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

  // ── C4: is this row a task at all? ──
  //
  // The client twin of `dcc_is_task_row` (db.js / migration 001), exclusion list
  // byte-for-byte identical, pinned by a test that reads the SQL function's own
  // definition rather than restating it. Four places re-derived this idea and drifted;
  // this is the one definition of the KIND question.
  //
  // Scope, stated because two neighbours look like they should collapse into this and
  // must not:
  //   - `isFoldableTask` (persistence.js) is NOT replaced wholesale. It is this
  //     predicate AND a status test AND a day-scoping test. Only the kind half moved
  //     here; the day-scoping half is per-view and belongs to the fold.
  //   - `getRescheduleSubtreePool`'s task test (db.js) is a DIFFERENT question -- "can
  //     this row move as part of a subtree" -- and C3 measured that this list is
  //     LOOSER than that walk can afford (it admits meeting artifacts, which are real
  //     parent_id children of a meeting, so a task move would re-date a prep doc).
  //     db.js:698-714 says do not unify them without re-measuring. C4 did not.
  //
  // Known hole, inherited deliberately and NOT widened here: this excludes
  // `responsibility%`, which C2 measured is wrong for `responsibility_task` (19 real
  // dated timed rows on the prod restore). C2 works around it with an explicit OR in
  // its own query. The fold has always rejected them by the same kind test, so
  // matching `dcc_is_task_row` exactly keeps the twin claim TRUE and changes no
  // behavior. Widening both halves together is a phase of its own.
  const NON_TASK_KINDS = ["delegated_item", "task_group", "reschedule_tombstone"];
  const NON_TASK_TYPES = ["day_root", "time_entry"];
  function isTaskRow(block) {
    block = block || {};
    if (NON_TASK_TYPES.indexOf(block.type) !== -1) return false;
    const kind = (block.properties || {}).kind || "";
    if (NON_TASK_KINDS.indexOf(kind) !== -1) return false;
    if (/^responsibility/.test(kind)) return false;
    return true;
  }

  // ── C4: does the itinerary render this row as a task? ──
  //
  // isTaskRow AND "addressable as an ev": it needs a local_id, or it must be one of the
  // API-inserted shapes the fold keys by row id instead (kind:"task" from the
  // Slack-bookmark poller and the MCP tools, shells, materialized meetings). Without
  // that second half `isTaskRow` is far too wide -- side_project rows, sticky notes and
  // untitled scaffolding all pass the kind exclusions.
  //
  // Shared by the fold (persistence.js isFoldableTask) and the time-sync
  // (schedule.js syncAddedTaskTimes) because they were the same rule written twice and
  // HAD DRIFTED: syncAddedTaskTimes was missing the `isShell` branch, so a shell block
  // folded into the itinerary and then never persisted its start/end -- its times reset
  // on every reload. That is the class of bug C4 exists to close, found by factoring.
  function foldsIntoItinerary(block) {
    if (!isTaskRow(block)) return false;
    const p = (block || {}).properties || {};
    if (p.local_id) return true;
    if (p.kind === "task") return true;
    if (p.kind === "shell" || p.type === "shell") return true;
    return p.kind === "meeting" || p.type === "meeting" || p.type === "oneone";
  }

  // ── C4: the ev id a row projects to, in ONE place ──
  //
  // There were three spellings of this and they disagreed: the fold keys on
  // `local_id || block.id` (persistence.js), the backlog projection on
  // `local_id || "blk-" + block.id` (schedule.js), and `_writeRowDate` reached for
  // `local_id || blockId` (state.js). For any row WITHOUT a local_id the second differs
  // from the other two by the `blk-` prefix, so `_syncBacklogProjection` looked up a key
  // the projection had never stored and silently failed to remove the entry: the task got
  // a date and still sat in the Backlog drawer with a stale badge, which is the two-homes
  // disagreement this phase exists to close, reintroduced by a key spelling.
  //
  // `backlogKey` is the projection's spelling and the one both sides of that lookup use
  // now. It is deliberately NOT the fold's — the fold's ids reach `scheduled[]`, where a
  // "blk-" prefix would be a visible id change, and this phase is not renaming ev ids.
  function backlogKey(block) {
    block = block || {};
    const p = block.properties || {};
    return p.local_id || ("blk-" + block.id);
  }

  // ── C4: the rows that ARE the Unscheduled section and the Backlog ──
  //
  // `date IS NULL` is the definition. One list, so one badge can mean one thing.
  //
  // opts.includeLegacyDatedBacklog admits rows that carry `kind:"backlog"` AND a date.
  // Those exist and are NOT unscheduled by this definition -- they are backlog items
  // the dcc-task-ops API stamped the request date onto. Measured on the prod restore:
  // 8 live rows, on 2026-06-24 / 07-09 / 07-27. They are included because dropping
  // them hides 8 genuinely open tasks: `hydrateBacklogFromBlocks` was date-blind, so
  // the drawer is the only place they have ever been reachable, and C2's carryover
  // lane cannot pick them up either (getCarryoverPool requires a `start` or a parent
  // edge, and an API-minted backlog row has neither). Every write path in C4 strips
  // the date, so each one heals the first time it is touched; the remaining rows want
  // a migration, which is Track A's file. Flagged in the Coordination log with ids.
  function selectUnscheduled(blocks, opts) {
    opts = opts || {};
    const out = [];
    const rows = Array.isArray(blocks) ? blocks : [];
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i];
      if (!b || b.deleted_at || b.type !== "block") continue;
      const p = b.properties || {};
      // A backlog row is addressable even with no local_id: the projection keys it by row
      // id, which is what hydrateBacklogFromBlocks' `"blk-" + b.id` fallback did. That
      // shape is not in `foldsIntoItinerary`, and it must not be — widening the SHARED
      // predicate would also make such a row fold into the itinerary, which it never has.
      // 0 rows are in this shape today (checked across every workspace, tombstones
      // included), but the code it replaces handled it explicitly, so narrowing it
      // silently is how a latent path becomes a bug report.
      if (!foldsIntoItinerary(b) && p.kind !== "backlog") continue;
      // Closed work is not unscheduled work. `done` is in this list where the fold
      // admits it, because the fold seeds a done registry from the row and this
      // selector feeds a to-do list. A dateless done row has no day to be done ON,
      // which is the same reason isFoldableTask keeps it out.
      if (p.status === "deleted" || p.status === "archived" || p.status === "done") continue;
      if (p.done === true) continue;
      // A titleless row cannot render on either surface; both consumers dropped it.
      if (!p.title) continue;
      if (!b.date) { out.push(b); continue; }
      if (opts.includeLegacyDatedBacklog && p.kind === "backlog") out.push(b);
    }
    return out;
  }

  return {
    fromBlock: fromBlock,
    isTaskRow: isTaskRow,
    foldsIntoItinerary: foldsIntoItinerary,
    backlogKey: backlogKey,
    selectUnscheduled: selectUnscheduled
  };
});
