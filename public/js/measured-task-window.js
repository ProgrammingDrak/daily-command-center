// Pure, shared helper for turning an exact task timer into the five-minute
// schedule window shown by the itinerary. Browser and server both load this
// file so Slack completion and the DCC checkbox cannot drift.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MeasuredTaskWindow = api;
})(typeof self !== "undefined" ? self : this, function () {
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  function localParts(ms, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const out = {};
    for (const part of parts) if (part.type !== "literal") out[part.type] = part.value;
    if (!out.year || !out.month || !out.day || out.hour == null || out.minute == null) return null;
    return {
      date: out.year + "-" + out.month + "-" + out.day,
      hour: Number(out.hour), minute: Number(out.minute),
      hhmm: String(out.hour).padStart(2, "0") + ":" + String(out.minute).padStart(2, "0"),
    };
  }

  function measuredTaskWindow(startedAt, completedAt, opts) {
    opts = opts || {};
    const startMs = typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
    const endMs = typeof completedAt === "number" ? completedAt : Date.parse(completedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

    const exactStart = localParts(startMs, opts.timeZone);
    const exactEnd = localParts(endMs, opts.timeZone);
    if (!exactStart || !exactEnd || exactStart.date !== exactEnd.date) return null;

    const roundedStartMs = Math.floor(startMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const roundedEndMs = Math.ceil(endMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const roundedStart = localParts(roundedStartMs, opts.timeZone);
    const roundedEnd = localParts(roundedEndMs, opts.timeZone);
    if (!roundedStart || !roundedEnd || roundedStart.date !== roundedEnd.date) return null;
    const startMinute = roundedStart.hour * 60 + roundedStart.minute;
    const endMinute = roundedEnd.hour * 60 + roundedEnd.minute;
    if (endMinute <= startMinute) return null;

    return {
      start: roundedStart.hhmm,
      end: roundedEnd.hhmm,
      durationMinutes: Math.round((roundedEndMs - roundedStartMs) / 60000),
      roundedStartMs,
      roundedEndMs,
    };
  }

  return { FIVE_MINUTES_MS, measuredTaskWindow };
});
