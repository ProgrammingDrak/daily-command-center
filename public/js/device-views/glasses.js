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
  let preview = null;
  const swipeActions = { left: 'delete', right: 'complete' };
  const prompts = { left: 'Delete?', right: 'Complete?' };
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
  const undoStatus = button('', () => undoTaskAction(), 'glasses-undo');
  undoStatus.id = 'glasses-undo'; undoStatus.hidden = true;
  const status = node('p', 'glasses-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const exit = node('a', 'glasses-exit', 'Full app'); const url = new URL(location.href); url.searchParams.delete('device'); exit.href = url.pathname + url.search + url.hash;
  const refresh = button('↻', () => refreshSources(), 'glasses-refresh'); refresh.setAttribute('aria-label', 'Refresh tasks');
  header.append(mode, position, refresh, exit); footer.append(back, undoStatus, details);
  root.append(header, collection, content, footer, status); document.body.append(root); document.body.classList.add('device-glasses');
  document.getElementById('glasses-startup')?.remove();
  document.documentElement.classList.remove('glasses-starting');
  let restoredHistory = false;
  const navigationHistory = Navigation.createHistory({
    history: window.history, scope: principal,
    active: () => signedIn() && new URLSearchParams(location.search).get('device') === 'glasses',
    changed: saved => { inputAdapter.reset(); preview = null; nav.restore(saved); render(); }
  });
  window.addEventListener('popstate', () => navigationHistory.pop());
  function announce(message) { status.textContent = message; }
  const hierarchy = (items, options) => Navigation.taskHierarchy(items, DCC.TaskModel, options);
  function descriptor(value, section) {
    if (value?.kind && value.actionId) return { ...value, section: section || value.section || '' };
    const row = value?.task || (value?.properties ? value : null);
    const ev = value?.ev || (row ? DCC.TaskModel.fromBlock(row) : value);
    const id = row?.id || ev?._blockId || ev?.__unf?.sourceId || ev?.id;
    return id ? { id: String(id), actionId: String(id), kind: 'task', row, ev, title: ev?.title || row?.properties?.title || 'Task', section: section || '', queue: value?.task ? value : null } : null;
  }
  function lists() {
    const queue = (window.DCCWorkingQueue?.getState().queue?.items || []).map(item => window.DCCQueuePolicy.presentation(item));
    const lanes = window.DCCQueuePolicy.lanes(queue, DCC.TaskPriority.group);
    const working = ['foreground', 'needs', 'background', 'priority'].flatMap((key, i) =>
      hierarchy((lanes[key] || []).map(item => descriptor(item, Navigation.LANES[i])), { preserveOrder: true }));
    const itinerary = (window.glassesItineraryTasks?.() || []).map(ev => descriptor(ev));
    const whenever = (DCC.Whenever?.glassesTasks?.() || []).map(ev => descriptor(ev));
    const waitingRules = DCC.TaskQueues.waitingRules({ today: DCC.dates.todayKey(), scoreClass: score => window.urgency.scoreClass(score) });
    const waiting = (DCC.Waiting?.all?.() || []).filter(waitingRules.isOpenDelegated).map(row => ({ id: 'waiting:' + row.id, actionId: row.id, kind: 'waiting', row, title: row.properties?.myTask || row.properties?.title || 'Waiting', ev: DCC.TaskModel.fromBlock(row) }));
    return [library.allTasks, working, hierarchy(itinerary), looseEnds,
      hierarchy(whenever),
      library.someday, waiting];
  }
  function reconcile() {
    if (!signedIn()) {
      undo = null; library = { allTasks: [], someday: [] }; looseEnds = []; nav.setLists([]); inputAdapter.reset();
      problem = 'Account changed or signed out. Reload to continue safely.';
    } else {
      try { nav.setLists(lists()); } catch (error) { problem = error.message; }
    }
    if (loaded && !restoredHistory && signedIn()) {
      restoredHistory = true;
      const saved = navigationHistory.current();
      if (saved) nav.restore(saved);
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
        library = { allTasks: hierarchy(nextLibrary.allTasks), someday: hierarchy(nextLibrary.someday) };
        looseEnds = nextLoose; problem = ''; loaded = true;
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
    if (item.kind === 'waiting') return { relation, label: 'Waiting', color: 'var(--waiting-ink)' };
    const sourceReview = item.ev?.type === 'task' && DCC.TimeBlocks.isSourceReviewTask(item.ev);
    const type = window.TaskTypes.get(item.kind === 'triage' || sourceReview ? 'triage' : item.ev);
    return { relation, label: type.label, color: type.color };
  }
  function direction(symbol, label, action, className) {
    const el = button('', () => input(action), 'glasses-direction ' + className); el.dataset.action = action; el.setAttribute('aria-label', label);
    el.append(node('span', '', symbol), node('small', '', label)); return el;
  }
  function renderPreview() {
    const target = content.querySelector('.glasses-swipe-target');
    if (!target) return;
    target.dataset.swipe = preview?.direction || '';
    const prompt = target.querySelector('.glasses-swipe-prompt');
    if (prompt) prompt.textContent = prompts[preview?.direction] || '';
    for (const direction of Object.keys(prompts)) {
      const control = target.querySelector('[data-action="' + direction + '"]');
      if (!control) continue;
      const label = preview?.direction === direction ? prompts[direction] : prompts[direction].slice(0, -1);
      control.querySelector('small').textContent = label;
      control.setAttribute('aria-label', label);
    }
  }
  function render() {
    // Wait for canonical lists before restoring a reload/Forward entry.
    if (loaded && restoredHistory) navigationHistory.sync(nav.snapshot());
    const state = nav.snapshot(), wasInside = content.contains(document.activeElement), previous = root.dataset.level;
    if (preview && (preview.level !== state.level || preview.taskId !== state.selected?.id)) preview = null;
    root.dataset.level = state.level;
    const enteringSelect = previous === 'jump' && state.level === 'select';
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
        if (selected) {
          row.classList.add('glasses-selected');
          if (enteringSelect) row.classList.add('glasses-select-enter');
        }
        row.append(node('span', 'glasses-number', index + 1)); const label = node('span', 'glasses-row-label');
        if (item.section && item.section !== section) label.append(node('small', 'glasses-section', item.section));
        section = item.section;
        label.append(node('span', 'glasses-title', item.title));
        row.append(label, node('span', type === 'Task' ? 'glasses-type glasses-relation' : 'glasses-type',
          type === 'Task' ? relation : type));
        if (selected && state.level === 'select') {
          const reveal = node('div', 'glasses-swipe-target glasses-row-reveal');
          reveal.setAttribute('role', 'presentation');
          const prompt = node('span', 'glasses-swipe-prompt');
          prompt.setAttribute('aria-hidden', 'true');
          reveal.append(row, prompt);
          list.append(reveal);
        } else list.append(row);
      });
      content.append(list);
    } else if (state.level === 'task') {
      const item = state.selected, view = node('div', 'glasses-task-view glasses-swipe-target');
      const { relation, label: type, color } = appearance(item);
      const foreground = window.DCCWorkingQueue?.getState().queue?.items?.some(entry => entry.task.id === item.actionId && entry.status === 'foreground');
      const focus = button('', () => input('tap-fore'), 'glasses-focus'); focus.setAttribute('aria-label', 'Complete ' + item.title);
      const category = node('span', 'glasses-focus-type', [relation, type === 'Task' && relation ? '' : type].filter(Boolean).join(' · '));
      category.style.setProperty('--glasses-type-color', color);
      focus.append(category, node('strong', '', item.title), node('span', 'glasses-task-meta', meta(item)), node('small', '', pending ? 'Saving…' : '◎ Tap to complete'));
      view.append(direction('↑', foreground ? 'Background · 30m' : 'Foreground', 'up', 'glasses-up'),
        direction('✓', 'Complete', 'right', 'glasses-left'), focus,
        direction('⊖', 'Delete', 'left', 'glasses-right'), direction('•••', 'More actions', 'down', 'glasses-down'));
      content.append(view);
    } else if (state.level === 'details') {
      const detail = node('section', 'glasses-placeholder'); detail.append(node('h2', '', state.selected.title), node('p', '', 'Task Details'), node('p', '', 'The full details view is coming later.')); content.append(detail);
    } else {
      const more = node('div', 'glasses-more-actions');
      moreOptions(state.selected).forEach(([label, action], index) => { const el = button(label, action); el.classList.toggle('glasses-selected', index === state.moreIndex); el.dataset.moreIndex = index; more.append(el); });
      content.append(more);
    }
    details.hidden = state.level !== 'task';
    renderPreview();
    if (wasInside) root.focus({ preventScroll: true });
    updateUndo();
    if (problem) announce(problem);
    else if (!status.textContent) announce('Swipe to navigate. Forefinger selects. Middle finger goes back.');
    return navigationHistory.settled();
  }
  function moreOptions(item) {
    return [
      ['Open existing outcome flow', () => window.DCCWorkingQueue.openTaskOutcome(item.actionId, item).catch(error => announce(error.message))],
      ['Task Details', () => { nav.input('back'); nav.input('hold-fore'); render(); }],
      ['Remove priority', () => mutate('remove', item)],
      ['Back to task', () => input('tap-middle')]
    ];
  }
  function updateUndo() {
    if (undo && (!sameAccount() || Date.now() >= undo.expiresAt)) undo = null;
    if (!undo && document.activeElement === undoStatus) root.focus({ preventScroll: true });
    undoStatus.hidden = !undo;
    undoStatus.disabled = pending;
    const deleteControl = content.querySelector('.glasses-task-view [data-action="left"]');
    if (deleteControl) deleteControl.disabled = !!undo || pending;
    if (undo) {
      const seconds = Math.max(1, Math.ceil((undo.expiresAt - Date.now()) / 1000));
      const label = 'Swipe left to undo · ' + seconds + 's';
      if (undoStatus.textContent !== label) undoStatus.textContent = label;
      undoStatus.setAttribute('aria-label', 'Undo ' + (undo.action === 'delete' ? 'deletion' : 'completion'));
    }
  }
  async function mutate(action, item) {
    if (pending || !item || !signedIn()) return;
    if (!navigator.onLine) { announce('Offline. Nothing submitted. Reconnect and try again.'); return; }
    pending = true; const operation = ++revision;
    const deleting = action === 'delete';
    const deleteMutationId = deleting ? crypto.randomUUID() : null;
    const progress = {
      complete: 'Completing task… awaiting DCC confirmation.',
      delete: 'Deleting task… awaiting DCC confirmation.'
    };
    announce(progress[action] || 'Saving task action…'); render();
    try {
      const result = deleting
        ? await window.blockStore.batchOp([{ op: 'delete', id: item.actionId, deleteMutationId }])
        : await window.DCCWorkingQueue.performTaskAction(action, item.actionId, { kind: item.kind });
      if (!sameAccount() || operation !== revision) return;
      if (deleting) {
        if (!result.ok) {
          announce(result.buffered ? 'Deletion queued for retry.' : 'Deletion could not be confirmed.');
          return;
        }
        // The Itinerary and Unscheduled projections read the folded schedule.
        window.refoldTaskStateFromBlockCache?.();
        undo = { action: 'delete', taskId: item.actionId, deleteMutationId, expiresAt: Date.now() + 8000 };
        announce('Deleted ' + item.title + '. Swipe left to undo.');
      } else if (action === 'complete') {
        undo = result.undo ? { ...result.undo, action: 'complete' } : null;
        announce(undo ? 'Completed ' + item.title + '. Swipe left to undo.' : 'Completed ' + item.title + '.');
      } else announce(action === 'remove' ? 'Removed from Priority Queue. Task retained.' : 'Task moved to ' + (action === 'background' ? 'Background for 30 minutes' : 'Foreground') + '.');
      const current = nav.snapshot();
      if ((deleting || action === 'complete') && current.level === 'task' && current.selected?.id === item.id) {
        nav.input('select-view'); render();
      }
      pending = false;
      ++refreshGeneration; updateUndo();
      await refreshSources(true);
    } catch (error) { if (sameAccount() && operation === revision) announce('Not confirmed: ' + error.message); }
    finally { if (operation === revision) pending = false; reconcile(); }
  }
  async function undoTaskAction() {
    updateUndo(); const receipt = undo;
    if (!receipt || pending || !signedIn()) return;
    if (!navigator.onLine) { announce('Offline. Undo was not submitted.'); return; }
    pending = true; const operation = ++revision;
    const deleting = receipt.action === 'delete';
    undo = null; preview = null; renderPreview(); updateUndo();
    announce(deleting ? 'Restoring task… awaiting DCC confirmation.' : 'Undoing completion… awaiting DCC confirmation.');
    try {
      const result = deleting
        ? await window.blockStore.restoreBlocks([receipt.taskId], { deleteMutationId: receipt.deleteMutationId })
        : await window.DCCWorkingQueue.undoCompletion(receipt);
      if (sameAccount() && operation === revision) {
        if (deleting && !result.ok) {
          announce(result.buffered ? 'Restore queued for retry.' : 'Restore could not be confirmed.');
          return;
        }
        if (deleting) window.refoldTaskStateFromBlockCache?.();
        pending = false; ++refreshGeneration;
        announce(deleting ? 'Task restored.' : 'Completion undone.');
        await refreshSources(true);
      }
    } catch (error) { if (sameAccount() && operation === revision) announce('Undo not confirmed: ' + error.message); }
    finally { if (operation === revision) pending = false; reconcile(); }
  }
  async function input(action) {
    if (!signedIn()) { reconcile(); return; }
    if (navigationHistory.busy()) return;
    updateUndo();
    if (action === 'left' && undo) return undoTaskAction();
    const state = nav.snapshot();
    if (swipeActions[action] && ['select', 'task'].includes(state.level)) {
      if (pending || !state.selected) return;
      const { selected, level } = state;
      if (selected.kind !== 'task') {
        announce('Open this item’s existing action flow in More.');
        return;
      }
      if (preview?.taskId === selected.id && preview.level === level) {
        const confirmed = preview.direction === action;
        preview = null; renderPreview();
        if (confirmed) return mutate(swipeActions[action], selected);
        announce('Action canceled.');
        return;
      }
      preview = { direction: action, taskId: selected.id, level };
      renderPreview();
      announce(prompts[action] + ' Swipe ' + action + ' again to confirm.');
      return;
    }
    if (preview) {
      preview = null; renderPreview();
      announce('Action canceled.');
      if (action === 'tap-fore' && state.level === 'task') return;
    }
    if (action === 'tap-middle') return navigationHistory.back(state);
    if (state.level === 'more' && action === 'tap-fore') return moreOptions(state.selected)[state.moreIndex][1]();
    if (state.level === 'task') {
      if (action === 'tap-fore') return mutate('complete', state.selected);
      if (action === 'up') {
        const foreground = window.DCCWorkingQueue.getState().queue?.items?.some(item => item.task.id === state.selected.actionId && item.status === 'foreground');
        return mutate(foreground ? 'background' : 'foreground', state.selected);
      }
      if (action === 'down') { nav.input('more'); render(); return; }
    }
    const next = nav.input(action);
    if (state.level === 'jump' && next.level === 'select' && !undo) {
      announce('Swipe left to delete or right to complete.');
    }
    return render();
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
  window.addEventListener('blur', () => { inputAdapter.reset(); swipe = null; });
  let swipe = null;
  content.addEventListener('pointerdown', event => {
    const control = event.target.closest('button');
    const onTask = control?.classList.contains('glasses-focus');
    if (!event.isPrimary || event.button !== 0 || (control && !onTask)) return;
    const { level, selected } = nav.snapshot();
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, level, taskId: selected?.id, onTask };
    // The content survives renders even when the task button under the finger does not.
    content.setPointerCapture(event.pointerId);
    if (onTask) inputAdapter.down('fore');
  });
  function swipeDelta(event) {
    if (swipe?.id !== event.pointerId) return null;
    const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
    return Math.max(Math.abs(dx), Math.abs(dy)) >= 35 ? { dx, dy } : null;
  }
  content.addEventListener('pointermove', event => {
    if (swipeDelta(event)) inputAdapter.cancel();
  });
  content.addEventListener('pointerup', event => {
    if (swipe?.id !== event.pointerId) return;
    const delta = swipeDelta(event);
    const start = swipe;
    swipe = null;
    const { level, selected } = nav.snapshot();
    if (!delta && start.onTask && start.level === level && start.taskId === selected?.id) {
      inputAdapter.up('fore');
      return;
    }
    inputAdapter.cancel();
    if (!delta || start.level !== level) return;
    const { dx, dy } = delta;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (start.taskId === selected?.id) input(dx < 0 ? 'left' : 'right');
    } else input(dy < 0 ? 'up' : 'down');
  }, true);
  function cancelSwipe(event) {
    if (swipe?.id !== event.pointerId) return;
    swipe = null;
    inputAdapter.cancel();
  }
  content.addEventListener('click', event => {
    if (event.detail > 0 && event.target.closest('.glasses-focus')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  content.addEventListener('pointercancel', cancelSwipe);
  content.addEventListener('lostpointercapture', cancelSwipe);
  window.addEventListener('dcc:glasses-gesture', event => { if (['up', 'down', 'left', 'right', 'tap-fore', 'hold-fore', 'tap-middle'].includes(event.detail?.action)) input(event.detail.action); });
  if (params.has('glassesSimulator')) {
    const simulator = node('nav', 'glasses-simulator'); simulator.setAttribute('aria-label', 'Development gesture simulator');
    for (const [label, action] of [['↑','up'],['↓','down'],['←','left'],['→','right'],['Forefinger','tap-fore'],['Hold forefinger','hold-fore'],['Middle','tap-middle']]) simulator.append(button(label, () => input(action)));
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
  window.addEventListener('offline', () => announce('Offline. Task actions are paused until you reconnect.'));
  document.addEventListener('visibilitychange', () => { inputAdapter.reset(); if (!document.hidden) refreshSources(); });
  setInterval(() => { updateUndo(); if (!sameAccount()) reconcile(); }, 100);
  // The canonical boot owns loading. Its data-ready event refreshes all sources.
  reconcile();
  if (document.readyState === 'complete') refreshSources();
})();
