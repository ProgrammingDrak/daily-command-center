// Opt-in presentation pilot. The full app still owns every selector, row and action.
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('device') !== 'glasses') return;
  document.body.classList.add('device-glasses');
  const rowSelector = '.it-list-item[data-id]:not(.resched-away-row), .wq-card[data-queue-id]';
  const idOf = row => row.dataset.queueId || row.dataset.id;
  let selectedId = null;
  let focusToken = null;
  let confirming = null;
  const forwarded = new WeakSet();
  const expanded = new Set();
  const visible = el => !!(el && el.getClientRects().length && !el.closest('[hidden],[inert],[aria-hidden="true"],details:not([open])'));
  function activeScope() {
    if (confirming) return confirming.scope;
    const focusedDialog = document.activeElement?.closest('[role="dialog"], dialog');
    if (focusedDialog && visible(focusedDialog)) return focusedDialog;
    const looseEnds = document.querySelector('#catchup-overlay.open');
    if (visible(looseEnds)) return looseEnds;
    const drawer = document.querySelector('#tasks-drawer.open [role="dialog"]');
    return visible(drawer) ? drawer : document;
  }
  const rows = () => [...activeScope().querySelectorAll(rowSelector)].filter(visible);
  const selected = () => rows().find(row => idOf(row) === selectedId);
  const titleOf = row => row.matches('.wq-card') ? row : row.querySelector('.ttl');
  const contextKey = () => JSON.stringify([window.DCC_ACCOUNT_CONTEXT || null, typeof __state === 'undefined' ? null : __state.date]);
  const button = (text, action, label) => {
    const el = document.createElement('button');
    el.type = 'button'; el.textContent = text;
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('click', action);
    return el;
  };
  const bar = document.createElement('nav');
  bar.className = 'glasses-nav'; bar.setAttribute('aria-label', 'Glasses task navigation');
  const status = document.createElement('p');
  status.className = 'glasses-status'; status.setAttribute('role', 'status');
  status.textContent = 'Focus a task · Enter opens details';
  function announce(message) { status.textContent = message; }
  function select(row, focus) {
    if (!row) return;
    selectedId = idOf(row);
    rows().forEach(item => item.classList.toggle('glasses-selected', item === row));
    if (focus) { titleOf(row)?.focus({ preventScroll: true }); row.scrollIntoView({ block: 'center', behavior: 'instant' }); }
    const list = rows();
    prev.disabled = list.indexOf(row) <= 0;
    next.disabled = list.indexOf(row) === list.length - 1;
    position.textContent = (list.indexOf(row) + 1) + ' / ' + list.length + ' visible';
  }
  function move(delta) {
    const list = rows();
    const at = list.findIndex(row => idOf(row) === selectedId);
    select(list[Math.max(0, Math.min(list.length - 1, at + delta))], true);
  }
  const prev = button('↑ Previous', () => move(-1), 'Previous visible task');
  const next = button('↓ Next', () => move(1), 'Next visible task');
  const position = document.createElement('span'); position.className = 'glasses-position';
  const tools = button('App tools', () => {
    const open = document.body.classList.toggle('glasses-tools-open');
    tools.setAttribute('aria-expanded', String(open));
    if (open) document.querySelector('#tab-bar .tab.active')?.scrollIntoView({ block: 'center' });
  });
  tools.setAttribute('aria-expanded', 'false');
  bar.append(prev, position, next, tools, status);
  document.body.append(bar);
  const exit = document.createElement('a');
  const normalUrl = new URL(location.href); normalUrl.searchParams.delete('device');
  exit.href = normalUrl.pathname + normalUrl.search + normalUrl.hash;
  exit.textContent = 'Full app'; exit.className = 'glasses-exit';
  document.querySelector('.header h1')?.append(exit);

  const dialog = document.createElement('dialog');
  dialog.className = 'glasses-confirm';
  dialog.setAttribute('aria-labelledby', 'glasses-confirm-title');
  const heading = document.createElement('h2'); heading.id = 'glasses-confirm-title';
  const detail = document.createElement('p');
  const note = document.createElement('p'); note.className = 'glasses-confirm-note';
  const cancel = button('Keep as is', () => dialog.close());
  const confirm = button('Mark done', () => {
    const request = confirming;
    if (!request || confirm.disabled) return;
    confirm.disabled = true;
    // Resolve the CURRENT canonical control, never a detached pre-refresh callback.
    const row = rows().find(item => item.dataset.id === request.id);
    const control = row?.querySelector('.it-list-check');
    if (!control || control.disabled || contextKey() !== request.context || row.classList.contains('done') !== request.done) {
      dialog.close(); announce('Task changed. Review its current state before trying again.'); return;
    }
    if (!navigator.onLine) { dialog.close(); announce('Offline. Nothing submitted. Reconnect, then try again.'); return; }
    forwarded.add(control);
    dialog.close();
    announce('Action sent to DCC. Check the save status before repeating.');
    control.click();
    forwarded.delete(control);
  });
  dialog.append(heading, detail, note, cancel, confirm);
  document.body.append(dialog);
  dialog.addEventListener('close', () => { confirming = null; select(selected(), true); });
  dialog.addEventListener('pointerdown', event => event.stopPropagation());
  dialog.addEventListener('keydown', event => {
    event.stopPropagation(); // The underlying queue's Tab/Escape trap must not handle this dialog.
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  });
  function ask(control, row) {
    if (dialog.open || control.disabled) return;
    if (!navigator.onLine) { announce('Offline. Nothing submitted. Reconnect, then try again.'); return; }
    select(row, false);
    confirming = { id: row.dataset.id, done: row.classList.contains('done'), context: contextKey(), scope: activeScope() };
    heading.textContent = confirming.done ? 'Reopen this task?' : 'Mark this task done?';
    detail.textContent = titleOf(row)?.textContent || 'Task';
    note.textContent = confirming.done ? 'Uses DCC’s existing reopen action.' : 'DCC’s normal rules for this item apply.';
    confirm.textContent = confirming.done ? 'Reopen task' : 'Mark done';
    confirm.disabled = false;
    dialog.showModal(); cancel.focus();
  }
  document.addEventListener('click', event => {
    const control = event.target.closest('.it-list-check');
    const row = control?.closest(rowSelector);
    if (!row || forwarded.has(control)) return;
    event.preventDefault(); event.stopImmediatePropagation(); ask(control, row);
  }, true);
  // Suppress the canonical quick-complete hold/key shortcut while confirmation owns it.
  document.addEventListener('pointerdown', event => {
    if (event.target.closest('.it-list-item[data-id] .it-list-check')) event.stopImmediatePropagation();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.repeat && ['Enter', ' '].includes(event.key) && event.target.matches('.ttl, .wq-card')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.target.matches('.wq-card') && event.key === 'Enter' && !event.repeat) {
      event.preventDefault(); event.stopImmediatePropagation();
      event.target.querySelector('[data-queue-action=details]')?.click(); return;
    }
    // A bounded list interaction, not a second page-wide spatial focus manager.
    // Prevent default only when moving a title; all other arrows stay native.
    if (event.target.matches('.ttl, .wq-card') && event.target.closest(rowSelector) && ['ArrowUp', 'ArrowDown'].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const list = rows(); const at = list.indexOf(event.target.closest(rowSelector));
      const destination = list[at + (event.key === 'ArrowDown' ? 1 : -1)];
      if (destination) { event.preventDefault(); event.stopImmediatePropagation(); select(destination, true); }
      return;
    }
    const control = event.target.closest('.it-list-check');
    const row = control?.closest(rowSelector);
    if (!row || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat) ask(control, row);
  }, true);
  document.addEventListener('focusin', event => {
    const row = event.target.closest(rowSelector);
    if (!row) { if (event.target !== document.body) focusToken = null; return; }
    select(row, false);
    if (event.target.matches('.ttl, .wq-card')) row.scrollIntoView({ block: 'center', behavior: 'instant' });
    focusToken = { id: idOf(row), el: event.target, kind: event.target.classList.contains('it-list-check') ? '.it-list-check' : row.matches('.wq-card') ? null : '.ttl' };
  });

  function adapt() {
    document.body.classList.toggle('glasses-queue-view', !!document.querySelector('#tab-working-queue.active'));
    document.querySelectorAll(rowSelector).forEach(row => {
      if (row.matches('.wq-card')) {
        row.draggable = false;
        row.setAttribute('aria-label', row.querySelector('h3')?.textContent || 'Task');
        if (!row.querySelector('.glasses-more')) {
          const more = button('More', () => {
            if (expanded.has(idOf(row))) expanded.delete(idOf(row)); else expanded.add(idOf(row));
            row.classList.toggle('glasses-expanded', expanded.has(idOf(row)));
            more.setAttribute('aria-expanded', String(expanded.has(idOf(row))));
          }, 'More actions for ' + row.querySelector('h3')?.textContent);
          more.className = 'glasses-more';
          row.querySelector('.wq-actions')?.append(more);
        }
        row.classList.toggle('glasses-expanded', expanded.has(idOf(row)));
        row.querySelector('.glasses-more')?.setAttribute('aria-expanded', String(expanded.has(idOf(row))));
        return;
      }
      const title = titleOf(row);
      if (!title) return;
      const control = row.querySelector('.it-list-check');
      if (control && !control.dataset.glassesLabel) {
        control.dataset.glassesLabel = 'true';
        control.setAttribute('aria-label', (row.classList.contains('done') ? 'Reopen: ' : 'Mark done: ') + title.textContent);
        const label = document.createElement('span');
        label.className = 'glasses-check-label'; label.textContent = row.classList.contains('done') ? 'Reopen' : 'Done';
        control.append(label);
      }
      if (!row.querySelector('.glasses-more')) {
        const more = button('More', event => {
          event.stopPropagation();
          if (expanded.has(row.dataset.id)) expanded.delete(row.dataset.id); else expanded.add(row.dataset.id);
          row.classList.toggle('glasses-expanded', expanded.has(row.dataset.id));
          more.setAttribute('aria-expanded', String(expanded.has(row.dataset.id)));
        }, 'More actions for ' + title.textContent);
        more.className = 'glasses-more';
        more.setAttribute('aria-expanded', String(expanded.has(row.dataset.id)));
        row.querySelector('.it-list-meta')?.append(more);
      }
      row.classList.toggle('glasses-expanded', expanded.has(row.dataset.id));
    });
    const list = rows();
    select(selected() || list[0], false);
    if (!list.length) { prev.disabled = true; next.disabled = true; position.textContent = 'No visible tasks'; }
    if (focusToken && !focusToken.el.isConnected && document.activeElement === document.body && !dialog.open) {
      const row = list.find(item => idOf(item) === focusToken.id) || selected();
      const target = (focusToken.kind && row?.querySelector(focusToken.kind)) || (row && titleOf(row));
      target?.focus({ preventScroll: true });
    }
  }
  // Ignore selection styling; shared overlay inert changes must restore navigation.
  let queued = false;
  const observer = new MutationObserver(records => {
    if (!records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.(rowSelector) || node.querySelector?.(rowSelector))))) return;
    if (queued) return;
    queued = true; requestAnimationFrame(() => { queued = false; adapt(); });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] });
  document.querySelectorAll('.tab-content').forEach(tab => {
    new MutationObserver(() => adapt()).observe(tab, { attributes: true, attributeFilter: ['class'] });
  });
  document.addEventListener('toggle', event => {
    if (event.target.matches?.('.wq-completed')) adapt();
  }, true);
  window.addEventListener('offline', () => announce('Offline. Completion is paused until you reconnect.'));
  window.addEventListener('online', () => announce('Connection restored. Review DCC’s save status before retrying.'));
  adapt();
})();
