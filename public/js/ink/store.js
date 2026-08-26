// Mycelium Ink — local store.
//
// The device is the primary store and the vault is the backup, not the other way
// around. You must be able to open a notebook and write on a plane, so nothing
// in the writing path is allowed to touch the network.
//
// IndexedDB, because strokes are far too big for localStorage (which is ~5MB and
// synchronous, so writing a page would jank the pen).
//
// SYNC STATE lives on the page row itself, as `dirty` plus the hash of what was
// last accepted by the server. That gives coalescing for free: edit one page
// fifty times offline and there is still exactly one row to send, because the row
// IS the page. A separate outbox table would need a partial unique index to
// achieve the same thing.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InkStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DB_NAME = "mycelium-ink";
  const DB_VERSION = 1;

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notebooks")) {
          db.createObjectStore("notebooks", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("pages")) {
          const pages = db.createObjectStore("pages", { keyPath: "id" });
          // Every read is "the pages of one notebook, in order".
          pages.createIndex("byNotebook", ["notebookId", "index"], { unique: false });
          // The sync loop asks only for what still needs sending.
          pages.createIndex("byDirty", "dirty", { unique: false });
        }
        void e;
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      // Resolve on transaction completion, not on request success: the write is
      // not durable until the transaction commits, and resolving early would let
      // the UI claim "saved" for data that can still be rolled back.
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      out = fn(s, t);
      if (out && typeof out.then === "function") {
        throw new Error("tx callback must be synchronous; IndexedDB transactions auto-close");
      }
    }));
  }

  function reqAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getAll(store, query) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, "readonly");
      const req = query ? t.objectStore(store).index(query.index).getAll(query.range) : t.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function uid(prefix) {
    // crypto.randomUUID is unavailable on older Safari and on plain-http origins.
    const rand = (globalThis.crypto && crypto.getRandomValues)
      ? Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("")
      : Math.random().toString(16).slice(2).padEnd(16, "0");
    return `${prefix}_${Date.now().toString(36)}${rand}`;
  }

  // ── notebooks ──────────────────────────────────────────────────────────────

  async function createNotebook(title, cover) {
    const now = Date.now();
    const nb = { id: uid("nb"), title: String(title || "Untitled").trim() || "Untitled", cover: cover || "slate", created: now, updated: now };
    await tx("notebooks", "readwrite", (s) => s.put(nb));
    // A notebook always opens on a page. An empty shelf item you have to
    // "add a page" to before writing is one tap between you and the pen.
    await addPage(nb.id, 0);
    return nb;
  }

  async function listNotebooks() {
    const all = await getAll("notebooks");
    return all.sort((a, b) => b.updated - a.updated);
  }

  function getNotebook(id) {
    return open().then((db) => reqAsPromise(db.transaction("notebooks", "readonly").objectStore("notebooks").get(id)));
  }

  async function renameNotebook(id, title) {
    const nb = await getNotebook(id);
    if (!nb) return null;
    nb.title = String(title || "").trim() || nb.title;
    nb.updated = Date.now();
    await tx("notebooks", "readwrite", (s) => s.put(nb));
    return nb;
  }

  async function deleteNotebook(id) {
    const pages = await listPages(id);
    await tx("pages", "readwrite", (s) => { for (const p of pages) s.delete(p.id); });
    await tx("notebooks", "readwrite", (s) => s.delete(id));
  }

  async function touchNotebook(id) {
    const nb = await getNotebook(id);
    if (!nb) return;
    nb.updated = Date.now();
    await tx("notebooks", "readwrite", (s) => s.put(nb));
  }

  // ── pages ──────────────────────────────────────────────────────────────────

  async function addPage(notebookId, index) {
    const pages = await listPages(notebookId);
    const at = index == null ? pages.length : index;
    const page = {
      id: uid("pg"),
      notebookId,
      index: at,
      data: null,          // serialized strokes; null means never written on
      updated: Date.now(),
      dirty: 0,            // 0/1 rather than boolean: IndexedDB cannot index booleans
      syncedHash: null,
      transcript: "",
    };
    await tx("pages", "readwrite", (s) => s.put(page));
    return page;
  }

  async function listPages(notebookId) {
    const all = await getAll("pages", {
      index: "byNotebook",
      range: IDBKeyRange.bound([notebookId, -Infinity], [notebookId, Infinity]),
    });
    return all.sort((a, b) => a.index - b.index);
  }

  function getPage(id) {
    return open().then((db) => reqAsPromise(db.transaction("pages", "readonly").objectStore("pages").get(id)));
  }

  // Marking dirty is the ONLY way a page enters the sync queue, and it happens
  // on every save. A page cannot be silently left behind.
  async function savePage(id, serialized, transcript) {
    const page = await getPage(id);
    if (!page) return null;
    page.data = serialized;
    if (transcript != null) page.transcript = transcript;
    page.updated = Date.now();
    page.dirty = 1;
    await tx("pages", "readwrite", (s) => s.put(page));
    await touchNotebook(page.notebookId);
    return page;
  }

  async function deletePage(id) {
    const page = await getPage(id);
    if (!page) return;
    const siblings = (await listPages(page.notebookId)).filter((p) => p.id !== id);
    siblings.forEach((p, i) => { p.index = i; });
    await tx("pages", "readwrite", (s) => {
      s.delete(id);
      for (const p of siblings) s.put(p);
    });
  }

  // ── sync bookkeeping ───────────────────────────────────────────────────────

  function dirtyPages() {
    return getAll("pages", { index: "byDirty", range: IDBKeyRange.only(1) });
  }

  // Clearing `dirty` is conditional on the content not having moved. Without the
  // hash check, a page edited WHILE its upload was in flight would be marked
  // clean and those strokes would never reach the vault.
  async function markSynced(id, hash, expectHash) {
    const page = await getPage(id);
    if (!page) return false;
    if (expectHash != null && hashOf(page.data) !== expectHash) return false;
    page.dirty = 0;
    page.syncedHash = hash;
    await tx("pages", "readwrite", (s) => s.put(page));
    return true;
  }

  // FNV-1a. Not a security hash: it only has to notice that a page changed
  // while an upload was in flight, and it must run on every browser without
  // async crypto in the middle of a save.
  function hashOf(text) {
    if (text == null) return "0";
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  async function stats() {
    const [notebooks, dirty] = await Promise.all([listNotebooks(), dirtyPages()]);
    return { notebooks: notebooks.length, unsynced: dirty.length };
  }

  return {
    open, uid, hashOf,
    createNotebook, listNotebooks, getNotebook, renameNotebook, deleteNotebook,
    addPage, listPages, getPage, savePage, deletePage,
    dirtyPages, markSynced, stats,
    _tx: tx,
  };
});
