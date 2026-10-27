// Strict, timezone-independent command envelope. No natural-language inference here.
const crypto = require("node:crypto");
function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function text(value, name, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw fail(`Invalid ${name}`);
  return value;
}
function instant(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw fail("Use an ISO timestamp with an explicit timezone");
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw fail("Invalid calendar timestamp");
  return Date.parse(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])])
    );
  return value;
}
function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function command(input, now = Date.now()) {
  const b = structuredClone(input || {});
  const allowed = [
    "action",
    "sourceEventId",
    "expectedRevision",
    "at",
    "taskId",
    "entryId",
    "parts",
    "reason",
    "correctedWindow",
    "order",
    "note",
    "generation",
    "remindMinutes",
    "guided",
    "delegation"
  ];
  if (Object.keys(b).some((k) => !allowed.includes(k)))
    throw fail("Unknown command field; account identity comes from authorization");
  if (
    ![
      "start",
      "pause",
      "continue",
      "done",
      "background-start",
      "background-stop",
      "correct",
      "queue-add",
      "queue-remove",
      "queue-reorder",
      "queue-note",
      "queue-block",
      "queue-unblock",
      "queue-claim",
      "queue-snooze",
      "queue-dismiss",
      "delegated-register",
      "delegated-update"
    ].includes(b.action)
  )
    throw fail("Explicit start, pause, done, background or correction required");
  text(b.sourceEventId, "sourceEventId");
  if (!Number.isInteger(b.expectedRevision) || b.expectedRevision < 0)
    throw fail("Read current state and supply expectedRevision");
  const at = instant(b.at);
  if (at > now + 30000) throw fail("Future activity cannot be recorded");
  if (b.action.startsWith("delegated-")) {
    if (
      Object.keys(b).some(
        (k) => !["action", "sourceEventId", "expectedRevision", "at", "taskId", "delegation"].includes(k)
      )
    )
      throw fail("Unexpected delegated work command field");
    if (b.taskId != null) text(b.taskId, "taskId");
    require("./delegated-work").validate(b);
    return b;
  }
  if (b.action === "correct") {
    text(b.entryId, "entryId");
    text(b.reason, "correction reason", 1000);
    if (b.correctedWindow) {
      if (Object.keys(b.correctedWindow).some((k) => !["start", "end"].includes(k)))
        throw fail("Invalid corrected window");
      const start = instant(b.correctedWindow.start),
        end = instant(b.correctedWindow.end);
      if (end <= start || end > now || end - start > 36 * 3600000) throw fail("Invalid corrected interval");
    }
    if (!Array.isArray(b.parts) || !b.parts.length || b.parts.length > 12) throw fail("Choose 1–12 correction parts");
    b.parts.forEach((p) => {
      if (!p || Object.keys(p).some((k) => !["kind", "taskId", "calendarEventId", "start", "end"].includes(k)))
        throw fail("Invalid correction part");
      if (!["focused", "meeting", "unknown"].includes(p.kind)) throw fail("Invalid allocation kind");
      if (instant(p.end) <= instant(p.start)) throw fail("Allocation end must follow start");
      if (p.kind === "focused") text(p.taskId, "taskId");
      if (p.kind === "meeting") text(p.calendarEventId, "calendarEventId", 500);
      if ((p.kind !== "focused" && p.taskId) || (p.kind !== "meeting" && p.calendarEventId))
        throw fail("Allocation identity does not match its kind");
    });
  } else if (b.action !== "queue-reorder") text(b.taskId, "taskId");
  if (b.remindMinutes != null && (!Number.isInteger(b.remindMinutes) || b.remindMinutes < 1 || b.remindMinutes > 1440))
    throw fail("Choose 1–1440 reminder minutes");
  if (b.action === "queue-snooze" && b.remindMinutes == null) throw fail("Snooze requires reminder minutes");
  if (b.action === "queue-note" && (typeof b.note !== "string" || b.note.length > 4000))
    throw fail("Context must be at most 4000 characters");
  if (["queue-claim", "queue-snooze", "queue-dismiss"].includes(b.action)) text(b.generation, "reminder generation");
  if (
    b.action === "queue-reorder" &&
    (!Array.isArray(b.order) ||
      b.order.length > 100 ||
      b.order.some((id) => typeof id !== "string" || !id || id.length > 160))
  )
    throw fail("Invalid queue order");
  return b;
}
const TIMING_WRITE = Symbol("conversation-timing-write");
module.exports = { fail, text, instant, digest, command, TIMING_WRITE };
