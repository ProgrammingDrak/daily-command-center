const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./public/js/alarm-model.js');
process.env.TZ = 'America/New_York';
const at = text => new Date(text).getTime();
function alarm(changes = {}) {
  return { id: 'a', label: 'Wake', date: '2026-10-07', time: '07:00', mode: 'once', days: [], enabled: true, challenge: 'math', difficulty: 'easy', count: 3, tone: 'chime', volume: 0.15, snoozes: 1, createdAt: at('2026-10-06T12:00:00'), ...changes };
}
function scheduled(a = alarm()) { const s = M.empty(at('2026-10-07T06:59:50')); s.alarms.push(a); return s; }
test('one-off next time and enabled state', () => {
  const a = alarm(); assert.equal(M.next(a, at('2026-10-07T06:00:00')).at, at('2026-10-07T07:00:00'));
  assert.equal(M.next({ ...a, enabled: false }, at('2026-10-07T06:00:00')), null);
  assert.equal(M.next(a, at('2026-10-07T08:00:00')), null);
});
test('repeat days choose next selected weekday including week rollover', () => {
  const a = alarm({ mode: 'repeat', days: [1, 3, 5] });
  assert.equal(M.next(a, at('2026-10-07T08:00:00')).at, at('2026-10-09T07:00:00'));
  assert.equal(M.next(a, at('2026-10-09T08:00:00')).at, at('2026-10-12T07:00:00'));
});
test('invalid dates, no days, invalid difficulty/count and past one-off rejected', () => {
  for (const edit of [{ date: '2026-02-30' }, { time: '25:00' }, { count: 0 }, { count: 11 }, { mode: 'repeat', days: [] }, { difficulty: 'impossible' }, { volume: 2 }]) assert.throws(() => M.validate(alarm(edit)));
  assert.throws(() => M.saveAlarm(M.empty(0), alarm(), at('2026-10-08T00:00:00')), /future/);
});
test('only one occurrence after duplicate ticks, reload and backward clock', () => {
  let s = scheduled(); M.tick(s, at('2026-10-07T07:00:00'), true, () => 0);
  assert.equal(s.runs.length, 1); assert.equal(s.alarms[0].enabled, false);
  s = M.restore(JSON.parse(JSON.stringify(s)), 0);
  s.alarms[0].enabled = true;
  M.tick(s, at('2026-10-07T06:59:00'), true); M.tick(s, at('2026-10-07T07:00:00'), true);
  assert.equal(s.runs.length, 1);
});
test('simultaneous definitions queue without overwriting active challenge', () => {
  const s = scheduled(); s.alarms.push(alarm({ id: 'b', challenge: 'quiz' }));
  M.tick(s, at('2026-10-07T07:00:00'), true, () => 0);
  assert.equal(s.runs.length, 2); M.stop(s, s.runs[0].key); assert.equal(s.runs[0].alarm.id, 'b');
});
test('late, hidden and closed/reopened delivery are explicitly missed', () => {
  for (const [now, visible] of [['2026-10-07T07:02:00', true], ['2026-10-07T07:00:00', false], ['2026-12-07T07:00:00', true]]) {
    const s = scheduled(); M.tick(s, at(now), visible); assert.equal(s.runs.length, 0); assert.equal(s.handled['a/2026-10-07'], 'missed'); assert.match(s.notice, /Missed/);
  }
});
test('incorrect, blank, malformed and unsafe answers never advance; progress survives reload', () => {
  let s = scheduled(); M.tick(s, at('2026-10-07T07:00:00'), true, () => 0);
  const key = s.runs[0].key;
  for (const answer of ['', '1', '2x', '2.0', '2e0', 'Infinity', '9007199254740992']) assert.equal(M.answer(s,key,answer), false);
  assert.equal(s.runs[0].index, 0); assert.equal(M.answer(s,key,'2'), true);
  s = M.restore(JSON.parse(JSON.stringify(s)), 0); assert.equal(s.runs[0].index, 1);
  M.answer(s,key,'2'); M.answer(s,key,'2'); assert.equal(s.runs.length, 0); assert.equal(s.handled[key],'completed');
  assert.equal(M.answer(s,key,'2'), false);
});
test('bounded snooze preserves challenge and emergency stop cancels snooze', () => {
  const now = at('2026-10-07T07:00:00'), s = scheduled(); M.tick(s, now, true, () => 0);
  const key = s.runs[0].key; M.answer(s,key,'2'); assert.equal(M.snooze(s,key,now),true);
  assert.equal(M.answer(s,key,'2'),false); M.tick(s,now + 300000,true);
  assert.equal(s.runs[0].index,1); assert.equal(M.snooze(s,key,now + 300000),false);
  M.stop(s,key); M.tick(s,now + 600000,true); assert.equal(s.runs.length,0);
});
test('missed snooze is not replayed', () => {
  const now = at('2026-10-07T07:00:00'), s = scheduled(); M.tick(s,now,true,()=>0);
  const key = s.runs[0].key; M.snooze(s,key,now); M.tick(s,now+600000,true);
  assert.equal(s.runs.length,0); assert.equal(s.handled[key],'missed snooze');
});
test('DST spring gap advances by gap; fall fold chooses earlier offset once', () => {
  assert.equal(M.localDate('2026-03-08','02:30'), at('2026-03-08T03:30:00-04:00'));
  assert.equal(M.localDate('2026-11-01','01:30'), at('2026-11-01T01:30:00-04:00'));
  const a = alarm({ mode: 'repeat', days: [0], time: '01:30', createdAt: at('2026-10-01T12:00:00') });
  const s = M.empty(at('2026-11-01T01:29:50-04:00')); s.alarms.push(a);
  M.tick(s,at('2026-11-01T01:30:00-04:00'),true); M.tick(s,at('2026-11-01T01:30:00-05:00'),true);
  assert.equal(s.runs.length,1);
});
test('timezone change follows wall time while same calendar date stays consumed', () => {
  const a = alarm({ mode:'repeat', days:[3] }), s = scheduled(a);
  M.tick(s,at('2026-10-07T07:00:00'),true);
  process.env.TZ = 'America/Los_Angeles';
  try { assert.equal(M.next(a,at('2026-10-07T06:00:00'),s.handled).at,at('2026-10-14T07:00:00')); M.tick(s,at('2026-10-07T07:00:00'),true); assert.equal(s.runs.length,1); }
  finally { process.env.TZ = 'America/New_York'; }
});
test('editing pending challenge refused; emergency stops do not count as correct completion', () => {
  const s = scheduled(); M.tick(s,at('2026-10-07T07:00:00'),true);
  assert.throws(() => M.saveAlarm(s,alarm({ time:'08:00' }),at('2026-10-07T07:00:00')),/Stop/);
  M.stop(s,s.runs[0].key); assert.equal(s.handled['a/2026-10-07'],'emergency stopped');
});
test('quiz difficulty pools and question count are deterministic under a supplied random source', () => {
  for (const difficulty of ['easy','medium','hard']) {
    const qs = M.questions(alarm({ challenge:'quiz', difficulty, count:10 }), () => 0.7);
    assert.equal(qs.length,10); assert.equal(typeof qs[0].answer,'string');
  }
});
test('corrupt stored state fails closed without silently resetting it', () => {
  const s = scheduled(); s.alarms.push(alarm()); assert.throws(() => M.restore(s,0),/Duplicate/);
  const bad = scheduled(); bad.version = 7; assert.throws(() => M.restore(bad,0),/preserved/);
});
