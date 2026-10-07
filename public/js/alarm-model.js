/* Pure alarm/challenge transitions; browser and Node share the same model. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DCCAlarmModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const GRACE = 60000;
  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function localDate(date, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('Choose a valid date and time.');
    const [y, m, d] = date.split('-').map(Number);
    const check = new Date(y, m - 1, d, 12);
    if (dayKey(check) !== date) throw Error('Choose a valid calendar date.');
    const [h, min] = time.split(':').map(Number);
    // Date uses the earlier fold offset; gaps move forward by the DST gap.
    return new Date(y, m - 1, d, h, min).getTime();
  }
  function validate(a) {
    if (!a || typeof a.id !== 'string' || !a.id || typeof a.label !== 'string' || a.label.length > 80) throw Error('Invalid alarm name.');
    if (!['once', 'repeat'].includes(a.mode) || typeof a.enabled !== 'boolean') throw Error('Invalid schedule.');
    localDate(a.date, a.time);
    if (!Array.isArray(a.days) || a.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || (a.mode === 'repeat' && !a.days.length)) throw Error('Select at least one repeat day.');
    if (!['math', 'quiz'].includes(a.challenge) || !['easy', 'medium', 'hard'].includes(a.difficulty)) throw Error('Choose a challenge and difficulty.');
    if (!Number.isInteger(a.count) || a.count < 1 || a.count > 10) throw Error('Use 1–10 questions.');
    if (![0, 1].includes(a.snoozes) || !['chime', 'pulse'].includes(a.tone) || !Number.isFinite(a.volume) || a.volume < 0 || a.volume > 0.5) throw Error('Invalid sound or snooze setting.');
    if (!Number.isFinite(a.createdAt)) throw Error('Invalid creation time.');
    return a;
  }
  const empty = now => ({ version: 1, alarms: [], runs: [], handled: {}, checkpoint: now, notice: '' });
  function restore(value, now) {
    if (!value) return empty(now);
    if (value.version !== 1 || !Array.isArray(value.alarms) || !Array.isArray(value.runs) || !value.handled || !Number.isFinite(value.checkpoint)) throw Error('Alarm storage is invalid. Scheduling is stopped; saved data was preserved.');
    value.alarms.forEach(validate);
    if (new Set(value.alarms.map(a => a.id)).size !== value.alarms.length) throw Error('Duplicate alarm IDs in storage.');
    value.runs.forEach(r => {
      validate(r.alarm);
      if (typeof r.key !== 'string' || !['ringing', 'snoozed'].includes(r.status) || !Number.isInteger(r.index) || r.index < 0 || !Array.isArray(r.questions) || r.questions.length !== r.alarm.count || r.index >= r.questions.length || !Number.isInteger(r.snoozed) || r.snoozed < 0 || r.snoozed > r.alarm.snoozes || (r.status === 'snoozed' && !Number.isFinite(r.until))) throw Error('Invalid saved challenge. Scheduling is stopped.');
      r.questions.forEach(q => { if (typeof q.prompt !== 'string' || typeof q.answer !== 'string') throw Error('Invalid saved question.'); });
    });
    if (new Set(value.runs.map(r => r.key)).size !== value.runs.length) throw Error('Duplicate challenge IDs in storage.');
    return value;
  }
  function occurrence(a, date) {
    if (a.mode === 'once' && date !== a.date) return null;
    const at = localDate(date, a.time);
    if (a.mode === 'repeat' && !a.days.includes(new Date(date + 'T12:00:00').getDay())) return null;
    return { at, key: `${a.id}/${date}` };
  }
  function next(a, now, handled = {}) {
    if (!a.enabled) return null;
    if (a.mode === 'once') {
      const o = occurrence(a, a.date);
      return o.at > now && !handled[o.key] ? o : null;
    }
    for (let i = 0; i < 8; i++) {
      const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + i);
      const o = occurrence(a, dayKey(d));
      if (o && o.at > now && !handled[o.key]) return o;
    }
    return null;
  }
  const quizzes = {
    easy: [['How many sides does a triangle have?', '3'], ['How many minutes are in an hour?', '60'], ['How many days are in a week?', '7']],
    medium: [['How many degrees are in a right angle?', '90'], ['What is the square root of 81?', '9'], ['How many hours are in two days?', '48']],
    hard: [['What is the next prime after 19?', '23'], ['How many degrees are in a triangle?', '180'], ['What is 2 to the power of 8?', '256']]
  };
  function questions(a, random = Math.random) {
    const int = max => 1 + Math.floor(random() * max);
    return Array.from({ length: a.count }, () => {
      if (a.challenge === 'quiz') {
        const [prompt, answer] = quizzes[a.difficulty][Math.floor(random() * 3)];
        return { prompt, answer };
      }
      const x = int(a.difficulty === 'easy' ? 9 : a.difficulty === 'medium' ? 40 : 99);
      const y = int(a.difficulty === 'hard' ? 12 : a.difficulty === 'medium' ? 40 : 9);
      const multiply = a.difficulty === 'hard';
      return { prompt: `${x} ${multiply ? '×' : '+'} ${y} = ?`, answer: String(multiply ? x * y : x + y) };
    });
  }
  const run = (a, key, random) => ({ key, alarm: { ...a }, status: 'ringing', index: 0, snoozed: 0, questions: questions(a, random) });
  function tick(state, now, visible, random) {
    const previous = state.checkpoint;
    state.checkpoint = now;
    // A backward clock change never clears the occurrence ledger.
    for (const a of state.alarms) {
      if (!a.enabled) continue;
      const dates = a.mode === 'once' ? [a.date] : Array.from({ length: 8 }, (_, i) => {
        const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i); return dayKey(d);
      }).reverse();
      for (const date of dates) {
        const o = occurrence(a, date);
        if (!o || o.at <= a.createdAt || o.at > now || state.handled[o.key]) continue;
        // Reconcile overdue definitions even if the app was closed beyond the lookback.
        const onTime = o.at > previous && now - o.at <= GRACE && visible;
        state.handled[o.key] = onTime ? 'started' : 'missed';
        if (a.mode === 'once') a.enabled = false;
        if (onTime) state.runs.push(run(a, o.key, random));
        else state.notice = `Missed ${a.label || 'alarm'} (${date}). Browser delivery was unavailable or late.`;
      }
    }
    state.runs = state.runs.filter(r => {
      if (r.status !== 'snoozed' || r.until > now) return true;
      if (!visible || now - r.until > GRACE) { state.handled[r.key] = 'missed snooze'; state.notice = 'A snoozed browser alarm was missed.'; return false; }
      r.status = 'ringing'; delete r.until; return true;
    });
    return state;
  }
  function answer(state, key, input) {
    const r = state.runs.find(r => r.key === key);
    if (!r || r.status !== 'ringing') return false;
    const text = String(input).trim();
    if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || String(Number(text)) !== r.questions[r.index].answer) return false;
    r.index++;
    if (r.index === r.questions.length) stop(state, key, 'completed');
    return true;
  }
  function stop(state, key, reason = 'emergency stopped') {
    if (!state.runs.some(r => r.key === key)) return false;
    state.runs = state.runs.filter(r => r.key !== key);
    state.handled[key] = reason;
    state.notice = reason === 'completed' ? 'Challenge complete. Alarm dismissed.' : 'Alarm stopped safely.';
    return true;
  }
  function snooze(state, key, now) {
    const r = state.runs.find(r => r.key === key);
    if (!r || r.status !== 'ringing' || r.snoozed >= r.alarm.snoozes) return false;
    r.snoozed++; r.status = 'snoozed'; r.until = now + 5 * 60000; return true;
  }
  function saveAlarm(state, a, now) {
    validate(a);
    if (a.mode === 'once' && a.enabled && localDate(a.date, a.time) <= now) throw Error('Choose a future time for a one-off alarm.');
    if (state.runs.some(r => r.alarm.id === a.id)) throw Error('Stop the current alarm before editing it.');
    const i = state.alarms.findIndex(row => row.id === a.id);
    if (i < 0 && state.alarms.length >= 20) throw Error('Use at most 20 alarms.');
    if (i < 0) state.alarms.push(a); else state.alarms[i] = a;
  }
  return { GRACE, dayKey, localDate, validate, empty, restore, occurrence, next, questions, run, tick, answer, stop, snooze, saveAlarm };
});
