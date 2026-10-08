(function () {
  "use strict";
  const account = window.DCC_ACCOUNT_CONTEXT;
  if (!account?.userId || !account.workspaceId) return;
  const scope = account.userId + ":" + account.workspaceId;
  let dbPromise;
  let flushing;
  let generation = 0, refreshSequence = 0;
  let summary = { pending: 0, attention: false, localError: null, lastSyncedAt: null, remoteError: null };
  function open() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("dcc-commitments:" + scope, 2);
      req.onupgradeneeded = () => {
        for (const [name, keyPath] of [["cache", "id"], ["outbox", "actionId"], ["meta", "key"]]) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }
  async function transaction(mode, run, expectedGeneration) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["cache", "outbox", "meta"], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Local save failed"));
      try {
        const meta = tx.objectStore("meta"), request = meta.get("generation");
        request.onsuccess = () => {
          const current = request.result?.value || 0;
          // This check and cache replacement share one IDB transaction. It
          // observes writes from every tab, including when Web Locks is absent.
          if (expectedGeneration !== undefined && current !== expectedGeneration) { result = false; return; }
          if (mode === "readwrite") meta.put({ key: "generation", value: current + 1 });
          try { result = run(tx.objectStore("cache"), tx.objectStore("outbox"), current); }
          catch (e) { tx.abort(); reject(e); }
        };
      }
      catch (e) { tx.abort(); reject(e); }
    });
  }
  async function durableGeneration() {
    const entries = await rows("meta");
    return entries.find(entry => entry.key === "generation")?.value || 0;
  }
  async function rows(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function notify() {
    const pending = await rows("outbox");
    summary = { ...summary, pending: pending.length, attention: pending.some(p => p.error) };
    if (typeof updateSaveStatus === "function") updateSaveStatus(summary.localError ? "local-error" : summary.attention || summary.remoteError ? "error" : "ok", summary.localError || (summary.attention ? "A commitment change needs review" : summary.remoteError ? "Commitments offline; local work is safe" : "Commitments saved locally"));
    window.dispatchEvent(new CustomEvent("dcc:commitments", { detail: summary }));
  }
  async function queue(record, body, create = false) {
    const pending = await rows("outbox");
    if (pending.some(p => p.commitmentId === record.id)) throw new Error("Review or sync this commitment's pending change first");
    const actionId = crypto.randomUUID();
    const input = create ? { ...body, actionId, id: record.id } : { ...body, actionId, expectedRevision: record.revision };
    const action = { actionId, commitmentId: record.id, scope, create, body: input, createdAt: Date.now() };
    try {
      await transaction("readwrite", (cache, outbox) => { cache.put(record); outbox.put(action); });
      generation++;
      summary.localError = null;
    } catch (e) {
      summary.localError = "Local save failed. This commitment change was not queued.";
      if (typeof updateSaveStatus === "function") updateSaveStatus("local-error", summary.localError);
      throw new Error(summary.localError, { cause: e });
    }
    await notify();
    void flush();
    return action;
  }
  async function refresh() {
    const startGeneration = generation, sequence = ++refreshSequence;
    try {
      const durableStart = await durableGeneration();
      const items = await DCC.api("/api/commitments");
      if (generation !== startGeneration || sequence !== refreshSequence) return rows("cache");
      const pending = await rows("outbox");
      const protectedIds = new Set(pending.filter(p => p.create && !p.error).map(p => p.commitmentId));
      const applied = await transaction("readwrite", cache => {
        const request = cache.getAll();
        request.onsuccess = () => {
          if (generation !== startGeneration || sequence !== refreshSequence) return;
          for (const item of request.result) if (!protectedIds.has(item.id)) cache.delete(item.id);
          for (const item of items) if (!protectedIds.has(item.id)) cache.put(item);
        };
        return true;
      }, durableStart);
      if (!applied) return rows("cache");
      summary.lastSyncedAt = Date.now();
      summary.remoteError = null;
    } catch (e) {
      if ([401,403,404].includes(e.status)) await transaction("readwrite", cache => cache.clear());
      // Offline cache is explicitly stale; permissions are rechecked on every write.
      summary.remoteError = e.message;
      if (e.status) throw e;
    }
    await notify();
    return rows("cache");
  }
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const run = async () => {
        for (const action of (await rows("outbox")).sort((a,b) => a.createdAt-b.createdAt)) {
          if (action.scope !== scope || action.error) continue;
          const durableStart = await durableGeneration();
          try {
            const result = await DCC.api(action.create ? "/api/commitments" : "/api/commitments/" + encodeURIComponent(action.commitmentId) + "/actions", { method: "POST", body: action.body });
            await transaction("readwrite", (cache, outbox, current) => {
              // Clear this exact receipt even when another tab already installed
              // newer state. An old acknowledgement cannot restore revoked data.
              if (current === durableStart) {
                if (result.declined) cache.delete(action.commitmentId); else cache.put(result);
              }
              outbox.delete(action.actionId);
            });
            generation++;
            summary.lastSyncedAt = Date.now();
            summary.remoteError = null;
          } catch (e) {
            if (!e.status || e.status >= 500) { summary.remoteError = e.message; break; }
            generation++;
            await transaction("readwrite", (cache, outbox, current) => {
              if (current !== durableStart) return;
              const request = outbox.get(action.actionId);
              request.onsuccess = () => {
                // A delayed failure must not resurrect acknowledged or discarded intent.
                if (!request.result) return;
                outbox.put({ ...action, error: e.message, status: e.status, code: e.code });
                if ([401,403,404].includes(e.status)) cache.delete(action.commitmentId);
              };
            });
          }
        }
      };
      if (navigator.locks) await navigator.locks.request("dcc-commitment-sync:" + scope, run);
      else await run();
      await notify();
    })().catch(e => {
      summary.localError = "Commitment storage needs attention: " + e.message;
      if (typeof updateSaveStatus === "function") updateSaveStatus("local-error", summary.localError);
    }).finally(() => { flushing = null; });
    return flushing;
  }
  async function discard(actionId) {
    await transaction("readwrite", (_cache, outbox) => outbox.delete(actionId));
    await refresh();
  }
  async function retry(actionId) {
    const action = (await rows("outbox")).find(p => p.actionId === actionId);
    if (!action) return;
    // Retry EXACTLY the same operation. Never auto-rebase a conflict or change
    // the principal to make a revoked/stale action succeed.
    await transaction("readwrite", (_cache, outbox) => outbox.put({ ...action, error: null, status: null }));
    await flush();
    await refresh();
  }
  window.DCCCommitmentSync = { queue, refresh, flush, discard, retry,
    cached: () => rows("cache"), pending: () => rows("outbox"), get summary() { return { ...summary }; } };
  window.addEventListener("online", () => { void flush().then(refresh).catch(() => {}); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void flush().then(refresh).catch(() => {}); });
  setInterval(() => { if (navigator.onLine !== false) void flush().then(refresh).catch(() => {}); }, 60000);
  void flush().then(refresh).catch(() => {});
})();
