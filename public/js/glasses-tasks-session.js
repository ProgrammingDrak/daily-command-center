(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./glasses-model'), require('./task-model'));
  else root.GlassesTasksSession = factory(root.GlassesModel, root.DCC.TaskModel);
})(typeof self !== 'undefined' ? self : this, function (M, TM) {
  'use strict';
  const issue = (message, status = 0) => Object.assign(new Error(message), { status });
  function create({ request, storage, uuid, online = () => true, timeZone = 'UTC', changed = () => {} }) {
    const s = { row: null, view: null, busy: false, pending: null, error: '', status: 'Opening…', code: 0, account: null, date: null };
    const key = () => 'dcc.glasses.task-retry.v1:' + s.account;
    async function verify() {
      const me = await request('/api/me');
      if (!me.userId || !me.workspaceId) throw issue('Sign in to DCC.', 401);
      const account = String(me.userId) + ':' + me.workspaceId;
      if (s.account && account !== s.account) {
        s.row = null; s.view = null; throw issue('Account changed. Reload this page to open the new account.', 403);
      }
      s.account = account;
    }
    async function run(fn) {
      if (s.busy) return;
      s.busy = true; s.error = ''; s.code = 0; s.accountChanged = false; changed(s);
      try {
        if (!online()) throw issue('Offline. No change was sent. Reconnect to continue.');
        await fn();
      } catch (e) {
        s.accountChanged = e.code === 'ACCOUNT_CHANGED';
        if (s.accountChanged) {
          s.row = null; s.view = null;
          e.status = 403; e.message = 'Account changed. Reload this page for the current account. Pending work is kept for its original account.';
        }
        s.code = e.status || 0;
        s.error = s.code === 401 ? 'Sign in again, then return here. No completion is assumed.'
          : s.code === 409 ? 'This task changed elsewhere. Refresh saved state and review it before continuing.' : e.message;
        s.status = s.pending ? 'Completion unconfirmed' : 'Needs attention';
      } finally { s.busy = false; changed(s); }
    }
    async function row(id) {
      const b = await request('/api/blocks/' + encodeURIComponent(id));
      const backlog = b.type === 'block' && b.properties?.kind === 'backlog' && TM.isTaskRow(b);
      if ((!TM.foldsIntoItinerary(b) && !backlog) || b.deleted_at || ['deleted', 'archived'].includes(b.properties?.status)) throw issue('Task is no longer available.', 404);
      return M.fromBlock(b, s.view?.overlays?.[b.date]);
    }
    async function refreshView(date, allEarlier) {
      const snapshot = await request('/api/sync/bootstrap' + (date ? '?date=' + encodeURIComponent(date) : ''));
      if (s.account.split(':').slice(1).join(':') !== snapshot.workspaceId) throw issue('Workspace changed. Reload before continuing.', 403);
      const carry = await request('/api/tasks/open?before=' + M.clock(timeZone).date + (allEarlier ? '&days=all&limit=2000' : '&days=14'));
      s.view = M.project(snapshot, carry, { timeZone }); s.view.allEarlier = !!allEarlier; s.date = snapshot.date;
    }
    function restore() {
      const raw = storage.getItem(key());
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.account !== s.account || typeof p.taskId !== 'string' || p.body?.completed !== true || typeof p.body.mutationId !== 'string') throw issue('Recovery receipt is invalid. Clear this site’s local recovery data before continuing.');
      s.pending = p;
    }
    async function send() {
      await verify();
      const p = s.pending;
      if (!p || p.account !== s.account) throw issue('Retry receipt belongs to another account.', 403);
      const result = await request('/api/tasks/' + encodeURIComponent(p.taskId) + '/completion', { method: 'POST', body: p.body });
      if (result.ok !== true || result.mutationId !== p.body.mutationId) throw issue('DCC did not acknowledge this completion. Retry the same request safely.');
      const fresh = await row(p.taskId);
      // Read-after-write prevents a historical duplicate receipt from overriding a reopen.
      storage.removeItem(key()); s.pending = null; s.row = fresh;
      s.status = fresh.completed ? 'Completion synced' : 'Task is open · saved state';
      if (s.view) {
        for (const values of Object.values(s.view)) if (Array.isArray(values)) for (const task of values) if (task.taskId === fresh.taskId) Object.assign(task, fresh);
        s.view.todos = s.view.todos.filter(task => !task.completed);
      }
    }
    return {
      state: s,
      load: options => run(async () => {
        const { taskId, date, allEarlier = false, discardConflict = false } = options || {};
        await verify();
        if (discardConflict && s.pending) { storage.removeItem(key()); s.pending = null; }
        restore(); await refreshView(date, allEarlier);
        const id = s.pending?.taskId || taskId;
        s.row = null;
        s.row = id ? await row(id) : null;
        s.status = s.pending ? 'Completion unconfirmed · retry safely' : 'Synced';
      }),
      complete: () => run(async () => {
        if (!s.row || s.row.completed || s.pending) return;
        if (!s.row.date) throw issue('Schedule this task in DCC before completing it here.');
        await verify();
        const fresh = await row(s.row.taskId);
        if (!fresh.date) throw issue('Schedule this task in DCC before completing it here.');
        if (fresh.completed) { s.row = fresh; s.status = 'Already completed in DCC'; return; }
        if (fresh.completionRevision !== s.row.completionRevision) throw issue('Completion state changed.', 409);
        const pending = { account: s.account, taskId: fresh.taskId, body: { completed: true, taskDate: fresh.date, expectedRevision: fresh.completionRevision, mutationId: uuid() } };
        try { storage.setItem(key(), JSON.stringify(pending)); }
        catch { throw issue('Recovery storage unavailable. No completion was sent. Enable site storage and retry.'); }
        s.pending = pending; changed(s); await send();
      }),
      retry: () => run(send),
      leaveUnresolved: () => {
        if (s.busy || !s.pending) return;
        // Keep the receipt for investigation, but stop forcing an inaccessible task open.
        storage.setItem(key() + ':unresolved:' + s.pending.body.mutationId, JSON.stringify(s.pending));
        storage.removeItem(key()); s.pending = null; s.row = null; s.status = 'Left unresolved · completion not confirmed'; changed(s);
      }
    };
  }
  return { create };
});
