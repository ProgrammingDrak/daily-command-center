// meeting-identity.js — the ONE definition of a calendar meeting's stable identity.
//
// This string is load-bearing: the materializer keys, reconciles, dedupes, and
// cancels meeting blocks by it. server.js injects this into the materializer and
// the backfill script requires it directly, so the ingest path and the migration
// always key blocks the same way. If a new fallback key is ever needed, add it
// here once rather than forking a second copy.
//
// Precedence: gcal event_id, then source_id, then gcal_event_id, then id.
module.exports = function meetingIdentity(meeting) {
  return String(
    meeting?.event_id ||
    meeting?.source_id ||
    meeting?.gcal_event_id ||
    meeting?.id ||
    ""
  ).trim();
};
