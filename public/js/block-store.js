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
    const display = window.__DCC_HEALTH_ERROR || msg || "Save failed";
    if (typeof updateSaveStatus === "function") updateSaveStatus("error", display);
    if (typeof showToast === "function") showToast(msg || display || "Save failed - will retry", "error");
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

  // ── API Helpers ──
  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, _clientId: CLIENT_ID })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e = new Error(err.error || `API error ${res.status}`);
      e.status = res.status;
      throw e;
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
      const e = new Error(err.error || `API error ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  async function apiDelete(url) {
    const res = await fetch(url + "?_clientId=" + CLIENT_ID, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e = new Error(err.error || `API error ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
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

  function cacheSet(block) {
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
    // and returns { blocks: [] } without ever consulting this function, so a 404 there
    // is always buffered. The loop below is the only consulter — and a `false` verdict
    // there means the entry is re-queued forever behind a permanent "N edits pending"
    // banner, because nothing else caps a batch's attempts.
    // "undelete" too: A2's route 404s when the row is gone for real (hard-deleted, or
    // purged by the 30-day purgeSoftDeleted sweep). There is nothing left to revive, so
    // retrying can only fail again.
    if ((entry.op === "update" || entry.op === "delete" || entry.op === "reschedule" || entry.op === "batch" || entry.op === "undelete") && err.status === 404) return true;
    return false;
  }

  let _replaying = false;
  async function replayWAL() {
    if (_replaying) return; // avoid overlapping replays (SSE reconnect + boot)
    const entries = walGet();
    if (!entries.length) return;
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
            await apiPatch("/api/blocks/" + entry.id, entry.data);
            break;
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
        }
        walRemove(entry._walId);
        succeeded++;
      } catch (e) {
        if (isPermanentReplayFailure(entry, e)) {
          walMoveToDeadLetter(entry, `${e.status || "error"} ${e.message || ""}`.trim());
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
    } else {
      console.warn("[BlockStore] WAL replay:", succeeded, "ok,", dropped, "stale dropped,", failed, "still queued for retry");
      setError(failed + " edits pending — will retry");
    }
  }

  // ── Main BlockStore API ──
  const blockStore = {

    CLIENT_ID,

    // NOTE: day-context.js wraps these mutators at runtime (createBlock,
    // updateBlock, deleteBlock, rescheduleBlock, batchOp) to invalidate its
    // per-day slot cache after each write. If you add a new server-mutating
    // method here, add it to that wrap list too or its day can go stale.
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
        properties,
        sort_order: sortOrder || 0
      };
      // Optimistic cache update BEFORE API call — so reads (e.g. loadNotes) are instant
      // and don't race with the async API response. Same pattern as updateBlock().
      // The id is final from the start now, so there is no placeholder entry to swap out
      // afterwards and no window where the cache holds an id nothing else can resolve.
      const optimistic = {
        ...payload,
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
    async updateBlock(id, properties, extra) {
      setSaving();
      // extra carries top-level column changes the server PATCH accepts beyond
      // properties — today just {date}, used when an Unscheduled row is
      // promoted onto a day.
      extra = extra || {};
      // Optimistic cache update BEFORE API call — so reads are instant
      const existing = cacheGet(id);
      const optimistic = existing ? { ...existing, ...extra, properties, updated_at: new Date().toISOString() } : null;
      if (optimistic) cacheSet(optimistic);
      // Pre-write to WAL so the mutation survives a mid-flight reload / close.
      const walId = walPush({ op: "update", id, data: { properties, ...extra } });
      try {
        const block = await apiPatch("/api/blocks/" + id, { properties, ...extra });
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
      _tombstones.add(id);
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
        return block;
      } catch (e) {
        setError("Restore failed — buffered for retry");
        return null;
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
        return result;
      } catch (e) {
        setError("Batch save failed — buffered for retry");
        return { blocks: [] };
      }
    },

    // Move a task + its whole subtask subtree to another date in one server-side
    // transaction (see POST /api/blocks/:id/reschedule). One round-trip regardless
    // of subtree size, one broadcast the origin client ignores (own clientId) — so
    // no snap-back, no duplication, no stranded children. The moved blocks now live
    // on targetDate, so evict them from the current-day cache.
    async rescheduleBlock(blockId, targetDate, { parentStart, parentEnd, fromDate } = {}) {
      setSaving();
      // fromDate: the viewed origin day, used by the server when the block row
      // itself is undated (task-bar pending_tasks) so the move can't 400.
      const body = { targetDate, parentStart, parentEnd, fromDate };
      const walId = walPush({ op: "reschedule", id: blockId, data: body });
      try {
        const result = await apiPost("/api/blocks/" + blockId + "/reschedule", body);
        (result.moved || []).forEach(id => cacheDelete(id));
        // Tombstone(s) land on the ORIGIN (current) day — cache them so the amber
        // "Rescheduled away" list renders now, since we ignore our own SSE echo.
        (result.created || []).forEach(b => { if (b && b.id) cacheSet(b); });
        walRemove(walId);
        setSaved();
        return result;
      } catch (e) {
        // Same permanence rule as isPermanentReplayFailure: 400/404 are final,
        // 401/403 (auth blips) and 5xx/network stay buffered for replay. The
        // verdict is stamped on the error so callers don't re-derive it.
        if (e) e.permanent = e.status === 400 || e.status === 404;
        if (e && e.permanent) {
          // Permanent rejection: the caller falls back to a clone move, so a
          // buffered replay of this entry could only double-move the task.
          walRemove(walId);
          setError("Reschedule rejected — " + (e.message || e.status));
        } else {
          setError("Reschedule failed — buffered for retry");
        }
        throw e;
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
    async logTimeEntry({ blockId, taskTitle, start, end, durSec, source, pomoType, note, date } = {}) {
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
      if (pomoType) props.pomoType = pomoType;
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
            dccState: dccStates[ds] || null
          });
          d.setDate(d.getDate() + 1);
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
        return await this.loadDccState(event.date || _currentDate);
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
        walEntries: walGet().length,
        deadLetterEntries: (() => { try { return JSON.parse(localStorage.getItem(WAL_DEAD_LETTER_KEY) || "[]").length; } catch { return 0; } })()
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
