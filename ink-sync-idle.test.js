"use strict";

// Writing must never wait for the network. Uploading a page renders 5.4
// megapixels and JPEG-encodes them on the main thread -- the pen's own thread --
// so these tests pin down WHEN that is allowed to happen. The bug they exist to
// prevent: app.js called syncNow() from the save path, which runs 700ms after
// every stroke, so the app synced continuously while being written in and the
// pen stalled.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const InkSync = require("./public/js/ink/sync.js");

const ROOT = __dirname;
const APP = fs.readFileSync(path.join(ROOT, "public/js/ink/app.js"), "utf8");
const SYNC = fs.readFileSync(path.join(ROOT, "public/js/ink/sync.js"), "utf8");
const CANVAS = fs.readFileSync(path.join(ROOT, "public/js/ink/canvas.js"), "utf8");

// Every scheduler created here must be stopped: `nudge` re-arms itself while
// busy, so a leaked one keeps the test runner's event loop alive forever.
const live = [];
const track = (s) => { live.push(s); return s; };
test.afterEach(() => { while (live.length) live.pop().stop(); });

function fakeStore(pages) {
  const remaining = pages.slice();
  return {
    uploads: [],
    dirtyPages: async () => remaining.slice(),
    getNotebook: async () => ({ id: "nb_abcdefghijklmnop", title: "Test" }),
    hashOf: () => "h",
    markSynced: async (id) => {
      const i = remaining.findIndex((p) => p.id === id);
      if (i >= 0) remaining.splice(i, 1);
      return true;
    },
  };
}

// Blank pages take the early-exit path, so they exercise the scheduler without
// needing a DOM canvas to render into.
const blankStrokes = { deserialize: () => ({}), isBlank: () => true };

test("the save path nudges and never calls syncNow directly", () => {
  const saveAt = APP.indexOf("async function savePage(");
  const end = APP.indexOf("async function goPage(", saveAt);
  const body = APP.slice(saveAt, end);
  assert.match(body, /sync\.nudge\(\)/);
  assert.doesNotMatch(body, /sync\.syncNow\(\)/);
});

test("no code path calls syncNow on every stroke", () => {
  // The only syncNow callers left are deliberate flushes inside sync.js itself.
  assert.doesNotMatch(APP, /sync\.syncNow\(\)/);
});

test("the periodic timer is nudged, so it cannot fire mid-sentence", () => {
  assert.match(SYNC, /setInterval\(\(\) => \{ if \(navigator\.onLine\) nudge\(0\); \}, 300000\)/);
});

test("the canvas exposes whether a stroke is in progress", () => {
  assert.match(CANVAS, /isPenDown: \(\) => state\.activePointer !== null/);
  assert.match(APP, /isBusy: \(\) => !!\(ink && ink\.isPenDown\(\)\)/);
});

test("nudge waits out the idle delay instead of syncing now", async () => {
  const store = fakeStore([{ id: "pg_1", notebookId: "nb_abcdefghijklmnop", data: "x" }]);
  const sync = track(InkSync.create({ store, strokes: blankStrokes }));
  sync.nudge(40);
  assert.strictEqual((await store.dirtyPages()).length, 1, "must not have synced yet");
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual((await store.dirtyPages()).length, 0, "should sync once idle");
});

test("each nudge pushes the sync further out, so continuous writing never syncs", async () => {
  const store = fakeStore([{ id: "pg_1", notebookId: "nb_abcdefghijklmnop", data: "x" }]);
  const sync = track(InkSync.create({ store, strokes: blankStrokes }));
  // Five "strokes" 30ms apart against a 70ms idle window: the window never
  // elapses, so nothing is uploaded while the writing continues.
  for (let i = 0; i < 5; i++) {
    sync.nudge(70);
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.strictEqual((await store.dirtyPages()).length, 1, "synced while still writing");
  await new Promise((r) => setTimeout(r, 140));
  assert.strictEqual((await store.dirtyPages()).length, 0, "should sync after the pen stops");
});

test("a pen that is down defers the sync rather than competing for the thread", async () => {
  const store = fakeStore([{ id: "pg_1", notebookId: "nb_abcdefghijklmnop", data: "x" }]);
  let penDown = true;
  const sync = track(InkSync.create({ store, strokes: blankStrokes, isBusy: () => penDown }));
  sync.nudge(30);
  await new Promise((r) => setTimeout(r, 90));
  assert.strictEqual((await store.dirtyPages()).length, 1, "uploaded while the pen was down");
  penDown = false;
  // The deferred path re-arms itself on BUSY_RECHECK_DELAY (4s), so prove the
  // recovery directly rather than waiting on that timer.
  await sync.syncNow();
  assert.strictEqual((await store.dirtyPages()).length, 0);
});

test("syncNow stops partway through a backlog when the pen comes down", async () => {
  const store = fakeStore([
    { id: "pg_1", notebookId: "nb_abcdefghijklmnop", data: "x" },
    { id: "pg_2", notebookId: "nb_abcdefghijklmnop", data: "y" },
  ]);
  let penDown = false;
  let seen = 0;
  const strokes = {
    deserialize: () => { seen++; if (seen === 1) penDown = true; return {}; },
    isBlank: () => true,
  };
  const sync = track(InkSync.create({ store, strokes, isBusy: () => penDown }));
  await sync.syncNow();
  // First page went through; the second was abandoned because writing resumed.
  assert.strictEqual((await store.dirtyPages()).length, 1);
});

test("a deferred page never counts as progress", async () => {
  // Guards the hot loop: `if (!out.stillDirty) progressed = true` would have
  // read a deferred result as progress and spun forever.
  const store = fakeStore([{ id: "pg_1", notebookId: "nb_abcdefghijklmnop", data: "x" }]);
  const sync = track(InkSync.create({ store, strokes: blankStrokes, isBusy: () => true }));
  await Promise.race([
    sync.syncNow(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("syncNow spun")), 500)),
  ]);
  assert.strictEqual((await store.dirtyPages()).length, 1);
});

test("hiding the tab flushes immediately, because the pen is provably idle", () => {
  assert.match(SYNC, /if \(document\.hidden\) syncNow\(\);\s*\n\s*else nudge\(\);/);
});
