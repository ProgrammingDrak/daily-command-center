// Journal task pages: device -> DCC server outbox for ONE journal page.
//
// The on-device record (page-store.js) is the queue. flush() sends whatever the
// record holds now, with expectedRevision = the last accepted server revision.
// Only the content the server accepted is acknowledged (store.acknowledge checks
// the mutation id), so strokes drawn while a request is in flight stay dirty and
// go in the next send. Never last-writer-wins: a stale revision is a conflict the
// user resolves.
//
// States reported through onStatus({state, message, revision}):
//   synced | pending | syncing | offline | retrying | signed-out | conflict | error
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JournalPageSync = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const BACKOFF = [2000, 10000, 30000, 120000, 300000];
  const IDLE_RECHECK = 1500;

  function create(options) {
    const opts = options || {};
    const store = opts.store;
    const journalId = opts.journalId;
    const send = opts.fetch;
    const onStatus = opts.onStatus || function () {};
    const isBusy = opts.isBusy || (() => false);
    const isOnline = opts.isOnline || (() => true);
    // Called as plain functions: a browser's setTimeout throws "Illegal
    // invocation" when called as a method of another object.
    const setT = opts.setTimeout || setTimeout, clearT = opts.clearTimeout || clearTimeout;
    const timers = { set: (fn, ms) => setT(fn, ms), clear: t => clearT(t) };
    // The task's server id. A task created moments ago is known on this device
    // by its local id until the block store learns the server row.
    const resolveTaskId = opts.resolveTaskId || (rec => rec.taskId);
    const backoff = opts.backoff || BACKOFF;

    let running = null;
    let again = false;
    let timer = null;
    let attempt = 0;
    let paused = null;     // "signed-out" | "conflict" | "error": wait for resume()
    let stopped = false;
    let last = null;

    function status(state, extra) {
      last = Object.assign({ state, journalId }, extra || {});
      onStatus(last);
    }
    function schedule(ms) {
      if (stopped) return;
      if (timer) timers.clear(timer);
      timer = timers.set(() => { timer = null; flush(); }, ms);
    }

    async function once() {
      if (!isOnline()) { status("offline", { message: "Offline. Saved on this device." }); return "wait"; }
      if (isBusy()) { schedule(IDLE_RECHECK); return "wait"; }
      const rec = await store.load(journalId);
      if (!rec) return "done";
      if (rec.conflict) { paused = "conflict"; status("conflict", { message: "Changed on another device." }); return "done"; }
      if (!rec.dirty) { attempt = 0; status("synced", { revision: rec.baseRevision }); return "done"; }
      // An ambiguous or mismatched task binding sends NOTHING and says why.
      let taskId;
      try { taskId = resolveTaskId(rec); }
      catch (e) { paused = "error"; status("error", { message: (e && e.message) || "This page cannot be matched to its task.", fatal: true, code: e && e.code }); return "done"; }
      if (!taskId) { status("error", { message: "This page has no task to save to." }); paused = "error"; return "done"; }
      const sentMutationId = rec.mutationId;
      status("syncing");
      let res;
      try {
        res = await send("/api/journal/tasks/" + encodeURIComponent(taskId), {
          method: "PUT", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ journalId, ink: rec.ink || null, body: rec.body || "", expectedRevision: rec.baseRevision || 0, mutationId: sentMutationId }),
        });
      } catch (e) {
        return retry(isOnline() ? "Could not reach DCC. Saved on this device; retrying." : "Offline. Saved on this device.");
      }
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.ok && data && Number.isInteger(data.revision)) {
        attempt = 0;
        const after = await store.acknowledge(journalId, sentMutationId, data.revision);
        return after && after.dirty ? "again" : (status("synced", { revision: data.revision }), "done");
      }
      const code = data && data.code;
      if (res.status === 401) { paused = "signed-out"; status("signed-out", { message: "Sign in to sync. Saved on this device." }); return "done"; }
      if (res.status === 409 && code === "JOURNAL_CONFLICT") {
        // The user can only choose between two pages if both are on this device.
        // If the saved copy cannot be fetched, stay retryable instead of parking
        // the page in a conflict with nothing to compare against.
        const current = await fetchServer(taskId);
        if (!current) return retry("Changed on another device; loading the saved copy to compare. Your page is safe on this device.");
        await store.markConflict(journalId, current);
        paused = "conflict";
        status("conflict", { message: "Changed on another device." });
        return "done";
      }
      if (res.status === 409 && code === "ACCOUNT_CHANGED") {
        paused = "error";
        status("error", { message: (data && data.error) || "This tab belongs to another account. Reload to continue.", fatal: true });
        return "done";
      }
      // A task created moments ago may not have reached the server yet.
      if (res.status === 404 || res.status >= 500 || res.status === 429 || res.status === 408) {
        return retry(res.status === 404 ? "Waiting for the task to save. Saved on this device." : "DCC had a problem. Saved on this device; retrying.");
      }
      paused = "error";
      status("error", { message: ((data && data.error) || "Could not sync") + ". Saved on this device.", fatal: true });
      return "done";
    }

    function retry(message) {
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      attempt++;
      status(isOnline() ? "retrying" : "offline", { message, retryIn: delay });
      schedule(delay);
      return "wait";
    }

    async function fetchServer(taskId) {
      try {
        const res = await send("/api/journal/tasks/" + encodeURIComponent(taskId), { credentials: "same-origin" });
        if (!res.ok) return null;
        const data = await res.json();
        return data && Number.isInteger(data.revision) && data.journalId === journalId ? data : null;
      } catch { return null; }
    }

    function flush() {
      if (stopped || paused) return running || Promise.resolve(last);
      if (running) { again = true; return running; }
      if (timer) { timers.clear(timer); timer = null; }
      running = (async () => {
        try {
          let step;
          do { again = false; step = await once(); } while (!stopped && (step === "again" || (again && step === "done" && !paused)));
        } catch (e) {
          // The local read/ack failed. Keep the device copy and try again later.
          retry("On-device storage error; retrying.");
        } finally { running = null; }
        return last;
      })();
      return running;
    }

    // Edits mark the record pending; the send waits for the pen to rest.
    function nudge() {
      if (stopped) return;
      if (!paused) status("pending", { message: "Saved on this device." });
      schedule(IDLE_RECHECK);
    }
    // After sign-in, reconnect or a resolved conflict.
    function resume() { paused = null; attempt = 0; return flush(); }
    function stop() { stopped = true; if (timer) { timers.clear(timer); timer = null; } }

    return { flush, nudge, resume, stop, fetchServer, get status() { return last; }, get paused() { return paused; } };
  }

  return { create, BACKOFF };
});
