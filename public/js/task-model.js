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
// Everything above answers a question about a persisted BLOCK. Everything C6a added
// below answers a question about a set of EVs -- "which of these does this surface
// show, in what order, nested how" -- and it is now the only place allowed to.
// See "THE DERIVATION LAYER" below for the full contract, and
// `render-surface-registry.test.js` for the grep that keeps it that way.
//
// Browser: loaded after task-serialize.js, before data.js/persistence.js/state.js;
// exposes window.DCC.TaskModel. Node: require()d by tests. UMD wrapper matches
// task-serialize.js / task-types.js / day-context.js.
//
// This file is the spine later phases build on (Track C: C4's isTaskRow, C5's
// status derivation, C6a's selectDay/selectTree). Keep it pure and
// dependency-free -- see the injected-status note in the C6a section for the one
// place that invariant cost something, and what it bought.
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
    const allDay = !!p.all_day;
    const hasStoredTime = !allDay && !dateless && p.start && p.start !== "00:00";
    const untimed = (!p.start && !allDay) || dateless;    // no scheduled time -> Unscheduled section
    const rawSource = String(p.source || "manual").toLowerCase();
    const isCalendarSource = rawSource === "calendar" || rawSource === "gcal" || !!p.calendar_id;
    const sourceKey = isCalendarSource
      ? "calendar:" + (p.account_key || p.account_email || "default") + ":" + (p.calendar_id || "primary")
      : (rawSource.includes("slack") || p.alertType === "slack" ? "slack"
        : (rawSource === "notion" || (rawSource === "manual" && p.notionUrl) ? "notion"
          : (["manual", "quick-task", "triage", "responsibility", "reward"].includes(rawSource) ? "dcc" : "other")));
    const sourceLabel = isCalendarSource
      ? (p.calendar_name || p.account_email || "Calendar")
      : ({ notion: "Notion", slack: "Slack", dcc: "DCC", other: "Other" }[sourceKey] || "Other");
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
      status: p.status || "open",
      allDay: allDay,
      allDayStart: p.all_day_start || (allDay ? block.date : null),
      allDayEnd: p.all_day_end || null,
      sourceKey: sourceKey,
      sourceLabel: sourceLabel,
      startedAt: p.startedAt || null,
      completedAt: p.completedAt || null,
      actualMinutes: p.actualMinutes == null ? null : Number(p.actualMinutes),
      pointsDurationMinutes: p.pointsDurationMinutes == null ? null : Number(p.pointsDurationMinutes),
      aiSummary: p.aiSummary || "",
      notionUrl: p.notionUrl || "", calUrl: p.calUrl || "", priority: p.priority || "High",
      calendarId: p.calendar_id || "", calendarName: p.calendar_name || "",
      calendarColor: p.calendar_color || "", calendarAccountKey: p.account_key || "",
      calendarAccountEmail: p.account_email || "",
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
      repeatMode: p.repeatMode || null,
      repeatSeriesId: p.repeatSeriesId || null,
      repeatOccurrenceKey: p.repeatOccurrenceKey || null,
      repeatOccurrenceInstant: p.repeatOccurrenceInstant || null,
      repeatOccurrenceRootId: p.repeatOccurrenceRootId || null,
      recurrenceOverride: !!p.recurrenceOverride,
      alertKey: p.alertKey || null,
      alertType: p.alertType || null,
      publicVisibility: p.publicVisibility || "public",
      triageId: p.triageId || null,
      triageKey: p.triageKey || null,
      triageTitle: p.triageTitle || "",
      triageType: p.triageType || "",
      triageSourceRef: p.triageSourceRef || "",
      triageReceivedAt: p.triageReceivedAt || "",
      triageConversationId: p.triageConversationId || "",
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
      sourceTaskId: p.sourceTaskId || null,
      retiredContainerHidden: p.retiredContainerHidden === true
    };
    if (p.commuteMinutes || p.commute_minutes) task.commuteMinutes = p.commuteMinutes || p.commute_minutes;
    if (p.commuteToMinutes || p.commute_to_minutes) task.commuteToMinutes = p.commuteToMinutes || p.commute_to_minutes;
    if (p.commuteBackMinutes || p.commute_back_minutes || p.commuteReturnMinutes || p.commute_return_minutes) task.commuteBackMinutes = p.commuteBackMinutes || p.commute_back_minutes || p.commuteReturnMinutes || p.commute_return_minutes;
    // Pin the start time so recalcTimes() doesn't overwrite it (skip nested
    // items: ride-alongs/subtasks live under their parent, never cascaded).
    //
    // `_pinnedStart` is DERIVED: every top-level row that carries a stored start gets
    // one, whether a human chose that time or the cascade produced it. That is why the
    // drag reflow (`recalcTimes({orderWins:true})`) has to demote pins wholesale --
    // holding all of them would make a drag unable to reorder anything.
    //
    // `_userSetStart` is the INTENT half, and it is set only where a person names a
    // time (pinStartTime, the placement picker, a timed server placement). Nothing
    // derives it. Reflow holds a user-set start unconditionally, so a hand-typed 06:00
    // survives a drag that legitimately re-chains everything around it.
    if (hasStoredTime && !task.subtaskOf) task._pinnedStart = p.start;
    if (p.userSetStart && !task.subtaskOf) task._userSetStart = true;
    return task;
  }

  // Project a Sweep Suite triage record into the same event shape the itinerary
  // renders. The source record stays authoritative until an action materializes
  // a task. Source-only fields live under __triage so they cannot masquerade as
  // persisted task properties.
  function fromTriageItem(item) {
    item = item || {};
    const rawPriority = String(item.priority || "medium").toLowerCase();
    const priority = rawPriority === "high" || rawPriority === "urgent" || rawPriority === "critical"
      ? "High" : (rawPriority === "low" ? "Low" : "Medium");
    const duration = Math.max(5, parseInt(
      item.estimated_minutes || item.estimatedMinutes || item.durMin ||
      item.duration_minutes || item.durationMinutes || 5,
      10
    ) || 5);
    const sourceId = item.id || "unknown";
    return {
      id: "triage-" + sourceId,
      title: item.title || "Triage item",
      type: "triage",
      start: "00:00",
      end: _fmt(duration),
      untimed: true,
      durMin: duration,
      durationMinutes: duration,
      duration_minutes: duration,
      priority: priority,
      source: "triage",
      source_id: item.link || item.source_url || "",
      meta: "Triage item",
      detail: [item.summary, item.notes].filter(Boolean).join("\n\n"),
      tags: ["triage"],
      publicVisibility: "private",
      __triage: { sourceId: sourceId, item: item }
    };
  }

  // Due responsibilities are definitions, not task rows. This projection gives
  // their open occurrence the standard itinerary shape without persisting one.
  function fromDueResponsibility(item) {
    item = item || {};
    const duration = Math.max(1, Number(item.estimatedMinutes) || 30);
    const sourceId = item.id || "unknown";
    return {
      id: "responsibility-" + sourceId,
      title: item.title || "Recurring responsibility",
      type: "triage",
      start: "00:00",
      end: _fmt(duration),
      untimed: true,
      durMin: duration,
      durationMinutes: duration,
      duration_minutes: duration,
      priority: "High",
      source: "responsibility",
      source_id: "",
      meta: "Recurring responsibility",
      detail: "",
      tags: ["responsibility"],
      publicVisibility: "private",
      __responsibility: { sourceId: sourceId, item: item }
    };
  }

  // Slack's ⌛ state is durable task data, separate from the schedule's "Now"
  // calculation. A row stays visibly in progress until the hourglass is removed
  // or any completion representation wins. `done` lets renderers include their
  // canonical day-overlay answer without coupling this pure module to globals.
  function isInProgress(task, done) {
    task = task || {};
    return !!task.startedAt && !done && task.status !== "done" && !task.completedAt;
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
  // Responsibility definitions and triggers are scaffolding, but a
  // `responsibility_task` is the dated itinerary instance. Excluding that root while
  // admitting its `subtaskOf` children promotes every child to a standalone task and
  // makes the responsibility itself disappear. Keep this exception aligned with
  // db.js and dcc_is_task_row in pg-schema.js.
  // Meeting automation artifacts are evidence owned by their meeting. In particular,
  // proposed_action_item.citation.startOffset is not an itinerary start time; approval
  // creates a separate action row that can later become a real scheduled task.
  const NON_TASK_KINDS = [
    "delegated_item", "task_group", "reschedule_tombstone", "triage_suppression", "slack_reaction_tombstone", "slack_done_intent",
    "meeting_prep", "meeting_transcript", "meeting_summary", "proposed_action_item",
    // This dateless definition belongs only to the Anytime surface.
    "anytime_item"
  ];
  const NON_TASK_TYPES = ["day_root", "time_entry"];
  function isTaskRow(block) {
    block = block || {};
    if (NON_TASK_TYPES.indexOf(block.type) !== -1) return false;
    const kind = (block.properties || {}).kind || "";
    if (NON_TASK_KINDS.indexOf(kind) !== -1) return false;
    if (/^responsibility/.test(kind) && kind !== "responsibility_task") return false;
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
      // Dependency-parked tasks live in Waiting until their prerequisite is
      // released. They remain dateless but must not duplicate into Backlog.
      if (p.dependencyWaitingItemId) continue;
      // A titleless row cannot render on either surface; both consumers dropped it.
      if (!p.title) continue;
      if (!b.date) { out.push(b); continue; }
      if (opts.includeLegacyDatedBacklog && p.kind === "backlog") out.push(b);
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // C6a: THE DERIVATION LAYER
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Before this, 36 call sites across 11 files re-derived "which tasks does this
  // surface show" by filtering the `scheduled` global inline. They disagreed, and
  // the disagreements were the bugs: a done RIDE-ALONG never folded under its
  // parent (two fold predicates tested `subtaskOf` only), a wrap/shell child leaked
  // into Unscheduled as a standalone row (`!isSubtask` where `!isNested` was meant),
  // and `ev.nested` — which nothing has ever set true — gated the focus banner and
  // task pickers, so both could offer you a subtask as "your next task".
  //
  // Everything that answers a question ABOUT A SET of evs now lives here, and
  // `render-surface-registry.test.js` asserts no file outside this one filters
  // `scheduled` directly. That grep is the durable half of the phase: without it,
  // the next feature adds predicate #37 and this regrows.
  //
  // ── Why status is INJECTED and why a missing resolver THROWS ──
  //
  // This file is pure (its tests `require()` it under node with no `window`), but
  // "is this task done" is not a property of the ev — C5b made completion live on
  // the task ROW, projected into the in-memory `manualDone` registry that
  // `isDone(ev)` reads. There is no `ev.done`. So a node-side fallback reading an
  // ev flag would answer `false` for every real ev: a fake more benign than
  // production, which C5b established is a different program. Resolvers therefore
  // come from `opts`, fall back to the page's globals via the same
  // `typeof x === "function"` idiom `_pt`/`_fmt`/`_ms` already use, and THROW when
  // neither exists. Loud beats silently-nothing-is-done. Render-time only, and
  // `_doRender`'s per-surface try/catch contains it.
  //
  // `isCollapsed` is the one resolver that defaults: nothing-collapsed is the
  // truthful answer with no localStorage, not a softened one.
  function _need(opts, key, globalName, globalFn) {
    if (opts && typeof opts[key] === "function") return opts[key];
    if (typeof globalFn === "function") return globalFn;
    throw new Error(
      "TaskModel: pass opts." + key + " — no global `" + globalName + "` in this context"
    );
  }
  function _doneFn(opts) {
    return _need(opts, "isDone", "isDone", typeof isDone === "function" ? isDone : null);
  }
  function _deletedFn(opts) {
    return _need(opts, "isDeleted", "isDeleted", typeof isDeleted === "function" ? isDeleted : null);
  }
  // Side-project ("trivial") flags are a MAP of id -> truthy, not a function.
  // Absent is not the same as empty, so this throws too rather than assuming a
  // clean slate and quietly showing rows a surface has always hidden.
  function _trivialFlags(opts) {
    if (opts && opts.trivialFlags && typeof opts.trivialFlags === "object") return opts.trivialFlags;
    if (typeof loadTrivialFlags === "function") return loadTrivialFlags() || {};
    throw new Error("TaskModel: pass opts.trivialFlags — no global `loadTrivialFlags` in this context");
  }
  function _collapsedFn(opts) {
    if (opts && typeof opts.isCollapsed === "function") return opts.isCollapsed;
    if (typeof isCollapsed === "function") return isCollapsed;
    return function () { return false; };
  }
  function _arr(items) { return Array.isArray(items) ? items : []; }

  // ── Shape predicates: pure functions of one ev, no status needed ──
  //
  // parentIdOf is the canonical EV-SPACE edge: wrapId first, then subtaskOf.
  // `state.js` documents why this deliberately diverges from `lib/reschedule.js`'s
  // row-space order; do not "fix" that. Mirrored (not moved) from state.js, which
  // keeps the bare globals every existing call site reads.
  function parentIdOf(ev) { return (ev && (ev.wrapId || ev.subtaskOf)) || null; }
  function relOf(ev) { return ev ? (ev.wrapId ? "ride-along" : (ev.subtaskOf ? "subtask" : null)) : null; }
  function isSubtask(ev) { return !!(ev && ev.subtaskOf); }
  function isRideAlong(ev) { return !!(ev && ev.wrapId); }
  // The shape `unfinished-tasks.js` already computed truthfully as
  // `nested = !!(p.subtaskOf || p.wrapId)`. `ev.nested` (data.js writes it as a
  // literal `false` and nothing else ever assigns it) is NOT this and never was.
  function isNested(ev) { return !!parentIdOf(ev); }
  // Occupies a slot on the timeline. `fromBlock` sets untimed for a dateless row
  // too, so this covers both "no start" and "day-agnostic".
  function isScheduled(ev) { return !!ev && !ev.untimed; }
  // Belongs to THE viewed day, as opposed to an Unscheduled-everywhere row. The
  // day's progress bar, stats and point totals all scope on this.
  function isDayScoped(ev) { return !!ev && !ev._dateless; }

  // ── Status predicates ──
  function evIsDone(ev, opts) { return !!_doneFn(opts)(ev); }
  function evIsDeleted(ev, opts) { return !!_deletedFn(opts)(ev); }
  // Open = present and not finished. Deliberately NOT "not deleted": a deleted row
  // is not open either, but three quarters of the call sites that ask "open?" have
  // already excluded deleted rows upstream, and folding the two together here would
  // change what they count. `selectActive` is the both-at-once question.
  function evIsOpen(ev, opts) { return !!ev && !evIsDone(ev, opts); }

  // ── Edge lookups: three genuinely different questions, so three functions ──
  // childrenOf: either edge (the unified tree).
  // ridersOf:   the wrap edge only — ride-alongs occupy time inside their parent's
  //             window, which is what drag.js's wrap layout re-times.
  // subtasksOf: the subtask edge only — timeless steps, what a completion cascades.
  function childrenOf(parentId, pool) { return _arr(pool).filter(function (c) { return parentIdOf(c) === parentId; }); }
  function ridersOf(parentId, pool) { return _arr(pool).filter(function (c) { return !!c && c.wrapId === parentId; }); }
  function subtasksOf(parentId, pool) { return _arr(pool).filter(function (c) { return !!c && c.subtaskOf === parentId; }); }

  // ── Set selectors. Each existing call site keeps its EXACT semantics ──
  //
  // These are deliberately narrow rather than one clever configurable filter. C6a
  // routes 36 sites through this layer and fixes only the four the phase names; a
  // site whose predicate was already right must come out byte-equivalent, and a
  // named selector makes that reviewable. Where two sites differ only in whether
  // they excluded deleted rows, that difference is preserved, not harmonised —
  // harmonising it is a behaviour change nobody asked for. Divergences worth
  // closing are recorded in the phase handoff instead.
  function selectDone(items, opts) { const f = _doneFn(opts); return _arr(items).filter(function (ev) { return !!f(ev); }); }
  function selectOpen(items, opts) { const f = _doneFn(opts); return _arr(items).filter(function (ev) { return !!ev && !f(ev); }); }
  function selectActive(items, opts) {
    const d = _doneFn(opts), x = _deletedFn(opts);
    return _arr(items).filter(function (ev) { return !!ev && !d(ev) && !x(ev); });
  }
  // Active AND on the clock — the reflow cascade's population. An untimed row lives
  // in the Unscheduled section, so it must not consume a time slot.
  function selectTimedActive(items, opts) {
    const d = _doneFn(opts), x = _deletedFn(opts);
    return _arr(items).filter(function (ev) { return !!ev && !d(ev) && !x(ev) && !ev.untimed; });
  }
  function selectNotDeleted(items, opts) {
    const x = _deletedFn(opts);
    return _arr(items).filter(function (ev) { return !!ev && !x(ev); });
  }
  // What a render surface may show at all: not deleted, not flagged as a side
  // project. The base every section in `selectDay` is carved out of.
  function selectVisible(items, opts) {
    const x = _deletedFn(opts), triv = _trivialFlags(opts);
    return _arr(items).filter(function (ev) { return !!ev && !x(ev) && !triv[ev.id] && !ev.retiredContainerHidden; });
  }
  function selectDayScoped(items) { return _arr(items).filter(isDayScoped); }
  function selectTopLevel(items) { return _arr(items).filter(function (ev) { return !!ev && !isNested(ev); }); }
  function selectOpenTopLevel(items, opts) {
    const d = _doneFn(opts);
    return _arr(items).filter(function (ev) { return !!ev && !d(ev) && !isNested(ev); });
  }

  // ── selectRoots: the rows of THIS set that nothing in the set parents ──
  //
  // "no parent edge, OR a parent that is not in this list." Distinct from `selectTopLevel`
  // (`!isNested`), which excludes anything carrying an edge at all: an orphan whose parent
  // finished on another day IS a root here and is NOT top-level. Conflating the two is how
  // the carryover lane's fallback started undercounting its own section badge in review.
  // `DCC.Carryover.rootsOf` is this function under its published name.
  function selectRoots(items) {
    const list = _arr(items);
    const ids = new Set();
    for (let i = 0; i < list.length; i++) if (list[i]) ids.add(list[i].id);
    return list.filter(function (ev) {
      if (!ev) return false;
      const p = parentIdOf(ev);
      return !p || !ids.has(p);
    });
  }

  // ── selectCarryover: the open rows of a carryover pool ──
  //
  // A past-day row's completion is NOT `isDone(ev)` (that reads TODAY's registry) —
  // it is the origin day's status, which the collector stamps as `__unf.done`.
  // `unfinished-tasks.js openRows` delegates here so the carryover lane, the Catch
  // up modal and the morning prompt keep sharing ONE definition; this is its home,
  // not a second copy.
  function selectCarryover(pool) {
    return _arr(pool).filter(function (ev) { return !!ev && !(ev.__unf && ev.__unf.done); });
  }

  // ── selectDay: the viewed day, partitioned ──
  //
  // Returns, for a pool of evs already scoped to the viewed day (`scheduled`):
  //
  //   visible           not deleted, not side-project-flagged. The universe below.
  //   unscheduledRoots  the open, untimed, TOP-LEVEL rows. What the section header
  //                     counts and what the manual drag order sorts.
  //   unscheduled       those roots PLUS all of their visible descendants — the
  //                     section AS A SUBTREE.
  //   folded            done SUBTASKS of a still-visible parent whose whole subtree is
  //                     finished. They render in the parent's detail panel, which lists
  //                     subtasks, so they get no row anywhere. See the fold note below for
  //                     why this is the subtask edge only.
  //   timed             visible − unscheduled − folded. The work list; done rows sit
  //                     inline in their slot, nested under their parent.
  //   open              timed ∧ ¬done.
  //   nestedDone        timed ∧ done ∧ nested under a visible parent. Renders inline in the
  //                     work list; a compact DONE SECTION must not also list it standalone.
  //   done              timed ∧ done ∧ ¬nestedDone — the timeline's compact "Done" section.
  //   carryover         open rows of opts.carryoverPool, and ONLY when the viewed
  //                     day is the actual today. A past or future day does not
  //                     collect yesterday's leftovers.
  //
  // TWO EXACT INVARIANTS, both pinned by tests:
  //   timed ⊎ unscheduled ⊎ folded    == visible   (disjoint AND exhaustive)
  //   open  ⊎ done ⊎ nestedDone       == timed     (disjoint AND exhaustive)
  //
  // WHY `unscheduled` IS A SUBTREE AND NOT JUST ITS ROOTS. This is what makes the
  // orphan fix safe. `selectTree` now HIDES a child whose parent is in the pool but
  // filtered out of the input — so if `unscheduled` held only the roots, a subtask of
  // an untimed parent would sit in `timed` with its parent absent and would VANISH
  // instead of being promoted the way it is today. Taking the closure keeps every row
  // on screen: the child renders nested under its parent inside the Unscheduled
  // section, which is the "wrap children stay nested" outcome reached without
  // dropping anything.
  //
  // ★ WHY A DONE ROW ONLY FOLDS WHEN ITS WHOLE SUBTREE IS DONE. Folding means "no row
  // of your own; you live in your parent's detail panel", and `selectTree` will then
  // hide your children too, because their parent is in the pool but not in the input.
  // Fold a done parent that still has an OPEN child and that open work disappears
  // from every surface — worse than the orphan promotion this phase is fixing. So the
  // fold requires the visible subtree to be finished. A done leaf folds (the common
  // case), a done step with unfinished steps under it stays as a greyed inline row
  // with its open children nested beneath it, and nothing is ever dropped. The rule is
  // self-consistent: every member of a fully-done subtree is itself done, nested, and
  // parented inside `visible`, so folding the top folds all of it.
  function selectDay(pool, dateStr, opts) {
    opts = opts || {};
    const visible = selectVisible(pool, opts);
    const done = _doneFn(opts);
    const byId = new Map();
    for (let i = 0; i < visible.length; i++) byId.set(visible[i].id, visible[i]);
    // Adjacency built once: selectDay walks the tree three times (unscheduled
    // closure, fold check, and the subtree-done test) and childrenOf is a scan.
    const kidsOf = new Map();
    for (let i = 0; i < visible.length; i++) {
      const pid = parentIdOf(visible[i]);
      if (!pid || !byId.has(pid)) continue;
      if (!kidsOf.has(pid)) kidsOf.set(pid, []);
      kidsOf.get(pid).push(visible[i]);
    }

    // ── Fold FIRST: done, nested under a visible parent, finished all the way down ──
    //
    // ★ ORDER MATTERS, and getting it wrong shipped a real bug in review. The fold used
    // to be computed AFTER the unscheduled closure and skipped anything the closure had
    // claimed — so a finished step under an untimed parent could never fold, joined the
    // Unscheduled subtree instead, and rendered as an unchecked row titled "Mark done"
    // whose checkbox UN-COMPLETED it. Folding first makes the rule uniform: a finished
    // subtree folds wherever it hangs, timed or untimed.
    //
    // Memoised so a deep chain is walked once. `seen` breaks a data cycle by treating the
    // revisited node as "not blocking", which is the right answer: every ev has one parent
    // pointer, so a cycle is a closed ring, and a ring whose every member is done IS
    // finished. The seen short-circuit returns BEFORE writing the memo, so a cached value
    // was always computed by really walking children; and if any member of a ring is open,
    // that `done(kids[k])` test fails and the false propagates all the way round. So the
    // memo cannot hand back a stale true.
    const subtreeDone = new Map();
    function allDone(ev, seen, cyc) {
      if (subtreeDone.has(ev.id)) return subtreeDone.get(ev.id);
      // ★ A short-circuited answer is NOT cacheable, and an earlier version of this code
      // memoised it with a comment claiming that was impossible. It is not: a ring can have
      // branches hanging BELOW it. With A<->B a ring and open C parented on A, walking A
      // first resolves allDone(B) to true via this short-circuit and CACHES it, before C has
      // been looked at. B then folds with open work inside its subtree, and selectTree drops
      // C along with it. `cyc` marks the walk as tainted so nothing on that path is stored.
      if (seen.has(ev.id)) { cyc.hit = true; return true; }
      seen.add(ev.id);
      const kids = kidsOf.get(ev.id) || [];
      let ok = true;
      for (let k = 0; k < kids.length && ok; k++) {
        // ★ `isSubtask` HERE, not just `done`. `kidsOf` is built from `parentIdOf`, so a done
        // subtask's descendants can include a RIDE-ALONG -- which the fold below can never
        // claim, because the detail panel has no rider item type. Fold the parent anyway and
        // that rider is left in `timed` with its parent absent, which selectTree hides: the
        // row renders on no surface and cannot be un-checked. A fuzz over 30k random days lost
        // a row on 3.7% of them and EVERY loss was exactly this shape. So the fold requires a
        // subtree that is itself fold-eligible, which is what makes "the subtree leaves
        // together" true rather than merely asserted.
        if (!isSubtask(kids[k]) || !done(kids[k]) || !allDone(kids[k], seen, cyc)) ok = false;
      }
      if (!cyc.hit) subtreeDone.set(ev.id, ok);
      return ok;
    }
    // ★ THE FOLD IS THE SUBTASK EDGE ONLY, and the reason is a capability, not a preference.
    //
    // Folding means "no row of your own; you live in your parent's detail panel". That panel
    // (`renderModalItems`, features.js) is built from `subtasksOf` -- it lists SUBTASKS and
    // has no ride-along item type. So the subtask edge has a home to fold into and the wrap
    // edge does not. An earlier cut of this phase widened the fold to `parentIdOf` on the
    // grounds that "a done ride-along never folds" was a bug; it is, but only on the ONE
    // surface where folding means "do not list this separately" -- the timeline's compact
    // Done section. Widening it globally deleted the done rider from every surface: it left
    // `timed`, so the list view stopped nesting it under its wrap, and its wrap reported
    // hasKids:false so there was not even a chevron to find it behind. The only remaining
    // trace was the aggregate "N ride-alongs" chip.
    //
    // So the two questions are separated, and both are returned:
    //   folded      -> has a non-list home; keep it out of the work list entirely
    //   nestedDone  -> renders nested inline under a visible parent; a compact DONE SECTION
    //                  must not ALSO list it standalone
    // The list view renders `timed` (done riders included, nested and greyed, which is what
    // base did) and the timeline's Done section reads `done`, which excludes nestedDone --
    // so the standalone-Done-row bug the phase set out to fix is still fixed.
    const foldedIds = new Set();
    const folded = [];
    for (let i = 0; i < visible.length; i++) {
      const ev = visible[i];
      if (!done(ev) || !isSubtask(ev)) continue;
      const pid = ev.subtaskOf;
      if (!pid || !byId.has(pid)) continue;
      if (!allDone(ev, new Set(), { hit: false })) continue;
      foldedIds.add(ev.id); folded.push(ev);
    }

    // ── Unscheduled: the open untimed top-level roots, then their closure ──
    // `!isNested` (not `!isSubtask`): a wrap/shell ride-along is not a standalone
    // Unscheduled row, which is the leak this phase closes.
    const unscheduledRoots = [];
    for (let i = 0; i < visible.length; i++) {
      const ev = visible[i];
      if (ev.untimed && !done(ev) && !isNested(ev)) unscheduledRoots.push(ev);
    }
    const unscheduledIds = new Set();
    const unscheduled = [];
    const queue = unscheduledRoots.slice();
    for (let i = 0; i < unscheduledRoots.length; i++) {
      unscheduledIds.add(unscheduledRoots[i].id);
      unscheduled.push(unscheduledRoots[i]);
    }
    // Breadth-first, skipping folded rows. Skipping cannot orphan anything, and the reason is
    // the `isSubtask` gate inside `allDone`: a folded row's whole visible subtree is done AND
    // fold-eligible, so every member of it folds too. The subtree leaves together.
    // `unscheduledIds` doubles as the visited set, so a parent cycle cannot loop here.
    while (queue.length) {
      const parent = queue.shift();
      const kids = kidsOf.get(parent.id) || [];
      for (let k = 0; k < kids.length; k++) {
        if (unscheduledIds.has(kids[k].id) || foldedIds.has(kids[k].id)) continue;
        unscheduledIds.add(kids[k].id); unscheduled.push(kids[k]); queue.push(kids[k]);
      }
    }

    const timed = [], openItems = [], doneItems = [], nestedDone = [];
    for (let i = 0; i < visible.length; i++) {
      const ev = visible[i];
      if (unscheduledIds.has(ev.id) || foldedIds.has(ev.id)) continue;
      timed.push(ev);
      if (!done(ev)) { openItems.push(ev); continue; }
      // `parentIdOf`, so a done RIDE-ALONG counts here too: it renders nested inline in the
      // work list, so a compact Done section must not list it standalone as well.
      const pid = parentIdOf(ev);
      if (pid && byId.has(pid)) nestedDone.push(ev); else doneItems.push(ev);
    }

    // FAIL CLOSED. The old form was `(dateStr && today && dateStr !== today) ? [] : collect`,
    // which meant a caller passing a carryoverPool but no `today` got the full pool on EVERY
    // date -- the exact opposite of the documented today-only rule.
    const carryover = (opts.today && dateStr === opts.today) ? selectCarryover(opts.carryoverPool) : [];

    return {
      visible: visible,
      unscheduledRoots: unscheduledRoots,
      unscheduled: unscheduled,
      timed: timed,
      open: openItems,
      done: doneItems,
      nestedDone: nestedDone,
      folded: folded,
      carryover: carryover
    };
  }

  // ── selectTree: render order for a nested list ──
  //
  // Nodes are {ev, depth, rel, hasKids, collapsed}; descendants of a collapsed node
  // are omitted. Children render subtasks first (a task's own steps stay directly
  // under it), then ride-alongs by start time.
  //
  // ★ THE ORPHAN FIX, and it is entirely in how ROOTS are computed. `state.js`
  // `flattenSchedule` resolved roots against the INPUT array, so any filter that
  // dropped a parent promoted its children to depth 0 — a subtask of an untimed,
  // side-project-flagged, deleted or done-and-folded parent rendered as a top-level
  // task with a rank number of its own. `state.js:799` documents that as known
  // behaviour, and it is why every surface except the three list-view call sites
  // showed subtasks and ride-alongs as flat peers.
  //
  // Roots now resolve against `opts.pool` — the unfiltered universe — so:
  //   • parent absent from the POOL entirely  -> genuine orphan, promoted to depth 0
  //     and still visible, because standalone work must never disappear
  //   • parent in the pool but filtered out of `items` -> HIDDEN, because it renders
  //     inside its parent wherever that parent does render
  // `opts.pool` defaults to `items`, which is exactly the old behaviour, so a call
  // site opts in to the fix by naming its pool.
  function selectTree(items, opts) {
    opts = opts || {};
    const list = _arr(items);
    // Gate on PRESENCE, not truthiness+length. `{pool:[]}` is a legitimate thing for a
    // filtered caller to compute and it means "the pool is empty, promote everything" --
    // the old `&& opts.pool.length` silently turned it into `pool = list`, i.e. back into
    // the orphan-promoting default that naming a pool is supposed to opt out of.
    const pool = Array.isArray(opts.pool) ? opts.pool : list;
    const collapsedFn = _collapsedFn(opts);
    const poolIds = new Set(), poolById = new Map();
    for (let i = 0; i < pool.length; i++) if (pool[i]) { poolIds.add(pool[i].id); poolById.set(pool[i].id, pool[i]); }
    // ★ A row whose ancestor chain inside the pool CYCLES has no root, so the plain root test
    // ("no parent, or parent absent from the pool") never fires for it and neither it nor
    // anything hanging below it is ever walked -- the ring and its whole branch vanish. Treat
    // a cycling chain as rootless so the ring flattens instead. Corrupt data only (every
    // reparent path guards against cycles), but "standalone work must never disappear" is the
    // rule this phase is built on, and a lost OPEN row is the worst way to break it.
    function chainCycles(ev) {
      const walked = new Set();
      let cur = ev;
      while (cur) {
        if (walked.has(cur.id)) return true;
        walked.add(cur.id);
        const p = parentIdOf(cur);
        if (!p || !poolIds.has(p)) return false;
        cur = poolById.get(p);
      }
      return false;
    }
    const out = [], seen = new Set();
    function walk(ev, depth) {
      if (seen.has(ev.id) || depth > 20) return;   // cycle / runaway guard
      seen.add(ev.id);
      const kids = childrenOf(ev.id, list);
      const hasKids = kids.length > 0;
      const collapsed = hasKids && !!collapsedFn(ev.id);
      out.push({ ev: ev, depth: depth, rel: relOf(ev), hasKids: hasKids, collapsed: collapsed });
      if (hasKids && !collapsed) {
        const ride = kids.filter(function (k) { return relOf(k) === "ride-along"; })
          .sort(function (a, b) { return _pt(a.start) - _pt(b.start); });
        const subs = kids.filter(function (k) { return relOf(k) === "subtask"; });
        subs.concat(ride).forEach(function (k) { walk(k, depth + 1); });
      }
    }
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      if (!ev) continue;
      const p = parentIdOf(ev);
      if (!p || !poolIds.has(p) || chainCycles(ev)) walk(ev, 0);
    }
    return out;
  }

  return {
    fromBlock: fromBlock,
    fromTriageItem: fromTriageItem,
    fromDueResponsibility: fromDueResponsibility,
    isInProgress: isInProgress,
    isTaskRow: isTaskRow,
    foldsIntoItinerary: foldsIntoItinerary,
    backlogKey: backlogKey,
    selectUnscheduled: selectUnscheduled,
    // C6a — shape
    parentIdOf: parentIdOf,
    relOf: relOf,
    isSubtask: isSubtask,
    isRideAlong: isRideAlong,
    isNested: isNested,
    // C6a — status. `isDone`/`isOpen`/`isDeleted`/`isScheduled`/`isDayScoped` are NOT
    // exported: nothing calls them, the 30-odd routed sites all use the SET selectors
    // (selectDone / selectOpen / selectNotDeleted / selectDayScoped), and shipping a
    // published predicate whose first real user gets to discover whether it means what its
    // name says is worse than not shipping it. `isNested` IS exported, because two call
    // sites read it directly when choosing a default focused task.
    // C6a — edges
    childrenOf: childrenOf,
    ridersOf: ridersOf,
    subtasksOf: subtasksOf,
    // C6a — sets
    selectDone: selectDone,
    selectOpen: selectOpen,
    selectActive: selectActive,
    selectTimedActive: selectTimedActive,
    selectNotDeleted: selectNotDeleted,
    selectVisible: selectVisible,
    selectDayScoped: selectDayScoped,
    selectTopLevel: selectTopLevel,
    selectOpenTopLevel: selectOpenTopLevel,
    selectCarryover: selectCarryover,
    selectRoots: selectRoots,
    selectDay: selectDay,
    selectTree: selectTree
  };
});
