"use strict";

// The assembled click path for notification dismissal, which is the half no unit test
// reached: render the strip -> fire the real dismiss handler -> assert the DURABLE write
// happened -> re-render and assert the row is actually filtered out.
//
// The existing triage-suppression-client.test.js harness deliberately stubs the strip out
// ("INIT_NOTIFICATIONS: []  // buildTriage tail-calls the notification strip; not under
// test here"). This file supplies the array and the handler plumbing instead, because the
// original defect was precisely that the write and the compare disagreed, which only an
// end-to-end round trip can catch.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./public/js/triage.js"), "utf8");

function mustSlice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found — the source moved or was renamed, fix the pattern");
  return m[0];
}
const BUILD = mustSlice(SRC, /^function buildTriage\(\) \{[\s\S]*?\n\}/m, "buildTriage");
const SERVER_SUPS = mustSlice(SRC, /^function serverTriageSuppressions\(\) \{[\s\S]*?\n\}/m, "serverTriageSuppressions");

// Two rows in the real sweep-calendar shape: no id, no title, message only.
const N1 = {
  source: "sweep-calendar",
  timestamp: "2026-08-18T09:30:00Z",
  message: "[ACTION NEEDED] Houzeo [BLOCK] meeting at 9:30 AM today",
  requires_approval: true,
};
const N2 = {
  source: "sweep-calendar",
  timestamp: "2026-08-18T10:00:00Z",
  message: "[ACTION NEEDED] Second calendar item needs a response",
};

// A day_root stand-in: the property bag _bsProp/_bsSaveProp read and write.
function makeWorld(notifications) {
  const dayRoot = {};
  const localStore = {};
  const handlers = { dismiss: [], restore: [] };

  const makeEl = () => {
    const el = { innerHTML: "", textContent: "", parentNode: { insertBefore: () => {} } };
    el.querySelectorAll = (sel) => {
      // Only the notification strip's two wiring loops matter here. Rebuild fake buttons
      // from whatever the render just wrote into innerHTML.
      const attr = sel.includes("notif-dismiss") ? "data-notif-dismiss" : "data-notif-restore";
      const found = [...el.innerHTML.matchAll(new RegExp(attr + '="([^"]*)"', "g"))].map((m) => m[1]);
      return found.map((val) => ({
        dataset: sel.includes("notif-dismiss") ? { notifDismiss: val } : { notifRestore: val },
        addEventListener: (_evt, fn) => {
          handlers[sel.includes("notif-dismiss") ? "dismiss" : "restore"].push({ val, fn });
        },
      }));
    };
    return el;
  };
  const els = {};
  const ctx = {
    console,
    INIT_TRIAGE: [],
    INIT_NOTIFICATIONS: notifications,
    __state: { date: "2026-08-18", triage: { suppressed_items: [], resolved_items: [] } },
    scheduled: [],
    DCC: { esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") },
    document: {
      getElementById: (id) => (els[id] = els[id] || makeEl()),
      createElement: () => makeEl(),
      querySelectorAll: () => [],
    },
    loadDismissed: () => ({}),
    loadTriageParents: () => ({}),
    loadDeletedTriage: () => [],
    loadTriageScheduled: () => ({}),
    currentTriageScheduled: () => ({}),
    buildTriageCard: (i) => "<card>" + i.id + "</card>",
    notesButton: () => "",
    saveDismissed: () => {},
    removeTriageSuppression: async () => {},
    // The durable day_root pair. Returning true is the real contract when blockStore is
    // available, and it is what must stop the localStorage fallback from also firing.
    _bsProp: (key, def) => (key in dayRoot ? dayRoot[key] : def),
    _bsSaveProp: (key, value) => { dayRoot[key] = value; return true; },
    localStorage: {
      getItem: (k) => (k in localStore ? localStore[k] : null),
      setItem: (k, v) => { localStore[k] = v; },
    },
    scheduleIDBSave: () => {},
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(SERVER_SUPS + "\n" + BUILD, ctx);
  return { ctx, els, dayRoot, localStore, handlers, render: () => { handlers.dismiss.length = 0; handlers.restore.length = 0; ctx.buildTriage(); } };
}

test("both id-less notifications render, each with its own dismiss key", () => {
  const w = makeWorld([N1, N2]);
  w.render();
  const html = w.els["triage-notifications"].innerHTML;
  const keys = [...html.matchAll(/data-notif-dismiss="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 2, "both rows rendered");
  assert.notEqual(keys[0], keys[1], "the old code gave both the same empty key");
  assert.ok(keys.every(Boolean), "and neither key is empty");
});

test("dismissing one row writes it durably and hides only that row", () => {
  const w = makeWorld([N1, N2]);
  w.render();
  const target = w.handlers.dismiss[0];
  target.fn({ stopPropagation() {} });

  // The durable half: this is what was writing nothing at all before.
  assert.ok(Array.isArray(w.dayRoot._notifDismissed), "must persist to the day_root property");
  assert.deepStrictEqual([...w.dayRoot._notifDismissed], [target.val]);
  assert.equal(Object.keys(w.localStore).length, 0, "durable write succeeded, so no localStorage fallback");

  // The compare half: re-render and confirm the write actually matches on read.
  const html = w.els["triage-notifications"].innerHTML;
  assert.ok(!html.includes('data-notif-dismiss="' + target.val + '"'), "dismissed row is gone");
  assert.match(html, /Dismissed notifications \(1\)/);
  const still = [...html.matchAll(/data-notif-dismiss="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(still.length, 1, "the OTHER row survives");
  assert.notEqual(still[0], target.val);
});

test("the dismissal survives a fresh render, which is the actual bug", () => {
  const w = makeWorld([N1, N2]);
  w.render();
  w.handlers.dismiss[0].fn({ stopPropagation() {} });
  const key = w.dayRoot._notifDismissed[0];
  w.render();   // stands in for a reload: state is re-read from the day_root
  const html = w.els["triage-notifications"].innerHTML;
  assert.ok(!html.includes('data-notif-dismiss="' + key + '"'), "must NOT come back");
  assert.match(html, /Dismissed notifications \(1\)/);
});

test("Restore puts the row back and clears the durable record", () => {
  const w = makeWorld([N1, N2]);
  w.render();
  w.handlers.dismiss[0].fn({ stopPropagation() {} });
  const key = w.dayRoot._notifDismissed[0];
  w.render();
  const restore = w.handlers.restore.find((h) => h.val === key);
  assert.ok(restore, "a Restore control is wired for the dismissed row");
  restore.fn({ stopPropagation() {} });
  assert.deepStrictEqual([...w.dayRoot._notifDismissed], [], "durable record cleared");
  const html = w.els["triage-notifications"].innerHTML;
  assert.ok(html.includes('data-notif-dismiss="' + key + '"'), "row is active again");
});

test("dismissing both rows leaves an empty active list, not a resurrected one", () => {
  const w = makeWorld([N1, N2]);
  w.render();
  w.handlers.dismiss[0].fn({ stopPropagation() {} });
  w.render();
  w.handlers.dismiss[0].fn({ stopPropagation() {} });
  w.render();
  assert.equal(w.dayRoot._notifDismissed.length, 2);
  const html = w.els["triage-notifications"].innerHTML;
  assert.equal([...html.matchAll(/data-notif-dismiss="([^"]*)"/g)].length, 0);
  assert.match(html, /Dismissed notifications \(2\)/);
});

test("a hostile notification title cannot inject markup into the strip", () => {
  const w = makeWorld([{ ...N1, message: '<img src=x onerror="alert(1)">' }]);
  w.render();
  const html = w.els["triage-notifications"].innerHTML;
  assert.ok(!html.includes("<img src=x"), "sweep-supplied text must be escaped");
  assert.ok(html.includes("&lt;img"), "and escaped in the visible form");
});

test("a javascript: link is refused rather than rendered as an href", () => {
  const w = makeWorld([{ ...N1, link: "javascript:alert(1)" }]);
  w.render();
  const html = w.els["triage-notifications"].innerHTML;
  assert.ok(!html.includes("javascript:"), "non-http(s) links must not reach the href");
  assert.ok(!html.includes("Review</a>"), "and the Review affordance is dropped entirely");
});

test("the localStorage fallback fires only when the durable write fails", () => {
  const w = makeWorld([N1, N2]);
  w.ctx._bsSaveProp = () => false;   // no blockStore, e.g. offline boot
  w.render();
  w.handlers.dismiss[0].fn({ stopPropagation() {} });
  assert.equal(w.dayRoot._notifDismissed, undefined, "nothing durable was written");
  assert.equal(Object.keys(w.localStore).length, 1, "so localStorage carried it instead");
});
