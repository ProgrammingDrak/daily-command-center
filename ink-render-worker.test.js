"use strict";
/* global Blob */

// Rendering a page is 5.4 megapixels rasterised and JPEG-encoded. Scheduling it
// on the main thread only chooses when the pen stutters; a worker removes the
// stutter. Measured in Chromium: 275.3ms worst main-thread block inline versus
// 0.1ms via the worker, for a byte-identical JPEG.
//
// The worker is the easy half. These tests cover the half that breaks in the
// field: what happens when it is missing, broken, silent, or lying about what
// it encoded.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const InkSync = require("./public/js/ink/sync.js");
const WORKER = fs.readFileSync(path.join(__dirname, "public/js/ink/render-worker.js"), "utf8");
const SW = fs.readFileSync(path.join(__dirname, "ink-sw.js"), "utf8");

const live = [];
const track = (s) => { live.push(s); return s; };

// sync.js decides whether a worker is usable when create() runs, so the fakes
// have to be installed first and removed after.
const saved = {};
function installGlobals({ worker, offscreen = true, doc = true }) {
  for (const k of ["Worker", "OffscreenCanvas", "document"]) saved[k] = globalThis[k];
  if (worker) globalThis.Worker = worker; else delete globalThis.Worker;
  if (offscreen) globalThis.OffscreenCanvas = function () {}; else delete globalThis.OffscreenCanvas;
  if (doc) {
    globalThis.document = {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
          quadraticCurveTo() {}, arc() {}, stroke() {}, fill() {}, fillRect() {}, clearRect() {},
          setTransform() {},
        }),
        // The in-page encoder. Always succeeds, so a fallback is observable.
        toBlob: (cb) => cb(new Blob(["fallback-jpeg"], { type: "image/jpeg" })),
      }),
      addEventListener() {}, hidden: false,
    };
  } else delete globalThis.document;
}
function restoreGlobals() {
  for (const k of ["Worker", "OffscreenCanvas", "document"]) {
    if (saved[k] === undefined) delete globalThis[k];
    else globalThis[k] = saved[k];
  }
}

test.afterEach(() => {
  while (live.length) live.pop().stop();
  restoreGlobals();
});

// A page with a stroke on it, so uploads reach the render instead of the
// blank-page early exit.
const inkedStrokes = {
  deserialize: () => ({ w: 1275, h: 1650, strokes: [{ tool: "pen", pts: [0, 0, 0.5] }] }),
  isBlank: () => false,
  serialize: () => '{"v":1,"w":1275,"h":1650,"strokes":[]}',
  drawPage() {},
};

function fakeStore() {
  const remaining = [{ id: "pg_1", notebookId: "nb_abcdefghijklmnop", index: 0, data: "x", transcript: "" }];
  return {
    dirtyPages: async () => remaining.slice(),
    getNotebook: async () => ({ id: "nb_abcdefghijklmnop", title: "Test" }),
    hashOf: () => "h",
    markSynced: async (id) => { const i = remaining.findIndex((p) => p.id === id); if (i >= 0) remaining.splice(i, 1); return true; },
  };
}

// Records what was uploaded so a test can tell which renderer produced it.
function captureFetch() {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const image = init.body.get("image");
    seen.push({ url, type: image && image.type, size: image && image.size });
    return { ok: true, status: 200, json: async () => ({ slug: "notebooks/ink-x", page: 1 }) };
  };
  return seen;
}

// A fake Worker whose reply is scripted per test.
function workerClass(reply) {
  return class FakeWorker {
    constructor(url) { this.url = url; this.posted = []; FakeWorker.last = this; }
    postMessage(msg) {
      this.posted.push(msg);
      if (reply === "silent") return;
      if (reply === "throw") { setTimeout(() => this.onerror && this.onerror({ message: "boom" }), 0); return; }
      setTimeout(() => this.onmessage && this.onmessage({ data: Object.assign({ id: msg.id }, reply) }), 0);
    }
    terminate() { this.terminated = true; }
  };
}

test("the worker file imports the shared drawing code rather than reimplementing it", () => {
  // A second renderer would let a page look one way under the pen and another
  // way in the vault.
  assert.match(WORKER, /importScripts\("\/public\/js\/ink\/strokes\.js"\)/);
  assert.match(WORKER, /new OffscreenCanvas\(/);
  assert.match(WORKER, /convertToBlob\(\{ type: msg\.type \|\| "image\/jpeg", quality: msg\.quality \}\)/);
});

test("the worker reports the type it actually encoded", () => {
  // Safari does not throw on a format it cannot encode; it returns a PNG.
  assert.match(WORKER, /type: blob\.type/);
});

test("the offline shell precaches the worker", () => {
  assert.match(SW, /"\/public\/js\/ink\/render-worker\.js"/);
  assert.match(SW, /const CACHE = "mycelium-ink-shell-v\d+";/);
});

test("a page is rendered in the worker when one is available", async () => {
  const blob = new Blob(["worker-jpeg-bytes"], { type: "image/jpeg" });
  installGlobals({ worker: workerClass({ ok: true, blob, type: "image/jpeg" }) });
  const seen = captureFetch();
  const sync = track(InkSync.create({ store: fakeStore(), strokes: inkedStrokes }));
  await sync.syncNow();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].size, blob.size, "did not upload what the worker produced");
  assert.strictEqual(globalThis.Worker.last.url, "/public/js/ink/render-worker.js");
  assert.strictEqual(globalThis.Worker.last.posted[0].type, "image/jpeg");
});

test("a worker that encodes the wrong format is retired, and the page still uploads", async () => {
  // Safari's silent PNG. A PNG of this canvas is megabytes, so the in-page
  // encoder -- which does support JPEG -- has to take over.
  const png = new Blob(["png-bytes-much-larger"], { type: "image/png" });
  installGlobals({ worker: workerClass({ ok: true, blob: png, type: "image/png" }) });
  const seen = captureFetch();
  const sync = track(InkSync.create({ store: fakeStore(), strokes: inkedStrokes }));
  await sync.syncNow();
  assert.strictEqual(seen.length, 1, "page was not uploaded at all");
  assert.strictEqual(seen[0].type, "image/jpeg", "uploaded the worker's PNG instead of falling back");
  assert.ok(globalThis.Worker.last.terminated, "the bad worker was left running");
});

test("a worker that fails to start falls back instead of losing the page", async () => {
  installGlobals({ worker: workerClass("throw") });
  const seen = captureFetch();
  const sync = track(InkSync.create({ store: fakeStore(), strokes: inkedStrokes }));
  await sync.syncNow();
  assert.strictEqual(seen.length, 1, "a broken worker must not block the upload");
  assert.strictEqual(seen[0].type, "image/jpeg");
});

test("a worker that never answers does not strand the page forever", () => {
  // The timeout is what turns a silent worker into a retry rather than a page
  // stuck as permanently syncing.
  const SYNC = fs.readFileSync(path.join(__dirname, "public/js/ink/sync.js"), "utf8");
  assert.match(SYNC, /const WORKER_TIMEOUT_MS = \d+;/);
  assert.match(SYNC, /render worker timed out/);
});

test("no worker and no OffscreenCanvas still uploads, on the old path", async () => {
  installGlobals({ worker: null, offscreen: false });
  const seen = captureFetch();
  const sync = track(InkSync.create({ store: fakeStore(), strokes: inkedStrokes }));
  await sync.syncNow();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].type, "image/jpeg");
});

test("stopping the scheduler also terminates the worker", async () => {
  const blob = new Blob(["x"], { type: "image/jpeg" });
  installGlobals({ worker: workerClass({ ok: true, blob, type: "image/jpeg" }) });
  captureFetch();
  const sync = InkSync.create({ store: fakeStore(), strokes: inkedStrokes });
  await sync.syncNow();
  sync.stop();
  assert.ok(globalThis.Worker.last.terminated, "stop() left a worker running");
});
