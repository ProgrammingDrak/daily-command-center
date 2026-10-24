/* global GlassesSession, WorkoutModel */
(function () {
  'use strict';
  const host = document.getElementById('glasses');
  const params = new URLSearchParams(location.search);
  const today = new Date();
  let date = params.get('date') || new Intl.DateTimeFormat('en-CA', { timeZone: window.DCC_APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today);
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(date))) date = today.toISOString().slice(0, 10);
  let selected = params.get('task'), confirm = false, focusNext = 'card';
  const esc = window.DCC.esc;
  const session = GlassesSession.create({
    storage: { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) },
    uuid: () => crypto.randomUUID(), online: () => navigator.onLine, changed: render,
    request: async (url, options = {}) => {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          ...options, ...(options.body ? { body: JSON.stringify(options.body), headers: { 'Content-Type': 'application/json' } } : {}) });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw Object.assign(new Error(body?.error || 'DCC could not confirm this request.'), { status: response.status, code: body?.code });
        if (!body) throw new Error('DCC returned an unreadable response. Check saved state before retrying.');
        return body;
      } catch (e) {
        if (e.name === 'AbortError' || e instanceof TypeError) throw new Error('Connection interrupted. The change may have reached DCC. Retry checks the same request safely.');
        throw e;
      } finally { clearTimeout(timeout); }
    }
  });
  function url(taskId) {
    const p = new URLSearchParams({ date }); if (taskId) p.set('task', taskId);
    return '/glasses-routine.html?' + p;
  }
  function button(label, action, options = {}) {
    return '<button data-action="' + action + '"' + (options.disabled ? ' disabled' : '') + (options.primary ? ' class="primary"' : '') + '>' + esc(label) + '</button>';
  }
  function render(s) {
    const focused = document.activeElement?.dataset.action || document.activeElement?.id;
    const scroll = host.querySelector('.card')?.scrollTop || 0;
    const offline = !navigator.onLine, locked = s.busy || !!s.pending || offline || [401, 403, 409].includes(s.code);
    let content = '', actions = '', progress = '';
    const row = s.row;
    if (row) {
      selected = row.taskId; history.replaceState(null, '', url(selected));
      const v = row.record, steps = WorkoutModel.guidanceSteps(v.plan), g = v.guidance;
      const index = g?.stepIndex || 0, step = steps[index], entry = v.plan.exercises.find(e => e.id === step.exerciseId);
      progress = '<div class="muted">Card ' + (index + 1) + ' of ' + steps.length + ' · Round ' + step.round + '<progress aria-label="Guidance progress" value="' + (index + 1) + '" max="' + steps.length + '"></progress></div>';
      content = '<p class="card-title">' + esc(row.title) + '</p>';
      if (row.completed) {
        content += '<h1>Task complete</h1><p>Confirmed by DCC.</p><p class="muted">Your existing workout results are unchanged.</p>';
      } else if (confirm) {
        content += '<h1>Complete this task?</h1><p>This marks “' + esc(row.title) + '” done in DCC.</p><p class="muted">It does not record reps, holds or workout timing.</p>';
        actions = button('Cancel', 'cancel', { disabled: s.busy }) + button('Confirm completion', 'complete', { primary: true, disabled: locked });
      } else if (g?.status === 'finished') {
        content += '<h1>Guidance finished</h1><p>All ' + steps.length + ' cards visited.</p><p class="muted">Your task is still open. Complete it only when you are ready.</p>';
        if (row.date) actions = button('Complete task…', 'confirm', { primary: true, disabled: locked });
        else content += '<p class="muted">Schedule this task in DCC before completing it here.</p>';
      } else {
        content += '<h1>' + esc(entry.name) + '</h1>' + (entry.side && entry.side !== 'none' ? '<div class="side">' + esc(entry.side.toUpperCase()) + '</div>' : '') + '<p class="instruction">' + esc(entry.movement?.visualInstructions || 'Follow your planned movement at a comfortable pace.') + '</p>';
        if (entry.movement?.breath && entry.movement.breath !== 'none') content += '<p class="muted">Optional natural breath: ' + esc(entry.movement.breath) + '</p>';
        if (!g) actions = button('Begin routine', 'begin', { primary: true, disabled: locked });
        else if (g.status === 'paused') actions = button('Resume routine', 'resume', { primary: true, disabled: locked });
        else actions = button('Back', 'back', { disabled: locked || index === 0 }) + button(index === steps.length - 1 ? 'Finish guidance' : 'Next', index === steps.length - 1 ? 'finish' : 'next', { primary: true, disabled: locked }) + button('Pause', 'exit', { disabled: locked });
      }
      if (!confirm) actions += button('Routines', 'list', { disabled: s.busy || !!s.pending });
    } else {
      content = '<h1>Guided routines</h1><p class="muted">Scheduled workouts · ' + esc(date) + '</p>';
      content += s.rows.length ? s.rows.map((r, i) => '<button class="routine" data-action="open-' + i + '">' + esc(r.title) + '<small>' + (r.completed ? 'Task complete' : r.record.guidance ? 'Resume saved guidance' : 'Ready to begin') + '</small></button>').join('') : '<p>No guided workouts on this date.</p><p class="muted">Use DCC’s workout templates to plan a routine, then open it here.</p>';
      actions = button('Previous day', 'previous-day', { disabled: s.busy }) + button('Next day', 'next-day', { disabled: s.busy });
    }
    const error = offline ? 'Offline · last confirmed state. Reconnect to save changes.' : s.error;
    let recovery = '';
    if (s.accountChanged) recovery += button('Reload account', 'reload-account', { disabled: s.busy });
    if (s.code === 401) recovery += '<a class="control" data-action="login" href="/login?next=' + encodeURIComponent(url(selected)) + '">Sign in to DCC</a>';
    if (s.pending && s.code !== 409) recovery += button('Retry safely', 'retry', { disabled: s.busy || offline || s.code === 403 });
    if (s.pending && [403, 404].includes(s.code)) recovery += button('Leave unresolved', 'leave', { disabled: s.busy });
    if (s.error || offline || s.pending) recovery += button(s.code === 409 ? 'Reload saved routine' : 'Refresh saved state', 'refresh', { disabled: s.busy || offline });
    host.innerHTML = '<header><span class="eyebrow">DCC / Guided</span><span class="status" role="status">' + esc(offline ? 'Offline' : s.busy ? 'Connecting…' : s.status) + '</span></header>' + progress +
      (error ? '<div class="alert" role="alert">' + esc(error) + '</div>' : '') +
      '<section class="card" id="card" tabindex="0" aria-label="Routine card">' + content + '</section>' +
      (recovery ? '<div class="actions" aria-label="Recovery">' + recovery + '</div>' : '') +
      '<nav aria-label="Routine controls">' + actions + '</nav><footer>Arrows move focus · Enter selects<br>Focus card + ↑↓ to read · Navigation never logs exercise results</footer>';
    const target = focusNext || focused || 'card';
    const el = host.querySelector('[data-action="' + target + '"]:not(:disabled)') || document.getElementById(target) || document.getElementById('card');
    el?.focus({ preventScroll: true });
    const card = host.querySelector('.card'); if (!focusNext) card.scrollTop = scroll;
    if (!s.busy) focusNext = null;
  }
  host.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]'); if (!el || el.disabled || session.state.busy) return;
    const action = el.dataset.action;
    if (action === 'reload-account') { location.reload(); return; }
    if (action === 'login') return;
    if (action === 'leave') { session.leaveUnresolved(); selected = null; confirm = false; focusNext = 'card'; render(session.state); return; }
    if (action === 'confirm') { confirm = true; focusNext = 'cancel'; render(session.state); return; }
    if (action === 'cancel') { confirm = false; focusNext = 'confirm'; render(session.state); return; }
    if (action === 'complete') { focusNext = 'card'; await session.complete(); if (session.state.row?.completed) confirm = false; render(session.state); return; }
    if (action === 'retry') { focusNext = 'card'; await session.retry(); if (session.state.row?.completed) confirm = false; render(session.state); return; }
    if (action === 'refresh') { confirm = false; focusNext = 'card'; await session.load({ taskId: selected, date, discardConflict: session.state.code === 409 }); return; }
    if (action.startsWith('open-')) selected = session.state.rows[Number(action.slice(5))].taskId;
    else if (action === 'list') { selected = null; confirm = false; history.replaceState(null, '', url(null)); }
    else if (action.endsWith('-day')) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + (action === 'next-day' ? 1 : -1)); date = d.toISOString().slice(0, 10); history.replaceState(null, '', url(null)); }
    else { focusNext = 'card'; await session.guide(action); return; }
    focusNext = 'card'; await session.load({ taskId: selected, date });
  });
  document.addEventListener('keydown', e => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.repeat) { e.preventDefault(); return; }
    if (e.key === 'Enter') {
      // Use native Enter activation for buttons/links. The card itself is inert.
      if (document.activeElement?.id === 'card') e.preventDefault();
      return;
    }
    e.preventDefault();
    const card = document.getElementById('card');
    if (document.activeElement === card && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
      const down = e.key === 'ArrowDown';
      if ((down && card.scrollTop + card.clientHeight < card.scrollHeight - 2) || (!down && card.scrollTop > 0)) { card.scrollTop += down ? 110 : -110; return; }
    }
    const items = Array.from(host.querySelectorAll('#card, button:not(:disabled), a.control'));
    const current = items.indexOf(document.activeElement), delta = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1;
    items[(Math.max(current, 0) + delta + items.length) % items.length]?.focus();
  });
  window.addEventListener('offline', () => render(session.state));
  window.addEventListener('online', () => render(session.state));
  window.addEventListener('focus', () => { if (document.activeElement === document.body) document.getElementById('card')?.focus(); });
  session.load({ taskId: selected, date });
})();
