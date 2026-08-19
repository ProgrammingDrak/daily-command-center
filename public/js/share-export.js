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
    const s = str(value);
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
      .replace(/\r?\n/g, "\\n");
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
  function endTimeFor(task) {
    const start = timeCompact(task.start);
    if (!start) return null;
    const explicit = timeCompact(task.end);
    if (explicit && explicit > start) return explicit;
    const minutes = Number(task.durationMinutes) || 30;
    const startMinutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(2, 4));
    const total = Math.min(startMinutes + minutes, 23 * 60 + 59);
    return pad2(Math.floor(total / 60)) + pad2(total % 60) + "00";
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
        lines.push("DTSTART:" + dateCompact(date) + "T" + start);
        lines.push("DTEND:" + dateCompact(date) + "T" + endTimeFor(task));
      } else {
        lines.push("DTSTART;VALUE=DATE:" + dateCompact(date));
        lines.push("DTEND;VALUE=DATE:" + nextDayCompact(date));
      }
      lines.push("SUMMARY:" + icsEscape(task.title));
      const description = [];
      if (task.detail) description.push(task.detail);
      if (task.itemTypeLabel) description.push("Type: " + task.itemTypeLabel);
      if (task.status) description.push("Status: " + task.status);
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

    const section = (heading, rows, checked) => {
      if (!rows.length) return;
      out.push("", "## " + heading);
      out.push("");
      for (const task of rows) {
        const time = mdTimeLabel(task);
        out.push("- [" + (checked ? "x" : " ") + "] "
          + (time ? "**" + time + "** " : "")
          + mdOneLine(task.title)
          + (task.durationMinutes && time !== task.durationMinutes + "m" ? " (" + task.durationMinutes + "m)" : ""));
        for (const line of mdNoteLines(task.detail)) out.push("  - " + line);
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
