const Zones = require("../public/js/schedule-zones");
const { fail } = require("./conversation-model");

function boundary(date, time, zone, offset) {
  if (!Zones.validDate(date)) throw fail("Use a valid date in YYYY-MM-DD format");
  const matches = Zones.candidates(date, time, zone);
  if (!matches.length) throw fail("The wall time is invalid or does not exist in the selected timezone");
  if (offset !== undefined) {
    if (typeof offset !== "string" || !/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(offset))
      throw fail("UTC offset must use +HH:MM or -HH:MM");
    const chosen = Date.parse(date + "T" + time + ":00" + offset);
    if (!matches.includes(chosen)) throw fail("UTC offset does not match the selected timezone and wall time");
    return chosen;
  }
  if (matches.length !== 1) throw fail("The wall time repeats in this timezone; supply its UTC offset");
  return matches[0];
}

function placement(input, appZone) {
  if (!Zones.validZone(input.timeZone)) throw fail("Provide an IANA timezone, for example Asia/Tokyo");
  const startMs = boundary(input.date, input.start, input.timeZone, input.startOffset);
  const endMs = boundary(input.endDate ?? input.date, input.end, input.timeZone, input.endOffset);
  if (endMs <= startMs || endMs - startMs > 86400000) throw fail("End must be after start, within 24 hours");
  const start = Zones.civil(startMs, appZone);
  const end = Zones.civil(endMs, appZone);
  // The shared itinerary grid stores one scheduling date and ascending clock times.
  if (start.date !== end.date || start.time >= end.time)
    throw fail(
      "This slot crosses midnight or a repeated hour in the DCC scheduling zone. Split it into separate slots.",
      422
    );
  return {
    date: start.date,
    startMs,
    endMs,
    properties: {
      start: start.time,
      end: end.time,
      userSetStart: true,
      duration: (endMs - startMs) / 60000,
      durMin: (endMs - startMs) / 60000,
      scheduleInstant: {
        date: start.date,
        start: start.time,
        end: end.time,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
        zone: input.timeZone,
        source: "mcp-zoned"
      }
    }
  };
}

function interval(block, zone) {
  const plan = Zones.inspect(block, zone);
  if (!Number.isFinite(plan.instant)) return null;
  const p = block.properties;
  const storedEnd = plan.status === "fixed" ? Date.parse(p.scheduleInstant.endAt) : NaN;
  const ends = p.end ? Zones.candidates(block.date, p.end, zone) : [];
  const duration = Number(p.duration ?? p.durMin ?? p.estimatedMinutes);
  const end = Number.isFinite(storedEnd)
    ? storedEnd
    : ends.length === 1 && ends[0] > plan.instant
      ? ends[0]
      : plan.instant + duration * 60000;
  return { start: plan.instant, end: end > plan.instant ? end : null, fixed: plan.status === "fixed" };
}

function occupied(block, zone) {
  const p = block.properties;
  if (p.transparency === "transparent") return null;
  if (!p.all_day) return interval(block, zone);
  if (!calendarOwned(block) && !["meeting", "oneone", "ooo"].includes(p.type || p.kind)) return null;
  const start = p.all_day_start || block.date;
  if (!Zones.validDate(start)) return null;
  const end = p.all_day_end || Zones.shiftDate(start, 1);
  if (!Zones.validDate(end) || end <= start) return null;
  return { start: Zones.dayWindow(start, zone).start, end: Zones.dayWindow(end, zone).start };
}

function calendarOwned(block) {
  const p = block.properties;
  return (
    ["calendar", "gcal"].includes(String(p.source || "").toLowerCase()) ||
    !!p.calendar_id ||
    !!p.gcal_event_id ||
    !!p.gcal_calendar_id
  );
}

module.exports = { placement, interval, occupied, calendarOwned };
