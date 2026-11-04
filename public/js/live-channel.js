// One EventSource lifecycle for "something changed, re-read" streams.
//
// Native EventSource hides two things this module works around:
//   - HTTP status. A 404, 429 or 503 all look the same: an `error` event with
//     readyState CLOSED. So on CLOSED we ask `probe()` (a normal fetch of the
//     feed, which CAN read the status): 404 means revoked, success means the
//     stream alone is unavailable (poll and reopen later), a network failure
//     means offline.
//   - Comment frames (": ping"). They never reach script, so they cannot prove a
//     socket is alive. The server sends a named `heartbeat` event instead, and a
//     watchdog reopens the stream when heartbeats stop.
// Other named events: `capacity` (server is over its viewer cap: poll; the
// browser retries after the server's `retry`) and `revoked` (link disabled).
//
// States: connecting, live, reconnecting, polling, offline, revoked.
// Callbacks: onPing(reason) for "re-read now" (reason: reconnect | changed),
// onState(state), probe() -> Promise<HTTP status, or 0 for a network failure>.
(function(root, factory){
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DCCLiveChannel = api;
})(typeof window !== "undefined" ? window : globalThis, function(){
  "use strict";
  const CLOSED = 2, OPEN = 1;
  function createLiveChannel(opts){
    const ES = opts.EventSourceImpl || (typeof EventSource !== "undefined" ? EventSource : null);
    const heartbeatMs = opts.heartbeatMs || 25000;
    const watchdogMs = Math.round(heartbeatMs * 2.5);
    const reopenDelaysMs = opts.reopenDelaysMs || [30000, 60000, 300000];
    const setT = opts.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    const clearT = opts.clearTimeoutFn || (id => clearTimeout(id));
    const isVisible = opts.isVisible || (() => true);
    let source = null, state = null, watchdog = null, reopenTimer = null, reopenCount = 0, closed = false, probing = false;

    function set(next){
      if (state === next) return;
      state = next;
      if (opts.onState) opts.onState(next);
    }
    function clearWatchdog(){ if (watchdog != null) clearT(watchdog); watchdog = null; }
    function armWatchdog(){
      clearWatchdog();
      watchdog = setT(() => { watchdog = null; if (!closed) { set("reconnecting"); open(); } }, watchdogMs);
    }
    function teardown(){
      clearWatchdog();
      if (!source) return;
      source.onmessage = null; source.onerror = null;
      source.close();
      source = null;
    }
    function open(){
      if (closed) return;
      teardown();
      if (reopenTimer != null) { clearT(reopenTimer); reopenTimer = null; }
      if (!ES) { set("polling"); return; }
      if (state == null) set("connecting");
      const es = source = new ES(opts.url);
      es.onmessage = event => {
        armWatchdog();
        if (event.data === "connected") { reopenCount = 0; set("live"); opts.onPing("reconnect"); }
        else if (event.data === "changed") { set("live"); opts.onPing("changed"); }
      };
      es.addEventListener("heartbeat", () => { armWatchdog(); if (state === "reconnecting" || state === "offline") set("live"); });
      es.addEventListener("capacity", () => set("polling"));
      es.addEventListener("revoked", () => revoke());
      es.onerror = () => {
        if (closed || es !== source) return;
        if (es.readyState === CLOSED) { teardown(); probe(); }
        else if (state !== "polling") set("reconnecting");
      };
      armWatchdog();
    }
    async function probe(){
      if (probing || closed) return;
      probing = true;
      let status = 0;
      try { status = await opts.probe(); } catch (_e) { status = 0; }
      probing = false;
      if (closed) return;
      report(status);
      if (closed) return;
      // The feed answers but the stream is down: say so, poll, and reopen later.
      if (status && status < 500) set("polling");
      scheduleReopen();
    }
    function scheduleReopen(){
      if (reopenTimer != null) clearT(reopenTimer);
      const delay = reopenDelaysMs[Math.min(reopenCount, reopenDelaysMs.length - 1)];
      reopenCount += 1;
      reopenTimer = setT(() => { reopenTimer = null; if (isVisible()) open(); }, delay);
    }
    // Every feed read reports its status here, so one place decides the state.
    function report(status){
      if (closed) return;
      if (status === 404 || status === 410) return revoke();
      if (!status || status >= 500) { set("offline"); return; }
      if (state === "offline" || state === "connecting" || state == null) set(source && source.readyState === OPEN ? "live" : "polling");
    }
    function revoke(){
      if (closed) return;
      closed = true;
      teardown();
      if (reopenTimer != null) clearT(reopenTimer);
      reopenTimer = null;
      set("revoked");
    }
    // Back on the tab or the network: reopen a stream that is not running.
    function resume(){
      if (closed || source) return;
      reopenCount = 0;
      open();
    }
    return { open, resume, report, close: revoke, state: () => state };
  }
  return { createLiveChannel };
});
