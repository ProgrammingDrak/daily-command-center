/**
 * block-store.js — Client-side BlockStore
 *
 * Write-through cache that talks to the SQLite block API.
 * Every mutation hits the server immediately (~1-5ms localhost).
 * Partitioned cache: dayCache (date-scoped) + globalCache (persistent).
 * sessionStorage write-ahead buffer for server-down resilience.
 */

(function() {
  "use strict";

  const CLIENT_ID = crypto.randomUUID();
  const WAL_KEY = "blockstore-wal"; // durable write-ahead log in localStorage
  const WAL_DEAD_LETTER_KEY = "blockstore-wal-dead-letter";
  const WAL_LEGACY_SESSION_KEY = "blockstore-wal"; // same name, older sessionStorage home
  const _completionMetrics = { acknowledged: 0, queued: 0, replayed: 0, rejected: 0 };

  // ── Partitioned Cache ──
  let _dayCache = new Map();   // id → block (cleared on date switch)
  let _globalCache = new Map(); // id → block (persistent across dates)
  // Ids this client soft-deleted, so a foreign SSE broadcast naming one does not make
  // this tab re-fetch and re-cache the row it just removed. (A2 also made
  // GET /api/blocks/:id 404 on a tombstone; this is the client half and both are worth
  // having, since the skip avoids the round trip entirely.) Session-scoped:
  // a reload starts empty, by which point loadDay's deleted_at-filtered query is the
  // source of truth, so this never has to be pruned.
  const _tombstones = new Set();
  let _currentDate = null;
  let _dayLoadSequence = 0;
  let _dayLoadTargetDate = null;
  const _dayLoadsByDate = new Map();
  let _mutationGeneration = 0;
  let _activeWriteRequests = 0;
  // A task can be moved repeatedly faster than the network round trip. Serialize
  // those intents per row so the server sees them in click order and the final
  // destination is always the most recent one. Different tasks still move in
  // parallel.
  const _rescheduleChains = new Map();
  const _updateChains = new Map();
  // Server IDs for day_root are workspace-prefixed (e.g. "day-root-ws-1-2026-04-24").
  // Resolved from the block list returned by loadDay() so callsites can look up
  // the cached root reliably, not a naive "day-root-<date>" that misses.
  let _currentDayRootId = null;
  let _syncCursor = null;
  let _syncWorkspaceId = null;
  let _syncPullPromise = null;
  let _syncPullDate = null;
  const _syncForceStateDates = new Set();

  function syncCursorKey(workspaceId) {
    return "dcc-sync-cursor:" + String(workspaceId || "default");
  }

  function saveSyncCursor(workspaceId, cursor) {
    _syncWorkspaceId = workspaceId || _syncWorkspaceId;
    _syncCursor = Number(cursor);
    if (!Number.isSafeInteger(_syncCursor) || _syncCursor < 0) _syncCursor = null;
    if (_syncWorkspaceId && _syncCursor !== null) {
      try { localStorage.setItem(syncCursorKey(_syncWorkspaceId), String(_syncCursor)); } catch (e) {}
    }
  }

  function hydrateSyncSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.blocks) || !Array.isArray(snapshot.globals)) return null;
    _currentDate = snapshot.date || _currentDate;
    _currentDayRootId = null;
    _dayCache.clear();
    _globalCache.clear();
    for (const block of snapshot.globals) cacheSet(block);
    for (const block of snapshot.blocks) cacheSet(block);
    const root = snapshot.blocks.find((block) => block.type === "day_root");
    if (root) _currentDayRootId = root.id;
    saveSyncCursor(snapshot.workspaceId, snapshot.cursor);
    return snapshot.blocks;
  }

  async function pullSyncChanges(dateStr, options) {
    if (!window.DCC_DELTA_SYNC_ENABLED || !dateStr) return null;
    if (options && options.includeState) _syncForceStateDates.add(dateStr);
    if (_syncPullPromise) {
      if (_syncPullDate === dateStr) return _syncPullPromise;
      // The caches are shared, so pulls for different dates must run in order.
      // After the active date settles, start a fresh pull for the requested date.
      // Returning the active promise here made navigation render its old-day cache.
      return _syncPullPromise.catch(() => null).then(() => pullSyncChanges(dateStr));
    }
    _syncPullDate = dateStr;
    _syncPullPromise = (async () => {
      if (_syncCursor === null || _currentDate !== dateStr) {
        const snapshot = await apiGet("/api/sync/bootstrap?date=" + encodeURIComponent(dateStr));
        hydrateSyncSnapshot(snapshot);
        _syncForceStateDates.delete(dateStr);
        if (snapshot.dayState) window.dispatchEvent(new CustomEvent("dcc-sync-day-state", { detail: snapshot.dayState }));
        return { ...snapshot, bootstrap: true };
      }
      if (hasPendingWritesNow()) return null;
      let combined = { blocks: [], deletedBlockIds: [], dayState: null, hasMore: false, cursor: _syncCursor };
      do {
        let delta;
        const includeState = _syncForceStateDates.has(dateStr);
        try {
          delta = await apiGet("/api/sync/pull?date=" + encodeURIComponent(dateStr) + "&cursor=" + encodeURIComponent(_syncCursor) + (includeState ? "&includeState=1" : ""));
        } catch (error) {
          if (!error || error.status !== 410) throw error;
          const snapshot = await apiGet("/api/sync/bootstrap?date=" + encodeURIComponent(dateStr));
          hydrateSyncSnapshot(snapshot);
          _syncForceStateDates.delete(dateStr);
          if (snapshot.dayState) window.dispatchEvent(new CustomEvent("dcc-sync-day-state", { detail: snapshot.dayState }));
          return { ...snapshot, bootstrap: true };
        }
        // Clear the forced refresh only after the server returned its projection.
        // A transient rejection keeps the request pending for the next safe pull.
        if (includeState) _syncForceStateDates.delete(dateStr);
        for (const id of delta.deletedBlockIds || []) {
          cacheDelete(id);
          _tombstones.add(id);
        }
        for (const block of delta.blocks || []) cacheSet(block);
        saveSyncCursor(_syncWorkspaceId, delta.cursor);
        combined = {
          blocks: combined.blocks.concat(delta.blocks || []),
          deletedBlockIds: combined.deletedBlockIds.concat(delta.deletedBlockIds || []),
          dayState: delta.dayState || combined.dayState,
          hasMore: !!delta.hasMore,
          cursor: delta.cursor,
        };
      } while ((combined.hasMore || _syncForceStateDates.has(dateStr)) && !hasPendingWritesNow());
      if (combined.dayState) {
        window.dispatchEvent(new CustomEvent("dcc-sync-day-state", { detail: combined.dayState }));
      }
      return combined;
    })().finally(() => {
      _syncPullPromise = null;
      _syncPullDate = null;
      if (_syncForceStateDates.has(dateStr) && _currentDate === dateStr && !hasPendingWritesNow()) {
        setTimeout(() => pullSyncChanges(dateStr), 0);
      }
    });
    return _syncPullPromise;
  }

  // ── Save Status Helpers ──
  function setSaving() {
    // A passive read captures this number before its request. Any mutation that
    // starts before the response is applied invalidates that snapshot, even when
    // the write finishes quickly enough that the WAL is empty again by then.
    _mutationGeneration++;
    if (typeof updateSaveStatus === "function") updateSaveStatus("saving", "Saving...");
  }
  function setSaved() {
    if (typeof updateSaveStatus === "function") updateSaveStatus("ok", "All changes saved");
  }
  function setError(msg) {
    const display = window.__DCC_HEALTH_ERROR || msg || "Save failed";
    if (typeof updateSaveStatus === "function") updateSaveStatus("error", display);
    if (typeof showToast === "function") showToast(msg || display || "Save failed - will retry", "error");
  }
  function setPending(msg) {
    const display = msg || "Completion pending - retrying";
    if (typeof updateSaveStatus === "function") updateSaveStatus("saving", display);
    if (typeof showToast === "function") showToast(display, "info");
  }

  // ── Write-Ahead Log (localStorage) ──
  // Every mutation pushes an entry before the fetch fires and removes it only on
  // server ack. localStorage survives tab close, reloads mid-flight, and browser
  // crashes, so pending writes replay on next boot instead of being lost.
  function walPush(entry) {
    const entryId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ("w-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    try {
      let wal = JSON.parse(localStorage.getItem(WAL_KEY) || "[]");
      // Updates replace the complete properties document, so the newest update for
      // one row fully supersedes every older buffered update for that row. This also
      // makes completion intent last-write-wins after a lost acknowledgement: an old
      // buffered complete can never replay after a newer reopen.
      // "realloc" belongs here too: a failed save leaves the dialog usable, so the user
      // can edit the pieces and save again, and the WAL would then hold two plans for
      // one segment. The stale one carries a different actionId, so the server does not
      // see a duplicate, and it is APPLIED if its pieces still fit the now-shorter
      // source: a second, unrequested re-attribution of time already moved.
      if (entry && (entry.op === "update" || entry.op === "completion" || entry.op === "realloc") && entry.id) {
        wal = wal.filter(e => !(e && e.op === entry.op && e.id === entry.id));
      }
      wal.push({ ...entry, _walId: entryId, timestamp: new Date().toISOString() });
      localStorage.setItem(WAL_KEY, JSON.stringify(wal));
    } catch {}
    return entryId;
  }

  function walRemove(entryId) {
    if (!entryId) return;
    try {
      const wal = JSON.parse(localStorage.getItem(WAL_KEY) || "[]");
      const next = wal.filter(e => e._walId !== entryId);
      if (next.length === 0) localStorage.removeItem(WAL_KEY);
      else localStorage.setItem(WAL_KEY, JSON.stringify(next));
    } catch {}
  }

  function walGet() {
    try { return JSON.parse(localStorage.getItem(WAL_KEY) || "[]"); } catch { return []; }
  }

  function walPendingTaskCompletion(id) {
    const entries = walGet().filter(e => e && e.op === "completion" && String(e.id) === String(id));
    return entries.length ? entries[entries.length - 1] : null;
  }

  function applyCompletionState(properties, completed, completedAt) {
    const next = { ...(properties || {}) };
    if (completed) {
      next.status = "done";
      next.done = true;
      next.completedAt = completedAt || next.completedAt || new Date().toISOString();
    } else {
      if (next.status === "done") next.status = "open";
      for (const key of ["done", "completed", "completedAt", "doneAt", "completedBy"]) delete next[key];
    }
    return next;
  }

  function overlayPendingCompletion(block) {
    if (!block || !block.id) return block;
    if (block.type === "day_root") {
      const pendingForDay = walGet().filter(entry => entry && entry.op === "completion"
        && entry.data && entry.data.taskDate === block.date);
      if (!pendingForDay.length) return block;
      const props = { ...(block.properties || {}) };
      const done = { ...((props._done && typeof props._done === "object") ? props._done : {}) };
      let ids = Array.isArray(done.ids) ? done.ids.map(String) : [];
      const at = { ...((done.at && typeof done.at === "object") ? done.at : {}) };
      for (const entry of pendingForDay) {
        const key = String(entry.id);
        ids = ids.filter(id => id !== key);
        if (entry.data.completed) { ids.push(key); at[key] = entry.data.completedAt; }
        else delete at[key];
      }
      props._done = { ...done, ids, at };
      return { ...block, properties: props, _completionState: "pending" };
    }
    const pending = walPendingTaskCompletion(block.id);
    if (!pending) return block;
    const data = pending.data || {};
    return {
      ...block,
      date: data.completed && !block.date && data.taskDate ? data.taskDate : block.date,
      properties: applyCompletionState(block.properties, !!data.completed, data.completedAt),
      _completionState: "pending",
      _completionMutationId: data.mutationId || null,
    };
  }

  function walPendingCompletionTransition(id) {
    const updates = walGet().filter(e => e && e.op === "update" && e.id === id && e.data && e.data.completionIntent);
    if (!updates.length) return null;
    const data = updates[updates.length - 1].data;
    const entry = updates[updates.length - 1];
    // A completion entry written by an older client has no base/patch metadata and
    // must not be upgraded into a fresh ordinary edit. The server will reject and
    // dead-letter it during replay instead.
    if (!Object.prototype.hasOwnProperty.call(data, "completionBaseRevision") || !entry.completionPropertyPatch) return null;
    return {
      intent: data.completionIntent,
      mutationId: data.completionMutationId,
      data,
      propertyPatch: entry.completionPropertyPatch,
    };
  }

  function samePropertyValue(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }

  // Record the exact property delta made by the user action, rather than guessing
  // from a completion-field allowlist. This includes measured timing/points and the
  // removal/restoration of `kind:"backlog"`, while excluding an unchanged stale title.
  function makeCompletionPropertyPatch(beforeProps, afterProps) {
    const before = beforeProps || {};
    const after = afterProps || {};
    const set = {};
    const unset = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.prototype.hasOwnProperty.call(after, key) || after[key] === undefined) {
        if (Object.prototype.hasOwnProperty.call(before, key)) unset.push(key);
      } else if (!Object.prototype.hasOwnProperty.call(before, key) || !samePropertyValue(before[key], after[key])) {
        set[key] = after[key];
      }
    }
    return { set, unset };
  }

  function applyCompletionPropertyPatch(baseProps, patch) {
    const next = { ...(baseProps || {}) };
    for (const key of (patch && patch.unset) || []) delete next[key];
    Object.assign(next, (patch && patch.set) || {});
    return next;
  }

  function mergeCompletionPropertyPatches(older, newer) {
    const set = { ...((older && older.set) || {}) };
    const unset = new Set((older && older.unset) || []);
    for (const key of (newer && newer.unset) || []) {
      delete set[key];
      unset.add(key);
    }
    for (const [key, value] of Object.entries((newer && newer.set) || {})) {
      unset.delete(key);
      set[key] = value;
    }
    return { set, unset: [...unset] };
  }

  function walReplaceData(entryId, data) {
    try {
      const wal = walGet();
      const entry = wal.find(e => e && e._walId === entryId);
      if (!entry) return;
      entry.data = data;
      localStorage.setItem(WAL_KEY, JSON.stringify(wal));
    } catch {}
  }

  function withCrossTabUpdateLock(id, send) {
    const locks = typeof navigator !== "undefined" && navigator.locks;
    if (locks && typeof locks.request === "function") {
      return locks.request("dcc-block-update:" + id, send);
    }
    return send();
  }

  function queueUpdateRequest(id, send) {
    const previous = _updateChains.get(id) || Promise.resolve();
    const queued = previous.catch(() => {}).then(() => withCrossTabUpdateLock(id, send));
    _updateChains.set(id, queued);
    return queued.finally(() => {
      if (_updateChains.get(id) === queued) _updateChains.delete(id);
    });
  }

  function walMoveToDeadLetter(entry, reason) {
    if (!entry) return;
    try {
      const dead = JSON.parse(localStorage.getItem(WAL_DEAD_LETTER_KEY) || "[]");
      dead.push({ ...entry, deadLetteredAt: new Date().toISOString(), reason: reason || "permanent failure" });
      localStorage.setItem(WAL_DEAD_LETTER_KEY, JSON.stringify(dead.slice(-50)));
    } catch {}
    walRemove(entry._walId);
  }

  // Migrate any entries left over from the sessionStorage era. Older clients
  // that still have a session open will already have populated the sessionStorage
  // WAL; move that content so it gets replayed alongside new localStorage entries.
  function walMigrateFromSession() {
    try {
      const legacy = sessionStorage.getItem(WAL_LEGACY_SESSION_KEY);
      if (!legacy) return;
      const legacyEntries = JSON.parse(legacy);
      if (!Array.isArray(legacyEntries) || !legacyEntries.length) { sessionStorage.removeItem(WAL_LEGACY_SESSION_KEY); return; }
      const current = JSON.parse(localStorage.getItem(WAL_KEY) || "[]");
      const merged = [...current, ...legacyEntries.map(e => ({ ...e, _walId: e._walId || ((crypto && crypto.randomUUID) ? crypto.randomUUID() : ("w-" + Date.now() + "-" + Math.random().toString(36).slice(2))) }))];
      localStorage.setItem(WAL_KEY, JSON.stringify(merged));
      sessionStorage.removeItem(WAL_LEGACY_SESSION_KEY);
    } catch {}
  }
  walMigrateFromSession();

  // Convert completion entries written by the full-document PATCH client into the
  // narrow intent format. Dead-letter entries are intentionally untouched because
  // replaying an already-rejected historical intent could reverse a newer decision.
  function walMigrateCompletionEntries() {
    try {
      const wal = walGet();
      let changed = false;
      const migrated = wal.map(entry => {
        if (!entry || entry.op !== "update" || !entry.data || !entry.data.completionIntent) return entry;
        changed = true;
        const data = entry.data;
        const props = data.properties || {};
        return {
          op: "completion",
          id: entry.id,
          data: {
            completed: data.completionIntent === "complete",
            completedAt: props.completedAt || props.doneAt || null,
            taskDate: data.date || null,
            mutationId: data.completionMutationId || ((crypto && crypto.randomUUID) ? crypto.randomUUID() : ("cm-" + Date.now())),
            expectedRevision: Object.prototype.hasOwnProperty.call(data, "completionBaseRevision")
              ? data.completionBaseRevision : null,
          },
          _walId: entry._walId,
          timestamp: entry.timestamp,
          migratedFrom: "full_properties_completion",
        };
      });
      if (changed) localStorage.setItem(WAL_KEY, JSON.stringify(migrated));
    } catch {}
  }
  walMigrateCompletionEntries();

  // ── API Helpers ──
  async function apiPost(url, body) {
    _activeWriteRequests++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, _clientId: CLIENT_ID })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        const e = new Error(err.error || `API error ${res.status}`);
        e.status = res.status;
        e.code = err.code;
        e.retryable = err.retryable;
        e.requestId = err.requestId;
        e.currentTask = err.currentTask;
        throw e;
      }
      return await res.json();
    } finally {
      _activeWriteRequests--;
    }
  }

  async function apiPatch(url, body) {
    _activeWriteRequests++;
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, _clientId: CLIENT_ID })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        const e = new Error(err.error || `API error ${res.status}`);
        e.status = res.status;
        e.code = err.code;
        throw e;
      }
      return await res.json();
    } finally {
      _activeWriteRequests--;
    }
  }

  async function apiDelete(url) {
    _activeWriteRequests++;
    try {
      const res = await fetch(url + "?_clientId=" + CLIENT_ID, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        const e = new Error(err.error || `API error ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return await res.json();
    } finally {
      _activeWriteRequests--;
    }
  }

  async function apiGet(url) {
    const res = await fetch(url);
    // Carry the status on the error: handleBlocksChanged has to tell "gone" (404)
    // apart from "the network hiccuped", and sniffing the message string for a
    // number is not a contract.
    if (!res.ok) { const err = new Error(`API error ${res.status}`); err.status = res.status; throw err; }
    return res.json();
  }

  // ── Cache Helpers ──
  // Unified block architecture: all user data is type='block'.
  // Cache partitioning: blocks WITH a date go in dayCache, blocks WITHOUT go in globalCache.
  // Legacy type names also route to globalCache for backward compat during migration.
  const LEGACY_GLOBAL_TYPES = new Set(["sticky_note", "trivial_task", "life_capture", "pending_task", "schedule_block", "tag"]);

  // The day's next 1000-spaced slot from what the cache can see. Deliberately the same shape as
  // db.js nextSortOrderForDay, and deliberately only an OPTIMISTIC guess -- the server recomputes it
  // against every row, including ones this client has not loaded.
  // BOTH caches: `cacheSet` routes a dateless `type:"block"` row to `_globalCache`, so scanning only
  // `_dayCache` returned 1000 for every dateless create -- i.e. it manufactured the duplicate
  // `sort_order` that migration 004 exists to remove.
  function _nextLocalSortOrder(date) {
    let mx = 0;
    for (const b of [..._dayCache.values(), ..._globalCache.values()]) {
      if (!b || b.deleted_at) continue;
      if ((b.date || null) !== (date || null)) continue;
      const n = Number(b.sort_order);
      if (Number.isFinite(n) && n > mx) mx = n;
    }
    return (Math.floor(mx / 1000) + 1) * 1000;
  }

  function cacheSet(block) {
    block = overlayPendingCompletion(block);
    // Remove any prior entry in either cache so a block can migrate between
    // global and day partitions without leaving a stale duplicate behind.
    _dayCache.delete(block.id);
    _globalCache.delete(block.id);
    // A row being written into the cache is live by definition, so it is no longer a
    // tombstone (loadDay only ever returns deleted_at IS NULL rows).
    _tombstones.delete(block.id);
    const props = block.properties || {};
    // Pinned blocks (sticky notes) are globally scoped even when the server
    // stored a date — otherwise loadDay() on date navigation would evict them.
    const isPinned = block.type === "block" && Array.isArray(props.tags) && props.tags.includes("pinned");
    if (LEGACY_GLOBAL_TYPES.has(block.type) || isPinned) {
      _globalCache.set(block.id, block);
    } else if (block.type === "block" && !block.date) {
      _globalCache.set(block.id, block);
    } else {
      _dayCache.set(block.id, block);
    }
  }

  function cacheGet(id) {
    return _dayCache.get(id) || _globalCache.get(id) || null;
  }

  function cacheDelete(id) {
    _dayCache.delete(id);
    _globalCache.delete(id);
  }

  // ── Debounce for Content Editing ──
  const _contentTimers = {};

  function debouncedUpdate(id, properties, delay = 300) {
    clearTimeout(_contentTimers[id]);
    // Update cache immediately for responsive UI
    const existing = cacheGet(id);
    if (existing) {
      cacheSet({ ...existing, properties, updated_at: new Date().toISOString() });
    }
    setSaving();
    _contentTimers[id] = setTimeout(() => {
      delete _contentTimers[id];
      blockStore.updateBlock(id, properties).catch(e => {
        setError("Note save failed: " + e.message);
      });
    }, delay);
  }

  // Flush all pending debounced writes (called on blur/close)
  function flushContentEdits() {
    for (const [id, timer] of Object.entries(_contentTimers)) {
      clearTimeout(timer);
      const block = cacheGet(id);
      if (block) {
        // Use keepalive for beforeunload survival
        _activeWriteRequests++;
        fetch("/api/blocks/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ properties: block.properties, _clientId: CLIENT_ID }),
          keepalive: true
        }).catch(() => {}).finally(() => { _activeWriteRequests--; });
      }
      delete _contentTimers[id];
    }
  }

  // ── WAL Replay (on reconnect / boot) ──
  // Replays every pending mutation and removes each entry on its own success.
  // Failures stay queued so the next reconnect (or next boot) can retry them --
  // a partial failure no longer wipes the unreplayed entries.
  function isPermanentReplayFailure(entry, err) {
    if (!entry || !err) return false;
    if (err.status === 401 || err.status === 403) return false;
    if (err.status === 400) return true;
    // "batch" belongs in this list as of #260/#262, and its absence was a
    // retry-forever bug rather than a missing nicety. /api/blocks/batch now authorizes
    // every id it references and 404s on one the caller does not own, and #262 made
    // GET /api/blocks/:id 404 on a tombstone. B1 had already made /batch the CANONICAL
    // client delete path, so this is the common path, not an exotic one.
    //
    // Note the asymmetry with the first attempt, which is deliberate and is why this
    // is the only place the fix belongs: blockStore.batchOp swallows its own failure
    // and returns { blocks: [], buffered: true } without ever consulting this function, so a 404 there
    // is always buffered. The loop below is the only consulter — and a `false` verdict
    // there means the entry is re-queued forever behind a permanent "N edits pending"
    // banner, because nothing else caps a batch's attempts.
    // "undelete" too: A2's route 404s when the row is gone for real (hard-deleted, or
    // purged by the 30-day purgeSoftDeleted sweep). There is nothing left to revive, so
    // retrying can only fail again.
    // "realloc" for the same reason, and it is reachable on REPLAY rather than only on
    // the first attempt: the POST fails with a network error so the entry stays
    // buffered, and by the time it replays the destination task or the segment itself
    // may be gone (404) or a local_id may now match two live rows (409).
    if ((entry.op === "update" || entry.op === "completion" || entry.op === "delete" || entry.op === "reschedule" || entry.op === "batch" || entry.op === "undelete" || entry.op === "work" || entry.op === "realloc") && err.status === 404) return true;
    // 409 is terminal for undelete and reschedule specifically. An undelete
    // db.undeleteBlock raises it when clearing deleted_at would move the row into
    // idx_blocks_idem_unique's predicate while a LIVE row already holds that
    // idempotency key. The twin does not disappear on retry, so without this the entry
    // re-queues forever behind a permanent "N edits pending" banner. db.js flags this
    // as B2's to wire up, and prod has 32 duplicate key groups of exactly this shape.
    // A reschedule gets 409 only when the row is an imported meeting whose
    // source calendar owns placement. That authority will not change on retry.
    if ((entry.op === "undelete" || entry.op === "reschedule") && err.status === 409) return true;
    if ((entry.op === "update" || entry.op === "completion") && err.status === 409) return true;
    if ((entry.op === "work" || entry.op === "realloc") && err.status === 409) return true;
    return false;
  }

  let _replaying = false;
  function hasPendingWritesNow() {
    return _replaying || _activeWriteRequests > 0 || Object.keys(_contentTimers).length > 0 || walGet().length > 0;
  }

  async function replayWAL() {
    if (_replaying) return; // avoid overlapping replays (SSE reconnect + boot)
    const entries = walGet();
    if (!entries.length) return;
    _mutationGeneration++;
    _replaying = true;
    console.log("[BlockStore] Replaying", entries.length, "buffered writes...");
    let succeeded = 0, failed = 0, dropped = 0;
    // A reschedule that couldn't send within this window is stale: the user has
    // long since retried or moved on, and replaying it now silently yanks the
    // task to wherever the old attempt pointed (the pre-#167 "reversal" bug).
    const RESCHEDULE_REPLAY_MAX_AGE_MS = 15 * 60 * 1000;
    // A create gets a far longer leash than a reschedule, and for a different reason —
    // mirroring the mechanism, not the rationale. Replaying an old reschedule is
    // ACTIVELY harmful (it yanks the task to where a long-abandoned attempt pointed),
    // which is why 15 minutes. Replaying an old create is now HARMLESS, because the
    // client-minted id makes it idempotent: worst case the server hands back the row it
    // already has. So the cap here is not protecting data, it is stopping an entry that
    // will never succeed from retrying forever and pinning a permanent "N edits
    // pending" banner. 24h is past any offline stretch a real session survives —
    // localStorage outlives the tab, so without a cap an entry from a dead server or a
    // since-revoked session is immortal.
    const CREATE_REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (entry.op === "reschedule" && entry.timestamp && (Date.now() - Date.parse(entry.timestamp)) > RESCHEDULE_REPLAY_MAX_AGE_MS) {
        walMoveToDeadLetter(entry, "stale reschedule (>15min old)");
        dropped++;
        continue;
      }
      if (entry.op === "create" && entry.timestamp && (Date.now() - Date.parse(entry.timestamp)) > CREATE_REPLAY_MAX_AGE_MS) {
        walMoveToDeadLetter(entry, "stale create (>24h old)");
        dropped++;
        continue;
      }
      try {
        switch (entry.op) {
          case "create":
            await apiPost("/api/blocks", entry.data);
            break;
          case "update":
            await queueUpdateRequest(entry.id, async () => {
              // The replay loop snapshots the WAL before awaiting. A newer live
              // update may supersede this entry while it waits on the row chain.
              if (!walGet().some(e => e && e._walId === entry._walId)) return;
              await apiPatch("/api/blocks/" + entry.id, entry.data);
            });
            break;
          case "completion": {
            const result = await queueUpdateRequest(entry.id, async () => {
              if (!walGet().some(e => e && e._walId === entry._walId)) return null;
              return apiPost("/api/tasks/" + encodeURIComponent(entry.id) + "/completion", { ...entry.data, _replay: true });
            });
            if (result) {
              _completionMetrics.replayed++;
              walRemove(entry._walId);
              (result.affectedTasks || []).forEach(cacheSet);
              if (result.task && result.task.type !== "legacy_task") cacheSet(result.task);
              if (typeof window.notifyReadyTaskDependencies === "function") {
                window.notifyReadyTaskDependencies(result.dependencyTransitions || []);
              }
              if (typeof CustomEvent === "function" && typeof window.dispatchEvent === "function") {
                window.dispatchEvent(new CustomEvent("task-completion-confirmed", {
                  detail: { ...result, replayed: true, clientMeta: entry.meta || null },
                }));
              }
            }
            break;
          }
          case "delete":
            await apiDelete("/api/blocks/" + entry.id);
            break;
          case "batch":
            await apiPost("/api/blocks/batch", entry.data);
            break;
          case "undelete":
            await apiPost("/api/blocks/" + entry.id + "/undelete", {});
            break;
          case "reschedule":
            await apiPost("/api/blocks/" + entry.id + "/reschedule", entry.data);
            break;
          case "work": {
            const result = await apiPost("/api/blocks/" + entry.id + "/work", entry.data);
            if (result && result.block) cacheSet(result.block);
            break;
          }
          case "realloc": {
            // The stored actionId is what makes this replay-safe: the server answers a
            // second arrival with { changed: false, reason: "duplicate" } instead of
            // splitting the segment again.
            const result = await apiPost("/api/time-entries/" + entry.id + "/reallocate", entry.data);
            (result && result.entries || []).forEach(block => { if (block && block.id) cacheSet(block); });
            break;
          }
        }
        walRemove(entry._walId);
        succeeded++;
      } catch (e) {
        if (isPermanentReplayFailure(entry, e)) {
          walMoveToDeadLetter(entry, `${e.status || "error"} ${e.message || ""}`.trim());
          // `undelete` is the first op where dropping the entry leaves the CLIENT ahead of
          // the server rather than in step with it. For every other op a permanent failure
          // means the write never happened and the UI never claimed it did; here the UI
          // already un-hid the task optimistically and told the user "Task restored", on the
          // strength of a retry that has now been abandoned. Reachable: the undelete fails
          // transiently (so undoDeleteTask keeps the optimistic restore), then the replay
          // gets a 409 because a live row holds the key. Put the row back where the server
          // has it, and say so, rather than letting the task silently vanish on next load.
          if (entry.op === "undelete" && entry.id) {
            _tombstones.add(entry.id);
            cacheDelete(entry.id);
            setError("A restore could not be completed — reload to see the current state");
          }
          if (entry.op === "completion" && entry.id) {
            _completionMetrics.rejected++;
            const current = e.currentTask;
            if (current && current.type !== "legacy_task") cacheSet(current);
            else cacheDelete(entry.id);
            setError("Completion rejected" + (e.requestId ? " (request " + e.requestId + ")" : ""));
          }
          dropped++;
          console.warn("[BlockStore] WAL replay moved stale entry to dead-letter:", entry.op, entry.id || "", e.message);
          continue;
        }
        failed++;
        console.warn("[BlockStore] WAL replay failed for", entry.op, entry.id || "", e.message);
      }
    }
    _replaying = false;
    if (failed === 0) {
      console.log("[BlockStore] WAL replay complete (", succeeded, "writes,", dropped, "stale dropped )");
      setSaved();
      // Replay writes through the API helpers, not the cache. Rehydrate both cache
      // partitions immediately so the originating tab does not wait for a timer or
      // hard reload to see the acknowledged result (own SSE echoes are ignored).
      const refreshDate = _currentDate || _dayLoadTargetDate;
      if (refreshDate) {
        // A foreign event or a fresh local edit can invalidate either GET while it is
        // in flight. Retry both partitions together with a short bounded backoff; one
        // interrupted attempt must not leave a replayed dateless delete cached forever.
        for (let attempt = 0; attempt < 5; attempt++) {
          const [dayBlocks, globalBlocks] = await Promise.all([
            blockStore.loadDay(refreshDate),
            blockStore.loadGlobals(),
          ]);
          if (Array.isArray(dayBlocks) && Array.isArray(globalBlocks)) {
            if (typeof CustomEvent === "function" && typeof window.dispatchEvent === "function") {
              window.dispatchEvent(new CustomEvent("blockstore-wal-drained"));
            }
            break;
          }
          if (attempt < 4) {
            await new Promise(resolve => setTimeout(resolve, Math.min(250 * (2 ** attempt), 2000)));
          }
        }
      }
    } else {
      console.warn("[BlockStore] WAL replay:", succeeded, "ok,", dropped, "stale dropped,", failed, "still queued for retry");
      setError(failed + " edits pending — will retry");
    }
  }

  // ── Main BlockStore API ──
  const blockStore = {

    CLIENT_ID,

    // NOTE: day-context.js wraps these mutators at runtime (createBlock,
    // updateBlock, deleteBlock, rescheduleBlock, batchOp, undeleteBlock,
    // reallocateTimeEntry) to
    // invalidate its per-day slot cache after each write. If you add a new
    // server-mutating method here, add it to that wrap list too or its day can go
    // stale. cancelBufferedWrite is deliberately NOT wrapped: it abandons a write
    // that never landed, so no day's data changed.
    // Create a new block
    async createBlock(type, properties, { parentId, date, sortOrder } = {}) {
      setSaving();
      // MINT THE ROW ID HERE. This is what makes a create idempotent, and it is the
      // whole point of B2: db.createBlock's `ON CONFLICT (id) DO NOTHING` (A3) absorbs
      // a replay of this same payload and hands back the row it already has, instead
      // of inserting a second one.
      //
      // Before this, the server minted the id. A create the server COMMITTED but whose
      // ack was lost stayed in the WAL (walRemove only runs on ack), replayed on the
      // next reconnect, and the server minted a FRESH uuid for the replay — nothing
      // linked the two rows, so one lost ack produced two tasks with the same
      // local_id. That is the live duplicate generator behind a real share of the
      // "clogged up" itinerary, and a caller-controlled id is what closes it.
      // Guarded exactly as walPush guards its own id, and for the same reason: the two
      // must not have different failure modes. crypto.randomUUID needs a secure context
      // and we only ever run on https or localhost, but if it were ever missing, walPush
      // would keep working while this threw. `blocks.id` is TEXT, not uuid, so the
      // fallback is a legal primary key rather than a deferred constraint violation.
      const id = (crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : ("c-" + Date.now() + "-" + Math.random().toString(36).slice(2));
      const payload = {
        id,
        type,
        parent_id: parentId || null,
        date: date !== undefined ? date : _currentDate,
        properties
      };
      // C6c: `sort_order` is OMITTED from the payload when the caller gave none, so db.createBlock's
      // `== null` branch computes the day's real next slot against EVERY row -- including ones this
      // client never loaded. Putting the local guess in the payload instead would have bypassed the
      // server entirely (schemas.js keeps the field), which is how every dateless create ended up
      // stamped 1000. The guess belongs on the OPTIMISTIC cache entry only, below.
      if (sortOrder != null) payload.sort_order = sortOrder;
      // Optimistic cache update BEFORE API call — so reads (e.g. loadNotes) are instant
      // and don't race with the async API response. Same pattern as updateBlock().
      // The id is final from the start now, so there is no placeholder entry to swap out
      // afterwards and no window where the cache holds an id nothing else can resolve.
      const optimistic = {
        ...payload,
        // Optimistic only: what the server will most likely assign, so the row renders at the end of
        // its day for the in-flight window (and the whole offline WAL window) instead of the top.
        sort_order: sortOrder != null ? sortOrder : _nextLocalSortOrder(date !== undefined ? date : _currentDate),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null
      };
      cacheSet(optimistic);
      // Pre-write to WAL so the mutation survives a mid-flight reload / close.
      const walId = walPush({ op: "create", data: payload });
      try {
        const block = await apiPost("/api/blocks", payload);
        // A tombstone can come back here: the id collided with a row this client
        // created earlier and then deleted, and db.createBlock's fallback is
        // tombstone-inclusive on purpose. cacheSet would file a deleted row back into
        // the day cache and resurrect the task — the same trap B1 hit caching a delete
        // op's { id, deleted_at } stub.
        if (block && block.deleted_at) cacheDelete(block.id);
        else if (block) cacheSet(block);
        walRemove(walId);
        setSaved();
        return block;
      } catch (e) {
        setError("Save failed — buffered for retry");
        // Entry stays in WAL; optimistic entry is already in cache.
        return optimistic;
      }
    },

    // Update a block (full properties replacement)
    updateBlock(id, properties, extra) {
      setSaving();
      // extra carries top-level PATCH metadata beyond properties. `date` promotes
      // an Unscheduled row, while `completionIntent` makes a deliberate done/open
      // transition survive stale full-properties writers and WAL replay.
      extra = { ...(extra || {}) };
      // The shared row queue may have fetched an uncached row immediately before
      // calling us. Use that authoritative snapshot for CAS/delta derivation without
      // leaking the client-only row into the HTTP body.
      const suppliedBaseBlock = extra._completionBaseBlock || null;
      delete extra._completionBaseBlock;
      // Optimistic cache update BEFORE API call, and the base revision for an
      // explicit transition. A replay from another device is rejected if this
      // revision no longer matches the durable row.
      const directExtra = { ...extra };
      const directCompletionIntent = !!extra.completionIntent;
      const existing = cacheGet(id) || suppliedBaseBlock;
      let completionPropertyPatch = null;
      let inheritedOrdinaryPatch = null;
      // A later ordinary edit is built from the optimistic full-row snapshot. If a
      // preceding completion is still buffered, the edit must carry that transition
      // forward before it supersedes the old WAL entry. Otherwise a failed complete
      // followed by a successful rename would persist the rename and silently lose done.
      const pendingCompletion = walPendingCompletionTransition(id);
      if (!extra.completionIntent && pendingCompletion) {
        const carried = {};
        for (const key of ["date", "parent_id", "sort_order", "completionBaseRevision"]) {
          if (extra[key] === undefined && pendingCompletion.data[key] !== undefined) {
            carried[key] = pendingCompletion.data[key];
          }
        }
        extra = {
          ...carried,
          ...extra,
          completionIntent: pendingCompletion.intent,
          completionMutationId: pendingCompletion.mutationId,
        };
        const pendingPatch = pendingCompletion.propertyPatch;
        // The coalesced request represents two user actions: the older completion
        // and this newer ordinary edit. Preserve both deltas for a possible conflict
        // rebase, with the newer ordinary edit winning on any overlapping field.
        // Compute the newer delta BEFORE applying the older transition. Doing it in
        // the opposite order erases an overlapping later edit such as Notes changed
        // immediately after a timed completion appended its measurement line.
        const ordinaryBase = (existing && existing.properties) || pendingCompletion.data.properties || {};
        const ordinaryPatch = makeCompletionPropertyPatch(ordinaryBase, properties);
        inheritedOrdinaryPatch = ordinaryPatch;
        completionPropertyPatch = mergeCompletionPropertyPatches(pendingPatch, ordinaryPatch);
        properties = applyCompletionPropertyPatch(ordinaryBase, completionPropertyPatch);
      }
      if (extra.completionIntent && !extra.completionMutationId) {
        extra = { ...extra, completionMutationId: crypto.randomUUID() };
      }
      if (extra.completionIntent && extra.completionBaseRevision === undefined) {
        extra = {
          ...extra,
          completionBaseRevision: existing && existing.properties
            ? (existing.properties._completionRevision || null)
            : null,
        };
      }
      if (extra.completionIntent && !completionPropertyPatch) {
        completionPropertyPatch = makeCompletionPropertyPatch(existing && existing.properties, properties);
      }
      const optimistic = existing ? { ...existing, ...extra, properties, updated_at: new Date().toISOString() } : null;
      if (optimistic) cacheSet(optimistic);
      // Pre-write to WAL so the mutation survives a mid-flight reload / close.
      const walId = walPush({
        op: "update", id, data: { properties, ...extra },
        ...(completionPropertyPatch ? { completionPropertyPatch } : {}),
      });
      const write = queueUpdateRequest(id, async () => {
        try {
          let block;
          try {
            block = await apiPatch("/api/blocks/" + id, { properties, ...extra });
          } catch (e) {
            if (!(e && e.status === 409 && e.code === "COMPLETION_CONFLICT" && extra.completionIntent)) throw e;
            // This is a live user action, not replayWAL. Refresh the server revision
            // and retry once so the newest direct intent wins. WAL replay never takes
            // this branch and dead-letters its stale transition instead.
            const latest = await apiGet("/api/blocks/" + id);
            if (!directCompletionIntent && inheritedOrdinaryPatch) {
              // This action was an ordinary edit carrying an older buffered
              // transition. A conflict means another device has since made an
              // explicit completion decision. Preserve that newer boundary and retry
              // only the ordinary edit; the inherited intent has lost its race.
              properties = applyCompletionPropertyPatch(latest && latest.properties, inheritedOrdinaryPatch);
              extra = { ...directExtra };
              completionPropertyPatch = null;
            } else {
              properties = applyCompletionPropertyPatch(latest && latest.properties, completionPropertyPatch);
              extra = {
                ...extra,
                completionBaseRevision: latest && latest.properties
                  ? (latest.properties._completionRevision || null)
                  : null,
              };
            }
            walReplaceData(walId, { properties, ...extra });
            block = await apiPatch("/api/blocks/" + id, { properties, ...extra });
          }
          cacheSet(block); // Replace optimistic with server response
          walRemove(walId);
          _completionMetrics.acknowledged++;
          setSaved();
          return block;
        } catch (e) {
          setError("Save failed — buffered for retry");
          // A newer same-row update may already have superseded this WAL entry.
          return optimistic || existing;
        }
      });
      return write;
    },

    // The only client primitive for changing task completion. It sends an intent,
    // not a full properties document, and distinguishes acknowledged, pending, and
    // permanently failed states for callers.
    setTaskCompletion(taskRef, completed, context) {
      context = { ...(context || {}) };
      const mutationId = context.mutationId || ((crypto && crypto.randomUUID)
        ? crypto.randomUUID() : ("cm-" + Date.now() + "-" + Math.random().toString(36).slice(2)));
      return queueUpdateRequest(taskRef, async () => {
        setSaving();
        let existing = context.block || cacheGet(taskRef) || null;
        // A rendered task can retain its row id while the cache is being refreshed.
        // Fetch that row so the first request carries the real revision instead of
        // manufacturing a conflict from a null base.
        if (!existing && context.resolveRow !== false) {
          try { existing = await apiGet("/api/blocks/" + encodeURIComponent(taskRef)); }
          catch (e) { if (e && e.status !== 404) throw e; }
        }
        const completedAt = completed
          ? (context.completedAt instanceof Date ? context.completedAt.toISOString() : (context.completedAt || new Date().toISOString()))
          : null;
        const body = {
          completed: !!completed,
          completedAt,
          taskDate: context.taskDate || (existing && existing.date) || null,
          mutationId,
          expectedRevision: context.expectedRevision !== undefined
            ? context.expectedRevision
            : (existing && existing.properties ? (existing.properties._completionRevision || null) : null),
        };
        const optimistic = existing ? {
          ...existing,
          date: completed && !existing.date && body.taskDate ? body.taskDate : existing.date,
          properties: applyCompletionState(existing.properties, !!completed, completedAt),
          _completionState: "pending",
          _completionMutationId: mutationId,
          updated_at: new Date().toISOString(),
        } : null;
        const walId = walPush({ op: "completion", id: taskRef, data: body, meta: context.sideEffects || null });
        if (optimistic) cacheSet(optimistic);
        try {
          let result;
          try {
            result = await apiPost("/api/tasks/" + encodeURIComponent(taskRef) + "/completion", body);
          } catch (error) {
            if (!(error && error.status === 409 && error.code === "COMPLETION_CONFLICT")) throw error;
            const current = error.currentTask || await apiGet("/api/blocks/" + encodeURIComponent(taskRef));
            const stillNewest = walGet().some(entry => entry && entry._walId === walId);
            if (!stillNewest) throw error;
            body.expectedRevision = current && current.properties
              ? (current.properties._completionRevision || null) : null;
            walReplaceData(walId, body);
            result = await apiPost("/api/tasks/" + encodeURIComponent(taskRef) + "/completion", body);
          }
          walRemove(walId);
          (result.affectedTasks || []).forEach(cacheSet);
          if (result.task && result.task.type !== "legacy_task") cacheSet(result.task);
          if (typeof window.notifyReadyTaskDependencies === "function") {
            window.notifyReadyTaskDependencies(result.dependencyTransitions || []);
          }
          setSaved();
          if (typeof CustomEvent === "function" && typeof window.dispatchEvent === "function") {
            window.dispatchEvent(new CustomEvent("task-completion-confirmed", { detail: result }));
          }
          return result;
        } catch (error) {
          // Authentication failures cannot become durable by replaying the same
          // unauthenticated request. Keeping them in the WAL pins a misleading
          // "will retry" banner and lets an old intent land after a later sign-in.
          // Roll back and surface them like every other terminal 4xx rejection.
          const permanent = error && (error.status === 400 || error.status === 401
            || error.status === 403 || error.status === 404 || error.status === 409);
          if (permanent) {
            _completionMetrics.rejected++;
            walMoveToDeadLetter(walGet().find(entry => entry && entry._walId === walId),
              `${error.status || "error"} ${error.message || ""}`.trim());
            if (error.currentTask && error.currentTask.type !== "legacy_task") cacheSet(error.currentTask);
            else if (existing) cacheSet(existing);
            else cacheDelete(taskRef);
            setError((error.message || "Completion rejected") + (error.requestId ? " (request " + error.requestId + ")" : ""));
            throw error;
          }
          _completionMetrics.queued++;
          setPending("Completion pending - will retry");
          return { ok: false, pending: true, mutationId, task: optimistic, error };
        }
      });
    },

    // Canonical Start/Pause lifecycle. Timestamp and action id are fixed before
    // the first request, so an offline replay repeats the same transition.
    async workAction(id, action, options) {
      options = options || {};
      setSaving();
      const data = {
        action,
        at: options.at || new Date().toISOString(),
        actionId: options.actionId || ((crypto && crypto.randomUUID)
          ? crypto.randomUUID() : ("work-" + Date.now() + "-" + Math.random().toString(36).slice(2))),
      };
      const existing = cacheGet(id);
      let optimistic = existing;
      if (existing) {
        const properties = { ...(existing.properties || {}) };
        if (action === "start") {
          properties.startedAt = data.at;
          properties.everStarted = true;
        } else if (action === "pause") {
          delete properties.startedAt;
          delete properties.activeWorkSessionId;
          delete properties.startedBy;
        }
        optimistic = { ...existing, properties, updated_at: data.at };
        cacheSet(optimistic);
      }
      const walId = walPush({ op: "work", id, data });
      try {
        const result = await apiPost("/api/blocks/" + id + "/work", data);
        if (result && result.block) cacheSet(result.block);
        walRemove(walId);
        setSaved();
        return result;
      } catch (error) {
        const permanent = error && (error.status === 400 || error.status === 404 || error.status === 409);
        if (permanent) {
          walMoveToDeadLetter(walGet().find(entry => entry && entry._walId === walId),
            `${error.status || "error"} ${error.message || ""}`.trim());
          if (existing) cacheSet(existing);
          setError(error.message || "Work update rejected");
          throw error;
        }
        setError("Work update failed - buffered for retry");
        return { changed: false, buffered: true, block: optimistic };
      }
    },

    // Move or split one tracked time_entry across destination tasks. Lives HERE, not in
    // time-reallocate.js, for the same reason workAction does: this is the layer that
    // owns the WAL, the optimistic cache, the save indicator, and the clientId the SSE
    // echo is suppressed by, and day-context wraps it to drop the slot cache for the
    // affected day. A dialog POSTing on its own would be the only block write in the app
    // outside this file, and its day-context entry would go stale in the very tab that
    // made the change.
    async reallocateTimeEntry(entryId, parts, options) {
      options = options || {};
      setSaving();
      const data = {
        parts,
        actionId: options.actionId || ((crypto && crypto.randomUUID)
          ? crypto.randomUUID() : ("realloc-" + Date.now() + "-" + Math.random().toString(36).slice(2))),
      };
      const walId = walPush({ op: "realloc", id: entryId, data });
      try {
        const result = await apiPost("/api/time-entries/" + entryId + "/reallocate", data);
        (result && result.entries || []).forEach(block => { if (block && block.id) cacheSet(block); });
        // The source row is gone on a whole move. Reflect that locally or the fill stays
        // clickable and hands a stale durSec to the next dialog.
        if (result && result.sourceEntryDeleted) {
          const stale = cacheGet(entryId);
          if (stale) cacheSet({ ...stale, deleted_at: new Date().toISOString() });
        }
        walRemove(walId);
        setSaved();
        return result;
      } catch (error) {
        // Same permanence rule as workAction: a 400/404/409 is a verdict, not a blip.
        const permanent = error && (error.status === 400 || error.status === 404 || error.status === 409);
        if (permanent) {
          walMoveToDeadLetter(walGet().find(entry => entry && entry._walId === walId),
            `${error.status || "error"} ${error.message || ""}`.trim());
          setError(error.message || "Time move rejected");
          throw error;
        }
        setError("Time move failed - buffered for retry");
        throw error;
      }
    },

    // Debounced update for content editing (notes, descriptions)
    updateBlockDebounced(id, properties, delay = 300) {
      debouncedUpdate(id, properties, delay);
    },

    // Flush all pending content edits
    flushPending() {
      flushContentEdits();
    },

    // Soft-delete a block
    async deleteBlock(id) {
      setSaving();
      _tombstones.add(id);
      const walId = walPush({ op: "delete", id });
      try {
        await apiDelete("/api/blocks/" + id);
        cacheDelete(id);
        walRemove(walId);
        setSaved();
        return { ok: true, buffered: false, walId };
      } catch (e) {
        setError("Delete failed — buffered for retry");
        cacheDelete(id);
        return {
          ok: false,
          buffered: true,
          walId,
          error: { message: (e && e.message) || "Delete failed", status: (e && e.status) || null }
        };
      }
    },

    // Abandon a write that is still sitting in the WAL, because a LATER user action made
    // replaying it wrong. The only caller today is Undo cancelling a delete that never
    // reached the server: leaving that entry queued means the next replay (boot, `online`,
    // visibilitychange, SSE reconnect) re-deletes the row the user just restored, with no
    // error shown. `ids` un-tombstones what the abandoned batch had optimistically hidden.
    //
    // Distinct from walMoveToDeadLetter: nothing FAILED permanently here, the write is
    // simply no longer wanted, so it should not show up in the dead-letter diagnostics.
    // Returns TRUE only if the entry was still pending and is now cancelled. That return
    // value is load-bearing, not informational: `buffered` is a snapshot taken when the
    // write failed, and the caller may act on it seconds later. replayWAL fires on the
    // `online` event with no delay, so the queued write can LAND in the gap between the
    // failure and the user's click -- which is exactly the "delete offline, reconnect,
    // click Undo" sequence. A caller that assumed the cancel worked would then skip its
    // real undo and leave the server disagreeing with the UI, silently. False means
    // "already gone, do it for real."
    cancelBufferedWrite(walId, ids) {
      const pending = !!walId && walGet().some(e => e && e._walId === walId);
      if (!pending) return false;
      walRemove(walId);
      for (const id of ids || []) _tombstones.delete(id);
      setSaved();
      return true;
    },

    // Revive a soft-deleted row, keeping its ORIGINAL id (A2's POST /:id/undelete).
    // This is what makes Undo durable: the old undo re-created the rows as NEW ids from
    // a client-side snapshot, so it could not survive a reload — the snapshot lived in
    // memory — and it left the tombstones behind.
    //
    // WAL-buffered like every other mutation here, and that is not ceremony: without it
    // a lost ack leaves the task visible (the overlay un-hid it optimistically) while
    // the server still has deleted_at set, so the next reload loses it again. That is
    // the same resurrection-vs-vanish class B1 and the rest of B2 exist to close.
    // Replay is safe because undeleteBlock just clears deleted_at — idempotent.
    // Returns { ok, block } or { ok: false, permanent }. Deliberately NOT the bare row:
    // the caller has to be able to tell "not yet, buffered" from "never, rejected",
    // because those want opposite UI. Reporting a rejection as a success is how you get
    // an itinerary that claims a task is back until the next reload disagrees.
    async undeleteBlock(id) {
      setSaving();
      // Clear the local tombstone up front, or handleBlocksChanged will skip the very
      // id we are restoring. A2 broadcasts undeletedIds so OTHER tabs can do this; this
      // is the same fix for the tab that initiated it, which sees no broadcast of its own.
      _tombstones.delete(id);
      const walId = walPush({ op: "undelete", id });
      try {
        const block = await apiPost("/api/blocks/" + id + "/undelete", {});
        if (block && block.id) cacheSet(block);
        walRemove(walId);
        setSaved();
        return { ok: true, block };
      } catch (e) {
        // 409 = a live row already holds this tombstone's idempotency key; 404 = the row
        // is gone for real. Neither can ever succeed, so drop the entry rather than
        // retrying forever, and put the tombstone BACK: the row is still deleted, and
        // the cache must not start serving it as live.
        const permanent = !!e && (e.status === 409 || e.status === 404);
        if (permanent) {
          walRemove(walId);
          _tombstones.add(id);
          setError("Restore rejected — " + ((e && e.message) || (e && e.status) || "conflict"));
        } else {
          setError("Restore failed — buffered for retry");
        }
        return { ok: false, permanent };
      }
    },

    // Atomic multi-block operation
    async batchOp(operations) {
      setSaving();
      for (const op of operations) {
        if (op && op.op === "delete" && op.id) _tombstones.add(op.id);
      }
      const walId = walPush({ op: "batch", data: { operations } });
      try {
        const result = await apiPost("/api/blocks/batch", { operations });
        if (result.blocks) {
          for (const block of result.blocks) {
            if (!block || !block.id) continue;
            // A delete op's result is a bare { id, deleted_at } stub (db.deleteBlock),
            // not a block — cacheSet would file a typeless, propertyless row back into
            // the day cache and resurrect the id it just deleted.
            if (block.deleted_at) cacheDelete(block.id);
            else cacheSet(block);
          }
        }
        walRemove(walId);
        setSaved();
        return { ...result, ok: true, walId, buffered: false };
      } catch (e) {
        setError("Batch save failed — buffered for retry");
        // `buffered: true` says the write did NOT land and is still in the WAL. Callers
        // could not tell before: this returned the same empty-blocks shape either way,
        // so a caller that needed to know whether its write reached the server had to
        // guess from an empty array. state.js undoDeleteTask genuinely needs to know --
        // undoing a delete that never landed must cancel the queued delete, not revive a
        // row that was never deleted and then let the batch replay over the top of it.
        return {
          blocks: [],
          ok: false,
          walId,
          buffered: true,
          error: { message: (e && e.message) || "Batch save failed", status: (e && e.status) || null }
        };
      }
    },

    // Move a task + its whole subtask subtree to another date in one server-side
    // transaction (see POST /api/blocks/:id/reschedule). One round-trip regardless
    // of subtree size, one broadcast the origin client ignores (own clientId) — so
    // no snap-back, no duplication, no stranded children. The moved blocks now live
    // on targetDate, so evict them from the current-day cache.
    async rescheduleBlock(blockId, targetDate, { parentStart, parentEnd, fromDate, placement, userSetStart } = {}) {
      const previous = _rescheduleChains.get(blockId) || Promise.resolve();
      const run = previous.catch(() => {}).then(async () => {
      setSaving();
      // fromDate: the viewed origin day, used by the server when the block row
      // itself is undated (task-bar pending_tasks) so the move can't 400.
      // userSetStart: TRUE only when a human named the landing time. A timed placement
      // alone cannot say that — an auto-slotted cross-day move sends parentStart too —
      // and the flag is what makes the client cascade leave the start alone.
      const body = { targetDate, parentStart, parentEnd, fromDate, placement, userSetStart };
      const walId = walPush({ op: "reschedule", id: blockId, data: body });
      try {
        let result;
        try {
          result = await apiPost("/api/blocks/" + blockId + "/reschedule", body);
        } catch (e) {
          // A different tab may have moved this row after the route read it but
          // before its transaction acquired the lock. The server rejects that stale
          // subtree plan so no children can be stranded. Repeating once rebuilds the
          // plan from the row's current day and preserves the user's intent.
          if (!(e && e.status === 409 && e.code === "RESCHEDULE_STALE")) throw e;
          result = await apiPost("/api/blocks/" + blockId + "/reschedule", body);
        }
        (result.moved || []).forEach(id => cacheDelete(id));
        (result.blocks || []).forEach(b => { if (b && b.id) cacheSet(b); });
        // Tombstone(s) land on the ORIGIN (current) day — cache them so the amber
        // "Rescheduled away" list renders now, since we ignore our own SSE echo.
        (result.created || []).forEach(b => { if (b && b.id) cacheSet(b); });
        // A single durable all-day block can cover dates beyond either anchor.
        // Clear the week partitions after placement so no expanded copy stays stale.
        this.invalidateRangeCache();
        walRemove(walId);
        setSaved();
        return result;
      } catch (e) {
        // Same permanence rule as isPermanentReplayFailure: 400/404 are final,
        // 401/403 (auth blips) and 5xx/network stay buffered for replay. The
        // verdict is stamped on the error so callers don't re-derive it.
        if (e) e.permanent = e.status === 400 || e.status === 404 || e.status === 409;
        if (e && e.permanent) {
          // Permanent rejection: the server refused for a reason a retry cannot change
          // ("Already on that date", "Block is deleted", "Block not found", a bad
          // targetDate), so a buffered replay could only double-move or re-fail. Drop it
          // and let the caller report the reason.
          //
          // This comment used to say "the caller falls back to a clone move". C3 deleted
          // that fallback — state.js rescheduleTaskToDate now surfaces the server's own
          // message and changes nothing — but dropping the WAL entry is still right, and
          // for the same reason it always was.
          walRemove(walId);
          setError("Reschedule rejected — " + (e.message || e.status));
        } else {
          setError("Reschedule failed — buffered for retry");
        }
        throw e;
      }
      });
      _rescheduleChains.set(blockId, run);
      try {
        return await run;
      } finally {
        if (_rescheduleChains.get(blockId) === run) _rescheduleChains.delete(blockId);
      }
    },

    // Reorder blocks
    async reorder(items) {
      setSaving();
      try {
        await apiPost("/api/blocks/reorder", { items });
        // Update cache sort orders
        for (const item of items) {
          const block = cacheGet(item.id);
          if (block) cacheSet({ ...block, sort_order: item.sort_order });
        }
        setSaved();
      } catch (e) {
        setError("Reorder failed");
      }
    },

    // ── Read Operations ──

    // Load all blocks for a date (replaces the 11-fetch waterfall)
    async loadDay(dateStr) {
      // Navigation and the passive timer often ask for the same day together. Share
      // that request so neither caller can supersede the other and then hydrate from
      // the previous day's cache while the winning request is still pending.
      const existing = _dayLoadsByDate.get(dateStr);
      if (existing && existing.mutationGeneration === _mutationGeneration && _dayLoadTargetDate === dateStr) return existing.promise;
      // A persisted WAL can exist before boot has any optimistic cache to protect.
      // Permit that one initial hydration; replay will rehydrate and notify once it
      // drains. Runtime refreshes still refuse to replace a populated optimistic cache.
      const allowInitialHydration = _currentDate === null && _dayCache.size === 0;
      if (hasPendingWritesNow() && !allowInitialHydration) return null;

      const sequence = ++_dayLoadSequence;
      _dayLoadTargetDate = dateStr;
      const mutationGeneration = _mutationGeneration;
      let entry = null;
      const load = (async () => {
        try {
          if (window.DCC_DELTA_SYNC_ENABLED) {
            const delta = await pullSyncChanges(dateStr);
            if (!delta) return null;
            if (sequence !== _dayLoadSequence || _dayLoadTargetDate !== dateStr
              || mutationGeneration !== _mutationGeneration
              || (hasPendingWritesNow() && !allowInitialHydration)) return null;
            return [..._dayCache.values()];
          }
          const blocks = await apiGet("/api/blocks?date=" + dateStr);
          // A different date won, or a write started after this GET. In either case,
          // applying the response would replace newer cache state with an old snapshot.
          if (sequence !== _dayLoadSequence || mutationGeneration !== _mutationGeneration || (hasPendingWritesNow() && !allowInitialHydration)) return null;
          // Fetch first, replace second. Clearing before the request created an empty-cache
          // window where an unrelated SSE event could rebuild the whole itinerary as open.
          _currentDate = dateStr;
          _currentDayRootId = null;
          _dayCache.clear();
          // Route through cacheSet so pinned/global blocks land in _globalCache
          // rather than being evicted on the next date switch.
          for (const b of blocks) cacheSet(b);
          // Resolve the real day_root id (may be workspace-prefixed server-side).
          // saveDoneState / reloadPersistedEdits / child-block parentId all depend
          // on this being the id the server actually stored.
          const root = blocks.find(b => b.type === "day_root");
          if (root) _currentDayRootId = root.id;
          return blocks;
        } catch (e) {
          console.error("[BlockStore] loadDay failed:", e);
          return null;
        }
      })().finally(() => {
        if (_dayLoadsByDate.get(dateStr) === entry) _dayLoadsByDate.delete(dateStr);
      });
      entry = { promise: load, mutationGeneration };
      _dayLoadsByDate.set(dateStr, entry);
      return load;
    },

    // Load global blocks (unified blocks without dates + legacy global types)
    async loadGlobals() {
      if (window.DCC_DELTA_SYNC_ENABLED && _syncCursor !== null) {
        return [..._globalCache.values()];
      }
      const types = ["block", ...LEGACY_GLOBAL_TYPES].join(",");
      const allowInitialHydration = _globalCache.size === 0;
      if (hasPendingWritesNow() && !allowInitialHydration) return null;
      const mutationGeneration = _mutationGeneration;
      try {
        const blocks = await apiGet("/api/blocks?type=" + types);
        if (mutationGeneration !== _mutationGeneration || (hasPendingWritesNow() && !allowInitialHydration)) return null;
        // This query is the complete live set for every type routed to the global
        // partition. Replace that partition so a replayed delete is represented by
        // the row's absence instead of leaving the old cached copy behind forever.
        _globalCache.clear();
        // Route through cacheSet so pinned blocks (sticky notes stored with a
        // stale date) are classified as global and survive date navigation.
        for (const b of blocks) cacheSet(b);
        return blocks;
      } catch (e) {
        console.error("[BlockStore] loadGlobals failed:", e);
        return null;
      }
    },

    // Load DCC-owned state for a date
    async loadDccState(dateStr) {
      try {
        const result = await apiGet("/api/dcc-state/" + dateStr);
        return result?.state_json || null;
      } catch (e) {
        console.error("[BlockStore] loadDccState failed:", e);
        return null;
      }
    },

    // ── Query Cache ──

    getByType(type) {
      // Unified: 'block' type searches BOTH caches (global + day)
      if (type === "block") {
        return [..._globalCache.values(), ..._dayCache.values()]
          .filter(b => b.type === "block" && !b.deleted_at)
          .sort((a, b) => a.sort_order - b.sort_order);
      }
      const source = LEGACY_GLOBAL_TYPES.has(type) ? _globalCache : _dayCache;
      return [...source.values()].filter(b => b.type === type && !b.deleted_at)
        .sort((a, b) => a.sort_order - b.sort_order);
    },

    getChildren(parentId) {
      // Children could be in either cache
      const all = [..._dayCache.values(), ..._globalCache.values()];
      return all.filter(b => b.parent_id === parentId && !b.deleted_at)
        .sort((a, b) => a.sort_order - b.sort_order);
    },

    get(id) {
      return cacheGet(id);
    },

    getCurrentDate() {
      return _currentDate;
    },

    getDayRootId() {
      if (_currentDayRootId) return _currentDayRootId;
      // Fallback for the narrow window between setting _currentDate and loadDay
      // populating the cache. Also matches the legacy naming for workspaces that
      // never got the workspace-prefix migration (server falls back to this id).
      return "day-root-" + _currentDate;
    },

    // ── Actual time tracking (day-review) ──
    // Create one actual time-tracking segment for a task on `date` (default the
    // viewed date). Lives under that day's day_root; loads via date+type query,
    // so parent-id exactness is not required. Returns the created block.
    async logTimeEntry({ blockId, taskTitle, start, end, durSec, source, note, date } = {}) {
      const d = date || _currentDate;
      const parentId = (d === _currentDate) ? this.getDayRootId() : ("day-root-" + d);
      const props = {
        blockId: blockId || null,
        taskTitle: taskTitle || "",
        start: start || null,
        end: end || null,
        durSec: Math.max(0, Math.round(durSec || 0)),
        source: source || "manual"
      };
      if (note) props.note = note;
      return this.createBlock("time_entry", props, { parentId, date: d });
    },

    // All live time_entry blocks for a date — day cache for the current date,
    // range cache otherwise. Used by the day-review model + HUD.
    getTimeEntries(dateStr) {
      const ds = dateStr || _currentDate;
      if (ds === _currentDate) {
        return [..._dayCache.values(), ..._globalCache.values()]
          .filter(b => b.type === "time_entry" && !b.deleted_at && (b.date === ds || !b.date));
      }
      const cached = this._rangeCache.get(ds);
      return cached ? cached.blocks.filter(b => b.type === "time_entry" && !b.deleted_at) : [];
    },

    // ── Range Loading (for Calendar View) ──
    _rangeCache: new Map(), // dateStr -> { blocks: [], dccState: null }

    async loadDateRange(startDate, endDate) {
      try {
        // dcc-state is nice-to-have here; blocks are what the range consumers
        // (day-review, Catch up, Unfinished) need. Don't let one failure nuke
        // the whole cache fill.
        const [blocksRes, dccRes] = await Promise.allSettled([
          apiGet(`/api/blocks/range?start=${startDate}&end=${endDate}`),
          apiGet(`/api/dcc-state/range?start=${startDate}&end=${endDate}`)
        ]);
        if (blocksRes.status !== "fulfilled") throw blocksRes.reason;
        const blocks = blocksRes.value || [];
        const dccStates = (dccRes.status === "fulfilled" && dccRes.value) || {};
        // Group blocks by date
        const byDate = {};
        for (const b of blocks) {
          const p = b.properties || {};
          if (p.all_day && p.all_day_start && p.all_day_end) {
            const cur = new Date(p.all_day_start + "T12:00:00Z");
            const stop = new Date(p.all_day_end + "T12:00:00Z");
            while (cur < stop) {
              const ds = cur.toISOString().slice(0, 10);
              if (ds >= startDate && ds <= endDate) {
                if (!byDate[ds]) byDate[ds] = [];
                if (!byDate[ds].some(x => x.id === b.id)) byDate[ds].push(b);
              }
              cur.setUTCDate(cur.getUTCDate() + 1);
            }
          } else {
            const ds = b.date || "unknown";
            if (!byDate[ds]) byDate[ds] = [];
            byDate[ds].push(b);
          }
        }
        // Cache each date
        const d = new Date(startDate + "T12:00:00Z");
        const end = new Date(endDate + "T12:00:00Z");
        while (d <= end) {
          const ds = d.toISOString().slice(0, 10);
          this._rangeCache.set(ds, {
            blocks: byDate[ds] || [],
            dccState: dccStates[ds] || null
          });
          d.setUTCDate(d.getUTCDate() + 1);
        }
        return { blocks, dccStates };
      } catch (e) {
        console.error("[BlockStore] loadDateRange failed:", e);
        return { blocks: [], dccStates: {} };
      }
    },

    getRangeCache(dateStr) {
      return this._rangeCache.get(dateStr) || null;
    },

    invalidateRangeCache(dateStr) {
      if (dateStr) this._rangeCache.delete(dateStr);
      else this._rangeCache.clear();
    },

    // ── SSE Integration ──

    // Called by SSE when blocks change from another source (tab, scheduled task)
    async handleBlocksChanged(event) {
      if (event.clientId === CLIENT_ID) return; // ignore own changes
      if (typeof window.notifyReadyTaskDependencies === "function") {
        window.notifyReadyTaskDependencies(event.dependencyTransitions || []);
      }
      if (window.DCC_DELTA_SYNC_ENABLED && _currentDate) {
        _mutationGeneration++;
        return pullSyncChanges(_currentDate);
      }
      // A row-level reconciliation that starts after a full-day GET must win. Bump
      // the same generation used by loadDay so the older snapshot cannot clear and
      // replace the just-refreshed foreign row when it resolves later.
      _mutationGeneration++;
      // A restore performed elsewhere has to clear our local tombstone FIRST, or the
      // loop below skips the very id we were told to re-read and the row stays
      // invisible in this tab until a reload. POST /api/blocks/:id/undelete carries
      // undeletedIds for exactly this.
      if (event.undeletedIds && event.undeletedIds.length) {
        for (const id of event.undeletedIds) _tombstones.delete(id);
      }
      // Re-fetch affected blocks
      if (event.blockIds && event.blockIds.length) {
        for (const id of event.blockIds) {
          if (_tombstones.has(id)) continue; // we deleted it; don't re-fetch the tombstone
          try {
            const block = await apiGet("/api/blocks/" + id);
            // The broadcast may be another tab's delete, which no local tombstone
            // covers. Trust deleted_at over the fact that we were told to look. Kept
            // as belt and braces now that the route 404s: /api/blocks/range and the
            // day load still hand back rows this way.
            if (block && block.deleted_at) cacheDelete(id);
            else if (block) cacheSet(block);
          } catch (e) {
            // A 404 IS the signal, not a failure to get one. A2 made GET /api/blocks/:id
            // 404 on a tombstone, so a foreign tab's delete now arrives here rather than
            // as a row carrying deleted_at — and a bare `catch {}` left the deleted row
            // sitting in this tab's cache until a reload. Measured before and after.
            // Anything that is not a 404 (offline, 500, SSE racing a redeploy) must still
            // be swallowed: evicting on those would blank rows that are perfectly alive.
            if (e && e.status === 404) cacheDelete(id);
          }
        }
      }
    },

    // Called by SSE when DCC state changes
    async handleDccStateChanged(event) {
      // Only refresh if it's for the current date
      if (event.date === _currentDate || !event.date) {
        if (window.DCC_DELTA_SYNC_ENABLED && _currentDate) return pullSyncChanges(_currentDate, { includeState: true });
        return await this.loadDccState(event.date || _currentDate);
      }
      return null;
    },

    // ── WAL ──
    replayWAL,
    hydrateSyncSnapshot,
    pullSyncChanges,

    // Passive refreshes must not replace optimistic client state with a server snapshot
    // while a write is queued, debounced, active, or replaying.
    hasPendingWrites() {
      return hasPendingWritesNow();
    },

    getMutationGeneration() {
      return _mutationGeneration;
    },

    // ── Debug ──
    debug() {
      return {
        clientId: CLIENT_ID,
        currentDate: _currentDate,
        dayCacheSize: _dayCache.size,
        globalCacheSize: _globalCache.size,
        walEntries: walGet().length,
        deadLetterEntries: (() => { try { return JSON.parse(localStorage.getItem(WAL_DEAD_LETTER_KEY) || "[]").length; } catch { return 0; } })(),
        completionMetrics: { ..._completionMetrics },
        syncCursor: _syncCursor,
      };
    }
  };

  // Expose globally
  window.blockStore = blockStore;

  // Flush pending content edits on page unload
  window.addEventListener("beforeunload", flushContentEdits);

  // Replay WAL on load (if server was down last session)
  if (walGet().length > 0) {
    setTimeout(() => replayWAL(), 2000);
  }

  // Replay triggers beyond SSE reconnect, so a pending write doesn't have to
  // wait on EventSource's backoff to reach the server:
  //  - 'online' fires the instant the browser regains connectivity.
  //  - 'visibilitychange' catches the "tab was backgrounded, now we're back"
  //    case, where SSE may have been paused by the browser.
  //  - Periodic sweep is a safety net for flaky connections where neither
  //    event fires reliably.
  window.addEventListener("online", () => {
    if (walGet().length > 0) replayWAL();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && walGet().length > 0) replayWAL();
  });
  setInterval(() => {
    if (navigator.onLine !== false && walGet().length > 0) replayWAL();
  }, 30000);

})();
