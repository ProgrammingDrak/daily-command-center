(function () {
  'use strict';
  const DCC = window.DCC;
  if (!DCC?.overlay) return;
  let open = false;
  function composer(seed = {}) {
    if (open) return;
    open = true;
    const body = document.createElement('div'); body.className = 'wq-form';
    const esc = DCC.esc;
    body.innerHTML = '<p>A single reading session. Save it to your Task Library, then choose when to read.</p><label>Book title (optional)<input data-title maxlength="300" value="' + esc(seed.title || '') + '"></label><label>Author (optional)<input data-author maxlength="200" value="' + esc(seed.author || '') + '"></label><label>Minutes<input data-minutes type="number" min="1" max="240" value="' + esc(seed.minutes || 30) + '"></label><label>QuietShelf book link (optional)<input data-url type="url" value="' + esc(seed.url || '') + '"></label><p role="status"></p>';
    const requestId = seed.requestId || crypto.randomUUID();
    let busy = false, saved = false;
    const handle = DCC.overlay.open({ kind: 'modal', title: 'Plan reading time', body, canClose: () => !busy, onClose: () => { open = false; }, actions: [{ label: 'Cancel' }, { label: 'Save reading session', kind: 'primary', onClick: async () => {
      if (busy || saved) return false;
      busy = true;
      try {
        const result = await DCC.api('/api/task-library/reading-sessions', { method: 'POST', body: { title: body.querySelector('[data-title]').value, author: body.querySelector('[data-author]').value, minutes: Number(body.querySelector('[data-minutes]').value), url: body.querySelector('[data-url]').value, requestId } });
        saved = true;
        body.querySelector('[role=status]').textContent = result.duplicate ? 'This reading session is already in your Task Library.' : 'Saved to your Task Library, unscheduled. Choose its time there when ready.';
        window.DCCTaskLibrary?.refresh?.();
        DCC.toast('Reading session saved to Task Library', 'success');
        // Keep the canonical task identity visible for a verifiable handoff.
        const link = body.querySelector('[data-url]').value;
        if (link) { const a = document.createElement('a'); a.href = link; a.rel = 'noreferrer'; a.textContent = 'Return to book in QuietShelf'; body.appendChild(a); }
        body.querySelectorAll('input').forEach(el => { el.disabled = true; });
        return false;
      } catch (error) { body.querySelector('[role=status]').textContent = error.message || 'Could not save. Retry this same draft.'; return false; }
      finally { busy = false; }
    } }] });
    return handle;
  }
  function handoff() {
    if (!location.hash.startsWith('#reading=')) return;
    try {
      const seed = JSON.parse(decodeURIComponent(location.hash.slice(9)));
      if (!seed || typeof seed !== 'object' || ['title', 'author', 'url', 'requestId'].some(key => typeof seed[key] !== 'string') || seed.url.length > 2000 || seed.title.length > 300 || seed.author.length > 200 || !/^[a-zA-Z0-9_-]{8,100}$/.test(seed.requestId)) throw new Error('Invalid reading draft');
      composer(seed);
    } catch { DCC.toast('Could not open this reading draft. Use Reading time in Task Library.', 'error'); }
  }
  document.addEventListener('click', event => { if (event.target.closest?.('[data-reading-session]')) composer(); });
  window.addEventListener('hashchange', handoff);
  window.DCCReadingSessions = { composer };
  handoff();
})();
