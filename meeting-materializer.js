// meeting-materializer.js — turn the calendar's read-time meeting ghosts into
// durable, user-owned task blocks.
//
// Before this, a calendar meeting existed only as a synthesized timeline item
// rebuilt on every read (server.js meetingToTimelineItem). That made it a
// second-class citizen: no notes, no completion, no subtasks, no manual move.
// This materializes each calendar meeting into a real `type:"meeting"` block
// (a normal task the reflow engine treats as fixed-time) keyed by the gcal
// event identity. Timed and all-day facts remain source-authoritative while
// local notes, completion, and nested work stay user-owned.
//
// Contract:
//   - CREATE a block the first time an event's identity is seen on a date.
//   - RECONCILE existing blocks calendar-wins: the calendar's start/end/title
//     overwrite the block on each sweep. The placement API rejects imported
//     meeting moves so the UI never offers a temporary change. Completed blocks
//     are never touched.
//   - NEVER resurrect a user-deleted meeting: soft-deleted rows are looked up
//     by source_id and left dead.
//   - CANCEL (soft-delete) a live meeting block whose event vanished from the
//     feed — but only when the ingest actually carried a meetings section, so a
//     triage-only ingest can't wipe the day's meetings. Completed ones survive.
//
// Double-emission is prevented on the READ side (server.js buildDayResponse
// queries these blocks and suppresses the synthesized item by source_id), NOT
// by annotating meetings[] — an intelligence merge can drop that array, so the
// query is the durable source of truth.
const { resolvePointTag: defaultResolvePointTag } = require("./slot-scoring");
const { assertNotResurrecting } = require("./lib/materialize-guard");

module.exports = function createMeetingMaterializer(deps) {
  // resolvePointTag is injectable like scoreTaskPoints (keeps the DI contract);
  // defaults to the real resolver so existing callers/tests need no rewiring.
  const { blockDB, scoreTaskPoints, meetingIdentity, APP_TIME_ZONE, resolvePointTag = defaultResolvePointTag } = deps;
  const TZ = APP_TIME_ZONE || "America/New_York";

  function isoToHHMM(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    let h = parts.find((p) => p.type === "hour")?.value ?? "00";
    const m = parts.find((p) => p.type === "minute")?.value ?? "00";
    if (h === "24") h = "00";
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  function hhmmToMin(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  function sortOrderFor(start) {
    return start ? hhmmToMin(start) : 0;
  }
  function shiftHHMM(hhmm, delta) {
    if (!hhmm || !Number.isFinite(delta)) return hhmm;
    const shifted = ((hhmmToMin(hhmm) + delta) % 1440 + 1440) % 1440;
    return `${String(Math.floor(shifted / 60)).padStart(2, "0")}:${String(shifted % 60).padStart(2, "0")}`;
  }
  // ET-local calendar date (YYYY-MM-DD) for an ISO instant. Mirrors isoToHHMM:
  // both read the wall-clock in TZ, so a meeting's day and its time never disagree.
  // A raw UTC slice would roll an evening-ET meeting onto the next day.
  function isoToDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value;
    const mo = parts.find((p) => p.type === "month")?.value;
    const da = parts.find((p) => p.type === "day")?.value;
    return y && mo && da ? `${y}-${mo}-${da}` : null;
  }
  // Date-label math on YYYY-MM-DD strings. Anchored at noon UTC so a one-day step
  // never lands on a DST seam; the returned slice is a plain calendar label.
  function addDaysISO(dateStr, n) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
  }
  function eachDateInclusive(startStr, endStr) {
    const out = [];
    let cur = new Date(`${startStr}T12:00:00Z`);
    const end = new Date(`${endStr}T12:00:00Z`);
    if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return out;
    let guard = 0;
    while (cur.getTime() <= end.getTime() && guard < 400) {
      out.push(cur.toISOString().slice(0, 10));
      cur = new Date(cur.getTime() + 86400000);
      guard++;
    }
    return out;
  }
  function isCompleted(props) {
    const s = String(props.status || "").toLowerCase();
    return s === "done" || s === "completed" || !!props.completed;
  }

  // Auto-prep horizon: a meeting whose start is ahead of us but inside this many
  // hours is "prep-eligible" — a newly materialized one gets stamped prep_status
  // "pending" so its card shows a pending chip immediately, and the sweep's prep
  // lane (review_meetings.py, same 36h window) picks it up and posts the real
  // brief, flipping the block to "ready". Past/far-future meetings get no stamp
  // (no chip): recap is the past's job, and far-out prep would just go stale.
  const PREP_HORIZON_MS = 36 * 60 * 60 * 1000;
  function withinPrepHorizon(startIso) {
    const t = new Date(startIso).getTime();
    if (Number.isNaN(t)) return false;
    const nowMs = Date.now();
    return t > nowMs && t <= nowMs + PREP_HORIZON_MS;
  }

  // Whether a block already carries the point-earning meeting tag. Used to heal
  // meetings materialized before the tag existed (see reconcile below).
  function hasMeetingTag(props) {
    return Array.isArray(props && props.tags) && props.tags.includes("meeting");
  }

  // Stamp the `meeting` tag and its resolved points onto a meeting's props. The
  // tag carries the multiplier via the tag-tier system (builtin meeting→half),
  // so a meeting keeps its non-earning TYPE yet still earns reduced points.
  // Settings aren't available here; the completion path (earnTaskCredit)
  // re-resolves against the user's own tier config, which is authoritative.
  function stampMeetingPoints(props, durationMinutes) {
    const tags = Array.isArray(props.tags) ? props.tags.slice() : [];
    if (!tags.includes("meeting")) tags.push("meeting");
    props.tags = tags;
    try {
      const tag = resolvePointTag(tags, null);
      if (tag) { props.point_tier = tag.tier; props.point_multiplier = tag.multiplier; }
      const scored = scoreTaskPoints({ ...props, durationMinutes });
      props.points = scored.awardPoints;
      props.pointsBreakdown = scored;
    } catch (e) {
      // Scoring is non-fatal (materialization must still produce the block),
      // but log it like the reconcile update path rather than swallowing.
      console.error("[meeting-materializer] point scoring failed (non-fatal):", e.message);
    }
    return props;
  }

  function buildProps({ meeting, identity, start, end, durationMinutes, allDay, allDayStart, allDayEnd }) {
    const title = meeting.title || "(No title)";
    const props = {
      title,
      type: "meeting",
      kind: "meeting",
      tags: ["meeting"],
      status: "open",
      ...(allDay ? {
        all_day: true,
        all_day_start: allDayStart,
        all_day_end: allDayEnd,
      } : { start, end }),
      estimatedMinutes: durationMinutes,
      priority: "Medium",
      source: "calendar",
      source_id: identity,
      calUrl: meeting.source_ref || meeting.htmlLink || meeting.calUrl || "",
      calendar_id: meeting.calendar_id || meeting.gcal_calendar_id || "",
      calendar_name: meeting.calendar_name || "",
      calendar_color: meeting.calendar_color || "",
      account_key: meeting.account_key || "",
      account_email: meeting.account_email || "",
      created_by: "calendar-ingest",
      created_at: new Date().toISOString(),
      location: meeting.location || "",
      hangout_link: meeting.hangout_link || meeting.conferenceUrl || "",
      rsvp_status: meeting.myResponseStatus || meeting.rsvp_status || "",
      attendee_count: Array.isArray(meeting.attendees)
        ? meeting.attendees.length
        : Number(meeting.attendee_count || 0),
      // Provenance: what the calendar last told us. Kept for debugging and a
      // future "manual wins until the gcal time itself changes" mode.
      synced_gcal_start: allDay ? allDayStart : start,
      synced_gcal_end: allDay ? allDayEnd : end,
      synced_gcal_title: title,
    };
    // Auto-prep: stamp a next-day meeting "pending" at birth so the card carries a
    // prep chip by morning with no button press. Only on CREATE — reconcile spreads
    // ...p, so a later "ready" (sweep-filled) or "pending" survives untouched, which
    // keeps re-ingest idempotent (a filled prep is never reset).
    if (!allDay && withinPrepHorizon(meeting.start)) props.prep_status = "pending";
    stampMeetingPoints(props, durationMinutes);
    return props;
  }

  // meetings: the ingest's meetings[] may span MANY days (the calendar sweep
  // publishes now through +10 business days in one payload). We group by ET-local
  // date and materialize every date present, so materialization owns meetings on
  // every date, not just the ingested one. `date` is the anchor: the earliest day
  // the feed covers. Cancellation is scoped to [date .. furthest meeting date].
  // hasMeetingsKey: did the triggering request actually carry a meetings section?
  // It is false during backfill and triage-only ingests, so they never cancel.
  async function materializeMeetings({ date, meetings, userId, workspaceId, hasMeetingsKey }) {
    const result = { created: 0, updated: 0, cancelled: 0, skipped: 0, blockIds: [] };
    const list = Array.isArray(meetings) ? meetings : [];

    // Group eligible meetings by ET-local date, and record every incoming identity
    // per date. The day is derived in the app timezone (isoToDate), not a raw UTC
    // slice, so an evening-ET meeting whose UTC start rolls past midnight still
    // lands on its ET day. Guards match meetingToTimelineItem so the sets align.
    const byDate = new Map();            // date -> eligible[]
    const incomingIdsByDate = new Map(); // date -> Set(identity), even guard-failed
    let horizonEnd = date;

    for (const m of list) {
      if (!m || !m.start) continue;
      const allDay = !!m.all_day;
      const allDayStart = allDay ? String(m.start_date || m.start || "").slice(0, 10) : null;
      const d = allDay ? allDayStart : isoToDate(m.start);
      if (!d) continue;
      const allDayEnd = allDay ? String(m.end_date || m.end || addDaysISO(d, 1) || "").slice(0, 10) : null;
      const coveredEnd = allDay && allDayEnd ? addDaysISO(allDayEnd, -1) : d;
      if ((coveredEnd || d) > horizonEnd) horizonEnd = coveredEnd || d;
      const identity = meetingIdentity(m);
      if (identity) {
        if (!incomingIdsByDate.has(d)) incomingIdsByDate.set(d, new Set());
        incomingIdsByDate.get(d).add(String(identity));
      }
      // Eligibility for a rendered/materialized block.
      if (allDay) {
        if (!identity || !allDayEnd || allDayEnd <= d) continue;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push({ meeting: m, identity: String(identity), start: null, end: null,
          durationMinutes: 0, allDay: true, allDayStart: d, allDayEnd });
        continue;
      }
      if (!m.end) continue;
      const sd = new Date(m.start), ed = new Date(m.end);
      if (Number.isNaN(sd.getTime()) || Number.isNaN(ed.getTime())) continue;
      if (!identity) continue;
      const start = isoToHHMM(m.start), end = isoToHHMM(m.end);
      if (!start || !end) continue;
      let durationMinutes = hhmmToMin(end) - hhmmToMin(start);
      if (!(durationMinutes > 0)) durationMinutes = 30; // guard midnight-cross / bad data
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push({ meeting: m, identity: String(identity), start, end, durationMinutes });
    }

    // Cancellation window: only when the ingest carried a meetings section. It
    // spans the anchor date through the furthest meeting the feed mentions, so a
    // day that dropped to zero meetings still gets its stale block cleared as long
    // as a later day keeps the horizon open. We deliberately do NOT cancel beyond
    // the furthest meeting: over-cancelling soft-deletes a block that no-resurrect
    // then keeps dead, so a partial feed must never reach past its own data. The
    // one gap is the furthest day emptying with nothing beyond it; the next sweep
    // that reaches past it clears it. Capped so a stray far-future meeting can't
    // trigger a huge scan.
    const cancelSet = new Set();
    if (hasMeetingsKey) {
      const cap = addDaysISO(date, 60);
      if (cap && horizonEnd > cap) {
        console.warn(`[meeting-materializer] cancellation window capped at ${cap} (feed reached ${horizonEnd})`);
        horizonEnd = cap;
      }
      for (const d of eachDateInclusive(date, horizonEnd)) cancelSet.add(d);
    }

    // Process every date with incoming meetings, plus every date in the
    // cancellation window. Load the entire window first so an event that moved
    // to another day can keep its durable block id and its nested work.
    const processDates = [...new Set([...byDate.keys(), ...cancelSet])].sort();
    const blocksByDate = new Map();
    const calendarBySource = new Map();
    let identityContext = [];
    const incomingSourceIds = [...new Set([...incomingIdsByDate.values()].flatMap((ids) => [...ids]))];
    if (incomingSourceIds.length && typeof blockDB.getCalendarMeetingContextBySourceIds === "function") {
      try {
        identityContext = await blockDB.getCalendarMeetingContextBySourceIds(incomingSourceIds, workspaceId);
      } catch (e) {
        console.error("[meeting-materializer] identity lookup failed:", e.message);
        throw e;
      }
    }
    for (const pd of processDates) {
      try {
        const blocks = await blockDB.getBlocksByDateIncludingDeleted(pd, workspaceId);
        blocksByDate.set(pd, blocks);
        for (const b of blocks) {
          const p = b.properties || {};
          if (p.source === "calendar" && (p.type === "meeting" || p.type === "oneone") && p.source_id) {
            calendarBySource.set(String(p.source_id), b);
          }
        }
      } catch (e) {
        console.error("[meeting-materializer] block lookup failed for", pd + ":", e.message);
        blocksByDate.set(pd, null);
      }
    }
    const allBlocksById = new Map();
    for (const block of [...identityContext, ...[...blocksByDate.values()].filter(Boolean).flat()]) {
      if (block && block.id) allBlocksById.set(block.id, block);
    }
    const allBlocks = [...allBlocksById.values()];
    for (const b of allBlocks) {
      const p = b.properties || {};
      if (p.source === "calendar" && (p.type === "meeting" || p.type === "oneone") && p.source_id) {
        calendarBySource.set(String(p.source_id), b);
      }
    }

    const claimedBlockIds = new Set();
    // Reconcile/create every incoming event before cancellation. This ordering
    // prevents an old-date row from being deleted before its new-date sweep can
    // move that same row and preserve child edges.
    for (const pd of processDates) {
      if (!blocksByDate.get(pd)) continue;
      await materializeDate({
        date: pd,
        eligible: byDate.get(pd) || [],
        allBlocks,
        calendarBySource,
        claimedBlockIds,
        userId, workspaceId, result,
      });
    }
    for (const pd of processDates) {
      if (!cancelSet.has(pd) || !blocksByDate.get(pd)) continue;
      await cancelDate({
        blocks: blocksByDate.get(pd),
        allBlocks,
        incomingIds: incomingIdsByDate.get(pd) || new Set(),
        claimedBlockIds,
        result,
      });
    }

    return result;
  }

  // Create, reconcile, and (optionally) cancel the calendar meeting blocks for a
  // SINGLE date. Accumulates into the shared `result`.
  async function materializeDate({ date, eligible, allBlocks, calendarBySource, claimedBlockIds, userId, workspaceId, result }) {
    let rootEnsured = false;
    for (const { meeting, identity, start, end, durationMinutes, allDay, allDayStart, allDayEnd } of eligible) {
      const existing = calendarBySource.get(identity);

      // User deleted it, so respect that and never resurrect. This check was the
      // reference implementation the shared guard was lifted from; it now calls the
      // shared one so the five materialize paths cannot drift apart. The lookup
      // stays local: bySourceId is one day-load reused across every meeting on the
      // date, and routing it through findForDedupe would make it one load per meeting.
      if (assertNotResurrecting(existing).skip) { result.skipped++; continue; }

      if (existing) {
        const p = existing.properties || {};
        if (!isCompleted(p)) {
          const nextTitle = meeting.title || p.title || "(No title)";
          // A meeting is first CREATED ~10 business days out (the sweep publishes a
          // wide horizon in one payload), so most meetings are born outside the 36h
          // window and miss the create-time pending stamp. Stamp it here as they
          // cross INTO the window on a later sweep. Guarded by !p.prep_status so a
          // sweep-filled "ready" is never clobbered and pending is never re-stamped.
          const wantsPending = !allDay && !p.prep_status && withinPrepHorizon(meeting.start);
          const nextCalUrl = meeting.source_ref || meeting.htmlLink || meeting.calUrl || p.calUrl || "";
          const nextCalendarId = meeting.calendar_id || meeting.gcal_calendar_id || p.calendar_id || "";
          const nextCalendarName = meeting.calendar_name || p.calendar_name || "";
          const nextCalendarColor = meeting.calendar_color || p.calendar_color || "";
          const nextAccountKey = meeting.account_key || p.account_key || "";
          const nextAccountEmail = meeting.account_email || p.account_email || "";
          const changed =
            existing.date !== date || p.title !== nextTitle ||
            (!!p.all_day !== !!allDay) ||
            (allDay ? (p.all_day_start !== allDayStart || p.all_day_end !== allDayEnd)
              : (p.start !== start || p.end !== end)) ||
            p.synced_gcal_start !== (allDay ? allDayStart : start) ||
            p.synced_gcal_end !== (allDay ? allDayEnd : end) ||
            p.calUrl !== nextCalUrl || p.calendar_id !== nextCalendarId ||
            p.calendar_name !== nextCalendarName || p.calendar_color !== nextCalendarColor ||
            p.account_key !== nextAccountKey || p.account_email !== nextAccountEmail ||
            // Heal meetings materialized before the point-earning tag existed:
            // a one-time reconcile stamps the tag + points, then stays idempotent.
            !hasMeetingTag(p) || wantsPending;
          if (changed) {
            const oldDate = existing.date;
            const oldStart = p.start;
            const props = {
              ...p,
              title: nextTitle,
              ...(allDay ? {
                all_day: true, all_day_start: allDayStart, all_day_end: allDayEnd,
                start: undefined, end: undefined,
              } : {
                all_day: false, all_day_start: undefined, all_day_end: undefined,
                start, end,
              }),
              estimatedMinutes: durationMinutes,
              location: meeting.location || p.location || "",
              hangout_link: meeting.hangout_link || meeting.conferenceUrl || p.hangout_link || "",
              rsvp_status: meeting.myResponseStatus || meeting.rsvp_status || p.rsvp_status || "",
              calUrl: nextCalUrl,
              calendar_id: nextCalendarId,
              calendar_name: nextCalendarName,
              calendar_color: nextCalendarColor,
              account_key: nextAccountKey,
              account_email: nextAccountEmail,
              synced_gcal_start: allDay ? allDayStart : start,
              synced_gcal_end: allDay ? allDayEnd : end,
              synced_gcal_title: nextTitle,
            };
            if (allDay) { delete props.start; delete props.end; }
            else { delete props.all_day_start; delete props.all_day_end; }
            if (wantsPending) props.prep_status = "pending";
            stampMeetingPoints(props, durationMinutes);
            try {
              const childMoves = nestedMoveOps({ parent: existing, allBlocks, oldDate, newDate: date, oldStart, newStart: start });
              const parentOp = { op: "update", id: existing.id, properties: props, sort_order: sortOrderFor(start), date };
              if (childMoves.length) {
                if (typeof blockDB.batchOp !== "function") throw new Error("atomic batch update is unavailable");
                await blockDB.batchOp([parentOp, ...childMoves]);
              } else {
                await blockDB.updateBlock(existing.id, parentOp);
              }
              existing.date = date;
              existing.properties = props;
              for (const move of childMoves) {
                const child = allBlocks.find((row) => row.id === move.id);
                if (child) { child.date = move.date; child.properties = move.properties; }
              }
              result.updated++;
            } catch (e) {
              console.error("[meeting-materializer] update failed:", e.message);
            }
          }
        }
        claimedBlockIds.add(existing.id);
        result.blockIds.push(existing.id);
        continue;
      }

      // First time we've seen this event on this date, so create the block.
      try {
        if (!rootEnsured) { await blockDB.ensureDayRoot(date, userId, workspaceId); rootEnsured = true; }
        const props = buildProps({ meeting, identity, start, end, durationMinutes, allDay, allDayStart, allDayEnd });
        const created = await blockDB.createBlock({
          type: "block", date, properties: props, sort_order: sortOrderFor(start),
          user_id: userId, workspace_id: workspaceId,
        });
        result.created++;
        result.blockIds.push(created.id);
        claimedBlockIds.add(created.id);
        calendarBySource.set(identity, created);
      } catch (e) {
        console.error("[meeting-materializer] create failed:", e.message);
      }
    }
  }

  function aliasesOf(block) {
    const p = (block && block.properties) || {};
    return [...new Set([block && block.id, p.local_id].filter(Boolean))];
  }

  function nestedMoveOps({ parent, allBlocks, oldDate, newDate, oldStart, newStart }) {
    if (!parent || !Array.isArray(allBlocks)) return [];
    const delta = oldStart && newStart ? hhmmToMin(newStart) - hhmmToMin(oldStart) : 0;
    const dateDelta = Math.round((new Date(`${newDate}T12:00:00Z`) - new Date(`${oldDate}T12:00:00Z`)) / 86400000);
    const childrenByParent = new Map();
    for (const block of allBlocks) {
      if (!block || block.deleted_at) continue;
      const p = block.properties || {};
      const pid = p.wrapId || p.subtaskOf;
      if (!pid) continue;
      if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
      childrenByParent.get(pid).push(block);
    }
    const seenRows = new Set([parent.id]);
    const queue = aliasesOf(parent).flatMap((id) => childrenByParent.get(id) || []);
    const moves = [];
    while (queue.length) {
      const child = queue.shift();
      const p = child.properties || {};
      if (!child.id || seenRows.has(child.id)) continue;
      seenRows.add(child.id);
      const nextProps = { ...p };
      if (delta && p.start) nextProps.start = shiftHHMM(p.start, delta);
      if (delta && p.end) nextProps.end = shiftHHMM(p.end, delta);
      if (dateDelta && p.all_day) {
        if (p.all_day_start) nextProps.all_day_start = addDaysISO(p.all_day_start, dateDelta);
        if (p.all_day_end) nextProps.all_day_end = addDaysISO(p.all_day_end, dateDelta);
      }
      if (delta || oldDate !== newDate) {
        moves.push({ op: "update", id: child.id, properties: nextProps, date: addDaysISO(child.date || oldDate, dateDelta) || newDate });
      }
      aliasesOf(child).forEach((id) => (childrenByParent.get(id) || []).forEach((next) => queue.push(next)));
    }
    return moves;
  }

  // Cancellation: soft-delete live calendar blocks whose event vanished from the
  // feed. Only meetings still absent are removed; completed ones survive.
  async function cancelDate({ blocks, allBlocks, incomingIds, claimedBlockIds, result }) {
    for (const b of blocks) {
      const p = b.properties || {};
      if (p.source !== "calendar" || (p.type !== "meeting" && p.type !== "oneone") || !p.source_id) continue;
      if (incomingIds.has(String(p.source_id)) || claimedBlockIds.has(b.id)) continue;
      if (b.deleted_at || isCompleted(p)) continue;
      try {
        const parentAliases = new Set(aliasesOf(b));
        const childOps = allBlocks.filter((child) => {
          if (!child || child.deleted_at || child.id === b.id) return false;
          const cp = child.properties || {};
          return parentAliases.has(cp.wrapId || cp.subtaskOf);
        }).map((child) => {
          const cp = { ...(child.properties || {}), wrapId: null, subtaskOf: null, rel: null };
          if (child.properties && child.properties.subtaskOf && cp.start && cp.end && hhmmToMin(cp.end) <= hhmmToMin(cp.start)) {
            const startMin = hhmmToMin(cp.start);
            const endMin = Math.min(1439, startMin + 30);
            cp.end = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
            cp.duration = Math.max(0, endMin - startMin);
          }
          return { op: "update", id: child.id, properties: cp, parent_id: null, date: child.date };
        });
        if (childOps.length) {
          if (typeof blockDB.batchOp !== "function") throw new Error("atomic cancellation batch is unavailable");
          await blockDB.batchOp([...childOps, { op: "delete", id: b.id }]);
          for (const op of childOps) {
            const child = allBlocks.find((row) => row.id === op.id);
            if (child) child.properties = op.properties;
          }
        } else {
          await blockDB.deleteBlock(b.id);
        }
        result.cancelled++;
      } catch (e) {
        console.error("[meeting-materializer] cancel failed:", e.message);
      }
    }
  }

  return { materializeMeetings };
};
