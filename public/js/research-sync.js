// Owner-namespaced durable outbox. Revisions conflict visibly, never overwrite silently.
(() => {
  "use strict";
  let db, owner, active, conflict, latest, localTime;
  const status = () =>
    window.dispatchEvent(
      new CustomEvent("research-sync", { detail: { pending: undefined, conflict, latest, localTime } })
    );
  async function init(identity) {
    owner = identity.userId + ":" + identity.workspaceId;
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("dcc-research-v1", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("outbox", { keyPath: "key" });
        r.result.createObjectStore("cache", { keyPath: "key" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const state = await read("cache", "status");
    latest = state?.value.latest;
    localTime = state?.value.localTime;
    void sync();
    return api;
  }
  function transaction(store, mode, run) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let r;
      try {
        r = run(t.objectStore(store));
      } catch (e) {
        reject(e);
        return;
      }
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("Local save failed"));
    });
  }
  const key = (k) => owner + ":" + k;
  const read = (store, k) => transaction(store, "readonly", (s) => s.get(key(k)));
  const put = (store, k, value) => transaction(store, "readwrite", (s) => s.put({ key: key(k), value }));
  async function pending() {
    const all = await transaction("outbox", "readonly", (s) => s.getAll());
    return all.filter((r) => r.key.startsWith(owner + ":")).sort((a, b) => a.value.at - b.value.at);
  }
  async function request(url, method, body) {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-DCC-Wishlist": "1", "X-DCC-Research-Owner": owner },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const result = await response.json();
    if (response.ok && url.startsWith("/api/research") && response.headers.get("X-DCC-Research-Owner") !== owner)
      throw Object.assign(new Error("Account changed. Reopen Research & Ideas."), { status: 401 });
    if (!response.ok)
      throw Object.assign(new Error(result.error || "Request could not be confirmed"), { status: response.status });
    return result;
  }
  async function verifyOwner() {
    const r = await request("/api/me", "GET");
    const v = r.user || r;
    if ((v.id || r.userId) + ":" + (r.workspaceId || v.workspaceId) !== owner)
      throw Object.assign(new Error("Account changed. Reopen Research & Ideas."), { status: 401 });
  }
  async function sync() {
    if (active) return active;
    active = (async () => {
      conflict = null;
      try {
        const list = await pending();
        if (list.length) await verifyOwner();
        for (const entry of list) {
          const v = entry.value;
          if (v.rejected) continue;
          try {
            await request(v.url, v.method, v.body);
          } catch (e) {
            if (e.status === 400 || e.status === 404) {
              await transaction("outbox", "readwrite", (s) =>
                s.put({ ...entry, value: { ...v, rejected: e.message } })
              );
              continue;
            }
            conflict = e.status === 409 ? "A saved edit conflicts. Review pending edits before retrying." : e.message;
            break;
          }
          await transaction("outbox", "readwrite", (s) => s.delete(entry.key));
          latest = new Date().toISOString();
          await put("cache", "status", { latest, localTime });
        }
      } catch (e) {
        conflict = e.message;
      } finally {
        active = null;
        status();
      }
    })();
    return active;
  }
  async function api(url, method = "GET", body) {
    if (method === "GET" || url.endsWith("/search")) {
      try {
        await sync();
        const result = await request(url, method, body);
        await put("cache", url + JSON.stringify(body ?? null), result);
        return result;
      } catch (e) {
        if (e.status) throw e;
        const old = await read("cache", url + JSON.stringify(body ?? null));
        if (old) return old.value;
        throw e;
      }
    }
    if (url.endsWith("/action")) {
      await sync();
      if ((await pending()).some((r) => !r.value.rejected))
        throw new Error("Sync pending research edits before creating work.");
      return request(url, method, body);
    }
    const id = body.mutationId || body.id;
    await put("outbox", id, { url, method, body, at: Date.now() });
    localTime = new Date().toISOString();
    await put("cache", "status", { latest, localTime });
    status();
    await sync();
    const left = await read("outbox", id);
    if (left?.value.rejected) throw new Error(left.value.rejected);
    if (left) throw new Error("Saved locally. " + (conflict || "Waiting to sync. Open sync status for details."));
    return { id: body.id, revision: body.revision + 1 };
  }
  window.ResearchSync = {
    init,
    sync,
    pending,
    get state() {
      return { conflict, latest, localTime };
    },
    async discard(k) {
      await transaction("outbox", "readwrite", (s) => s.delete(k));
      status();
    }
  };
  window.addEventListener("online", () => db && void sync());
  document.addEventListener("visibilitychange", () => db && !document.hidden && void sync());
  setInterval(() => db && void sync(), 300000);
})();
