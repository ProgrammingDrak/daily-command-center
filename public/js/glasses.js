/* global GlassesTasksSession, GlassesModel */
(function () {
  'use strict';
  const host = document.getElementById('glasses'), params = new URLSearchParams(location.search), zone = window.DCC_APP_TIME_ZONE;
  let date = params.get('date'), selected = params.get('task'), screen = params.get('view') === 'tasks' ? 'tasks' : 'today';
  let pageIndex = Math.max(0, Number(params.get('page')) || 0), confirm = false, focusNext = 'card';
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const button = (label, action, disabled = false, primary = false) => '<button data-action="' + esc(action) + '"' + (disabled ? ' disabled' : '') + (primary ? ' class="primary"' : '') + '>' + esc(label) + '</button>';
  function url() { const p = new URLSearchParams({ view: screen, page: String(pageIndex) }); if (date) p.set('date', date); if (selected) p.set('task', selected); return '/glasses.html?' + p; }
  function time(t) { return t.allDay ? 'All day' : t.untimed ? (t.date ? 'Unplanned' : 'Unscheduled') : t.start + '–' + t.end; }
  function tile(t, label) { return '<button class="routine" data-action="open:' + esc(t.taskId) + '"><small>' + esc(label || time(t)) + (t.completed ? ' · Done' : '') + '</small><span>' + (t.depth ? '↳ ' : '') + esc(t.title) + '</span></button>'; }
  const session = GlassesTasksSession.create({
    storage: { getItem: k => sessionStorage.getItem(k), setItem: (k, v) => sessionStorage.setItem(k, v), removeItem: k => sessionStorage.removeItem(k) },
    uuid: () => crypto.randomUUID(), online: () => navigator.onLine, changed: render,
    request: async (path, options = {}) => {
      const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 15000);
      try {
        const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal, ...options,
          ...(options.body ? { body: JSON.stringify(options.body), headers: { 'Content-Type': 'application/json' } } : {}) });
        const body = await r.json().catch(() => null);
        if (!r.ok) throw Object.assign(new Error(body?.error || 'DCC could not confirm this request.'), { status: r.status });
        if (!body) throw new Error('Unreadable response. Refresh saved state before continuing.');
        return body;
      } catch (e) {
        if (e.name === 'AbortError' || e instanceof TypeError) throw new Error('Connection interrupted. A submitted completion may have reached DCC. Retry safely to check.');
        throw e;
      } finally { clearTimeout(timeout); }
    }
  });
  function render(s) {
    const focused = document.activeElement?.dataset.action || document.activeElement?.id, scroll = host.querySelector('.card')?.scrollTop || 0;
    const offline = !navigator.onLine, locked = s.busy || !!s.pending || offline || [401, 403, 409].includes(s.code), view = s.view;
    if (s.date) date = s.date;
    if (s.pending) selected = s.pending.taskId;
    let content = '', actions = '', headline = screen === 'tasks' ? 'To-do list' : 'Today’s itinerary';
    if (s.row && selected) {
      const row = s.row;
      headline = confirm ? 'Complete this task?' : row.completed ? 'Task complete' : 'Task detail';
      content = '<p class="eyebrow">' + esc(row.date || 'Unscheduled') + ' · ' + esc(time(row)) + '</p><h1>' + esc(row.title) + '</h1>';
      if (confirm) {
        content += '<p>Mark this task done in DCC?</p><p class="muted">DCC’s normal completion rules also apply to linked steps and dependencies.</p>';
        actions = button('Cancel', 'cancel', s.busy) + button('Confirm completion', 'complete', locked, true);
      } else {
        content += '<p class="muted">' + (row.completed ? 'Completed · confirmed by DCC' : row.startedAt ? 'In progress' : 'Open') + '</p><p class="instruction">' + esc(row.detail || row.notes || 'No additional details.') + '</p>';
        if (!row.completed && row.date) actions += button('Complete task…', 'confirm', locked, true);
        if (!row.date) content += '<p class="muted">Schedule this task in DCC before completing it here.</p><a class="control" data-action="full-dcc" href="/">Open full DCC</a>';
        if (row.type === 'workout') actions += '<a class="control" data-action="routine" href="/glasses-routine.html?task=' + encodeURIComponent(row.taskId) + '&date=' + encodeURIComponent(date) + '">Guided cards</a>';
        actions += button('Back', 'back', s.busy || !!s.pending);
      }
    } else if (view) {
      content = '<p class="muted">' + esc(date) + ' · ' + esc(zone) + '</p>';
      const rows = screen === 'tasks' ? view.todos : view.itinerary;
      const max = screen === 'tasks' ? Math.max(0, Math.ceil(rows.length / 3) - 1) : Math.ceil(rows.length / 3);
      pageIndex = Math.min(pageIndex, max);
      if (screen === 'today' && pageIndex === 0) {
        const clock = GlassesModel.clock(zone), pair = GlassesModel.currentNext(view, date === clock.date ? clock.minutes : -1);
        content += '<h1>' + (date === clock.date ? 'Your day, in view' : 'Your itinerary') + '</h1>';
        content += pair.current ? tile(pair.current, 'NOW · ' + time(pair.current)) : '<p class="muted">No scheduled task active now.</p>';
        content += pair.next ? tile(pair.next, 'UP NEXT · ' + time(pair.next)) : '<p class="muted">No later timed item.</p>';
        content += '<p class="muted">' + view.itinerary.filter(t => t.completed).length + ' of ' + view.itinerary.length + ' itinerary items done · ' + view.todos.length + ' open to-dos</p>';
      } else {
        const start = (screen === 'today' ? pageIndex - 1 : pageIndex) * 3, page = rows.slice(start, start + 3);
        content += '<h1>' + (screen === 'tasks' ? 'To-do list' : 'Itinerary') + '</h1>';
        content += page.length ? page.map(t => tile(t, (t.date && t.date !== date ? t.date + ' · ' : '') + time(t))).join('') : '<p>No items here.</p>';
        content += '<p class="muted">' + (rows.length ? Math.min(start + 1, rows.length) + '–' + Math.min(start + 3, rows.length) + ' of ' + rows.length : 'All clear') + '</p>';
      }
      if (view.seedOnly) content += '<p class="muted">' + view.seedOnly + ' legacy timeline item(s) require the full DCC view.</p>';
      if (view.truncated) content += '<p class="muted">Earlier tasks are limited to the newest 2,000 records.</p>';
      actions = button('Previous', 'previous', s.busy || pageIndex === 0) + button(screen === 'today' && pageIndex === 0 ? 'Full itinerary' : 'Next', 'next', s.busy || pageIndex >= max, true);
      actions += button(screen === 'tasks' ? 'Today' : 'To-do list', screen === 'tasks' ? 'today' : 'tasks', s.busy || !!s.pending);
    } else content = '<h1>Opening your day</h1><p>Waiting for DCC’s saved itinerary.</p>';
    const error = offline ? 'Offline · last confirmed view. Reconnect to complete tasks.' : s.error;
    let recovery = '';
    if (s.code === 401) recovery += '<a class="control" data-action="login" href="/login?next=' + encodeURIComponent(url()) + '">Sign in to DCC</a>';
    if (s.pending && s.code !== 409) recovery += button('Retry safely', 'retry', s.busy || offline || s.code === 403);
    if (s.pending && [403, 404].includes(s.code)) recovery += button('Leave unresolved', 'leave', s.busy);
    if (error || s.pending) recovery += button('Refresh saved state', 'refresh', s.busy || offline);
    host.innerHTML = '<header><span class="eyebrow">DCC / ' + esc(headline) + '</span><span class="status" role="status">' + esc(offline ? 'Offline' : s.busy ? 'Connecting…' : s.status) + '</span></header>' +
      (error ? '<div class="alert" role="alert">' + esc(error) + '</div>' : '') + '<section class="card" id="card" tabindex="0" aria-label="Current view">' + content + '</section>' +
      (recovery ? '<div class="actions" aria-label="Recovery">' + recovery + '</div>' : '') + '<nav aria-label="Task controls">' + actions + '</nav>' +
      '<footer><span>Arrows move focus · Enter selects · Focus card + ↑↓ to read</span>' + button('Refresh', 'refresh', s.busy || offline) + '</footer>';
    history.replaceState(null, '', url());
    const target = focusNext || focused || 'card';
    const el = Array.from(host.querySelectorAll('[data-action]:not(:disabled)')).find(e => e.dataset.action === target) || document.getElementById(target) || document.getElementById('card');
    el?.focus({ preventScroll: true }); if (!focusNext) host.querySelector('.card').scrollTop = scroll;
    if (!s.busy) focusNext = null;
  }
  async function load(discardConflict = false) { await session.load({ date, taskId: selected, discardConflict }); }
  host.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]'); if (!el || el.disabled || session.state.busy) return;
    const a = el.dataset.action;
    if (['login', 'routine', 'full-dcc'].includes(a)) return;
    if (a === 'leave') { session.leaveUnresolved(); selected = null; confirm = false; focusNext = 'card'; render(session.state); return; }
    if (a === 'confirm' || a === 'cancel') { confirm = a === 'confirm'; focusNext = confirm ? 'cancel' : 'confirm'; render(session.state); return; }
    if (a === 'complete' || a === 'retry') { focusNext = 'card'; await session[a](); confirm = false; render(session.state); return; }
    if (a === 'refresh') { const conflict = session.state.code === 409; confirm = false; focusNext = 'card'; await load(conflict); return; }
    if (a.startsWith('open:')) { selected = a.slice(5); focusNext = 'card'; await load(); return; }
    if (a === 'back') { focusNext = 'open:' + selected; selected = null; confirm = false; await load(); return; }
    if (a === 'today') { selected = null; date = null; screen = 'today'; pageIndex = 0; focusNext = 'card'; await load(); return; }
    if (a === 'tasks') { screen = 'tasks'; pageIndex = 0; }
    if (a === 'previous') pageIndex = Math.max(0, pageIndex - 1);
    if (a === 'next') pageIndex++;
    focusNext = 'card'; render(session.state);
  });
  document.addEventListener('keydown', e => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.repeat) { e.preventDefault(); return; }
    if (e.key === 'Enter') { if (document.activeElement?.id === 'card') e.preventDefault(); return; }
    e.preventDefault(); const card = document.getElementById('card');
    if (document.activeElement === card && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
      const down = e.key === 'ArrowDown';
      if ((down && card.scrollTop + card.clientHeight < card.scrollHeight - 2) || (!down && card.scrollTop > 0)) { card.scrollTop += down ? 110 : -110; return; }
    }
    const items = Array.from(host.querySelectorAll('#card, button:not(:disabled), a.control'));
    const index = items.indexOf(document.activeElement), delta = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1;
    items[(Math.max(index, 0) + delta + items.length) % items.length]?.focus();
  });
  window.addEventListener('offline', () => render(session.state));
  window.addEventListener('online', () => render(session.state));
  window.addEventListener('focus', () => { if (document.activeElement === document.body) document.getElementById('card')?.focus(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !session.state.busy && !confirm && !session.state.pending && navigator.onLine) load(); });
  setInterval(() => {
    if (document.visibilityState !== 'visible' || session.state.busy || confirm || session.state.pending || selected || !session.state.view) return;
    if (screen === 'today' && date !== GlassesModel.clock(zone).date) { date = null; load(); }
    else render(session.state);
  }, 30000);
  if (!zone) { host.innerHTML = '<p role="alert">DCC timezone could not be loaded. Reload after signing in.</p>'; return; }
  load();
})();
