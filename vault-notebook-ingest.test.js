"use strict";

// End-to-end for the Mycelium Ink page sync. The pure projection is covered in
// vault-notebook-page.test.js; this drives the real endpoint against a real
// VaultStore and asserts what actually lands on disk.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const express = require("express");
const matter = require("gray-matter");

const VaultStore = require("./vault-store");
const mountVault = require("./routes/vault");

const FormDataCtor = globalThis.FormData;
const BlobCtor = globalThis.Blob;

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function startVault() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dcc-notebook-ingest-"));
  const vault = new VaultStore({ vaultDir: dir });
  await vault.init();
  const app = express();
  app.use(express.json());
  mountVault(app, {
    vault,
    syncMgr: null,
    VAULT_REPO_URL: "",
    VAULT_SENSITIVE_PIN: "",
    getTodayStr: () => "2026-08-25",
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    dir, vault,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await vault.close();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

// `ink` varies per call so an "edit" produces genuinely different bytes,
// which is exactly the case that content-hash dedup alone would get wrong.
function pageForm({ ink = "strokes-v1", page = 1, transcript = "hello", notebook = "Morning Pages", extra = {}, inkName = "page.json", inkMime = "application/json", imgName = "page.png", imgMime = "image/png" } = {}) {
  const form = new FormDataCtor();
  form.append("ink", new BlobCtor([Buffer.from(ink)], { type: inkMime }), inkName);
  form.append("image", new BlobCtor([PNG], { type: imgMime }), imgName);
  form.append("notebookTitle", notebook);
  form.append("pageNumber", String(page));
  form.append("transcript", transcript);
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  return form;
}

const post = (base, form) => fetch(`${base}/api/vault/notebook-page-ingest`, { method: "POST", body: form });

async function readNode(dir, slug) {
  return matter(await fsp.readFile(path.join(dir, `${slug}.md`), "utf8"));
}

test("first page creates the notebook node and stores both blobs", async () => {
  const h = await startVault();
  try {
    const res = await post(h.base, pageForm({ transcript: "Morning pages. Ink first, filing later." }));
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.strictEqual(body.slug, "notebooks/morning-pages");
    assert.strictEqual(body.created, true);
    assert.strictEqual(body.deduplicated, false);

    const node = await readNode(h.dir, "notebooks/morning-pages");
    assert.strictEqual(node.data.type, "notebook");
    assert.strictEqual(node.data.title, "Morning Pages");
    assert.strictEqual(node.data.pages.length, 1);
    assert.strictEqual(node.data.pages[0].page, 1);
    assert.match(node.content, /^## Page 1$/m);
    assert.match(node.content, /Ink first, filing later/);
    assert.match(node.content, /Hand edits will be lost/);

    // Both blobs are on disk, not just referenced.
    const blobs = await fsp.readdir(path.join(h.dir, "media", "blobs", "2026"));
    assert.strictEqual(blobs.length, 2, `expected ink + image, got ${blobs.join(", ")}`);
    assert.ok(blobs.some((f) => f.endsWith(".json")), "ink strokes must be stored");
    assert.ok(blobs.some((f) => f.endsWith(".png")), "page image must be stored");
  } finally { await h.close(); }
});

test("a second page appends without disturbing the first", async () => {
  const h = await startVault();
  try {
    await post(h.base, pageForm({ page: 1, ink: "s1", transcript: "page one" }));
    const res = await post(h.base, pageForm({ page: 2, ink: "s2", transcript: "page two" }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).created, false);

    const node = await readNode(h.dir, "notebooks/morning-pages");
    assert.deepStrictEqual(node.data.pages.map((p) => p.page), [1, 2]);
    assert.match(node.content, /page one/);
    assert.match(node.content, /page two/);
  } finally { await h.close(); }
});

test("re-posting the identical page dedups instead of writing again", async () => {
  const h = await startVault();
  try {
    await post(h.base, pageForm({ ink: "same", transcript: "once" }));
    const before = await readNode(h.dir, "notebooks/morning-pages");

    const res = await post(h.base, pageForm({ ink: "same", transcript: "once" }));
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.deduplicated, true);
    assert.strictEqual(body.created, false);

    const after = await readNode(h.dir, "notebooks/morning-pages");
    assert.strictEqual(after.content, before.content, "a retry must not rewrite the node");
    assert.strictEqual(after.data.pages.length, 1);
    assert.strictEqual(after.content.match(/^## Page 1$/gm).length, 1);
  } finally { await h.close(); }
});

test("editing a page replaces its section rather than appending a duplicate", async () => {
  const h = await startVault();
  try {
    await post(h.base, pageForm({ page: 1, ink: "draft", transcript: "the draft line" }));
    await post(h.base, pageForm({ page: 2, ink: "s2", transcript: "page two" }));

    // Same page number, genuinely different ink: this is the case that breaks
    // a content-hash-only design.
    const res = await post(h.base, pageForm({ page: 1, ink: "revised", transcript: "the revised line" }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).deduplicated, false);

    const node = await readNode(h.dir, "notebooks/morning-pages");
    assert.strictEqual(node.content.match(/^## Page 1$/gm).length, 1, "page 1 must appear exactly once");
    assert.match(node.content, /the revised line/);
    assert.ok(!/the draft line/.test(node.content), "superseded text must be gone");
    assert.deepStrictEqual(node.data.pages.map((p) => p.page), [1, 2]);
    assert.strictEqual(node.data.pages.filter((p) => p.page === 1).length, 1);
  } finally { await h.close(); }
});

test("pages sync out of order and still read in order", async () => {
  const h = await startVault();
  try {
    for (const n of [3, 1, 10, 2]) {
      await post(h.base, pageForm({ page: n, ink: `s${n}`, transcript: `p${n}` }));
    }
    const node = await readNode(h.dir, "notebooks/morning-pages");
    const order = [...node.content.matchAll(/^## Page (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepStrictEqual(order, [1, 2, 3, 10]);
    assert.deepStrictEqual(node.data.pages.map((p) => p.page), [1, 2, 3, 10]);
  } finally { await h.close(); }
});

test("a page with only a diagram is accepted and flagged, not rejected", async () => {
  const h = await startVault();
  try {
    const res = await post(h.base, pageForm({ transcript: "", extra: { inkGap: "0.62" } }));
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await res.json()).partial, true);

    const node = await readNode(h.dir, "notebooks/morning-pages");
    assert.match(node.content, /_No recognized text on this page\._/);
    assert.match(node.content, /not recognized/);
    assert.strictEqual(node.data.pages[0].ocr_partial, true);
  } finally { await h.close(); }
});

test("separate notebooks stay separate nodes", async () => {
  const h = await startVault();
  try {
    await post(h.base, pageForm({ notebook: "Morning Pages", ink: "a" }));
    await post(h.base, pageForm({ notebook: "Work Notes", ink: "b" }));
    assert.ok((await readNode(h.dir, "notebooks/morning-pages")).data);
    assert.ok((await readNode(h.dir, "notebooks/work-notes")).data);
  } finally { await h.close(); }
});

test("malformed uploads are refused before anything is written", async () => {
  const h = await startVault();
  try {
    const cases = [
      ["missing ink", (() => { const f = new FormDataCtor(); f.append("image", new BlobCtor([PNG], { type: "image/png" }), "p.png"); f.append("notebookTitle", "N"); f.append("pageNumber", "1"); return f; })(), /ink strokes required/],
      ["missing image", (() => { const f = new FormDataCtor(); f.append("ink", new BlobCtor([Buffer.from("s")], { type: "application/json" }), "p.json"); f.append("notebookTitle", "N"); f.append("pageNumber", "1"); return f; })(), /page image required/],
      ["image mime mismatch", pageForm({ imgName: "p.png", imgMime: "text/plain" }), /JPEG or PNG/],
      ["ink is not a stroke file", pageForm({ inkName: "p.txt", inkMime: "text/plain" }), /stroke file/],
      ["no notebook title", pageForm({ notebook: "   " }), /notebookTitle required/],
      ["page zero", pageForm({ page: 0 }), /pageNumber/],
    ];
    for (const [label, form, pattern] of cases) {
      const res = await post(h.base, form);
      assert.strictEqual(res.status, 400, `${label}: expected 400, got ${res.status}`);
      assert.match((await res.json()).error, pattern, label);
    }
    // Nothing was created by any of the rejected requests.
    await assert.rejects(() => fsp.access(path.join(h.dir, "notebooks")));
  } finally { await h.close(); }
});
