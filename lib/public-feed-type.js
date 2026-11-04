// Public feed type for a shared-day row. One place for the mapping, its labels and
// the set of fixed-time types (meetings, breaks, OOO) that never get "done" and
// drop off the shared plan once they end. Parity with public/js/task-types.js
// fixedTypes() is pinned by queue-lanes-parity.test.js.
function publicFeedType(input) {
  const kind = String(input.kind || input.type || "task").toLowerCase();
  const source = String(input.source || "").toLowerCase();
  if (source === "calendar" || source === "gcal" || input.gcal_event_id || input.gcal_calendar_id || ["meeting", "oneone"].includes(kind)) return "calendar";
  if (["responsibility_trigger", "repeat_responsibility", "repeat", "recurring"].includes(kind) || input.is_recurring || input.recurring) return "repeat";
  if (["break", "free_time"].includes(kind)) return "break";
  if (kind === "ooo") return "ooo";
  return "task";
}

function publicFeedTypeLabel(feedType, kind) {
  if (feedType === "calendar") return kind === "oneone" ? "1:1" : "Calendar";
  if (feedType === "repeat") return "Repeat";
  if (feedType === "break") return "Break";
  if (feedType === "ooo") return "OOO";
  if (kind === "public_task") return "Public";
  return "Task";
}

const TIME_ONLY_FEED_TYPES = new Set(["calendar", "break", "ooo"]);

module.exports = { publicFeedType, publicFeedTypeLabel, TIME_ONLY_FEED_TYPES };
