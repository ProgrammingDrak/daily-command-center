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
const { resolvePointTag: defaultResolvePointTag } = require("./slot-scoring");

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

  function buildProps({ meeting, identity, start, end, durationMinutes }) {
    const title = meeting.title || "(No title)";
    const props = {
      title,
      type: "meeting",
      kind: "meeting",
      tags: ["meeting"],
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
    // Auto-prep: stamp a next-day meeting "pending" at birth so the card carries a
    // prep chip by morning with no button press. Only on CREATE — reconcile spreads
    // ...p, so a later "ready" (sweep-filled) or "pending" survives untouched, which
    // keeps re-ingest idempotent (a filled prep is never reset).
    if (withinPrepHorizon(meeting.start)) props.prep_status = "pending";
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
      const d = isoToDate(m.start);
      if (!d) continue;
      if (d > horizonEnd) horizonEnd = d;
      const identity = meetingIdentity(m);
      if (identity) {
        if (!incomingIdsByDate.has(d)) incomingIdsByDate.set(d, new Set());
        incomingIdsByDate.get(d).add(String(identity));
      }
      // Eligibility for a rendered/materialized block.
      if (m.all_day || !m.end) continue;
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
    // cancellation window (empty ones just get a cancellation sweep).
    const processDates = [...new Set([...byDate.keys(), ...cancelSet])].sort();
    for (const pd of processDates) {
      await materializeDate({
        date: pd,
        eligible: byDate.get(pd) || [],
        incomingIds: incomingIdsByDate.get(pd) || new Set(),
        doCancel: cancelSet.has(pd),
        userId, workspaceId, result,
      });
    }

    return result;
  }

  // Create, reconcile, and (optionally) cancel the calendar meeting blocks for a
  // SINGLE date. Accumulates into the shared `result`.
  async function materializeDate({ date, eligible, incomingIds, doCancel, userId, workspaceId, result }) {
    // Index existing calendar meeting blocks (incl. soft-deleted) by source_id.
    let blocks = [];
    try {
      blocks = await blockDB.getBlocksByDateIncludingDeleted(date, workspaceId);
    } catch (e) {
      console.error("[meeting-materializer] block lookup failed for", date + ":", e.message);
      return;
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

      // User deleted it, so respect that and never resurrect.
      if (existing && existing.deleted_at) { result.skipped++; continue; }

      if (existing) {
        const p = existing.properties || {};
        if (!isCompleted(p)) {
          const nextTitle = meeting.title || p.title || "(No title)";
          // A meeting is first CREATED ~10 business days out (the sweep publishes a
          // wide horizon in one payload), so most meetings are born outside the 36h
          // window and miss the create-time pending stamp. Stamp it here as they
          // cross INTO the window on a later sweep. Guarded by !p.prep_status so a
          // sweep-filled "ready" is never clobbered and pending is never re-stamped.
          const wantsPending = !p.prep_status && withinPrepHorizon(meeting.start);
          const changed =
            p.start !== start || p.end !== end || p.title !== nextTitle ||
            p.synced_gcal_start !== start || p.synced_gcal_end !== end ||
            // Heal meetings materialized before the point-earning tag existed:
            // a one-time reconcile stamps the tag + points, then stays idempotent.
            !hasMeetingTag(p) || wantsPending;
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
            if (wantsPending) props.prep_status = "pending";
            stampMeetingPoints(props, durationMinutes);
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

      // First time we've seen this event on this date, so create the block.
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

    // Cancellation: soft-delete live calendar blocks whose event vanished from the
    // feed. Only meetings still absent are removed; completed ones survive.
    if (doCancel) {
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
  }

  return { materializeMeetings };
};
