// Journal task pages: the on-device copy. Local-first, like Mycelium Ink's store.
//
// One IndexedDB database per DCC account (workspace + user), so a second account
// signing in on the same browser never opens the first account's pages. Records
// are keyed by the task's stable journalId, never by a date or a list position.
//
// Record: { journalId, taskId, ink, body, localRev, baseRevision, dirty,
//           mutationId, updatedAt, conflict, drafts, recoveries, owner }
//   localRev      version of the content on this device (see saveEdit)
//   baseRevision  the server revision the CURRENT content is based on
//   mutationId    identifies THIS content; a new edit mints a new one, a retry
//                 of the same content reuses it so the server can deduplicate
//
// Every edit is ONE read-modify-write transaction that writes content, dirty and
// the new mutationId together, and it resolves only on transaction complete.
// A rejected promise means the edit is NOT on this device; callers must say so.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JournalPageStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const DB_VERSION = 1;
  const STORE = "pages";
  const META = "meta";
  const MAX_PAGE_BYTES = 2 * 1024 * 1024;   // same cap the server validator enforces

  // The namespace is the account itself, written out losslessly. A hash here once
  // let two different accounts share a database (a 32-bit collision); an injective
  // name plus the owner stamped in the database and on every record rules that out.
  function ownerKey(account) {
    if (!account || !Number.isSafeInteger(account.userId) || account.userId < 0
        || typeof account.workspaceId !== "string" || !account.workspaceId) throw new Error("A signed-in account is required");
    return "u" + account.userId + ":" + encodeURIComponent(account.workspaceId);
  }
  function dbName(account) { return "dcc-journal:v1:" + ownerKey(account); }
  function foreign() { return Object.assign(new Error("This on-device journal belongs to another account"), { code: "OWNER_MISMATCH" }); }

  // Minimal transactional backend over IndexedDB. update() runs fn inside one
  // readwrite transaction and resolves with fn's result only after oncomplete.
  // The database records which account owns it and refuses to open for another.
  function idbBackend(idb, name, owner) {
    let opening = null;
    function open() {
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        if (!idb) { opening = null; reject(new Error("This browser has no on-device storage")); return; }
        const req = idb.open(name, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "journalId" });
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); opening = null; };
          const tx = db.transaction(META, "readwrite"), os = tx.objectStore(META);
          let mismatch = false;
          const r = os.get("owner");
          r.onsuccess = () => {
            if (!r.result) os.put({ key: "owner", owner });
            else if (r.result.owner !== owner) mismatch = true;
          };
          tx.oncomplete = () => { if (mismatch) { db.close(); opening = null; reject(foreign()); } else resolve(db); };
          tx.onerror = tx.onabort = () => { opening = null; reject(tx.error || new Error("Could not open on-device journal storage")); };
        };
        req.onerror = () => { opening = null; reject(req.error || new Error("Could not open on-device journal storage")); };
        req.onblocked = () => { opening = null; reject(new Error("On-device journal storage is blocked by another tab")); };
      });
      return opening;
    }
    function run(mode, body) {
      return open().then(db => new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(STORE, mode); } catch (e) { opening = null; reject(e); return; }
        const os = tx.objectStore(STORE);
        let out, failure = null;
        // An error raised inside a request callback aborts the transaction; report
        // that error rather than the generic abort.
        const fail = e => { failure = e; try { tx.abort(); } catch { /* already finished */ } };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(failure || tx.error || new Error("On-device save failed"));
        tx.onabort = () => reject(failure || tx.error || new Error("On-device save was aborted"));
        try { body(os, value => { out = value; }, fail); } catch (e) { fail(e); }
      }));
    }
    return {
      read(key) {
        return run("readonly", (os, set) => { const r = os.get(key); r.onsuccess = () => set(r.result || null); });
      },
      list() {
        return run("readonly", (os, set) => { const r = os.getAll(); r.onsuccess = () => set(r.result || []); });
      },
      update(key, fn) {
        return run("readwrite", (os, set, fail) => {
          const r = os.get(key);
          r.onsuccess = () => {
            try {
              const next = fn(r.result || null);
              if (next) os.put(next);
              set(next || r.result || null);
            } catch (e) { fail(e); }
          };
        });
      },
    };
  }

  function randomId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }
  function newJournalId() { return "jr_" + randomId(); }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  // The canvas keeps a captured pointer's coordinates even far off the page. The
  // server rejects points beyond one page-width/height outside the paper, so clamp
  // those invisible tails here instead of letting one stroke block every sync.
  function clampInk(page) {
    const out = clone(page);
    if (!out || !Array.isArray(out.strokes) || !(out.w > 0) || !(out.h > 0)) return out;
    for (const stroke of out.strokes) {
      const pts = stroke && stroke.pts;
      if (!Array.isArray(pts)) continue;
      for (let i = 0; i + 1 < pts.length; i += 3) {
        pts[i] = Math.min(out.w * 2, Math.max(-out.w, pts[i]));
        pts[i + 1] = Math.min(out.h * 2, Math.max(-out.h, pts[i + 1]));
      }
    }
    return out;
  }

  // Reject what the server would reject before it becomes the durable local copy:
  // an unknown stroke-format version must not be silently "upgraded" by editing,
  // and an oversized page must fail visibly here rather than on every sync.
  function checkPage(page) {
    if (page == null) return;
    if (!page || page.v !== 1 || !Array.isArray(page.strokes)) throw Object.assign(new Error("This page uses a stroke format this version of DCC cannot edit"), { code: "INK_VERSION" });
    if (JSON.stringify(page).length > MAX_PAGE_BYTES) throw Object.assign(new Error("This page is too large to save (2 MB limit)"), { code: "INK_TOO_LARGE" });
  }

  function create(options) {
    const opts = options || {};
    const owner = ownerKey(opts.account);
    const raw = opts.backend || idbBackend(opts.indexedDB || (typeof indexedDB !== "undefined" ? indexedDB : null), dbName(opts.account), owner);
    const now = opts.now || (() => new Date().toISOString());
    const makeId = opts.makeId || randomId;
    // Every record carries its owner; a record from another account is never
    // returned, listed or overwritten even if it were somehow present.
    const backend = {
      read: key => raw.read(key).then(r => { if (r && r.owner !== owner) throw foreign(); return r; }),
      list: () => raw.list().then(rows => rows.filter(r => r && r.owner === owner)),
      update: (key, fn) => raw.update(key, cur => {
        if (cur && cur.owner !== owner) throw foreign();
        const next = fn(cur);
        return next ? Object.assign(next, { owner }) : next;
      }),
    };

    function load(journalId) { return backend.read(journalId); }
    function listDirty() { return backend.list().then(rows => rows.filter(r => r && r.dirty)); }

    // ── task binding ────────────────────────────────────────────────────────
    // A page is bound to ONE task, identified by every id that task is known by
    // (its local id before the server acknowledges it, its server id after).
    // Pages are keyed by journalId, so if two tasks ever carried one journalId
    // (a copy, a concurrent create, a legacy duplicate) this binding is what keeps
    // one task from reading, writing or syncing the other's page. Ids only ever
    // join a binding when they overlap it; a disjoint set is a different task.
    function boundKeys(rec) { return rec ? (Array.isArray(rec.taskKeys) && rec.taskKeys.length ? rec.taskKeys : (rec.taskId ? [rec.taskId] : [])) : []; }
    function keysFrom(edit) { return (Array.isArray(edit.taskKeys) && edit.taskKeys.length ? edit.taskKeys : (edit.taskId ? [edit.taskId] : [])).filter(Boolean); }
    function overlaps(a, b) { return a.some(k => b.includes(k)); }
    function union(a, b) { return Array.from(new Set(a.concat(b))); }
    function mismatch() { return Object.assign(new Error("This journal page belongs to a different task on this device. Nothing was opened or changed."), { code: "TASK_MISMATCH" }); }
    function checkBinding(cur, keys) {
      const bound = boundKeys(cur);
      if (bound.length && keys.length && !overlaps(bound, keys)) throw mismatch();
      return union(bound, keys);
    }
    function belongsTo(rec, keys) { const bound = boundKeys(rec); return !bound.length || overlaps(bound, keys); }
    // Learn another id for the SAME task (local -> server remap). Disjoint ids are refused.
    function bindKeys(journalId, keys) {
      return backend.update(journalId, cur => cur && Object.assign({}, cur, { taskKeys: checkBinding(cur, keys.filter(Boolean)) }));
    }

    // ── the revision contract ───────────────────────────────────────────────
    // `localRev` is the version of the CONTENT (ink + body) on this device. It
    // changes whenever content changes -- a user edit, a newer server copy, a
    // conflict or recovery choice -- and never on acknowledgements. An editor
    // shows one content version and must name it when saving. A save naming an
    // older version is a stale whole-page snapshot (another tab saved, or a newer
    // server copy arrived while the pen was down): it must NOT replace content it
    // never displayed, and it must NOT inherit that content's baseRevision.
    // Instead it is kept durably in `drafts` and the user chooses.
    // Drafts and recovery copies have NO retention cap. "Your writing is saved"
    // must never later mean silently discarded, so a copy leaves the record only
    // through an explicit choice (resolveDraft) or deletion (dismissRecovery).
    // If the device runs out of room, the write fails and the editor says so.
    const BLANK = { baseRevision: 0, localRev: 0, conflict: null, recoveries: [], drafts: [] };
    function staleError() { return Object.assign(new Error("This page changed in another tab or on another device. Your page is kept; choose which to use."), { code: "STALE_DRAFT" }); }
    function snapshot(rec, reason) { return { id: makeId(), ink: clone(rec.ink), body: rec.body || "", savedAt: now(), reason }; }
    function keep(list, item) { return [item].concat(list || []); }
    // Content this build cannot edit is never adopted by a choice.
    function adoptable(ink) {
      if (ink != null && (!ink || ink.v !== 1)) throw Object.assign(new Error("That version was saved by a newer version of DCC and cannot be opened here. Nothing was changed."), { code: "INK_VERSION" });
    }
    function hasContent(rec) { return !!(rec && ((rec.ink && rec.ink.strokes && rec.ink.strokes.length) || rec.body)); }

    // A user edit, as a whole-page snapshot of what the editor displays.
    // Resolves { record, stale }. stale:true means the edit was preserved as a
    // draft (record.drafts, keyed by draftId) and the current content was not
    // touched. Rejects only when nothing could be written.
    function saveEdit(journalId, edit, expectLocalRev, draftId) {
      if (!Number.isInteger(expectLocalRev) || expectLocalRev < 0) return Promise.reject(new Error("A content version is required to save"));
      try { checkPage(edit.ink); } catch (e) { return Promise.reject(e); }
      let stale = false;
      const keys = keysFrom(edit);
      return backend.update(journalId, cur => {
        // Another task's page: refuse before writing anything, content OR draft.
        const taskKeys = checkBinding(cur, keys);
        const base = Object.assign({}, BLANK, cur || {});
        const taskId = base.taskId || edit.taskId || keys[0] || null;
        const content = { ink: clampInk(edit.ink), body: typeof edit.body === "string" ? edit.body : (base.body || "") };
        if ((base.localRev || 0) !== expectLocalRev) {
          stale = true;
          const id = draftId || makeId();
          const draft = Object.assign({ id, basedOn: expectLocalRev, savedAt: now() }, content);
          return Object.assign(base, { journalId, taskId, taskKeys,
            drafts: [draft].concat((base.drafts || []).filter(d => d.id !== id)) });
        }
        return Object.assign(base, content, {
          journalId, taskId, taskKeys,
          localRev: (base.localRev || 0) + 1, dirty: true, mutationId: makeId(), updatedAt: now(),
        });
      }).then(record => ({ record, stale }));
    }

    // A server copy arrived. It replaces content only when this device's copy is
    // clean and the server copy is strictly newer than what this device has seen;
    // the same accepted revision is the same content and changes nothing. A
    // replacement is a new content version, so an editor still showing the older
    // one cannot save over it (its save becomes a draft).
    // `taskKeys` are the ids of the task the caller verified the server copy is
    // for; the server copy must name one of them, and it must be this page's task.
    function seed(journalId, server, taskKeys) {
      const keys = (Array.isArray(taskKeys) && taskKeys.length ? taskKeys : [server.taskId]).filter(Boolean);
      if (server.journalId != null && server.journalId !== journalId) return Promise.reject(mismatch());
      if (server.taskId && !keys.includes(server.taskId)) return Promise.reject(mismatch());
      return backend.update(journalId, cur => {
        const bound = checkBinding(cur, keys);
        if (cur && (cur.dirty || cur.conflict)) return Object.assign({}, cur, { taskKeys: bound });
        const rev = server.revision || 0;
        if (cur && (cur.baseRevision || 0) >= rev) return Object.assign({}, cur, { taskKeys: bound });
        const base = Object.assign({}, BLANK, cur || {});
        return Object.assign(base, {
          journalId, taskId: base.taskId || server.taskId || null, taskKeys: bound,
          ink: clone(server.ink), body: server.body || "", baseRevision: rev,
          localRev: (base.localRev || 0) + 1,
          dirty: false, mutationId: null, conflict: null, updatedAt: server.updatedAt || now(),
        });
      });
    }

    // Resolve a stale draft. "mine": the draft becomes the content (the content
    // it replaces is kept as a recovery copy). "theirs": the content stays and the
    // draft becomes a recovery copy. Both name the content version the user saw.
    function resolveDraft(journalId, draftId, choice, expectLocalRev) {
      return backend.update(journalId, cur => {
        const draft = cur && (cur.drafts || []).find(d => d.id === draftId);
        if (!draft) throw Object.assign(new Error("That unsaved version was already resolved"), { code: "NO_DRAFT" });
        if ((cur.localRev || 0) !== expectLocalRev) throw staleError();
        const rest = (cur.drafts || []).filter(d => d.id !== draftId);
        if (choice === "mine") {
          return Object.assign({}, cur, { ink: clone(draft.ink), body: draft.body || "", drafts: rest,
            recoveries: hasContent(cur) ? keep(cur.recoveries, snapshot(cur, "replaced-by-draft")) : (cur.recoveries || []),
            localRev: (cur.localRev || 0) + 1, dirty: true, mutationId: makeId(), updatedAt: now() });
        }
        return Object.assign({}, cur, { drafts: rest, recoveries: keep(cur.recoveries, snapshot(draft, "unsaved-draft")) });
      });
    }

    // Put a recovery copy back as the content; what it replaces becomes a
    // recovery copy itself, so the choice can be reversed.
    function restoreRecovery(journalId, recoveryId, expectLocalRev) {
      return backend.update(journalId, cur => {
        const item = cur && (cur.recoveries || []).find(r => r.id === recoveryId);
        if (!item) throw Object.assign(new Error("That recovery copy is gone"), { code: "NO_RECOVERY" });
        if ((cur.localRev || 0) !== expectLocalRev) throw staleError();
        adoptable(item.ink);
        const rest = (cur.recoveries || []).filter(r => r.id !== recoveryId);
        return Object.assign({}, cur, { ink: clone(item.ink), body: item.body || "",
          recoveries: hasContent(cur) ? keep(rest, snapshot(cur, "replaced-by-recovery")) : rest,
          localRev: (cur.localRev || 0) + 1, dirty: true, mutationId: makeId(), updatedAt: now() });
      });
    }
    function dismissRecovery(journalId, recoveryId) {
      return backend.update(journalId, cur => cur && Object.assign({}, cur, { recoveries: (cur.recoveries || []).filter(r => r.id !== recoveryId) }));
    }

    // The server accepted `sentMutationId` as `revision`. Only that content is
    // acknowledged: if the user drew more while it was in flight, the record stays
    // dirty and the next send builds on the accepted revision.
    function acknowledge(journalId, sentMutationId, revision) {
      return backend.update(journalId, cur => {
        if (!cur) return null;
        const next = Object.assign({}, cur, { baseRevision: Math.max(cur.baseRevision || 0, revision) });
        if (cur.mutationId === sentMutationId) { next.dirty = false; next.mutationId = null; }
        return next;
      });
    }

    function markConflict(journalId, server) {
      return backend.update(journalId, cur => cur && Object.assign({}, cur, {
        conflict: { revision: server.revision || 0, ink: clone(server.ink), body: server.body || "", updatedAt: server.updatedAt || null, at: now() },
      }));
    }

    // "Keep this device's page": the device content (the version the user saw,
    // checked by expectLocalRev) is rebased onto the server's revision. Content is
    // unchanged, so the version is unchanged. The server keeps its overwritten
    // copy in `previous`, and a recovery copy of it stays here too.
    function keepLocal(journalId, expectLocalRev) {
      return backend.update(journalId, cur => {
        if (!cur || !cur.conflict) throw Object.assign(new Error("There is no conflict to resolve"), { code: "NO_CONFLICT" });
        if ((cur.localRev || 0) !== expectLocalRev) throw staleError();
        return Object.assign({}, cur, {
          recoveries: hasContent(cur.conflict) ? keep(cur.recoveries, snapshot(cur.conflict, "server-copy-overwritten")) : (cur.recoveries || []),
          baseRevision: cur.conflict.revision, conflict: null, dirty: true, mutationId: makeId(), updatedAt: now(),
        });
      });
    }

    // "Use the saved page": adopt the server copy; this device's page (exactly
    // the version the user saw) becomes a recovery copy rather than being dropped.
    function useServer(journalId, expectLocalRev) {
      return backend.update(journalId, cur => {
        if (!cur || !cur.conflict) throw Object.assign(new Error("There is no conflict to resolve"), { code: "NO_CONFLICT" });
        if ((cur.localRev || 0) !== expectLocalRev) throw staleError();
        adoptable(cur.conflict.ink);
        return Object.assign({}, cur, {
          recoveries: hasContent(cur) ? keep(cur.recoveries, snapshot(cur, "device-copy-replaced")) : (cur.recoveries || []),
          ink: clone(cur.conflict.ink), body: cur.conflict.body || "", baseRevision: cur.conflict.revision,
          localRev: (cur.localRev || 0) + 1,
          conflict: null, dirty: false, mutationId: null, updatedAt: now(),
        });
      });
    }

    // Pages bound to this task under a DIFFERENT journalId. That happens when the
    // server gave the task a fresh id because the one it was created with was
    // already claimed by another task. Their sync is refused (the task no longer
    // carries that id), so they are surfaced here instead of sitting unseen.
    //
    // Discovery is by CONTENT, not by a one-time marker. Every item a source page
    // holds -- its current content, each draft, each recovery copy -- has a key
    // derived from that item itself (content version + hash, draft id + hash,
    // recovery id). A source stays discoverable while ANY of its current item keys
    // has not been durably copied to the destination. So a write landing during a
    // handoff, or an old tab saving after it, is a new key and is found again.
    function digest(item) {
      const text = JSON.stringify([item && item.ink || null, item && item.body || ""]);
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return h.toString(36) + "." + text.length;
    }
    function sourceItems(src) {
      const items = [];
      if (hasContent(src)) items.push({ key: src.journalId + "|content:" + (src.localRev || 0) + ":" + digest(src), from: src, reason: "earlier-journal-id" });
      for (const d of src.drafts || []) items.push({ key: src.journalId + "|draft:" + d.id + ":" + digest(d), from: d, reason: "earlier-journal-id-draft" });
      for (const r of src.recoveries || []) items.push({ key: src.journalId + "|recovery:" + r.id, from: r, reason: r.reason || "earlier-journal-id-recovery" });
      return items;
    }
    function pendingItems(src) {
      const done = new Set(src.adoptedKeys || []);
      return sourceItems(src).filter(i => !done.has(i.key));
    }
    function boundElsewhere(journalId, keys) {
      return backend.list().then(rows => rows.filter(r => r.journalId !== journalId
        && boundKeys(r).length && overlaps(boundKeys(r), keys) && pendingItems(r).length > 0));
    }
    // Copy a source page's pending items into the task's current page as recovery
    // copies (explicit restore), in two version-safe steps:
    //   1. destination: add each item not already there (deduplicated by item key),
    //      in one transaction -- so replays and repeated opens never multiply copies;
    //   2. source: record ONLY the item keys step 1 copied. Whatever the source holds
    //      now that was not copied (a write that landed in between, a later draft)
    //      stays pending: the source stays discoverable and its dirty marker stays.
    //      The dirty marker clears only when nothing on the source is uncopied.
    // A failure in either step leaves the source discoverable; nothing is deleted.
    function adopt(journalId, sourceJournalId, keys) {
      let items;
      return backend.read(sourceJournalId).then(src => {
        if (!src || !overlaps(boundKeys(src), keys)) throw mismatch();
        items = pendingItems(src);
        if (!items.length) return null;
        return backend.update(journalId, cur => {
          const taskKeys = checkBinding(cur, keys);
          const base = Object.assign({}, BLANK, cur || {}, { journalId });
          const have = new Set((base.recoveries || []).map(r => r.fromKey).filter(Boolean));
          const add = items.filter(i => !have.has(i.key))
            .map(i => Object.assign(snapshot(i.from, i.reason), { fromJournalId: sourceJournalId, fromKey: i.key }));
          return Object.assign(base, { taskKeys, taskId: base.taskId || keys[0] || null, recoveries: add.concat(base.recoveries || []) });
        }).then(() => backend.update(sourceJournalId, cur => {
          if (!cur || !overlaps(boundKeys(cur), keys)) throw mismatch();
          const adoptedKeys = union(cur.adoptedKeys || [], items.map(i => i.key));
          const after = Object.assign({}, cur, { adoptedKeys, adoptedInto: journalId });
          if (!pendingItems(after).length) after.dirty = false;
          return after;
        }));
      });
    }

    return { load, listDirty, saveEdit, seed, acknowledge, markConflict, keepLocal, useServer, resolveDraft, restoreRecovery, dismissRecovery,
      boundKeys, belongsTo, bindKeys, boundElsewhere, adopt };
  }

  return { create, dbName, ownerKey, newJournalId, idbBackend, clampInk, checkPage, MAX_PAGE_BYTES };
});
