"use strict";

// Notification dismissal used to be a total no-op, and for two independent reasons:
//
//   1. `saveNotifDismissed` returned before writing whenever every USE_BLOCKSTORE flag
//      was true, and index.html sets all eleven to true. The early return was a hand-off
//      to a blockstore path that was never built, so a click wrote nothing anywhere and
//      the row was back before it finished.
//   2. The key WRITTEN was never the key COMPARED. The write used
//      `(n.id || n.title || "")`, which is "" for an id-less row, while the filter
//      compared `includes(n.id || n.title)`, i.e. undefined. Real sweep-calendar
//      "[ACTION NEEDED]" payloads carry only `message`, so identity was undefined for
//      exactly the rows that mattered, and a shared "" would have collapsed them all
//      into one anyway.
//
// notifKey is now the single derivation both halves call. These tests pin that it is
// non-empty, stable, and discriminating for the id-less shape.

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

const HASH = mustSlice(SRC, / {2}function notifHash\(text\)\{[\s\S]*?\n {2}\}/, "notifHash");
const KEY = mustSlice(SRC, / {2}function notifKey\(n\)\{[\s\S]*?\n {2}\}/, "notifKey");

const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${HASH}\n${KEY}\nthis.__key = notifKey;`, ctx);
const notifKey = ctx.__key;

// The exact shape observed in data/state/archive: no id, no title, only a message.
const A = {
  source: "sweep-calendar",
  timestamp: "2026-08-18T09:30:00Z",
  message: "[ACTION NEEDED] Houzeo [BLOCK] meeting at 9:30 AM today -- myResponseStatus is needsAction",
};
const B = { ...A, timestamp: "2026-08-18T10:00:00Z", message: "[ACTION NEEDED] Second calendar item needs a response" };

test("an id-less notification still gets a non-empty key", () => {
  const k = notifKey(A);
  assert.ok(k, "the old derivation produced \"\" here");
  assert.notEqual(k, "");
  assert.match(k, /^nh:\d+$/);
});

test("the key is stable across renders", () => {
  assert.equal(notifKey(A), notifKey({ ...A }));
});

test("two id-less notifications do not collapse into one key", () => {
  // The old code gave both "" on write and undefined on compare, so dismissing either
  // one would have hidden both (had it written anything at all).
  assert.notEqual(notifKey(A), notifKey(B));
});

test("a message-only difference is enough to separate two keys", () => {
  assert.notEqual(notifKey(A), notifKey({ ...A, message: A.message + "!" }));
});

test("an explicit id always wins over the hash", () => {
  assert.equal(notifKey({ id: "notif-7", ...A }), "notif-7");
});

test("a null notification yields an empty key rather than throwing", () => {
  assert.equal(notifKey(null), "");
});

// ── the write path actually writes ───────────────────────────────────────────

test("saveNotifDismissed no longer returns early when every USE_BLOCKSTORE flag is set", () => {
  const fn = mustSlice(SRC, / {2}function saveNotifDismissed\(ids\)\{[\s\S]*?\n {2}\}/, "saveNotifDismissed");
  assert.ok(
    !/USE_BLOCKSTORE[\s\S]*?every\(/.test(fn),
    "the every(v=>v) early return is what made dismissal a no-op; it must not come back"
  );
  assert.ok(fn.includes("_bsSaveProp"), "must attempt the durable day_root write");
  assert.ok(fn.includes("localStorage"), "and keep localStorage as the offline fallback");
});

test("load and save agree on the storage key", () => {
  const load = mustSlice(SRC, / {2}function loadNotifDismissed\(\)\{[\s\S]*?\n {2}\}/, "loadNotifDismissed");
  const save = mustSlice(SRC, / {2}function saveNotifDismissed\(ids\)\{[\s\S]*?\n {2}\}/, "saveNotifDismissed");
  assert.ok(load.includes("NOTIF_DISMISS_PROP") && save.includes("NOTIF_DISMISS_PROP"));
  assert.ok(load.includes("NOTIF_DISMISS_KEY") && save.includes("NOTIF_DISMISS_KEY"));
});

test("the render path derives identity through notifKey, never the old id-or-title form", () => {
  const strip = SRC.slice(SRC.indexOf("const notifEl = document.getElementById"));
  assert.ok(!strip.includes('n.id || n.title'), "the drifting derivation must be gone from the strip");
  assert.ok((strip.match(/notifKey\(n\)/g) || []).length >= 3, "filters and both row maps use it");
});
