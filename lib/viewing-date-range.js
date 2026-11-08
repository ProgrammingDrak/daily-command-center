const { dayWindow, inspect, shiftDate } = require("../public/js/schedule-zones");

function selectViewingRange(rows, start, end, viewingZone, schedulingZone) {
  const first = dayWindow(start, viewingZone).start;
  const last = dayWindow(end, viewingZone).end;
  return rows.filter(row => {
    const p = row.properties || {};
    if (row.type === "block" && p.all_day) {
      const from = p.all_day_start || row.date;
      return !!from && from <= end && (p.all_day_end || shiftDate(from, 1)) > start;
    }
    if (row.type === "block") {
      const result = inspect(row, schedulingZone);
      if (Number.isFinite(result.instant)) return result.instant >= first && result.instant < last;
    }
    return !!row.date && row.date >= start && row.date <= end;
  });
}

module.exports = { selectViewingRange };
