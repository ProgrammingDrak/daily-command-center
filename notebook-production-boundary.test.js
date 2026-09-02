"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = __dirname;
const SHELL = fs.readFileSync(path.join(ROOT, "ink.html"), "utf8");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "public/js/ink/app.js"), "utf8");
const SYNC = fs.readFileSync(path.join(ROOT, "public/js/ink/sync.js"), "utf8");
const WORKER = fs.readFileSync(path.join(ROOT, "ink-sw.js"), "utf8");
const CANVAS = fs.readFileSync(path.join(ROOT, "public/js/ink/canvas.js"), "utf8");
const InkSync = require("./public/js/ink/sync.js");

test("production serves the notebook shell through the admin boundary", () => {
  assert.match(SERVER, /app\.get\(\["\/ink", "\/ink\.html"\], requireAdmin,/);
  assert.doesNotMatch(
    SERVER,
    /hasServiceToken\(req, "dcc"\)[^\n]*notebook-page-ingest|notebook-page-ingest[^\n]*hasServiceToken\(req, "dcc"\)/,
  );
});

test("notebook settings expose the existing deletion control", () => {
  assert.match(SHELL, /<button class="danger" id="bookDelete">Delete<\/button>/);
});

test("the browser partitions storage before opening it", () => {
  const configureAt = APP.indexOf("Store.configureOwner(owner)");
  const openAt = APP.indexOf("await Store.open()");
  assert.ok(configureAt >= 0 && openAt > configureAt);
  assert.match(APP, /fetch\("\/api\/me", \{ credentials: "same-origin", cache: "no-store" \}\)/);
});

test("sync sends stable identity and explicit OCR state", () => {
  assert.match(SYNC, /form\.append\("notebookId", notebook\.id\)/);
  assert.match(SYNC, /form\.append\("ocrStatus", record\.transcript \? "complete" : "pending"\)/);
  assert.match(SYNC, /form\.append\("ocrSource", record\.transcript \? "client" : "none"\)/);
});

test("the service worker excludes every API response", () => {
  assert.match(WORKER, /if \(url\.pathname\.startsWith\("\/api\/"\)\) return/);
  assert.match(WORKER, /response\.ok && !response\.redirected/);
});

test("the canvas module boots in a browser without CommonJS globals", () => {
  const browserScope = { InkStrokes: {} };
  vm.runInNewContext(CANVAS, { self: browserScope });
  assert.strictEqual(typeof browserScope.InkCanvas.create, "function");
});

test("blank-page acknowledgement cannot clear a newer local edit", async () => {
  const record = { id: "pg_1", notebookId: "nb_abcdefghijklmnop", data: "blank" };
  let reads = 0;
  let marked = null;
  const store = {
    dirtyPages: async () => (reads++ === 0 ? [record] : []),
    getNotebook: async () => ({ id: record.notebookId, title: "Test" }),
    hashOf: () => "sent-hash",
    markSynced: async (...args) => { marked = args; return true; },
  };
  const strokes = { deserialize: () => ({}), isBlank: () => true };
  await InkSync.create({ store, strokes }).syncNow();
  assert.deepStrictEqual(marked, [record.id, null, "sent-hash"]);
});
