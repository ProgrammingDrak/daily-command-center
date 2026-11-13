// Glasses is a presentation adapter over the signed-in DCC application, not an app.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('device') !== 'glasses') return;
  const DCC = window.DCC, Navigation = window.DCCGlassesNavigation;
  if (!DCC || !Navigation) return;
  const principal = JSON.stringify(window.DCC_ACCOUNT_CONTEXT || null);
  const sameAccount = () => principal === JSON.stringify(window.DCC_ACCOUNT_CONTEXT || null);
  let sessionInvalid = false;
  const signedIn = () => !sessionInvalid && !!window.DCC_ACCOUNT_CONTEXT?.userId && sameAccount();
  const nav = Navigation.create();
  let pending = false, undo = null, revision = 0, refreshGeneration = 0;
  let library = { allTasks: [], someday: [] }, looseEnds = [], problem = '', loading = true;
  let loaded = false, refreshPromise = null;
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
  const button = (label, action, className = '') => {
    const el = node('button', className, label); el.type = 'button'; el.addEventListener('click', action); return el;
  };
  const root = node('main', 'glasses-app'); root.id = 'glasses-app'; root.tabIndex = 0; root.setAttribute('aria-label', 'Glasses task navigation');
  const header = node('header', 'glasses-header'), mode = node('span', 'glasses-mode'), position = node('span', 'glasses-position');
  const collection = node('h1', 'glasses-collection'), content = node('section', 'glasses-content');
  const footer = node('footer', 'glasses-footer');
  const back = button('↶ Back', () => input('tap-middle'), 'glasses-back'); back.setAttribute('aria-label', 'Middle finger: Back');
  const details = button('◎ Hold: Details', () => input('hold-fore'), 'glasses-details');
  const undoStatus = node('button', 'glasses-undo'); undoStatus.id = 'glasses-undo'; undoStatus.type = 'button'; undoStatus.addEventListener('click', () => input('double-middle')); undoStatus.hidden = true;
  const status = node('p', 'glasses-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const exit = node('a', 'glasses-exit', 'Full app'); const url = new URL(location.href); url.searchParams.delete('device'); exit.href = url.pathname + url.search + url.hash;
  const refresh = button('↻', () => refreshSources(), 'glasses-refresh'); refresh.setAttribute('aria-label', 'Refresh tasks');
  header.append(mode, position, refresh, exit); footer.append(back, undoStatus, details);
  root.append(header, collection, content, footer, status); document.body.append(root); document.body.classList.add('device-glasses');
  function announce(message) { status.textContent = message; }
  function descriptor(value, section) {
    if (value?.kind && value.actionId) return { ...value, section: section || value.section || '' };
    const row = value?.task || (value?.properties ? value : null);
    const ev = value?.ev || (row ? DCC.TaskModel.fromBlock(row) : value);
    const id = row?.id || ev?._blockId || ev?.__unf?.sourceId || ev?.id;
    return id ? { id: String(id), actionId: String(id), kind: 'task', row, ev, title: ev?.title || row?.properties?.title || 'Task', section: section || '', queue: value?.task ? value : null } : null;
  }
  function lists() {
    const hierarchy = (items, options) => Navigation.taskHierarchy(items, DCC.TaskModel, options);
    const queue = (window.DCCWorkingQueue?.getState().queue?.items || []).map(item => window.DCCQueuePolicy.presentation(item));
    const lanes = window.DCCQueuePolicy.lanes(queue, DCC.TaskPriority.group);
    const working = ['foreground', 'needs', 'background', 'priority'].flatMap((key, i) =>
      hierarchy((lanes[key] || []).map(item => descriptor(item, Navigation.LANES[i])), { preserveOrder: true }));
    const itinerary = (window.glassesItineraryTasks?.() || []).map(ev => descriptor(ev));
    const unscheduled = (window.glassesUnscheduledTasks?.() || []).map(ev => descriptor(ev));
    const whenever = (DCC.Whenever?.glassesTasks?.() || []).map(ev => descriptor(ev));
    const waitingRules = DCC.TaskQueues.waitingRules({ today: DCC.dates.todayKey(), scoreClass: score => window.urgency.scoreClass(score) });
    const waiting = (DCC.Waiting?.all?.() || []).filter(waitingRules.isOpenDelegated).map(row => ({ id: 'waiting:' + row.id, actionId: row.id, kind: 'waiting', row, title: row.properties?.myTask || row.properties?.title || 'Waiting', ev: DCC.TaskModel.fromBlock(row) }));
    return [hierarchy(library.allTasks), working, hierarchy(itinerary), looseEnds,
      hierarchy(unscheduled), hierarchy(whenever),
      hierarchy(library.someday), waiting];
  }
  function reconcile() {
    if (!signedIn()) {
      undo = null; library = { allTasks: [], someday: [] }; looseEnds = []; nav.setLists([]); inputAdapter.reset();
      problem = 'Account changed or signed out. Reload to continue safely.';
    } else {
      try { nav.setLists(lists()); } catch (error) { problem = error.message; }
    }
    render();
  }
  async function refreshSources(force = false) {
    if (!signedIn()) { reconcile(); return; }
    if (refreshPromise) return force ? refreshPromise.then(() => refreshSources()) : refreshPromise;
    const generation = ++refreshGeneration;
    loading = true;
    refreshPromise = (async () => {
      try {
        const [nextLibrary, nextLoose] = await Promise.all([
          window.DCCTaskLibrary.glassesCollections(), DCC.CatchUp.glassesTasks(),
          window.DCCWorkingQueue?.refresh()
        ]);
        if (!sameAccount() || generation !== refreshGeneration) return;
        library = nextLibrary; looseEnds = nextLoose; problem = ''; loaded = true;
      } catch (error) {
        if ([401, 403].includes(error.status)) { sessionInvalid = true; ++revision; }
        if (sameAccount()) problem = 'Refresh unavailable: ' + error.message;
      }
      finally { loading = false; refreshPromise = null; reconcile(); }
    })();
    return refreshPromise;
  }
  function meta(item) {
    const ev = item.ev || {}, p = item.row?.properties || {};
    const state = (window.DCCWorkingQueue?.getState().queue?.items || []).find(entry => entry.task.id === item.actionId);
    return [state?.status === 'foreground' ? 'Foreground' : item.section || '', ev.start || '', ev.duration ? ev.duration + ' min' : '', p.priorityLabel || ''].filter(Boolean).join(' · ') || (item.kind === 'waiting' ? 'Waiting for a response' : 'Ready when you are');
  }
  function appearance(item) {
    const relation = item.relation === 'subtask' ? 'Subtask' : item.relation === 'ride-along' ? 'Nested task' : '';
    if (item.kind === 'waiting') return { relation, label: 'Waiting', color: 'var(--glasses-waiting)' };
    const type = window.TaskTypes.get(item.kind === 'triage' || item.ev?.triageBlock ? 'triage' : item.ev);
    return { relation, label: type.label, color: type.color };
  }
  function direction(symbol, label, action, className) {
    const el = button('', () => input(action), 'glasses-direction ' + className); el.dataset.action = action; el.setAttribute('aria-label', label);
    el.append(node('span', '', symbol), node('small', '', label)); return el;
  }
  function render() {
    const state = nav.snapshot(), wasInside = content.contains(document.activeElement), previous = root.dataset.level;
    root.dataset.level = state.level;
    if (previous === 'jump' && state.level === 'select') {
      root.classList.remove('glasses-select-enter'); void root.offsetWidth; root.classList.add('glasses-select-enter');
    }
    mode.textContent = ({ jump: 'JUMP VIEW ×5', select: 'SELECT VIEW ×1', task: 'TASK VIEW', details: 'TASK DETAILS', more: 'MORE ACTIONS' })[state.level];
    position.textContent = state.count ? (state.index + 1) + ' / ' + state.count : '0 / 0'; collection.textContent = state.collectionName;
    content.replaceChildren();
    if (!state.selected) content.append(node('p', 'glasses-empty', problem || (loading ? 'Loading your tasks…' : 'No open tasks in this collection.')));
    else if (['jump', 'select'].includes(state.level)) {
      const list = node('div', 'glasses-list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', state.collectionName); list.style.setProperty('--rows', String(Math.max(11, state.rows.length)));
      let section = null;
      state.rows.forEach((item, slot) => {
        const index = state.window.start + slot, selected = index === state.index;
        const { relation, label: type, color } = appearance(item);
        const row = node('div', 'glasses-task-row'); row.dataset.taskId = item.id; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
        row.setAttribute('aria-label', [item.section, item.title, relation, type === 'Task' && relation ? '' : type].filter(Boolean).join(', '));
        row.style.setProperty('--glasses-type-color', color);
        if (relation) {
          row.dataset.relation = item.relation;
          row.style.setProperty('--glasses-depth', String(item.depth));
        }
        if (state.level === 'jump' && index >= state.range.start && index < state.range.end) row.classList.add('glasses-range');
        if (selected) row.classList.add('glasses-selected');
        row.append(node('span', 'glasses-number', index + 1)); const label = node('span', 'glasses-row-label');
        if (item.section && item.section !== section) label.append(node('small', 'glasses-section', item.section));
        section = item.section;
        label.append(node('span', 'glasses-title', item.title));
        row.append(label, node('span', type === 'Task' ? 'glasses-type glasses-relation' : 'glasses-type',
          type === 'Task' ? relation : type));
        list.append(row);
      });
      content.append(list);
    } else if (state.level === 'task') {
      const item = state.selected, view = node('div', 'glasses-task-view');
      const { relation, label: type, color } = appearance(item);
      const foreground = window.DCCWorkingQueue?.getState().queue?.items?.some(entry => entry.task.id === item.actionId && entry.status === 'foreground');
      const focus = button('', () => input('tap-fore'), 'glasses-focus'); focus.setAttribute('aria-label', 'Complete ' + item.title);
      const category = node('span', 'glasses-focus-type', [relation, type === 'Task' && relation ? '' : type].filter(Boolean).join(' · '));
      category.style.setProperty('--glasses-type-color', color);
      focus.append(category, node('strong', '', item.title), node('span', 'glasses-task-meta', meta(item)), node('small', '', pending ? 'Saving…' : '◎ Tap to complete'));
      bindFinger(focus, 'fore');
      view.append(direction('↑', foreground ? 'Background · 30m' : 'Foreground', 'up', 'glasses-up'), direction('✓', 'Complete', 'left', 'glasses-left'), focus, direction('⊖', 'Remove priority', 'right', 'glasses-right'), direction('•••', 'More actions', 'down', 'glasses-down'));
      content.append(view);
    } else if (state.level === 'details') {
      const detail = node('section', 'glasses-placeholder'); detail.append(node('h2', '', state.selected.title), node('p', '', 'Task Details'), node('p', '', 'The full details view is coming later.')); content.append(detail);
    } else {
      const more = node('div', 'glasses-more-actions');
      moreOptions(state.selected).forEach(([label, action], index) => { const el = button(label, action); el.classList.toggle('glasses-selected', index === state.moreIndex); el.dataset.moreIndex = index; more.append(el); });
      content.append(more);
    }
    details.hidden = state.level !== 'task';
    if (wasInside) root.focus({ preventScroll: true });
    updateUndo();
    if (problem) announce(problem);
    else if (!status.textContent) announce('Swipe to navigate. Forefinger selects. Middle finger goes back.');
  }
  function moreOptions(item) {
    return [
      ['Open existing outcome flow', () => window.DCCWorkingQueue.openTaskOutcome(item.actionId, item).catch(error => announce(error.message))],
      ['Task Details', () => { nav.input('back'); return input('hold-fore'); }],
      ['Refresh from DCC', () => refreshSources()],
      ['Back to task', () => input('tap-middle')]
    ];
  }
  function updateUndo() {
    if (undo && (!sameAccount() || Date.now() >= undo.expiresAt)) undo = null;
    undoStatus.hidden = !undo;
    if (undo) { undoStatus.textContent = '↶↶ Undo ' + Math.max(1, Math.ceil((undo.expiresAt - Date.now()) / 1000)) + 's'; undoStatus.setAttribute('aria-label', 'Double middle finger: undo completion'); }
  }
  async function mutate(action, item) {
    if (pending || !item || !signedIn()) return;
    if (!navigator.onLine) { announce('Offline. Nothing submitted. Reconnect and try again.'); return; }
    pending = true; const operation = ++revision;
    if (action === 'complete') nav.input('select-view');
    announce(action === 'complete' ? 'Completing task… awaiting DCC confirmation.' : 'Saving task action…'); render();
    try {
      const result = await window.DCCWorkingQueue.performTaskAction(action, item.actionId, { kind: item.kind });
      if (!sameAccount() || operation !== revision) return;
      if (action === 'complete') {
        undo = result.undo || null;
        announce(undo ? 'Completed ' + item.title + '. Double middle tap to undo.' : 'Completed ' + item.title + '.');
      } else announce(action === 'remove' ? 'Removed from Priority Queue. Task retained.' : 'Task moved to ' + (action === 'background' ? 'Background for 30 minutes' : 'Foreground') + '.');
      // Mutation ownership ends at acknowledgement, not after unrelated reads.
      pending = false; ++refreshGeneration; updateUndo();
      await refreshSources(true);
    } catch (error) { if (sameAccount() && operation === revision) announce('Not confirmed: ' + error.message); }
    finally { if (operation === revision) pending = false; reconcile(); }
  }
  async function undoCompletion() {
    updateUndo(); const receipt = undo;
    if (!receipt || pending || !signedIn()) return;
    if (!navigator.onLine) { announce('Offline. Undo was not submitted.'); return; }
    pending = true; const operation = ++revision; undo = null; updateUndo(); announce('Undoing completion… awaiting DCC confirmation.');
    try {
      await window.DCCWorkingQueue.undoCompletion(receipt);
      if (sameAccount() && operation === revision) {
        pending = false; ++refreshGeneration; announce('Completion undone.'); await refreshSources(true);
      }
    } catch (error) { if (sameAccount() && operation === revision) announce('Undo not confirmed: ' + error.message); }
    finally { if (operation === revision) pending = false; reconcile(); }
  }
  async function input(action) {
    if (!signedIn()) { reconcile(); return; }
    updateUndo();
    if (action === 'double-middle') { if (undo) return undoCompletion(); nav.input('home'); render(); return; }
    if (action === 'tap-middle') { nav.input('back'); render(); return; }
    const state = nav.snapshot();
    if (state.level === 'more' && action === 'tap-fore') return moreOptions(state.selected)[state.moreIndex][1]();
    if (state.level === 'task') {
      if (action === 'tap-fore' || action === 'left') return mutate('complete', state.selected);
      if (action === 'up') {
        const foreground = window.DCCWorkingQueue.getState().queue?.items?.some(item => item.task.id === state.selected.actionId && item.status === 'foreground');
        return mutate(foreground ? 'background' : 'foreground', state.selected);
      }
      if (action === 'right') return mutate('remove', state.selected);
      if (action === 'down') { nav.input('more'); render(); return; }
    }
    nav.input(action); render();
  }
  const inputAdapter = Navigation.createInput(action => input(action));
  // Pointer controls and keyboard Enter/Escape share exactly the same recognizer.
  function bindFinger(el, finger) {
    let pointer = false, suppressClick = false;
    el.addEventListener('pointerdown', event => { if (event.button !== 0) return; pointer = true; suppressClick = true; el.setPointerCapture?.(event.pointerId); inputAdapter.down(finger); });
    el.addEventListener('pointerup', () => { if (pointer) inputAdapter.up(finger); pointer = false; });
    el.addEventListener('pointercancel', () => { pointer = false; inputAdapter.cancel(); });
    el.addEventListener('lostpointercapture', () => { if (pointer) { pointer = false; inputAdapter.cancel(); } });
    el.addEventListener('click', event => { if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  }
  bindFinger(back, 'middle');
  function gestureScope(event) {
    return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
      !event.target.closest?.('input,textarea,select,[contenteditable="true"],dialog,[role="dialog"],.dcc-overlay') &&
      (event.target === document.body || event.target === root || root.contains(event.target));
  }
  document.addEventListener('keydown', event => {
    if (!gestureScope(event)) return;
    const action = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
    if (action) { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) input(action); return; }
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.target === document.body || event.target === root || event.target.classList.contains('glasses-focus')))) {
      event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) inputAdapter.down(event.key === 'Enter' ? 'fore' : 'middle');
    }
  }, true);
  document.addEventListener('keyup', event => {
    if (!gestureScope(event) || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault(); inputAdapter.up(event.key === 'Enter' ? 'fore' : 'middle');
  }, true);
  window.addEventListener('blur', () => inputAdapter.reset());
  let swipe = null;
  content.addEventListener('pointerdown', event => { if (event.target.closest('button') || event.button !== 0) return; swipe = { id: event.pointerId, x: event.clientX, y: event.clientY }; });
  content.addEventListener('pointerup', event => { if (!swipe || swipe.id !== event.pointerId) return; const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y; swipe = null; if (Math.max(Math.abs(dx), Math.abs(dy)) >= 35) input(Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'up' : 'down'); });
  content.addEventListener('pointercancel', () => { swipe = null; });
  window.addEventListener('dcc:glasses-gesture', event => { if (['up', 'down', 'left', 'right', 'tap-fore', 'hold-fore', 'tap-middle', 'double-middle'].includes(event.detail?.action)) input(event.detail.action); });
  if (params.has('glassesSimulator')) {
    const simulator = node('nav', 'glasses-simulator'); simulator.setAttribute('aria-label', 'Development gesture simulator');
    for (const [label, action] of [['↑','up'],['↓','down'],['←','left'],['→','right'],['Forefinger','tap-fore'],['Hold forefinger','hold-fore'],['Middle','tap-middle'],['Double middle','double-middle']]) simulator.append(button(label, () => input(action)));
    root.append(simulator);
  }
  window.DCCGlasses = Object.freeze({ input, snapshot: nav.snapshot, refresh: refreshSources });
  let queued = false;
  const update = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; reconcile(); }); };
  new MutationObserver(records => { if (records.some(record => !root.contains(record.target) && record.target !== root)) update(); }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('dcc:data-ready', () => refreshSources());
  document.addEventListener('dcc:working-queue-sync', update);
  window.addEventListener('task-completion-confirmed', () => refreshSources());
  window.addEventListener('dcc:carryover-settled', () => refreshSources());
  window.addEventListener('dcc:view-date-changed', () => { if (loaded) refreshSources(); });
  window.addEventListener('online', () => refreshSources());
  window.addEventListener('offline', () => announce('Offline. Completion is paused until you reconnect.'));
  document.addEventListener('visibilitychange', () => { inputAdapter.reset(); if (!document.hidden) refreshSources(); });
  setInterval(() => { updateUndo(); if (!sameAccount()) reconcile(); }, 100);
  // The canonical boot owns loading. Its data-ready event refreshes all sources.
  reconcile();
  if (document.readyState === 'complete') refreshSources();
})();
