/* Browser prototype: no background wake-up, push, or permission requests. */
(function () {
  'use strict';
  const M = window.DCCAlarmModel, store = window.DCCAlarmStore;
  const button = document.getElementById('dcc-alarms-open');
  if (!button || !M || !store) return;
  let state = M.empty(Date.now()), panel = null, challenge = null, practice = null;
  let session = false, release = null, busy = false, saving = false, fatal = '', context = null;
  let audioGeneration = 0, lastSummary = '';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const format = at => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const active = () => practice ? practice.runs[0] : state.runs.find(r => r.status === 'ringing');
  const current = () => practice || state;
  const actionButton = (text, action, extra = '') => `<button type="button" data-action="${action}" ${extra}>${text}</button>`;
  function stopAudio() {
    audioGeneration++;
    if (context) { const old = context; context = null; old.close().catch(() => {}); }
  }
  async function play(a, feedback) {
    stopAudio();
    const generation = audioGeneration;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw Error('Audio unavailable');
      context = new Audio(); const playing = context;
      await playing.resume();
      if (generation !== audioGeneration) return;
      if (playing.state !== 'running') throw Error('Playback blocked');
      const base = playing.currentTime;
      for (let i = 0; i < 8; i++) {
        const oscillator = playing.createOscillator(), gain = playing.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = a.tone === 'chime' ? (i % 2 ? 660 : 880) : 440;
        gain.gain.setValueAtTime(0, base + i * 0.5);
        gain.gain.linearRampToValueAtTime(a.volume, base + i * 0.5 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, base + i * 0.5 + 0.32);
        oscillator.connect(gain); gain.connect(playing.destination);
        oscillator.start(base + i * 0.5); oscillator.stop(base + i * 0.5 + 0.35);
      }
      window.setTimeout(() => { if (generation === audioGeneration) stopAudio(); }, 4200);
      feedback.textContent = 'Playing a four-second sound sample. Stop sound is always available.';
    } catch (_) { stopAudio(); feedback.textContent = 'Sound unavailable or blocked. The visual challenge still works.'; }
  }
  function endSession() { session = false; if (release) release(); release = null; stopAudio(); updateSummary(); }
  async function mutate(change) {
    if (saving) return false;
    try { change(structuredClone(state)); }
    catch (e) {
      const feedback = document.querySelector('#alarm-feedback, #alarm-challenge-feedback');
      if (feedback) feedback.textContent = e.message;
      return false;
    }
    saving = true;
    try {
      state = await store.transact(change); updateSummary(); return true;
    } catch (e) {
      fatal = e.message; endSession(); stopAudio();
      const feedback = document.querySelector('#alarm-feedback, #alarm-challenge-feedback');
      if (feedback) feedback.textContent = 'Local save failed. Scheduling stopped. ' + fatal;
      return false;
    } finally { saving = false; }
  }
  function updateSummary() {
    const next = state.alarms.map(a => ({ a, o: M.next(a, Date.now(), state.handled) })).filter(row => row.o).sort((a, b) => a.o.at - b.o.at)[0];
    const snoozed = state.runs.filter(r => r.status === 'snoozed').sort((a, b) => a.until - b.until)[0];
    const text = fatal ? 'Alarms · unavailable' : active() ? 'Browser alarm · challenge waiting' : snoozed ? 'Browser snooze · ' + format(snoozed.until) : next ? 'Next browser alarm · ' + format(next.o.at) : 'Clock & alarms · prototype';
    button.textContent = text;
    button.setAttribute('aria-label', text + '. Browser prototype' + (session ? ', visible session active' : ', session stopped'));
    const resume = panel?.el.querySelector('[data-action="resume"]');
    if (resume) resume.hidden = !state.runs.some(r => r.status === 'ringing');
    const nextEl = panel?.el.querySelector('#alarm-next');
    if (nextEl) nextEl.textContent = next ? `${next.a.label || 'Alarm'} · ${format(next.o.at)}` : 'No upcoming enabled alarm.';
    const summary = `${session}/${zone()}/${state.notice}/${fatal}`;
    if (summary !== lastSummary) {
      lastSummary = summary;
      const status = panel?.el.querySelector('#alarm-session-status');
      if (status) status.textContent = fatal ? `Local save failed · ${fatal}` : `${session ? 'Visible-page session active' : 'Session stopped'} · device time: ${zone()}. ${state.notice}`;
    }
  }
  async function startSession() {
    if (session) return;
    if (fatal) return;
    if (!navigator.locks) { fatal = 'This browser lacks tab coordination. Scheduling unavailable; silent practice is available.'; updateSummary(); renderManager(); return; }
    try {
      await navigator.locks.request('dcc-device-alarms-session', { ifAvailable: true }, async lock => {
        if (!lock) { const el = panel?.el.querySelector('#alarm-feedback'); if (el) el.textContent = 'Another DCC tab has the alarm session. Stop it there first.'; return; }
        session = true; lastSummary = ''; updateSummary(); renderManager();
        await new Promise(resolve => { release = resolve; });
      });
    } catch (e) { fatal = 'Tab coordination unavailable: ' + e.message; endSession(); renderManager(); }
  }
  function formHTML(a) {
    const today = M.dayKey(new Date());
    const v = a || { label: 'Morning alarm', time: '07:00', date: today, mode: 'repeat', days: [1,2,3,4,5], challenge: 'math', difficulty: 'easy', count: 3, snoozes: 0, tone: 'chime', volume: 0.15, enabled: true };
    const option = (value, text, selected) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${text}</option>`;
    return `<form id="alarm-form" class="alarm-form" data-id="${esc(a?.id || '')}">
      <h3>${a ? 'Edit alarm' : 'Add an alarm'}</h3>
      <label>Name <input name="label" maxlength="80" required value="${esc(v.label)}"></label>
      <div class="alarm-grid"><label>Time <input name="time" type="time" data-tw-skip required value="${esc(v.time)}"></label>
      <label>Schedule <select name="mode">${option('repeat', 'Repeat days', v.mode)}${option('once', 'One-off date', v.mode)}</select></label></div>
      <label id="alarm-date-label" ${v.mode === 'repeat' ? 'hidden' : ''}>One-off date <input name="date" type="date" data-tw-skip required value="${esc(v.date)}"></label>
      <fieldset id="alarm-days" ${v.mode === 'once' ? 'hidden' : ''}><legend>Repeat on</legend><div class="alarm-days">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i) => `<label><input name="days" type="checkbox" value="${i}" ${v.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div></fieldset>
      <div class="alarm-grid"><label>Challenge <select name="challenge">${option('math','Basic math',v.challenge)}${option('quiz','Number quizzes',v.challenge)}</select></label>
      <label>Difficulty <select name="difficulty">${['easy','medium','hard'].map(d => option(d, d[0].toUpperCase()+d.slice(1), v.difficulty)).join('')}</select></label>
      <label>Correct answers <input name="count" type="number" min="1" max="10" required value="${v.count}"></label>
      <label>Snooze <select name="snoozes">${option('0','No snooze',String(v.snoozes))}${option('1','Once, for 5 minutes',String(v.snoozes))}</select></label>
      <label>Sound <select name="tone">${option('chime','Chime',v.tone)}${option('pulse','Pulse',v.tone)}</select></label>
      <label>Sample volume <input name="volume" type="range" min="0" max="0.5" step="0.05" value="${v.volume}"></label></div>
      <label class="alarm-check"><input name="enabled" type="checkbox" ${v.enabled ? 'checked' : ''}>Enabled definition (requires a visible session)</label>
      <div class="alarm-actions">${actionButton('Preview sound (4 sec)', 'preview')}${actionButton('Stop sound','stop-sound')}${actionButton('Practice silently','practice')}<button type="submit">Save alarm locally</button>${a ? actionButton('Cancel edit','cancel-edit') : ''}</div>
      <p class="alarm-hint">Times follow this device’s timezone. DST gaps move forward; repeated hours fire once at the earlier offset. Sound plays only when you press a sound button.</p>
    </form>`;
  }
  function formAlarm(form) {
    const data = new FormData(form), id = form.dataset.id;
    const old = state.alarms.find(a => a.id === id);
    return { id: id || crypto.randomUUID(), label: String(data.get('label')).trim(), mode: data.get('mode'), time: data.get('time'), date: data.get('date'), days: data.getAll('days').map(Number), challenge: data.get('challenge'), difficulty: data.get('difficulty'), count: Number(data.get('count')), snoozes: Number(data.get('snoozes')), tone: data.get('tone'), volume: Number(data.get('volume')), enabled: data.has('enabled'), createdAt: old?.createdAt || Date.now() };
  }
  function renderManager(edit) {
    if (!panel) return;
    lastSummary = '';
    const body = document.createElement('div'); body.className = 'alarm-manager';
    body.innerHTML = `<p class="alarm-warning"><strong>Browser prototype · not a dependable wake-up alarm.</strong><br>Keep this page visible and your device awake. Locked, backgrounded, closed, rebooted, or suspended devices may miss alarms. Use your phone’s native alarm for waking up.</p>
      <div class="alarm-next"><span>Next alarm on this device</span><strong id="alarm-next"></strong><small>Local definitions only · no cloud sync · this browser profile shares alarms across DCC accounts.</small></div>
      <p id="alarm-session-status" role="status"></p><div class="alarm-actions">${actionButton('Export definitions for Android','export')} ${actionButton(session ? 'Stop visible session' : 'Start visible session', session ? 'stop-session' : 'start-session', fatal ? 'disabled' : '')}${actionButton('Resume saved challenge','resume', state.runs.some(r => r.status === 'ringing') ? '' : 'hidden')}</div>
      <p id="alarm-feedback" role="status" aria-live="polite"></p>
      <ul class="alarm-list">${state.alarms.map(a => `<li><div><strong>${esc(a.time)} · ${esc(a.label || 'Alarm')}</strong><small>${a.mode === 'once' ? esc(a.date) : a.days.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')} · ${esc(a.challenge)} / ${esc(a.difficulty)} · ${a.count} answers${state.runs.some(r=>r.alarm.id===a.id) ? ' · challenge pending' : ''}</small></div><div class="alarm-actions">${actionButton(a.enabled ? 'Disable' : 'Enable','toggle',`data-id="${esc(a.id)}" aria-label="${a.enabled ? 'Disable' : 'Enable'} ${esc(a.label)}"`)}${actionButton('Edit','edit',`data-id="${esc(a.id)}"`)}${actionButton('Remove','remove',`data-id="${esc(a.id)}"`)}</div></li>`).join('') || '<li>No alarms yet. Add one below.</li>'}</ul>${formHTML(edit)}`;
    panel.update({ title: 'Clock & challenge alarms', body }); updateSummary();
    body.querySelector('#alarm-form').addEventListener('change', event => {
      if (event.target.name === 'mode') { body.querySelector('#alarm-date-label').hidden = event.target.value !== 'once'; body.querySelector('#alarm-days').hidden = event.target.value === 'once'; }
    });
    body.querySelector('#alarm-form').addEventListener('submit', async event => {
      event.preventDefault(); const feedback = body.querySelector('#alarm-feedback');
      try {
        const a = formAlarm(event.target); M.saveAlarm(structuredClone(state), a, Date.now());
        if (await mutate(s => M.saveAlarm(s, a, Date.now()))) { renderManager(); panel.el.querySelector('#alarm-feedback').textContent = 'Saved locally. No background wake-up is scheduled.'; }
      } catch (e) { feedback.textContent = e.message; }
    });
    body.onclick = async event => {
      const target = event.target.closest('[data-action]'); if (!target) return;
      const action = target.dataset.action, id = target.dataset.id;
      const feedback = body.querySelector('#alarm-feedback');
      if (action === 'export') {
        const blob = new Blob([JSON.stringify({ version: 1, alarms: state.alarms }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = 'dcc-alarm-definitions.json'; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        feedback.textContent = 'Definitions exported. Import and approve scheduling on the Android companion; this does not arm your phone.';
        return;
      }
      if (action === 'stop-sound') return stopAudio();
      if (action === 'start-session') return startSession();
      if (action === 'stop-session') { endSession(); renderManager(); return; }
      if (action === 'resume') { showChallenge(); return; }
      if (action === 'cancel-edit') { renderManager(); return; }
      if (action === 'edit') { renderManager(state.alarms.find(a => a.id === id)); return; }
      if (action === 'preview' || action === 'practice') {
        try {
          const a = formAlarm(body.querySelector('#alarm-form')); M.validate(a);
          if (action === 'preview') return play(a, feedback);
          stopAudio(); practice = M.empty(Date.now()); practice.runs.push(M.run(a, 'practice'));
          showChallenge();
        } catch (e) { feedback.textContent = e.message; }
        return;
      }
      if (action === 'remove' || action === 'toggle') {
        stopAudio();
        const ok = await mutate(s => {
          const a = s.alarms.find(a => a.id === id); if (!a) return;
          s.runs.filter(r => r.alarm.id === id).forEach(r => M.stop(s, r.key));
          if (action === 'remove') s.alarms = s.alarms.filter(a => a.id !== id);
          else { const updated = { ...a, enabled: !a.enabled }; M.saveAlarm(s, updated, Date.now()); }
        });
        if (ok) renderManager();
      }
    };
  }
  function openManager() {
    if (active()) return showChallenge();
    stopAudio();
    panel = DCC.overlay.open({ title: 'Clock & challenge alarms', anchor: button, onClose: () => { panel = null; stopAudio(); } });
    renderManager();
  }
  function showChallenge() {
    const r = active(); if (!r || challenge) return;
    stopAudio();
    const body = document.createElement('div'); body.className = 'alarm-challenge';
    challenge = DCC.overlay.open({ title: practice ? 'Silent alarm practice' : r.alarm.label || 'Alarm challenge', body, anchor: button, onClose: reason => {
      challenge = null; stopAudio();
      // Closing the overlay pauses the challenge, never falsely completes it.
      if (reason !== 'finished' && practice) practice = null;
      updateSummary();
    } });
    challenge.el.dataset.alarmKey = r.key;
    challenge.el.querySelector('.dcc-overlay-close').setAttribute('aria-label','Pause challenge and stop sound');
    renderChallenge();
  }
  function renderChallenge() {
    const r = active(); if (!challenge || !r) return;
    challenge.el.dataset.alarmIndex = String(r.index);
    const body = challenge.el.querySelector('.dcc-overlay-body');
    body.innerHTML = `<div class="alarm-challenge"><p class="alarm-warning">${practice ? 'Practice only. Your schedules are untouched.' : 'Visible-page prototype. Sound is off until you press Play sound.'} Close or Escape pauses this challenge and stops sound.</p><p id="alarm-progress" role="status">${r.index} of ${r.alarm.count} correct answers</p><p id="alarm-question" class="alarm-question">${esc(r.questions[r.index].prompt)}</p>
      <form id="alarm-answer-form"><label>Answer <input name="answer" inputmode="numeric" autocomplete="off" aria-describedby="alarm-question alarm-challenge-feedback" required autofocus></label><button type="submit">Check answer</button></form>
      <p id="alarm-challenge-feedback" role="status" aria-live="polite"></p><div class="alarm-actions">${practice ? '' : actionButton('Play sound (4 sec)','play')}${actionButton('Stop sound','stop-sound')}${r.snoozed < r.alarm.snoozes ? actionButton('Snooze 5 min (once)','snooze',practice || !session ? 'disabled' : '') : ''}${actionButton('Emergency stop · skip quiz','emergency')}</div></div>`;
    body.querySelector('#alarm-answer-form').addEventListener('submit', async event => {
      event.preventDefault(); if (saving) return;
      const input = event.target.elements.answer;
      let correct = false;
      if (practice) correct = M.answer(practice, r.key, input.value);
      else if (!(await mutate(s => { correct = M.answer(s, r.key, input.value); }))) return;
      if (!correct) { body.querySelector('#alarm-challenge-feedback').textContent = 'Try again. Enter the correct whole number.'; input.setAttribute('aria-invalid','true'); input.select(); return; }
      if (!active()) finishChallenge('Challenge complete. Alarm dismissed.');
      else { renderChallenge(); challenge?.el.querySelector('[name="answer"]').focus(); }
    });
    body.onclick = async event => {
      const target = event.target.closest('[data-action]'); if (!target) return;
      if (target.dataset.action === 'play') return play(r.alarm, body.querySelector('#alarm-challenge-feedback'));
      if (target.dataset.action === 'stop-sound') return stopAudio();
      stopAudio();
      if (target.dataset.action === 'emergency') {
        if (practice) M.stop(practice, r.key);
        else if (!(await mutate(s => M.stop(s, r.key)))) { finishChallenge('Sound stopped. Local save failed; the challenge may return after reload.'); return; }
        finishChallenge('Alarm stopped safely. Quiz skipped.');
      }
      if (target.dataset.action === 'snooze' && session && !practice) {
        if (await mutate(s => M.snooze(s, r.key, Date.now()))) finishChallenge('Snoozed for five minutes. Keep this page visible.');
      }
    };
  }
  function finishChallenge(message) {
    stopAudio(); if (challenge) challenge.close('replaced'); practice = null;
    updateSummary(); openManager();
    const feedback = panel?.el.querySelector('#alarm-feedback'); if (feedback) feedback.textContent = message;
  }
  async function tick() {
    if (busy || saving || fatal || (!session && (!panel && !challenge || document.hidden || practice))) { updateSummary(); return; }
    busy = true;
    const old = JSON.stringify(state.runs);
    try {
      state = session ? await store.transact(s => M.tick(s, Date.now(), !document.hidden)) : await store.transact();
      updateSummary();
      if (challenge && !practice && challenge.el.dataset.alarmKey !== active()?.key) {
        stopAudio(); challenge.close('replaced');
        if (active()) showChallenge(); else openManager();
      }
      else if (challenge && !practice && challenge.el.dataset.alarmIndex !== String(active()?.index)) renderChallenge();
      if (!document.hidden && old !== JSON.stringify(state.runs)) {
        if (panel && !active()) renderManager();
        if (active() && !DCC.overlay.activeBlocking) showChallenge();
      }
    } catch (e) { fatal = e.message; endSession(); renderManager(); }
    finally { busy = false; }
  }
  button.addEventListener('click', openManager);
  document.addEventListener('visibilitychange', () => { stopAudio(); if (!document.hidden) tick(); });
  window.addEventListener('pagehide', endSession);
  store.transact().then(s => { state = s; updateSummary(); }).catch(e => { fatal = e.message; updateSummary(); });
  window.setInterval(tick, 1000);
})();
