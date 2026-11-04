// Shared live lifecycle: public/js/live-channel.js and the opt-in options of
// public/js/refresh-coordinator.js. Fake EventSource and timers, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate } = require('node:timers');
const { createLiveChannel } = require('./public/js/live-channel');
const { createTaskRefreshCoordinator } = require('./public/js/refresh-coordinator');

function clock() {
  let t = 0, seq = 0; const timers = new Map();
  return {
    now: () => t,
    setTimeoutFn: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeoutFn: id => timers.delete(id),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end;
    },
    pending: () => timers.size
  };
}
function fakeES() {
  const made = [];
  class ES {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; this.closed = false; made.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    close() { this.closed = true; this.readyState = 2; }
    message(data) { this.readyState = 1; this.onmessage?.({ data }); }
    emit(type) { (this.listeners[type] || []).forEach(fn => fn({ data: '' })); }
    fail(readyState) { this.readyState = readyState; this.onerror?.(); }
  }
  return { ES, made };
}
const flush = () => new Promise(r => setImmediate(r));
function setup(probeStatus = 200) {
  const c = clock(), { ES, made } = fakeES(), pings = [], states = [];
  let probes = 0;
  const channel = createLiveChannel({ url: '/events', EventSourceImpl: ES, heartbeatMs: 1000, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn,
    onPing: r => pings.push(r), onState: s => states.push(s), probe: async () => { probes++; return typeof probeStatus === 'function' ? probeStatus() : probeStatus; } });
  channel.open();
  return { c, made, pings, states, channel, probes: () => probes };
}

test('connected and changed messages ask for a re-read; every reconnect reconciles', () => {
  const { made, pings, states } = setup();
  made[0].message('connected'); made[0].message('changed');
  assert.deepEqual(pings, ['reconnect', 'changed']);
  assert.deepEqual(states, ['connecting', 'live']);
  made[0].fail(0);
  assert.equal(states.at(-1), 'reconnecting');
  made[0].message('connected');
  assert.deepEqual(pings, ['reconnect', 'changed', 'reconnect']);
});

test('a closed stream is resolved by probing the feed: 404 means revoked', async () => {
  const { c, made, states, probes } = setup(404);
  made[0].message('connected'); made[0].fail(2); await flush();
  assert.equal(probes(), 1); assert.equal(states.at(-1), 'revoked');
  assert.ok(made[0].closed); assert.equal(c.pending(), 0, 'no timers survive a revoke');
});

test('a closed stream with a healthy feed polls and reopens with backoff', async () => {
  const { c, made, states } = setup(200);
  made[0].message('connected'); made[0].fail(2); await flush();
  assert.equal(states.at(-1), 'polling');
  c.advance(29999); assert.equal(made.length, 1);
  c.advance(1); assert.equal(made.length, 2);
  made[1].fail(2); await flush(); c.advance(59999); assert.equal(made.length, 2); c.advance(1); assert.equal(made.length, 3);
  made[2].fail(2); await flush(); c.advance(300000); assert.equal(made.length, 4, 'backoff caps at 5 minutes');
  made[3].message('connected'); assert.equal(states.at(-1), 'live');
});

test('a network failure during the probe shows offline', async () => {
  const { made, states } = setup(0);
  made[0].fail(2); await flush();
  assert.equal(states.at(-1), 'offline');
});

test('capacity event shows polling without probing', async () => {
  const { made, states, probes } = setup();
  made[0].emit('capacity'); made[0].fail(0); await flush();
  assert.equal(states.at(-1), 'polling'); assert.equal(probes(), 0);
});

test('revoked event clears the channel at once', () => {
  const { made, states, c } = setup();
  made[0].message('connected'); made[0].emit('revoked');
  assert.equal(states.at(-1), 'revoked'); assert.equal(c.pending(), 0);
});

test('missing heartbeats reopen the stream; heartbeats keep it', () => {
  const { c, made, pings } = setup();
  made[0].message('connected');
  for (let i = 0; i < 5; i++) { c.advance(2000); made[0].emit('heartbeat'); }
  assert.equal(made.length, 1, 'heartbeats keep the socket');
  c.advance(2500);
  assert.equal(made.length, 2); assert.ok(made[0].closed);
  made[1].message('connected'); assert.equal(pings.at(-1), 'reconnect');
});

test('feed reads report status: 404 revokes, 5xx and network show offline, recovery returns', () => {
  const { made, states, channel } = setup();
  made[0].message('connected');
  channel.report(503); assert.equal(states.at(-1), 'offline');
  channel.report(200); assert.equal(states.at(-1), 'live');
  channel.report(0); assert.equal(states.at(-1), 'offline');
  channel.report(404); assert.equal(states.at(-1), 'revoked');
});

test('without EventSource the page polls', () => {
  const states = [];
  const channel = createLiveChannel({ url: '/e', EventSourceImpl: null, onPing() {}, onState: s => states.push(s), probe: async () => 200 });
  globalThis.EventSource === undefined && channel.open();
  assert.equal(states.at(-1), 'polling');
});

// ── coordinator opt-ins (owner defaults are covered by task-live-refresh.test.js) ──
function coord(extra = {}) {
  const c = clock(); let loads = 0, applied = [], fail = false, release;
  const co = createTaskRefreshCoordinator({ intervalMs: 30000, now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn,
    isVisible: () => true, canRefresh: () => true, getDate: () => 'tok', isLoaded: v => !!v,
    loadDay: () => { loads++; if (fail) return Promise.reject(Object.assign(new Error('x'), { status: 503 })); return new Promise(r => { release = () => r({ n: loads }); }); },
    apply: (_d, reason, data) => { applied.push([reason, data.n]); }, setIntervalFn: () => 1, addVisibilityListener() {}, ...extra });
  return { c, co, loads: () => loads, applied, release: () => release(), setFail: v => { fail = v; } };
}

test('trailing: a burst during a read collapses into one more read that starts after it', async () => {
  const h = coord({ trailing: true });
  const first = h.co.refresh('changed');
  const later = Array.from({ length: 50 }, () => h.co.refresh('changed'));
  assert.equal(h.loads(), 1);
  h.release(); await first; await flush();
  assert.equal(h.loads(), 2, 'exactly one trailing read');
  h.release(); await Promise.all(later);
  assert.deepEqual(h.applied.map(a => a[1]), [1, 2]);
});

test('without trailing (owner default) a mid-read call joins the read', async () => {
  const h = coord();
  const a = h.co.refresh('x'), b = h.co.refresh('y');
  h.release(); await a; await b; assert.equal(h.loads(), 1);
});

test('runAt schedules one timed read and a new time replaces it', async () => {
  const h = coord({ trailing: true });
  h.co.runAt(5000); h.co.runAt(8000);
  h.c.advance(7999); assert.equal(h.loads(), 0);
  h.c.advance(1); assert.equal(h.loads(), 1);
});

test('retry backoff after failures, reset by success; stop clears every timer', async () => {
  const h = coord({ retryDelaysMs: [5000, 10000] });
  h.setFail(true);
  await h.co.refresh('x'); assert.equal(h.loads(), 1);
  h.c.advance(5000); await flush(); assert.equal(h.loads(), 2);
  h.c.advance(9999); await flush(); assert.equal(h.loads(), 2);
  h.c.advance(1); await flush(); assert.equal(h.loads(), 3);
  h.co.runAt(1e9); h.co.stop(); assert.equal(h.c.pending(), 0);
  assert.equal(await h.co.refresh('after-stop'), false);
});

test('refreshOnVisible re-reads on return even when not stale', async () => {
  let visible = true;
  const h = coord({ refreshOnVisible: true, isVisible: () => visible });
  visible = false; h.co.onVisibilityChange(); assert.equal(h.loads(), 0);
  visible = true; h.co.onVisibilityChange(); assert.equal(h.loads(), 1);
});
