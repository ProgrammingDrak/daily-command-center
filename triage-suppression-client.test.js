// Contract tests for the CLIENT half of triage suppressions.
//
// public/js/triage.js is where the two user-visible regressions in this feature lived,
// and neither was reachable from the server tests:
//
//   * the Completed list is the ONLY surface that offers Undo for an item handled in
//     another tab or earlier in the day. The server strips such an item from
//     open_items, so it is not in INIT_TRIAGE and the ordinary path cannot render it.
//     If `completedRemote` silently produces nothing, Undo is gone and the failure is
//     invisible (an empty list, no error).
//   * the row template concatenates third-party text (swept Gmail subjects, Slack
//     message bodies) into innerHTML, and a suppression now PERSISTS that text
//     server-side, so an unescaped title re-executes on every device on every load.
//
// Harness follows the two idioms this repo already uses for public/js: slice the real
// source with a must-match guard (one-unscheduled-home.test.js) and run it in a
// node:vm with stubs (completion-date-choice.test.js, push-is-a-move.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./public/js/triage.js"), "utf8");
const { triageItemKey } = require("./triage-suppressions");

function mustSlice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found — the source moved or was renamed, fix the pattern");
  return m[0];
}

const KEY_FN = mustSlice(SRC, /^function triageItemKeyFor\(item\) \{[\s\S]*?\n\}/m, "triageItemKeyFor");
const SERVER_SUPS = mustSlice(SRC, /^function serverTriageSuppressions\(\) \{[\s\S]*?\n\}/m, "serverTriageSuppressions");
const BUILD = mustSlice(SRC, /^function buildTriage\(\) \{[\s\S]*?\n\}/m, "buildTriage");

// ── the third copy of the key ────────────────────────────────────────────────

test("the CLIENT key builder agrees with the server's, on every shape", () => {
  // triage-suppressions.js says a key that differs from the one mergeOpenItems builds
  // is a suppression that never matches, and dcc-intelligence.js imports the shared
  // function for exactly that reason. The browser cannot require() it, so
  // triageItemKeyFor is a hand-written third copy — and it is the one that MINTS the
  // `key` stored in every suppression row. If it drifts, the key arm of isSuppressed
  // silently stops matching and suppression quietly falls back to the bare-id arm
  // alone, which the module header explicitly says must not be relied on by itself.
  const clientKey = vm.runInNewContext("(" + KEY_FN + ")", {});
  const shapes = [
    { id: "gmail:19f3d0b61ba384a8", type: "email" },                                  // the live prod shape
    { id: "x1", source: "gmail", source_id: "19f3d0b61ba384a8", type: "email" },      // normalizer output
    { id: "only-id" },
    { title: "title only" },
    { source: "slack", type: "email", id: "a", source_id: "b" },                       // precedence
    {},
    null,
  ];
  for (const item of shapes) {
    assert.equal(clientKey(item), triageItemKey(item), "drift on " + JSON.stringify(item));
  }
});

// ── the Completed list ───────────────────────────────────────────────────────

function runBuildTriage({ initTriage = [], suppressedItems = [], dismissed = {} } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: "", textContent: "", querySelectorAll: () => [], parentNode: { insertBefore: () => {} } });
  const context = {
    console,
    INIT_TRIAGE: initTriage,
    __state: { date: "2026-08-06", triage: { suppressed_items: suppressedItems, resolved_items: [] } },
    scheduled: [],
    // Real escaper, not a stub: the escaping assertion below has to exercise what ships.
    DCC: { esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") },
    document: { getElementById: (id) => el(id), createElement: () => el("created"), querySelectorAll: () => [] },
    loadDismissed: () => dismissed,
    loadTriageParents: () => ({}),
    loadDeletedTriage: () => [],
    loadTriageScheduled: () => ({}),
    buildTriageCard: (i) => "<card>" + i.id + "</card>",
    notesButton: () => "",
    saveDismissed: () => {},
    removeTriageSuppression: async () => {},
    // buildTriage tail-calls the notification strip; not under test here.
    INIT_NOTIFICATIONS: [],
    buildNotifications: () => {},
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(SERVER_SUPS + "\n" + BUILD, context);
  context.buildTriage();
  return { completed: els["triage-completed"], count: els["triage-count"] };
}

test("an item handled in another tab still renders a Completed row with an Undo", () => {
  // It is gone from open_items (so gone from INIT_TRIAGE); the suppression record is
  // the only thing left to render it from.
  const { completed } = runBuildTriage({
    initTriage: [],
    suppressedItems: [
      { triage_id: "gmail:abc", title: "Re: discrepancies", reason: "done", note: "Replied", at: "2026-08-06T14:00:00Z" },
    ],
  });
  assert.match(completed.innerHTML, /data-undo-tri="gmail:abc"/, "Undo must survive losing the open item");
  assert.match(completed.innerHTML, /Re: discrepancies/);
  assert.match(completed.innerHTML, /Completed \(1\)/);
});

test("a 'deleted' suppression owes no Completed row, only a 'done' one does", () => {
  // The two reasons are not interchangeable: deleted means gone outright, done still
  // owes the user a way back.
  const { completed } = runBuildTriage({
    suppressedItems: [{ triage_id: "gmail:zap", title: "zapped", reason: "deleted", at: "2026-08-06T14:00:00Z" }],
  });
  assert.equal(/gmail:zap/.test(completed.innerHTML), false);
});

test("a suppressed item is not ALSO rendered as an open card", () => {
  const { completed } = runBuildTriage({
    initTriage: [{ id: "gmail:abc", title: "handled", priority: "high" }],
    suppressedItems: [{ triage_id: "gmail:abc", title: "handled", reason: "done", at: "2026-08-06T14:00:00Z" }],
  });
  assert.match(completed.innerHTML, /data-undo-tri="gmail:abc"/);
  assert.equal((completed.innerHTML.match(/gmail:abc/g) || []).length, 2, "one row: the data-tri-id and the data-undo-tri on it");
});

test("an item in INIT_TRIAGE and in suppressed_items renders ONCE, not twice", () => {
  // completed (local overlay) and completedRemote (server) are concatenated, so the
  // remote half must exclude anything INIT_TRIAGE already covers.
  const { completed } = runBuildTriage({
    initTriage: [{ id: "gmail:abc", title: "handled", priority: "low" }],
    dismissed: { "gmail:abc": { note: "local" } },
    suppressedItems: [{ triage_id: "gmail:abc", title: "handled", reason: "done", at: "2026-08-06T14:00:00Z" }],
  });
  assert.match(completed.innerHTML, /Completed \(1\)/, "not (2)");
});

test("the header count includes remote rows the section renders", () => {
  const { count } = runBuildTriage({
    initTriage: [{ id: "open:1", title: "still open", priority: "high" }],
    suppressedItems: [{ triage_id: "gmail:abc", title: "handled elsewhere", reason: "done", at: "2026-08-06T14:00:00Z" }],
  });
  assert.equal(count.textContent, "1 / 2", "a bare active count over a populated Completed block is a lie");
});

// ── escaping ─────────────────────────────────────────────────────────────────

test("a hostile title in a PERSISTED suppression is escaped, not executed", () => {
  // Triage titles are third-party text. Before suppressions this sink rendered only
  // within the tab that dismissed the item; now the value is stored server-side and
  // comes back on every device, every day, and there is no CSP behind it.
  const payload = '<img src=x onerror="alert(1)">';
  const { completed } = runBuildTriage({
    suppressedItems: [{ triage_id: "gmail:abc", title: payload, reason: "done", note: '"><script>bad()</script>', at: "2026-08-06T14:00:00Z" }],
  });
  assert.equal(completed.innerHTML.includes("<img src=x"), false, "raw tag reached innerHTML");
  assert.equal(completed.innerHTML.includes("<script>"), false, "raw script reached innerHTML");
  assert.match(completed.innerHTML, /&lt;img src=x/, "escaped, and still visible to the user");
});

test("a quote in a triage id cannot break out of the data attribute", () => {
  const { completed } = runBuildTriage({
    suppressedItems: [{ triage_id: 'a" onclick="bad()', title: "t", reason: "done", at: "2026-08-06T14:00:00Z" }],
  });
  assert.equal(completed.innerHTML.includes('onclick="bad()'), false);
  assert.match(completed.innerHTML, /&quot;/);
});
