// meeting-materializer.js — turn the calendar's read-time meeting ghosts into
// durable, user-owned task blocks.
//
// Before this, a calendar meeting existed only as a synthesized timeline item
// rebuilt on every read (server.js meetingToTimelineItem). That made it a
// second-class citizen: no notes, no completion, no subtasks, no manual move.
// This materializes each calendar meeting into a real `type:"meeting"` block
// (a normal task the reflow engine treats as fixed-time) keyed by the gcal
// event identity, so it behaves like every other task while still holding its
// slot.
//
// Contract:
//   - CREATE a block the first time an event's identity is seen on a date.
//   - RECONCILE existing blocks calendar-wins: the calendar's start/end/title
//     overwrite the block on each sweep (a user's manual move therefore holds
//     only until the next sweep — Drake's chosen precedence). Completed blocks
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
module.exports = function createMeetingMaterializer(deps) {
  const { blockDB, scoreTaskPoints, meetingIdentity, APP_TIME_ZONE } = deps;
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
  function isCompleted(props) {
    const s = String(props.status || "").toLowerCase();
    return s === "done" || s === "completed" || !!props.completed;
  }

  function buildProps({ meeting, identity, start, end, durationMinutes }) {
    const title = meeting.title || "(No title)";
    const props = {
      title,
      type: "meeting",
      kind: "meeting",
      status: "open",
      start,
      end,
      estimatedMinutes: durationMinutes,
      priority: "Medium",
      source: "calendar",
      source_id: identity,
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
      synced_gcal_start: start,
      synced_gcal_end: end,
      synced_gcal_title: title,
    };
    try {
      const scored = scoreTaskPoints({ ...props, durationMinutes });
      props.points = scored.awardPoints;
      props.pointsBreakdown = scored;
    } catch (_) { /* scoring is non-fatal; meetings are non-earning anyway */ }
    return props;
  }

  // meetings: the ingest's meetings[] (may span multiple days — we scope to `date`).
  // hasMeetingsKey: did the triggering request actually carry a meetings section?
  async function materializeMeetings({ date, meetings, userId, workspaceId, hasMeetingsKey }) {
    const result = { created: 0, updated: 0, cancelled: 0, skipped: 0, blockIds: [] };
    const list = Array.isArray(meetings) ? meetings : [];

    // Same guards as meetingToTimelineItem, so the materialized set matches the
    // synthesized set exactly (no double-render, no vanished meeting).
    const eligible = [];
    for (const m of list) {
      if (!m || m.all_day || !m.start || !m.end) continue;
      const sd = new Date(m.start), ed = new Date(m.end);
      if (Number.isNaN(sd.getTime()) || Number.isNaN(ed.getTime())) continue;
      if (String(m.start).slice(0, 10) !== date) continue; // scope to this date
      const identity = meetingIdentity(m);
      if (!identity) continue;
      const start = isoToHHMM(m.start), end = isoToHHMM(m.end);
      if (!start || !end) continue;
      let durationMinutes = hhmmToMin(end) - hhmmToMin(start);
      if (!(durationMinutes > 0)) durationMinutes = 30; // guard midnight-cross / bad data
      eligible.push({ meeting: m, identity, start, end, durationMinutes });
    }

    // Every identity present in the feed FOR THIS DATE (even ones that failed a
    // render guard) — cancellation must not fire on a meeting still in the feed.
    const incomingIds = new Set(
      list
        .filter((m) => m && String(m.start || "").slice(0, 10) === date)
        .map(meetingIdentity)
        .filter(Boolean)
    );

    // Index existing calendar meeting blocks (incl. soft-deleted) by source_id.
    let blocks = [];
    try {
      blocks = await blockDB.getBlocksByDateIncludingDeleted(date, workspaceId);
    } catch (e) {
      console.error("[meeting-materializer] block lookup failed:", e.message);
      return result;
    }
    const bySourceId = new Map();
    for (const b of blocks) {
      const p = b.properties || {};
      if (p.source === "calendar" && (p.type === "meeting" || p.type === "oneone") && p.source_id) {
        bySourceId.set(String(p.source_id), b);
      }
    }

    let rootEnsured = false;
    for (const { meeting, identity, start, end, durationMinutes } of eligible) {
      const existing = bySourceId.get(identity);

      // User deleted it — respect that, never resurrect.
      if (existing && existing.deleted_at) { result.skipped++; continue; }

      if (existing) {
        const p = existing.properties || {};
        if (!isCompleted(p)) {
          const nextTitle = meeting.title || p.title || "(No title)";
          const changed =
            p.start !== start || p.end !== end || p.title !== nextTitle ||
            p.synced_gcal_start !== start || p.synced_gcal_end !== end;
          if (changed) {
            const props = {
              ...p,
              title: nextTitle,
              start, end,
              estimatedMinutes: durationMinutes,
              location: meeting.location || p.location || "",
              hangout_link: meeting.hangout_link || meeting.conferenceUrl || p.hangout_link || "",
              rsvp_status: meeting.myResponseStatus || meeting.rsvp_status || p.rsvp_status || "",
              synced_gcal_start: start,
              synced_gcal_end: end,
              synced_gcal_title: nextTitle,
            };
            try {
              await blockDB.updateBlock(existing.id, { properties: props, sort_order: sortOrderFor(start) });
              result.updated++;
            } catch (e) {
              console.error("[meeting-materializer] update failed:", e.message);
            }
          }
        }
        result.blockIds.push(existing.id);
        continue;
      }

      // First time we've seen this event on this date — create the block.
      try {
        if (!rootEnsured) { await blockDB.ensureDayRoot(date, userId, workspaceId); rootEnsured = true; }
        const props = buildProps({ meeting, identity, start, end, durationMinutes });
        const created = await blockDB.createBlock({
          type: "block", date, properties: props, sort_order: sortOrderFor(start),
          user_id: userId, workspace_id: workspaceId,
        });
        result.created++;
        result.blockIds.push(created.id);
      } catch (e) {
        console.error("[meeting-materializer] create failed:", e.message);
      }
    }

    // Cancellation: only when the ingest actually carried a meetings section.
    if (hasMeetingsKey) {
      for (const [sid, b] of bySourceId) {
        if (incomingIds.has(sid)) continue;
        if (b.deleted_at) continue;
        if (isCompleted(b.properties || {})) continue;
        try {
          await blockDB.deleteBlock(b.id);
          result.cancelled++;
        } catch (e) {
          console.error("[meeting-materializer] cancel failed:", e.message);
        }
      }
    }

    return result;
  }

  return { materializeMeetings };
};
