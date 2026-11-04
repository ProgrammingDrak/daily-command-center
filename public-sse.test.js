const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPublicSseHub } = require('./lib/public-sse');

function client() {
  const req = new EventEmitter();
  const res = { frames: [], code: 200, ended: false, writeHead(code) { this.code = code; }, write(frame) { this.frames.push(frame); },
    status(code) { this.code = code; return this; }, end(frame) { if (frame) this.frames.push(frame); this.ended = true; req.emit('close'); } };
  return { req, res };
}

test('a burst of owner writes collapses into one numbered ping', async () => {
  const hub = createPublicSseHub({ debounceMs: 20, heartbeatMs: 60000 });
  const a = client(); hub.register('ws', a.req, a.res);
  assert.match(a.res.frames[0], /^retry: 3000\ndata: connected\n\n$/);
  for (let i = 0; i < 50; i++) hub.ping('ws');
  hub.ping('other-workspace');
  await new Promise(r => setTimeout(r, 60));
  const pings = a.res.frames.filter(f => f.includes('data: changed'));
  assert.deepEqual(pings, ['id: 1\ndata: changed\n\n']);
  hub.ping('ws'); await new Promise(r => setTimeout(r, 60));
  assert.equal(a.res.frames.filter(f => f.includes('data: changed')).length, 2);
  a.req.emit('close');
});

test('heartbeats are named events (visible to page script) and stop on close', async () => {
  const hub = createPublicSseHub({ debounceMs: 10, heartbeatMs: 15 });
  const a = client(); hub.register('ws', a.req, a.res);
  await new Promise(r => setTimeout(r, 50));
  const beats = a.res.frames.filter(f => /^event: heartbeat\ndata: \d{4}-/.test(f)).length;
  assert.ok(beats >= 2, 'beats ' + beats);
  a.req.emit('close');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(a.res.frames.filter(f => /^event: heartbeat\ndata: \d{4}-/.test(f)).length, beats);
  assert.equal(hub.size(), 0);
});

test('over the cap a viewer gets a readable capacity event; revoke announces itself and cancels pending pings', async () => {
  const hub = createPublicSseHub({ maxPerWorkspace: 2, debounceMs: 20, heartbeatMs: 60000 });
  const [a, b, c] = [client(), client(), client()];
  hub.register('ws', a.req, a.res); hub.register('ws', b.req, b.res); hub.register('ws', c.req, c.res);
  assert.equal(c.res.code, 200); assert.ok(c.res.ended); assert.equal(hub.size(), 2);
  assert.deepEqual(c.res.frames, ['retry: 60000\nevent: capacity\ndata: polling\n\n']);
  hub.ping('ws'); hub.close('ws');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(a.res.ended && b.res.ended);
  assert.ok(!a.res.frames.some(f => f.includes('changed')));
  assert.equal(a.res.frames.at(-1), 'event: revoked\ndata: 1\n\n');
  assert.equal(hub.size(), 0);
});
