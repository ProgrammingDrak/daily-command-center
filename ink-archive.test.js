"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const Archive = require("./public/js/ink/archive.js");
const Strokes = require("./public/js/ink/strokes.js");

const ROOT = __dirname;
const SHELL = fs.readFileSync(path.join(ROOT, "ink.html"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "public/js/ink/app.js"), "utf8");
const STORE = fs.readFileSync(path.join(ROOT, "public/js/ink/store.js"), "utf8");
const WORKER = fs.readFileSync(path.join(ROOT, "ink-sw.js"), "utf8");

const NOTEBOOK_ID = "nb_m1abcdef01234567890a";

function inkPage(n) {
  const page = Strokes.emptyPage();
  const stroke = Strokes.newStroke("pen", "#1b1b2f", 2.6);
  Strokes.addPoint(stroke, 10 * n, 10, 0.5);
  Strokes.addPoint(stroke, 40 * n, 60, 0.7);
  Strokes.addPoint(stroke, 80 * n, 120, 0.4);
  page.strokes.push(stroke);
  return Strokes.serialize(page);
}

function entry(overrides) {
  return Object.assign({
    notebook: { id: NOTEBOOK_ID, title: "Morning pages", cover: "moss", created: 1000, updated: 2000 },
    pages: [
      { id: "pg_1", notebookId: NOTEBOOK_ID, index: 0, data: inkPage(1), transcript: "first", updated: 1500, dirty: 0 },
      { id: "pg_2", notebookId: NOTEBOOK_ID, index: 1, data: inkPage(2), transcript: "", updated: 1900, dirty: 1 },
    ],
  }, overrides);
}

function uidFactory() {
  let n = 0;
  return (prefix) => `${prefix}_fresh${String(++n).padStart(16, "0")}`;
}

// ── the round trip, which is the whole point ─────────────────────────────────

test("a notebook survives export, serialization and import unchanged", () => {
  const source = entry();
  const text = Archive.serialize(Archive.build([source]));
  const planned = Archive.plan(Archive.parse(text), { uid: uidFactory() });

  assert.strictEqual(planned.length, 1);
  const restored = planned[0];
  assert.strictEqual(restored.title, "Morning pages");
  assert.strictEqual(restored.cover, "moss");
  assert.strictEqual(restored.created, 1000);
  assert.strictEqual(restored.updated, 2000);
  assert.strictEqual(restored.pages.length, 2);
  // Byte-for-byte: the strokes that come back are the strokes that went in.
  assert.strictEqual(restored.pages[0].data, source.pages[0].data);
  assert.strictEqual(restored.pages[1].data, source.pages[1].data);
  assert.strictEqual(restored.pages[0].transcript, "first");
});

test("the exported file is readable without the app", () => {
  const text = Archive.serialize(Archive.build([entry()]));
  const raw = JSON.parse(text);
  // Strokes are a real object in the file, not JSON hidden inside a JSON string.
  const page = raw.notebooks[0].pages[0].data;
  assert.strictEqual(typeof page, "object");
  assert.strictEqual(page.v, Strokes.FORMAT_VERSION);
  assert.ok(Array.isArray(page.strokes) && page.strokes.length > 0);
  assert.ok(text.includes("\n"), "the archive is indented so it can be read");
});

test("a page nobody wrote on exports as null and comes back as null", () => {
  const source = entry({
    pages: [{ id: "pg_1", notebookId: NOTEBOOK_ID, index: 0, data: null, transcript: "", updated: 10 }],
  });
  const planned = Archive.plan(Archive.parse(Archive.serialize(Archive.build([source]))), { uid: uidFactory() });
  assert.strictEqual(planned[0].pages[0].data, null);
});

test("export closes gaps left by deleted pages", () => {
  const source = entry({
    pages: [
      { index: 4, data: inkPage(1), transcript: "", updated: 1 },
      { index: 9, data: inkPage(2), transcript: "", updated: 2 },
    ],
  });
  const archive = Archive.build([source]);
  assert.deepStrictEqual(archive.notebooks[0].pages.map((p) => p.index), [0, 1]);
});

test("export orders pages by index, not by the order it read them", () => {
  const source = entry({
    pages: [
      { index: 1, data: inkPage(2), transcript: "second", updated: 2 },
      { index: 0, data: inkPage(1), transcript: "first", updated: 1 },
    ],
  });
  const archive = Archive.build([source]);
  assert.deepStrictEqual(archive.notebooks[0].pages.map((p) => p.transcript), ["first", "second"]);
});

test("unreadable page data rides along instead of being dropped", () => {
  const source = entry({
    pages: [{ index: 0, data: "{not json at all", transcript: "", updated: 1 }],
  });
  const planned = Archive.plan(Archive.parse(Archive.serialize(Archive.build([source]))), { uid: uidFactory() });
  assert.strictEqual(planned[0].pages[0].data, "{not json at all");
});

// ── recovery identity ────────────────────────────────────────────────────────

test("restoring keeps the notebook id, so it syncs back into its own vault node", () => {
  const planned = Archive.plan(Archive.parse(Archive.serialize(Archive.build([entry()]))), {
    existingIds: [],
    uid: uidFactory(),
  });
  assert.strictEqual(planned[0].id, NOTEBOOK_ID);
  assert.strictEqual(planned[0].restored, true);
  assert.strictEqual(planned[0].collided, false);
});

test("an id already on this device is copied beside it, never over it", () => {
  const planned = Archive.plan(Archive.parse(Archive.serialize(Archive.build([entry()]))), {
    existingIds: [NOTEBOOK_ID],
    uid: uidFactory(),
  });
  assert.notStrictEqual(planned[0].id, NOTEBOOK_ID);
  assert.strictEqual(planned[0].restored, false);
  assert.strictEqual(planned[0].collided, true);
  assert.strictEqual(planned[0].title, "Morning pages (imported)");
  assert.strictEqual(planned[0].sourceId, NOTEBOOK_ID);
});

test("copy mode always takes a fresh id even when the original is free", () => {
  const planned = Archive.plan(Archive.parse(Archive.serialize(Archive.build([entry()]))), {
    existingIds: [],
    mode: "copy",
    uid: uidFactory(),
  });
  assert.notStrictEqual(planned[0].id, NOTEBOOK_ID);
  assert.strictEqual(planned[0].restored, false);
});

test("an id the vault route would reject is never restored verbatim", () => {
  // routes/vault.js hashes the notebook id into the vault slug and rejects
  // anything off-shape. Restoring one as-is would make a notebook that can never
  // sync, which is a silent failure rather than a loud one.
  const source = entry({ notebook: { id: "nb_short", title: "Bad id", cover: "slate", created: 1, updated: 2 } });
  const planned = Archive.plan(Archive.parse(Archive.serialize(Archive.build([source]))), {
    existingIds: [],
    uid: uidFactory(),
  });
  assert.notStrictEqual(planned[0].id, "nb_short");
  assert.strictEqual(planned[0].restored, false);
  assert.match(planned[0].id, Archive.NOTEBOOK_ID_RE);
});

test("two notebooks in one archive cannot collapse onto one id", () => {
  const archive = Archive.parse(Archive.serialize(Archive.build([entry(), entry()])));
  const planned = Archive.plan(archive, { existingIds: [], uid: uidFactory() });
  assert.notStrictEqual(planned[0].id, planned[1].id);
  assert.strictEqual(planned[0].restored, true);
  assert.strictEqual(planned[1].collided, true);
});

// ── refusing bad input, loudly ───────────────────────────────────────────────

test("a file that is not an archive is refused", () => {
  assert.throws(() => Archive.parse("not json"), /not valid JSON/);
  assert.throws(() => Archive.parse(JSON.stringify({ hello: "world" })), /not a notebook archive/);
  assert.throws(() => Archive.parse(JSON.stringify([1, 2, 3])), /not a notebook archive/);
});

test("an archive from a newer version is refused rather than half-read", () => {
  const archive = Archive.build([entry()]);
  archive.v = Archive.VERSION + 1;
  assert.throws(() => Archive.parse(JSON.stringify(archive)), /newer version/);
});

test("a notebook with no page list is refused instead of importing empty", () => {
  const archive = Archive.build([entry()]);
  delete archive.notebooks[0].pages;
  assert.throws(() => Archive.parse(JSON.stringify(archive)), /no page list/);
});

test("an unreadable page refuses the whole file", () => {
  const archive = Archive.build([entry()]);
  archive.notebooks[0].pages[1] = "just a string";
  assert.throws(() => Archive.parse(JSON.stringify(archive)), /Page 2 of/);
});

test("a nameless notebook imports as Untitled rather than failing", () => {
  const archive = Archive.build([entry()]);
  archive.notebooks[0].title = "   ";
  assert.strictEqual(Archive.parse(JSON.stringify(archive)).notebooks[0].title, "Untitled");
});

test("summarize counts what the person is about to be told", () => {
  const archive = Archive.parse(Archive.serialize(Archive.build([entry(), entry()])));
  const sum = Archive.summarize(Archive.plan(archive, { existingIds: [], uid: uidFactory() }));
  assert.deepStrictEqual(sum, { notebooks: 2, pages: 4, restored: 1, copied: 1, collided: 1 });
});

test("the export filename is safe and dated", () => {
  const archive = Archive.build([entry()], { exported: "2026-09-18T10:00:00.000Z" });
  assert.strictEqual(Archive.filename(archive, "Morning pages / 2026"), "mycelium-ink-morning-pages-2026-2026-09-18.json");
  assert.strictEqual(Archive.filename(archive, ""), "mycelium-ink-shelf-2026-09-18.json");
});

// ── wiring ───────────────────────────────────────────────────────────────────

test("imported pages are queued for the vault and never claim to be synced", () => {
  assert.match(STORE, /dirty: p\.data \? 1 : 0/);
  assert.match(STORE, /syncedHash: null/);
});

test("the restore writes pages before the notebook row", () => {
  const pagesAt = STORE.indexOf('await tx("pages", "readwrite", (s) => { for (const p of pages) s.put(p); });');
  const notebookAt = STORE.indexOf('await tx("notebooks", "readwrite", (s) => s.put(notebook));');
  assert.ok(pagesAt > 0 && notebookAt > pagesAt);
});

test("export flushes the pending local save first", () => {
  const exportAt = APP.indexOf("async function exportNotebooks(");
  const saveAt = APP.indexOf("await savePage();", exportAt);
  const readAt = APP.indexOf("await Store.exportEntries(", exportAt);
  assert.ok(saveAt > exportAt && readAt > saveAt);
});

test("the shelf offers export and import, and a notebook offers its own export", () => {
  assert.match(SHELL, /id="exportAllBtn">Export all<\/button>/);
  assert.match(SHELL, /id="importBtn">Import<\/button>/);
  assert.match(SHELL, /id="bookMenuExport" role="menuitem">Export<\/button>/);
  assert.match(SHELL, /<input type="file" id="importFile" accept="application\/json,\.json" hidden>/);
  assert.match(SHELL, /<script src="\/public\/js\/ink\/archive\.js"><\/script>/);
});

test("a failed import does not claim the device is untouched once writing began", () => {
  assert.match(APP, /let writing = false;/);
  assert.match(APP, /writing = true;\s*\n\s*await Store\.importNotebooks\(planned\);/);
  assert.match(APP, /Nothing on this device was changed\./);
});

test("the offline shell caches the archive module", () => {
  assert.match(WORKER, /"\/public\/js\/ink\/archive\.js"/);
  // The precache list changed, so the old cache must not be reused.
  assert.match(WORKER, /const CACHE = "mycelium-ink-shell-v2";/);
});

test("the archive module loads in a browser without CommonJS globals", () => {
  const vm = require("node:vm");
  const scope = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "public/js/ink/archive.js"), "utf8"), { self: scope });
  assert.strictEqual(typeof scope.InkArchive.build, "function");
  assert.strictEqual(typeof scope.InkArchive.parse, "function");
});

test("the local schema is untouched, so portability lands before any migration", () => {
  assert.match(STORE, /const DB_PREFIX = "mycelium-ink";/);
  assert.match(STORE, /const DB_VERSION = 1;/);
});
