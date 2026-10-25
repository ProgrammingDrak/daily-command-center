const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./public/js/login-handoff');

function fixture(inFrame = false) {
  let nextId = 0, focused = true;
  const callbacks = new Map();
  const failures = [], clerk = { user: null, client: { signIn: {} } };
  const handoff = create({ clerk, inFrame, onFailure: value => failures.push(value),
    isForeground: () => focused,
    schedule: fn => { callbacks.set(++nextId, fn); return nextId; }, unschedule: id => { callbacks.delete(id); } });
  return { clerk, failures, handoff, timers: () => [...callbacks.keys()], foreground: value => { focused = value; },
    expire: () => { for (const [id, fn] of [...callbacks]) { callbacks.delete(id); fn(); } } };
}

test('a silent start failure gets bounded feedback without inspecting or exposing errors', () => {
  const f = fixture(); f.handoff.start(); f.expire(); f.expire();
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].code, 'G-START-TOP');
});
test('newly prepared handoff differs from a stale previous attempt and emits no secrets', () => {
  const f = fixture(true);
  const ready = id => ({ id, firstFactorVerification: { status: 'unverified', externalVerificationRedirectURL: 'https://example.invalid/?token=secret', error: { message: 'private' } } });
  f.clerk.client.signIn = ready('old-secret-id'); f.handoff.start(); f.expire();
  assert.equal(f.failures[0].code, 'G-START-FRAME');
  f.handoff.start(); f.clerk.client.signIn = ready('new-secret-id'); f.expire();
  assert.equal(f.failures[1].code, 'G-READY-FRAME');
  assert.doesNotMatch(JSON.stringify(f.failures), /secret|private|https|token/);
});
test('navigation, email fallback and session completion suppress late failure', () => {
  for (const complete of [false, true]) {
    const f = fixture(); f.handoff.start();
    if (complete) f.clerk.user = {}; else f.handoff.cancel();
    f.expire(); assert.deepEqual(f.failures, []);
  }
});
test('popup or background focus pauses feedback until the original window returns', () => {
  const f = fixture(); f.handoff.start(); f.foreground(false); f.handoff.pause();
  f.expire(); assert.deepEqual(f.failures, []);
  f.foreground(true); f.handoff.resume(); f.expire(); assert.equal(f.failures.length, 1);
});
test('a repeated activation replaces its timer and a foreground race can resume safely', () => {
  const f = fixture(); f.handoff.start(); assert.deepEqual(f.timers(), [1]);
  f.handoff.start(); assert.deepEqual(f.timers(), [2]);
  f.foreground(false); f.expire();
  assert.deepEqual(f.failures, []);
  f.foreground(true); f.handoff.resume(); f.expire(); assert.equal(f.failures.length, 1);
});
