// Account-scoped local journal records. A record and its pending mutation are
// one IndexedDB row; acknowledgements are conditional on the exact revision.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.JournalDrafts = api;
})(typeof window === "undefined" ? null : window, function () {
  "use strict";
  function create(owner, indexedDB = globalThis.indexedDB) {
    if (!String(owner || "").trim()) throw new Error("Journal owner required");
    // Encode the complete owner, avoiding collisions between account namespaces.
    const name = "dcc-library-journals-" + encodeURIComponent(String(owner));
    const database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "slug" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    async function transaction(mode, operation) {
      const db = await database;
      return new Promise((resolve, reject) => {
        const tx = db.transaction("records", mode),
          store = tx.objectStore("records");
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("Local journal transaction failed"));
        operation(store, (value) => {
          result = value;
        });
      });
    }
    const read = (slug) =>
      transaction("readonly", (s, done) => {
        const r = s.get(slug);
        r.onsuccess = () => done(r.result);
      });
    const list = () =>
      transaction("readonly", (s, done) => {
        const r = s.getAll();
        r.onsuccess = () => done(r.result);
      });
    const put = (record) =>
      transaction("readwrite", (s, done) => {
        s.put(record);
        done(record);
      });
    const edit = (record) =>
      transaction("readwrite", (s, done) => {
        const r = s.get(record.slug);
        r.onsuccess = () => {
          const current = r.result;
          const collided = current && record.revision !== current.revision;
          const copies = current?.localConflicts || [];
          const next = {
            ...record,
            hash: current?.hash || record.hash,
            conflict: collided
              ? "Another local or vault version changed. Both copies are kept."
              : current?.conflict || null,
            localConflicts: collided
              ? [
                  ...copies,
                  { body: current.body, frontmatter: current.frontmatter, hash: current.hash, updated: current.updated }
                ]
              : copies,
            pendingCreate: current?.pendingCreate ?? record.pendingCreate,
            revision: (current?.revision || 0) + 1,
            dirty: true,
            updated: Date.now()
          };
          s.put(next);
          done(next);
        };
      });
    const setBase = (slug, hash) =>
      transaction("readwrite", (s, done) => {
        const r = s.get(slug);
        r.onsuccess = () => {
          const current = r.result;
          if (!current) return done(null);
          const next = { ...current, hash, pendingCreate: false };
          s.put(next);
          done(next);
        };
      });
    async function acknowledge(slug, revision, hash) {
      if (!hash) throw new Error("Vault acknowledgement has no hash");
      return transaction("readwrite", (s, done) => {
        const r = s.get(slug);
        r.onsuccess = () => {
          const current = r.result;
          if (!current) return done(null);
          // Even an older accepted version advances the optimistic-lock base.
          // It may never clear newer pending ink.
          const next = {
            ...current,
            hash,
            dirty: current.revision !== revision,
            conflict: current.revision === revision ? null : current.conflict
          };
          s.put(next);
          done(next);
        };
      });
    }
    async function cache(node) {
      return transaction("readwrite", (s, done) => {
        const r = s.get(node.slug);
        r.onsuccess = () => {
          if (r.result?.dirty) return done(r.result);
          const next = {
            slug: node.slug,
            frontmatter: node.frontmatter,
            body: node.body || "",
            hash: node.hash,
            localConflicts: r.result?.localConflicts || [],
            revision: (r.result?.revision || 0) + (r.result && r.result.hash !== node.hash ? 1 : 0),
            dirty: false,
            updated: Date.now()
          };
          s.put(next);
          done(next);
        };
      });
    }
    async function markConflict(slug, message) {
      return transaction("readwrite", (s, done) => {
        const r = s.get(slug);
        r.onsuccess = () => {
          const current = r.result;
          if (!current) return done(null);
          const next = { ...current, conflict: message, dirty: true };
          s.put(next);
          done(next);
        };
      });
    }
    function resolve(slug, revision, remote) {
      return transaction("readwrite", (s, done) => {
        const r = s.get(slug);
        r.onsuccess = () => {
          const current = r.result;
          if (!current || current.revision !== revision || !remote.hash) {
            done(null);
            return;
          }
          const next = {
            ...current,
            hash: remote.hash,
            pendingCreate: false,
            conflict: null,
            dirty: true,
            revision: current.revision + 1,
            localConflicts: [
              ...(current.localConflicts || []),
              { body: remote.body, frontmatter: remote.frontmatter, hash: remote.hash, updated: Date.now() }
            ]
          };
          s.put(next);
          done(next);
        };
      });
    }
    return { read, list, put, edit, setBase, acknowledge, cache, markConflict, resolve };
  }
  return { create };
});
