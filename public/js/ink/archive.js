// Mycelium Ink — archive: export, import, recovery.
//
// store.js says the device is the primary store and the vault is the backup.
// Until this file existed that was only half true: strokes could go TO the vault
// and nothing could come back, and there was no way to get a notebook out of
// IndexedDB at all. A cleared site-data action, an evicted origin or a lost
// device took the ink with it.
//
// An archive is one self-describing JSON file holding whole notebooks. Pages
// carry the v1 stroke object itself, not an escaped string, so the file opens in
// any text editor and the strokes are readable without this app — the same
// reason strokes.js is an open format in the first place.
//
// STRICTNESS IS THE POINT. deserialize() in strokes.js is deliberately total,
// because a corrupt local page must never make a notebook unopenable. Import is
// the opposite: it refuses the whole file rather than quietly landing a notebook
// with pages missing. A restore that silently drops pages is worse than one that
// fails, because you find out months later.
//
// This module is pure. It does no IO, touches no database and knows nothing
// about the DOM, so the round trip is testable without a browser.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InkArchive = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT = "mycelium-ink-archive";
  const VERSION = 1;

  // Must match routes/vault.js `notebookVaultSlug`, which hashes the notebook id
  // into the vault slug. An id that fails this can never sync, so restoring one
  // verbatim would produce a notebook that silently never reaches the vault.
  const NOTEBOOK_ID_RE = /^nb_[a-z0-9]{12,96}$/i;

  // Stored page data is the string strokes.js serialize() produced. Unpacking it
  // for the file keeps the archive one clean JSON tree instead of JSON inside a
  // JSON string. Anything unparseable rides along verbatim rather than being
  // dropped: an unreadable page is still someone's page.
  function unpackPageData(data) {
    if (data == null) return null;
    if (typeof data !== "string") return data;
    try { return JSON.parse(data); } catch { return data; }
  }

  function packPageData(data) {
    if (data == null) return null;
    if (typeof data === "string") return data;
    return JSON.stringify(data);
  }

  function finite(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
  }

  // ── export ─────────────────────────────────────────────────────────────────

  // entries: [{ notebook, pages }] exactly as the store hands them over.
  function build(entries, opts) {
    const o = opts || {};
    const list = Array.isArray(entries) ? entries : [];
    return {
      format: FORMAT,
      v: VERSION,
      exported: o.exported || new Date().toISOString(),
      notebooks: list
        .filter((e) => e && e.notebook)
        .map((e) => ({
          id: e.notebook.id,
          title: e.notebook.title,
          cover: e.notebook.cover || "slate",
          created: finite(e.notebook.created),
          updated: finite(e.notebook.updated),
          // Re-indexed from zero on the way out, so a shelf that has grown gaps
          // through page deletions exports as a contiguous notebook.
          pages: (e.pages || [])
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((p, i) => ({
              index: i,
              data: unpackPageData(p.data),
              transcript: p.transcript || "",
              updated: finite(p.updated),
            })),
        })),
    };
  }

  function serialize(archive) {
    // Indented, because a backup you cannot read in a text editor is a backup you
    // have to trust rather than check.
    return JSON.stringify(archive, null, 2);
  }

  function filename(archive, label) {
    const day = new Date(archive && archive.exported ? archive.exported : Date.now())
      .toISOString()
      .slice(0, 10);
    const slug = String(label || "shelf")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "notebook";
    return `mycelium-ink-${slug}-${day}.json`;
  }

  // ── import ─────────────────────────────────────────────────────────────────

  function parse(text) {
    let raw = text;
    if (typeof text === "string") {
      try { raw = JSON.parse(text); }
      catch { throw new Error("That file is not valid JSON."); }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("That file is not a notebook archive.");
    }
    if (raw.format !== FORMAT) {
      throw new Error("That file is not a notebook archive.");
    }
    const v = finite(raw.v);
    if (v == null || v < 1) throw new Error("That archive does not say what version it is.");
    // Refuse forward versions outright. Reading one on a best-effort basis is how
    // you import three quarters of a notebook and never notice the rest.
    if (v > VERSION) {
      throw new Error(`That archive was written by a newer version (v${v}) than this app can read.`);
    }
    if (!Array.isArray(raw.notebooks)) throw new Error("That archive has no notebook list.");

    const notebooks = raw.notebooks.map((nb, n) => {
      const where = `Notebook ${n + 1}`;
      if (!nb || typeof nb !== "object" || Array.isArray(nb)) throw new Error(`${where} in that archive is unreadable.`);
      if (!Array.isArray(nb.pages)) throw new Error(`${where} in that archive has no page list.`);
      const title = String(nb.title == null ? "" : nb.title).trim() || "Untitled";
      return {
        id: typeof nb.id === "string" && nb.id ? nb.id : null,
        title,
        cover: typeof nb.cover === "string" && nb.cover ? nb.cover : "slate",
        created: finite(nb.created),
        updated: finite(nb.updated),
        pages: nb.pages.map((p, i) => {
          if (!p || typeof p !== "object" || Array.isArray(p)) {
            throw new Error(`Page ${i + 1} of “${title}” is unreadable.`);
          }
          return {
            index: i,
            data: packPageData(p.data),
            transcript: String(p.transcript == null ? "" : p.transcript),
            updated: finite(p.updated),
          };
        }),
      };
    });

    return { format: FORMAT, v: VERSION, exported: raw.exported || null, notebooks };
  }

  // Decide what each archived notebook becomes locally, without writing anything.
  //
  // "restore" keeps the original notebook id when it is free, which is what makes
  // this recovery rather than duplication: the same id hashes to the same vault
  // slug, so a restored notebook keeps syncing into the node it already had
  // instead of forking a second copy of every page.
  //
  // An id already on this device is NEVER overwritten. That case degrades to a
  // copy under a new id and is reported, because silently merging two notebooks
  // that share an id is unrecoverable and asking is cheap.
  function plan(archive, opts) {
    const o = opts || {};
    const mode = o.mode === "copy" ? "copy" : "restore";
    const uid = typeof o.uid === "function" ? o.uid : null;
    const now = finite(o.now) == null ? Date.now() : Number(o.now);
    const taken = new Set(o.existingIds || []);

    return (archive && archive.notebooks ? archive.notebooks : []).map((nb) => {
      const collided = !!(nb.id && taken.has(nb.id));
      const restored = mode === "restore" && !!nb.id && NOTEBOOK_ID_RE.test(nb.id) && !collided;
      let id = nb.id;
      if (!restored) {
        if (!uid) throw new Error("importing a copy needs a uid generator");
        do { id = uid("nb"); } while (taken.has(id));
      }
      taken.add(id);
      return {
        id,
        sourceId: nb.id,
        restored,
        collided,
        // Labelled so a copy made by a collision is identifiable on the shelf
        // rather than sitting there as a second notebook with the same name.
        title: collided ? `${nb.title} (imported)` : nb.title,
        cover: nb.cover,
        created: nb.created == null ? now : nb.created,
        updated: nb.updated == null ? now : nb.updated,
        pages: nb.pages,
      };
    });
  }

  function summarize(planned) {
    const list = planned || [];
    return {
      notebooks: list.length,
      pages: list.reduce((n, item) => n + (item.pages ? item.pages.length : 0), 0),
      restored: list.filter((item) => item.restored).length,
      copied: list.filter((item) => !item.restored).length,
      collided: list.filter((item) => item.collided).length,
    };
  }

  return {
    FORMAT, VERSION, NOTEBOOK_ID_RE,
    build, serialize, filename,
    parse, plan, summarize,
    unpackPageData, packPageData,
  };
});
