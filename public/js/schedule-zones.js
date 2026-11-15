/* Shared civil-time projection for the calendar and offline audit. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DCCScheduleZones = api;
})(typeof window === "object" ? window : null, function () {
  "use strict";
  const formatters = new Map();

  function validZone(zone) {
    if (typeof zone !== "string" || !/^(UTC|[A-Za-z_]+\/[A-Za-z0-9_+/-]+)$/.test(zone)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }

  function civil(instant, zone) {
    if (!formatters.has(zone)) {
      formatters.set(zone, new Intl.DateTimeFormat("en-GB", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }));
    }
    const fields = Object.fromEntries(formatters.get(zone).formatToParts(instant).map(p => [p.type, p.value]));
    return { date: fields.year + "-" + fields.month + "-" + fields.day, time: fields.hour + ":" + fields.minute };
  }

  // Sample both sides of nearby offset changes and verify every candidate by
  // round-tripping. Repeated and nonexistent times remain distinct results.
  function candidates(date, time, zone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return [];
    const nominal = Date.parse(date + "T" + time + ":00Z");
    if (!Number.isFinite(nominal)) return [];
    const offsets = new Set();
    for (const hours of [-36, 0, 36]) {
      const probe = nominal + hours * 3600000;
      const local = civil(probe, zone);
      offsets.add(Date.parse(local.date + "T" + local.time + ":00Z") - probe);
    }
    return [...offsets].map(offset => nominal - offset).filter(instant => {
      const local = civil(instant, zone);
      return local.date === date && local.time === time;
    }).sort((a, b) => a - b);
  }

  function inspect(block, zone) {
    const p = block.properties || {};
    if (!block.date || p.all_day || !p.start) return { status: "date-only" };
    const fixed = p.scheduleInstant;
    if (fixed && fixed.date === block.date && fixed.start === p.start && fixed.end === (p.end || null)) {
      const instant = Date.parse(fixed.startAt);
      if (Number.isFinite(instant)) return { status: "fixed", instant };
    }
    const instants = candidates(block.date, p.start, zone);
    if (instants.length !== 1) return { status: instants.length ? "repeated-time" : "invalid-or-nonexistent" };
    return { status: "legacy-schedule", instant: instants[0] };
  }

  function validDate(date) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const value = new Date(date + "T00:00:00Z");
    return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
  }

  function shiftDate(date, days) {
    const value = new Date(date + "T00:00:00Z");
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function dayWindow(date, zone) {
    // Find the first instant with a civil date at or after each boundary.
    // This also handles a gap at midnight or an entirely skipped civil date.
    function boundary(day) {
      const nominal = Date.parse(day + "T00:00:00Z");
      let low = nominal - 172800000, high = nominal + 172800000;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (civil(mid, zone).date < day) low = mid;
        else high = mid;
      }
      return high;
    }
    return { start: boundary(date), end: boundary(shiftDate(date, 1)) };
  }

  function viewingZone(preference, fallback, detect) {
    if (preference.mode === "device") {
      try {
        const detected = detect();
        if (validZone(detected)) return detected;
      } catch {}
    }
    if (preference.mode === "manual" && validZone(preference.zone)) return preference.zone;
    return fallback;
  }

  return { validZone, civil, candidates, inspect, viewingZone, dayWindow, shiftDate, validDate };
});
