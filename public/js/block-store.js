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
  const WAL_LEGACY_SESSION_KEY = "blockstore-wal"; // same name, older sessionStorage home

  // ── Partitioned Cache ──
  let _dayCache = new Map();   // id → block (cleared on date switch)
  let _globalCache = new Map(); // id → block (persistent across dates)
  let _currentDate = null;
  // Server IDs for day_root are workspace-prefixed (e.g. "day-root-ws-1-2026-04-24").
  // Resolved from the block list returned by loadDay() so callsites can look up
  // the cached root reliably, not a naive "day-root-<date>" that misses.
  let _currentDayRootId = null;

  // ── Save Status Helpers ──
  function setSaving() {
    if (typeof updateSaveStatus === "function") updateSaveStatus("saving", "Saving...");
  }
  function setSaved() {
    if (typeof updateSaveStatus === "function") updateSaveStatus("ok", "All changes saved");
  }
  function setError(msg) {
    if (typeof updateSaveStatus === "function") updateSaveStatus("error", msg || "Save failed");
    if (typeof showToast === "function") showToast(msg || "Save failed — will retry", "error");
  }

  // ── Write-Ahead Log (localStorage) ──
  // Every mutation pushes an entry before the fetch fires and removes it only on
  // server ack. localStorage survives tab close, reloads mid-flight, and browser
  // crashes, so pending writes replay on next boot instead of being lost.
  function walPush(entry) {
    const entryId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ("w-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    try {
      const wal = JSON.parse(localStorage.getItem(WAL_KEY) || "[]");
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

  // ── API Helpers ──
  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, _clientId: CLIENT_ID })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `API error ${res.status}`);
    }
    return res.json();
  }

  async function apiPatch(url, body) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, _clientId: CLIENT_ID })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `API error ${res.status}`);
    }
    return res.json();
  }

  async function apiDelete(url) {
    const res = await fetch(url + "?_clientId=" + CLIENT_ID, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `API error ${res.status}`);
    }
    return res.json();
  }

  async function apiGet(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }

  // ── Cache Helpers ──
  // Unified block architecture: all user data is type='block'.
  // Cache partitioning: blocks WITH a date go in dayCache, blocks WITHOUT go in globalCache.
  // Legacy type names also route to globalCache for backward compat during migration.
  const LEGACY_GLOBAL_TYPES = new Set(["sticky_note", "trivial_task", "life_capture", "pending_task", "schedule_block", "tag"]);

  function cacheSet(block) {
    // Remove any prior entry in either cache so a block can migrate between
    // global and day partitions without leaving a stale duplicate behind.
    _dayCache.delete(block.id);
    _globalCache.delete(block.id);
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
        fetch("/api/blocks/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ properties: block.properties, _clientId: CLIENT_ID }),
          keepalive: true
        }).catch(() => {});
      }
      delete _contentTimers[id];
    }
  }

  // ── WAL Replay (on reconnect / boot) ──
  // Replays every pending mutation and removes each entry on its own success.
  // Failures stay queued so the next reconnect (or next boot) can retry them --
  // a partial failure no longer wipes the unreplayed entries.
  let _replaying = false;
  async function replayWAL() {
    if (_replaying) return; // avoid overlapping replays (SSE reconnect + boot)
    const entries = walGet();
    if (!entries.length) return;
    _replaying = true;
    console.log("[BlockStore] Replaying", entries.length, "buffered writes...");
    let succeeded = 0, failed = 0;
    for (const entry of entries) {
      try {
        switch (entry.op) {
          case "create":
            await apiPost("/api/blocks", entry.data);
            break;
          case "update":
            await apiPatch("/api/blocks/" + entry.id, entry.data);
            break;
          case "delete":
            await apiDelete("/api/blocks/" + entry.id);
            break;
          case "batch":
            await apiPost("/api/blocks/batch", entry.data);
            break;
        }
        walRemove(entry._walId);
        succeeded++;
      } catch (e) {
        failed++;
        console.warn("[BlockStore] WAL replay failed for", entry.op, entry.id || "", e.message);
      }
    }
    _replaying = false;
    if (failed === 0) {
      console.log("[BlockStore] WAL replay complete (", succeeded, "writes )");
      setSaved();
    } else {
      console.warn("[BlockStore] WAL replay:", succeeded, "ok,", failed, "still queued for retry");
      setError(failed + " edits pending — will retry");
    }
  }

  // ── Main BlockStore API ──
  const blockStore = {

    CLIENT_ID,

    // Create a new block
    async createBlock(type, properties, { parentId, date, sortOrder } = {}) {
      setSaving();
      const payload = {
        type,
        parent_id: parentId || null,
        date: date !== undefined ? date : _currentDate,
        properties,
        sort_order: sortOrder || 0
      };
      // Optimistic cache update BEFORE API call — so reads (e.g. loadNotes) are instant
      // and don't race with the async API response. Same pattern as updateBlock().
      const tmpId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      const optimistic = {
        id: tmpId, ...payload,
        properties,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null
      };
      cacheSet(optimistic);
      // Pre-write to WAL so the mutation survives a mid-flight reload / close.
      const walId = walPush({ op: "create", data: payload });
      try {
        const block = await apiPost("/api/blocks", payload);
        // Swap optimistic entry for the real server block
        _dayCache.delete(tmpId);
        _globalCache.delete(tmpId);
        cacheSet(block);
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
    async updateBlock(id, properties) {
      setSaving();
      // Optimistic cache update BEFORE API call — so reads are instant
      const existing = cacheGet(id);
      const optimistic = existing ? { ...existing, properties, updated_at: new Date().toISOString() } : null;
      if (optimistic) cacheSet(optimistic);
      // Pre-write to WAL so the mutation survives a mid-flight reload / close.
      const walId = walPush({ op: "update", id, data: { properties } });
      try {
        const block = await apiPatch("/api/blocks/" + id, { properties });
        cacheSet(block); // Replace optimistic with server response
        walRemove(walId);
        setSaved();
        return block;
      } catch (e) {
        setError("Save failed — buffered for retry");
        // Entry stays in WAL; replayed on next connect.
        return optimistic || existing;
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
      const walId = walPush({ op: "delete", id });
      try {
        await apiDelete("/api/blocks/" + id);
        cacheDelete(id);
        walRemove(walId);
        setSaved();
      } catch (e) {
        setError("Delete failed — buffered for retry");
        cacheDelete(id);
      }
    },

    // Atomic multi-block operation
    async batchOp(operations) {
      setSaving();
      const walId = walPush({ op: "batch", data: { operations } });
      try {
        const result = await apiPost("/api/blocks/batch", { operations });
        if (result.blocks) {
          for (const block of result.blocks) {
            if (block.id) cacheSet(block);
          }
        }
        walRemove(walId);
        setSaved();
        return result;
      } catch (e) {
        setError("Batch save failed — buffered for retry");
        return { blocks: [] };
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
      _currentDate = dateStr;
      _currentDayRootId = null;
      _dayCache.clear();
      try {
        const blocks = await apiGet("/api/blocks?date=" + dateStr);
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
        return [];
      }
    },

    // Load global blocks (unified blocks without dates + legacy global types)
    async loadGlobals() {
      const types = ["block", ...LEGACY_GLOBAL_TYPES].join(",");
      try {
        const blocks = await apiGet("/api/blocks?type=" + types);
        // Route through cacheSet so pinned blocks (sticky notes stored with a
        // stale date) are classified as global and survive date navigation.
        for (const b of blocks) cacheSet(b);
        return blocks;
      } catch (e) {
        console.error("[BlockStore] loadGlobals failed:", e);
        return [];
      }
    },

    // Load PA-owned state for a date
    async loadPaState(dateStr) {
      try {
        const result = await apiGet("/api/pa-state/" + dateStr);
        return result?.state_json || null;
      } catch (e) {
        console.error("[BlockStore] loadPaState failed:", e);
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

    // ── Range Loading ──
    _rangeCache: new Map(), // dateStr → { blocks: [], paState: null }

    async loadDateRange(startDate, endDate) {
      try {
        const [blocks, paStates] = await Promise.all([
          apiGet(`/api/blocks/range?start=${startDate}&end=${endDate}`),
          apiGet(`/api/pa-state/range?start=${startDate}&end=${endDate}`)
        ]);
        // Group blocks by date
        const byDate = {};
        for (const b of blocks) {
          const d = b.date || "unknown";
          if (!byDate[d]) byDate[d] = [];
          byDate[d].push(b);
        }
        // Cache each date
        const d = new Date(startDate);
        const end = new Date(endDate);
        while (d <= end) {
          const ds = d.toISOString().slice(0, 10);
          this._rangeCache.set(ds, {
            blocks: byDate[ds] || [],
            paState: paStates[ds] || null
          });
          d.setDate(d.getDate() + 1);
        }
        return { blocks, paStates };
      } catch (e) {
        console.error("[BlockStore] loadDateRange failed:", e);
        return { blocks: [], paStates: {} };
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
      // Re-fetch affected blocks
      if (event.blockIds && event.blockIds.length) {
        for (const id of event.blockIds) {
          try {
            const block = await apiGet("/api/blocks/" + id);
            if (block) cacheSet(block);
          } catch {} // block may have been deleted
        }
      }
    },

    // Called by SSE when PA state changes
    async handlePaStateChanged(event) {
      // Only refresh if it's for the current date
      if (event.date === _currentDate || !event.date) {
        return await this.loadPaState(event.date || _currentDate);
      }
      return null;
    },

    // ── WAL ──
    replayWAL,

    // ── Debug ──
    debug() {
      return {
        clientId: CLIENT_ID,
        currentDate: _currentDate,
        dayCacheSize: _dayCache.size,
        globalCacheSize: _globalCache.size,
        walEntries: walGet().length
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
